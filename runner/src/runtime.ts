// One hosted agent's turns: the runner-side counterpart of Desktop's
// harness runtimes (`ClaudeRuntime`, `PiRuntime`, `GooseRuntime`,
// `CodexRuntime`). The harness machinery is an engine (engine.ts): buzz-app's
// `AgentSessions` for Claude, its `Pi` client for Pi, its goose module for
// Goose, its Codex client for Codex, all imported unchanged, as are the
// prompts (`systemPrompt`,
// `turnPrompt`, `steerPrompt`). What lives here is what Desktop's host
// provides around them, the same for every harness: the sender gate, the
// conversation key, thread context reads, the in-process Buzz tool server,
// typing, telemetry turns, the failure report and the runner's global turn
// limits.
// Where it repeats Desktop's host code (buzz-app src/bundled/*/runtime.ts),
// that code is Apache-2.0, Copyright 2026 Block, Inc.; see NOTICE.
import { respond, type Listing } from "@buzz/buzz-mcp/rpc";
import type { BuzzClient, BuzzEvent, Context } from "@buzz/buzz-mcp/client";
import { TOOLS } from "@buzz/buzz-mcp/tools";
import { turnNote } from "@buzz/buzz-mcp/session-tools";
import type { Settled, Spawn, ToolServer } from "@buzz/bundled/claude-code/claude";
import { CONTEXT_LIMIT, type Scope, systemPrompt, turnPrompt } from "@buzz/bundled/claude-code/prompt";
import type { ToolResult } from "@buzz/bundled/pi/pi";
import { coreMemorySection } from "@buzz/features/agent-harness/core-memory";
import { addressedTo, CHAT_KINDS } from "@buzz/features/agents/attention";
import { attestedOwner } from "@buzz/features/agents/owner-attestation";
import { type Pulses, pulseTyping } from "@buzz/features/agents/typing";
import type { EventData, RelayEvent } from "@buzz/features/relay/events";
import { threadReference } from "@buzz/features/relay/thread-reference";
import { verifyEvent } from "nostr-tools/pure";
import {
  CONTEXT_KINDS,
  CONTEXT_READ_TIMEOUT_MS,
  CORE_MEMORY_TIMEOUT_MS,
  DEFAULT_SCOPE,
  CLAUDE_HARNESS,
  CODEX_HARNESS,
  FAILURE_MESSAGE,
  GOOSE_HARNESS,
  HARNESS_CATALOG,
  PI_HARNESS,
  type HarnessId,
  MEDIA_TOTAL_MAX_BYTES,
  KIND_CHAT,
  NAMES_TIMEOUT_MS,
  REPLY_READ_TIMEOUT_MS,
  REPLY_THREAD_READ_LIMIT,
  STOP_INTERRUPT_MS,
  THREAD_CONTEXT_LIMIT,
  TURN_STOP_GRACE_MS,
  TURN_WALL_CLOCK_MS,
  WALL_CLOCK_ERROR,
} from "./constants";
import type { RunnerConfig } from "./config";
import type { ServerPool } from "@buzz/bundled/goose/sessions";
import type { ServeMcp } from "@buzz/features/agent-harness/acp/types";
import { CodexEngine } from "./codex-engine";
import { ClaudeEngine, type Engine } from "./engine";
import { GooseEngine, sessionTitle } from "./goose-engine";
import { errorMessage } from "./errors";
import type { Limiter } from "./limiter";
import type { PoolMember, SessionPool } from "./pool";
import { short, type Logger } from "./log";
import { withTimeout } from "./net";
import { PiEngine } from "./pi-engine";
import type { ChannelSummary, CommunityReads } from "./reads";
import { trimMedia, type AgentRecord, type AgentState } from "./store";
import type { Telemetry, TurnFailure, TurnHandle } from "./telemetry";

/** Hosted agents run thread-scoped sessions, Desktop's default scope. */
const SCOPE: Scope = "thread";
/** Every Buzz tool loads up front, as Desktop marks them (`load: "always"`).
 * The attention tools are not listed: hosted agents have no attention. */
const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));
/** The one tool that writes to disk; its total is capped. */
const MEDIA_TOOL = "media_get";
const TOOLS_HINT = "Read and act in Buzz as this agent.";
const LISTING: Listing = {
  instructions: TOOLS_HINT,
  tool: ({ load: _load, ...tool }) => ({ ...tool, _meta: { "anthropic/alwaysLoad": true } }),
};
/** The same tools as Pi's host lists them (buzz-mcp `sessionTools`, less
 * the attention tools hosted agents do not have). */
const PI_TOOLS = Object.freeze(TOOLS.map((tool) => ({ ...tool, load: "always" as const })));
/** The same tools as Codex's dynamic tools list them. */
const CODEX_TOOLS = Object.freeze(TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })));
/** A JSON-RPC id for the tool calls this runtime makes to its own server. */
const TOOL_CALL_ID = 1;

export type RuntimeDeps = Readonly<{
  /** The latest record, so a rename or config change reaches new sessions. */
  record(): AgentRecord;
  client: BuzzClient;
  reads: CommunityReads;
  isDm(channel: string): boolean;
  /** Whether a pubkey is any agent this runner hosts, so two hosted agents
   * can never wake each other into a loop. */
  isHosted(pubkey: string): boolean;
  /** Where `media_get` saves files; kept under MEDIA_TOTAL_MAX_BYTES. */
  mediaDir: string;
  /** The harness this runtime runs; fixed for its life (a move relaunches). */
  harness: HarnessId;
  /** Starts the harness's process as the harness user. */
  spawn: Spawn;
  state: AgentState;
  config: RunnerConfig;
  limiter: Limiter;
  /** The host-wide live-process cap, asked before a turn starts a process. */
  pool: SessionPool;
  /** Starts a session's loopback MCP server (Goose), runner-wide. */
  serveMcp: ServeMcp;
  /** The MCP servers every agent's Goose sessions hold, runner-wide. */
  mcpPool: ServerPool;
  log: Logger;
  /** The owner's live activity feed; absent with `publishTelemetry` off. */
  telemetry?: Telemetry | undefined;
}>;

/** A conversation's claim on a global turn slot. Later events for the same
 * conversation join it (and steer the running turn) instead of taking
 * another slot, and wait on `gate` so they keep their order. */
type Inflight = {
  gate: Promise<void>;
  count: number;
  release?: (() => void) | undefined;
  failed?: Error;
  /** The slot's observer turn, ended when the slot is released. */
  observed?: TurnHandle | undefined;
  /** The last delivery's failure, reported as the turn's `turn_error`. */
  failure?: TurnFailure | undefined;
};

/** What the observer turn of a slot names (buzz-acp `turn_started`). */
type TurnMeta = Readonly<{ channelId: string; trigger: string; threadRoot?: string | undefined }>;

/** `turn_error` outcomes: a delivery that failed, and one over the cap. */
const MS_PER_S = 1000;
/** Channel types where an untagged owner message keeps Buzz's own rules (the
 * reply-wake plugin's SKIPPED_CHANNEL_TYPES). */
const REPLY_SKIPPED_CHANNEL_TYPES = new Set(["solo"]);
const OUTCOME_ERROR = "error";
const OUTCOME_TIMEOUT = "timeout";

type Turn = Readonly<{
  key: string;
  event: EventData;
  scope: Scope;
  topLevel: boolean;
  channel: Readonly<{ id: string; name?: string; dm: boolean }>;
  thread?: Readonly<{ rootId: string; parentId: string }>;
  context: readonly EventData[];
  total: number;
  name(pubkey: string): string | undefined;
}>;

export class AgentRuntime {
  private readonly engine: Engine;
  /** Where each conversation's tools default to: its latest turn's thread
   * (Desktop `entry.contexts`). */
  private readonly contexts = new Map<string, Context>();
  private readonly inflight = new Map<string, Inflight>();
  /** Typing pulses by conversation, shared by concurrent turns there, as
   * Desktop's `runner.typing`. */
  private readonly pulses: Pulses = new Map();
  private disposed = false;
  private readonly agent: string;
  private readonly member: PoolMember;

  constructor(private readonly deps: RuntimeDeps) {
    this.agent = deps.record().pubkey;
    // A process stopped or freed: a turn waiting on the cap checks again.
    const onChange = () => deps.pool.notify();
    this.engine =
      deps.harness === GOOSE_HARNESS
        ? this.gooseEngine(onChange)
        : deps.harness === CODEX_HARNESS
        ? this.codexEngine(onChange)
        : deps.harness === PI_HARNESS
        ? new PiEngine({
            agent: this.agent,
            spawn: deps.spawn,
            tools: PI_TOOLS,
            hint: TOOLS_HINT,
            setup: async () => {
              const settings = this.settings();
              const memory = await this.coreMemory();
              return {
                cwd: settings.cwd,
                instructions: this.instructions(settings),
                ...(memory === undefined
                  ? {}
                  : { core: { text: coreMemorySection(memory), placeholder: coreMemorySection(null) } }),
                model: settings.model,
                effort: settings.effort,
              };
            },
            tool: (key, name, args) => this.callTool(key, name, args),
            inflight: this.inflight,
            onChange,
            feed: deps.telemetry?.feed(this.settings().cwd),
            log: deps.log.child({ harness: PI_HARNESS }),
          })
        : new ClaudeEngine({
            spawn: deps.spawn,
            state: deps.state,
            fingerprint: () => JSON.stringify(this.settings()),
            inflight: this.inflight,
            onChange,
            launch: async () => {
              const settings = this.settings();
              const memory = await this.coreMemory();
              return {
                cwd: settings.cwd,
                ...(settings.model ? { model: settings.model } : {}),
                ...(settings.effort ? { effort: settings.effort } : {}),
                tools: this.tools,
                systemPrompt: this.instructions(settings, memory),
              };
            },
          });
    this.member = {
      id: this.agent,
      live: () => this.engine.live(),
      holds: (slot) => this.engine.holds(slot),
      evict: (slot) => this.engine.evict(slot),
      stopped: () => this.disposed,
    };
    deps.pool.register(this.member);
  }

  /** Goose: sessions open with the system prompt and core memory, as
   * Claude's do; the model and level are read per turn. */
  private gooseEngine(onChange: () => void) {
    const { deps } = this;
    const setup = () => {
      const { cwd, model, effort } = this.settings();
      return { cwd, model, effort };
    };
    return new GooseEngine({
      spawn: deps.spawn,
      serve: deps.serveMcp,
      pool: deps.mcpPool,
      tools: this.tools,
      settings: setup,
      launch: async () => {
        const settings = this.settings();
        const memory = await this.coreMemory();
        return { ...setup(), systemPrompt: this.instructions(settings, memory) };
      },
      // Model and effort are picked per turn: a change opens no new session.
      fingerprint: () => {
        const { model: _model, effort: _effort, ...rest } = this.settings();
        return JSON.stringify(rest);
      },
      inflight: this.inflight,
      onChange,
      log: deps.log.child({ harness: GOOSE_HARNESS }),
    });
  }

  /** Codex: each turn reads the settings and core memory as it starts; the
   * conversation's thread resumes from the agent's state file. */
  private codexEngine(onChange: () => void) {
    const { deps } = this;
    return new CodexEngine({
      agent: this.agent,
      spawn: deps.spawn,
      store: deps.state.sessions,
      tools: CODEX_TOOLS,
      hint: TOOLS_HINT,
      settings: () => this.settings(),
      coreMemory: () => this.coreMemory(),
      tool: (key, name, args) => this.callTool(key, name, args),
      inflight: this.inflight,
      onChange,
      feed: deps.telemetry?.feed(this.settings().cwd, CODEX_HARNESS),
      log: deps.log.child({ harness: CODEX_HARNESS }),
    });
  }

  /** The conversation a harness session serves (Goose), for telemetry. */
  keyOfSession(session: string): string | undefined {
    return this.engine instanceof GooseEngine ? this.engine.keyOf(session) : undefined;
  }

  /** The system prompt, with the `core` memory for Claude, which shows it
   * there; Pi keeps it in a section of its own. */
  private instructions(settings: ReturnType<AgentRuntime["settings"]>, memory?: string | null) {
    return systemPrompt({
      scope: SCOPE,
      cwd: settings.cwd,
      agent: { name: settings.name, pubkey: this.agent },
      instructions: settings.instructions,
      ...(memory === undefined ? {} : { memory }),
    });
  }

  /** What a running process fixed at launch; a change restarts idle sessions. */
  private settings() {
    const record = this.deps.record();
    const { config } = this.deps;
    // The config's default model and effort are Claude's: no other harness
    // names its models alike.
    const claude = this.deps.harness === CLAUDE_HARNESS;
    const model = record.config.model ?? (claude ? config.model : undefined);
    const effort = record.config.effort ?? (claude ? config.effort : undefined);
    return {
      cwd: `${config.workspaceRoot}/${this.agent}`,
      name: record.name,
      instructions: record.config.instructions,
      // A scope change moves new turns to other conversations; restarting idle
      // sessions keeps no process on the old split.
      scope: record.config.scope ?? DEFAULT_SCOPE,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
  }

  /** Name, instructions, model or effort changed: idle sessions restart on
   * their next message, busy ones once they fall idle (Desktop `reconfigure`). */
  reconfigure() {
    this.engine.reconfigure();
  }

  dispose() {
    this.disposed = true;
    this.engine.dispose();
    for (const slot of this.inflight.values()) slot.release?.();
    this.inflight.clear();
    this.deps.pool.unregister(this.member);
  }

  /** The agent's stop (runner shutdown, delete, re-activation). New events
   * are refused at once. A busy turn is interrupted rather than awaited: a
   * turn may run for 30 min and the whole stop has 20 s, and an interrupt
   * lets claude end the turn and flush its session file, so it resumes
   * cleanly. Then every process is told to stop (stdin EOF first); the
   * caller waits for the exits through the agent's ChildTracker. */
  async shutdown() {
    this.disposed = true;
    const busy = this.engine.busy();
    if (busy.length) this.deps.log.info("interrupting busy turns for stop", { turns: busy.length });
    await Promise.allSettled(
      busy.map((key) => withTimeout(this.engine.interrupt(key), STOP_INTERRUPT_MS, "interrupt on stop")),
    );
    this.dispose();
  }

  /** The agent's `core` memory as Desktop's `Agents.core` gives it: its body,
   * `null` when it has none, `undefined` when it could not be read. */
  private async coreMemory(): Promise<string | null | undefined> {
    try {
      const { entries } = await withTimeout(this.deps.client.memories("core"), CORE_MEMORY_TIMEOUT_MS, "core memory read");
      return entries.find((entry) => entry.slug === "core")?.body ?? null;
    } catch (error) {
      this.deps.log.warn("core memory unreadable", { error });
      return undefined;
    }
  }

  /** The in-process MCP server Claude reaches over its control channel
   * (`mcp_message`). Calls are signed by the runner's `nodeClient`; the
   * claude process never holds the key. */
  private readonly tools: ToolServer = (conversation, message) =>
    this.serve((conversation && this.contexts.get(conversation)) || {}, conversation, message);

  /** One MCP message to the Buzz tools, in `context`. */
  private async serve(context: Context, conversation: string | undefined, message: unknown) {
    const request = (message ?? {}) as { method?: unknown; params?: { name?: unknown } };
    if (request.method === "tools/call")
      this.deps.log.info("tool call", { tool: String(request.params?.name ?? ""), conversation });
    const response = (await respond(this.deps.client, context, message, [], LISTING)) as {
      result?: { tools?: { name: string }[]; content?: unknown; isError?: boolean };
    };
    if (request.method === "tools/list" && response.result?.tools)
      response.result.tools = response.result.tools.filter((tool) => TOOL_NAMES.has(tool.name));
    if (request.method === "tools/call" && request.params?.name === MEDIA_TOOL) return this.capMedia(response);
    return response;
  }

  /** A tool call from a harness that asks for tools by name (Pi), through
   * the same server, listing and media budget as Claude's calls. */
  private async callTool(key: string | undefined, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Only the tools this runtime lists: the server also knows the
    // attention tools, which hosted agents do not have.
    if (!TOOL_NAMES.has(name)) return { content: [{ type: "text", text: `No tool ${name}` }], isError: true };
    const context = (key && this.contexts.get(key)) || {};
    const response = (await this.serve(context, key, {
      jsonrpc: "2.0",
      id: TOOL_CALL_ID,
      method: "tools/call",
      params: { name, arguments: args },
    })) as { result?: { content?: unknown; isError?: boolean }; error?: { message?: unknown } };
    if (response.error)
      return { content: [{ type: "text", text: String(response.error.message ?? "Tool call failed") }], isError: true };
    const content = Array.isArray(response.result?.content) ? (response.result.content as unknown[]) : [];
    return { content, ...(response.result?.isError ? { isError: true } : {}) };
  }

  /** Applies the media budget after a download. A file that alone exceeds
   * it is removed too, and the call then reports an error instead of a path
   * that no longer exists. */
  private async capMedia<T extends { result?: { content?: unknown; isError?: boolean } }>(response: T): Promise<T> {
    const removed = await trimMedia(this.deps.mediaDir, MEDIA_TOTAL_MAX_BYTES).catch((error) => {
      this.deps.log.warn("media trim failed", { error });
      return [] as string[];
    });
    if (!removed.length) return response;
    this.deps.log.info("media evicted", { files: removed.length, capBytes: MEDIA_TOTAL_MAX_BYTES });
    const text = JSON.stringify(response.result ?? {});
    if (!removed.some((path) => text.includes(path))) return response;
    return {
      ...response,
      result: { content: [{ type: "text", text: "Media is larger than this host keeps." }], isError: true },
    };
  }

  /** Desktop's wake rule, in order: not its own event, in a channel,
   * addressed to it (a chat p-tag, or any message in a one-to-one DM), and
   * from the owner, a pubkey in `allowedSenders`, or (with `acceptAttested`,
   * as Desktop's `fromOwner`) an agent with a valid owner NIP-OA tag: the
   * owner's desktop agents and this runner's other agents. With `acceptAttested`
   * off, the gate is owner plus `allowedSenders` only, and this runner's
   * other agents never wake it. Resolves whether the event was admitted, so
   * the listener moves its cursor only for those. Drops are logged with a
   * reason and never with content. */
  async handle(event: RelayEvent): Promise<boolean> {
    const { log, config } = this.deps;
    const drop = (reason: string) => {
      log.info("event dropped", { reason, event: event.id.slice(0, 12), kind: event.kind, author: short(event.pubkey) });
      return false;
    };
    if (this.disposed) return drop("agent-stopped");
    if (event.pubkey === this.agent) return drop("self");
    if (!config.acceptAttested && this.deps.isHosted(event.pubkey)) return drop("hosted-agent");
    const channel = event.tags.find((tag) => tag[0] === "h")?.[1];
    if (!channel) return drop("no-channel");
    const dm = event.kind === KIND_CHAT && this.deps.isDm(channel);
    const addressed = addressedTo(event, this.agent) && CHAT_KINDS.includes(event.kind);
    const reply = !dm && !addressed && (await this.replyTarget(event, channel));
    if (!dm && !addressed && !reply) return drop("not-addressed");
    let sender = "owner";
    if (event.pubkey !== config.ownerPubkey) {
      if (config.allowedSenders.includes(event.pubkey)) sender = "allowed";
      else if (config.acceptAttested && (await attestedOwner(event)) === config.ownerPubkey) sender = "attested";
      else return drop("not-owner");
    }
    // The signature check yields: the agent may have stopped meanwhile.
    if (this.disposed) return drop("agent-stopped");
    const via = dm ? "dm" : addressed ? "mention" : `reply (${reply})`;
    log.info("event accepted", { event: event.id.slice(0, 12), kind: event.kind, via, sender });
    void this.run(event, channel).catch((error) =>
      log.error("turn failed before delivery", { event: event.id.slice(0, 12), error }),
    );
    return true;
  }

  /** The reply-wake plugin's rule (`sagmans.reply-wake` layer 2), applied
   * here because that plugin can wake only agents its own app runs. It
   * answers which rule makes an untagged owner thread reply this agent's, or
   * undefined when it is not. Owner only: a reply from anyone else never
   * wakes. A message that tags anyone already wakes whom it names. Rules:
   * "reply" when the replied message is this agent's, else "last agent" when
   * the newest earlier message in the thread by one of the owner's agents
   * is this agent's. Reads fail closed, and the deciding event's signature
   * is checked, since query results are not verified by the client. */
  private async replyTarget(event: RelayEvent, channel: string): Promise<string | undefined> {
    const { config, log } = this.deps;
    if (!config.replyWake || event.pubkey !== config.ownerPubkey || event.kind !== KIND_CHAT) return undefined;
    if (event.tags.some((tag) => tag[0] === "p")) return undefined;
    const thread = threadReference(event);
    if (!thread) return undefined;
    try {
      const summary = await withTimeout(this.deps.reads.channel(channel), REPLY_READ_TIMEOUT_MS, "reply channel read");
      if (summary.channelType && REPLY_SKIPPED_CHANNEL_TYPES.has(summary.channelType)) return undefined;
      if (thread.parentId !== thread.rootId) {
        const [parent] = await withTimeout(
          this.deps.reads.read([{ ids: [thread.parentId], kinds: [KIND_CHAT], "#h": [channel], limit: 1 }]),
          REPLY_READ_TIMEOUT_MS,
          "reply parent read",
        );
        return parent?.id === thread.parentId &&
          parent.pubkey === this.agent &&
          channelOf(parent) === channel &&
          verified(parent)
          ? "reply"
          : undefined;
      }
      const events = await withTimeout(
        this.deps.reads.read([
          { ids: [thread.rootId], kinds: [KIND_CHAT], "#h": [channel], limit: 1 },
          { kinds: [KIND_CHAT], "#e": [thread.rootId], "#h": [channel], until: event.created_at, limit: REPLY_THREAD_READ_LIMIT },
        ]),
        REPLY_READ_TIMEOUT_MS,
        "reply thread read",
      );
      const mine = orderKey(event);
      const earlier = events
        .filter(
          (item) =>
            item.id !== event.id &&
            item.kind === KIND_CHAT &&
            channelOf(item) === channel &&
            orderKey(item) <= mine &&
            (item.id === thread.rootId || threadReference(item)?.rootId === thread.rootId),
        )
        .sort((a, b) => orderKey(b) - orderKey(a));
      for (const item of earlier) if (await this.ownersAgent(item)) return item.pubkey === this.agent ? "last agent" : undefined;
      return undefined;
    } catch (error) {
      log.warn("reply target unreadable", { event: event.id.slice(0, 12), channel, error: errorMessage(error) });
      return undefined;
    }
  }

  /** Whether `event` is by one of the owner's agents: this agent, another
   * agent of this runner (whose events may carry no owner tag, see config
   * `attestEvents`), or an agent with a valid owner NIP-OA tag (desktop agents). */
  private async ownersAgent(event: BuzzEvent) {
    if (event.pubkey === this.deps.config.ownerPubkey || !verified(event)) return false;
    if (event.pubkey === this.agent || this.deps.isHosted(event.pubkey)) return true;
    return (await attestedOwner(event)) === this.deps.config.ownerPubkey;
  }

  /** Desktop `run` for a mention: freeze the conversation, build the turn,
   * deliver it to that conversation's session, report a failure. */
  private async run(event: EventData, channel: string) {
    const summary = await this.deps.reads.channel(channel).catch((error): ChannelSummary => {
      this.deps.log.warn("channel unreadable", { channel, error });
      return { id: channel, members: [] };
    });
    const solo = summary.channelType === "solo";
    const topLevel = solo;
    const dm = summary.channelType === "dm";
    const root = threadReference(event)?.rootId ?? event.id;
    // Desktop `key`: channel scope makes the whole channel one conversation.
    const shared = this.deps.record().config.scope === "channel";
    const key = topLevel || dm || shared ? channel : `${channel}/${root}`;
    // Shown typing where the reply lands (same `topLevel` and root as the
    // reply), from now until the turn settles, as Desktop's `working`. It
    // goes through the reply's own publish path, so it carries the owner tag
    // exactly when replies do.
    const stopTyping = pulseTyping(
      (template) => this.deps.client.publish({ ...template, tags: template.tags ?? [] }),
      Promise.resolve(topLevel),
      event,
      channel,
      this.pulses,
    );
    try {
      await this.answer(event, summary, channel, key, root, topLevel, solo);
    } finally {
      stopTyping();
    }
  }

  /** Builds the turn, delivers it to the conversation's session and reports
   * a failure; split from `run` so typing wraps all of it. */
  private async answer(
    event: EventData,
    summary: ChannelSummary,
    channel: string,
    key: string,
    root: string,
    topLevel: boolean,
    solo: boolean,
  ) {
    // Desktop: a shared channel session has not seen every thread, so what
    // it has seen is kept per thread.
    const dm = summary.channelType === "dm";
    const contextRoot = key === channel && !dm && !topLevel ? root : undefined;
    const prompt = async (fresh: boolean) => {
      const turn = await this.turn(event, summary, key, topLevel, fresh, contextRoot);
      const text = turnPrompt({ ...turn, agent: this.agent, label: "@mention", channelLevel: false });
      return this.review(text);
    };
    this.contexts.set(
      key,
      topLevel ? { channel, ...(solo ? { topLevel } : {}) } : key === channel ? { channel } : { channel, root },
    );
    const meta = {
      channelId: channel,
      trigger: event.id,
      ...(key !== channel || contextRoot ? { threadRoot: root } : {}),
    };
    const context = this.contexts.get(key) ?? {};
    // Desktop's goose title: the agent, the place, and the root of a thread
    // session.
    const place = dm ? "DM" : summary.name ? `#${summary.name}` : channel;
    const title = sessionTitle(this.settings().name, place, key !== channel ? root : undefined);
    const settled = await this.dispatch(key, meta, () =>
      this.engine.deliver({ key, request: event.id, at: event.created_at, prompt, context, contextRoot, title }),
    );
    if (!settled.ok) await this.report(channel, event, settled.error ?? this.stoppedError(), topLevel);
  }

  /** `text` with the Buzz tools' end-of-turn note, when there is one. */
  private review(text: string) {
    return [text, turnNote(this.deps.client)].filter(Boolean).join("\n\n");
  }

  /** Desktop `turn`: the unseen thread context, the channel label and the
   * names the prompt shows. */
  private async turn(
    event: EventData,
    summary: ChannelSummary,
    key: string,
    topLevel: boolean,
    fresh: boolean,
    contextRoot: string | undefined,
  ): Promise<Turn> {
    const channelId = summary.id;
    const dm = summary.channelType === "dm";
    const thread = threadReference(event);
    const rootId = thread?.rootId ?? event.id;
    const scope: Scope = key === channelId ? "channel" : "thread";
    const seen = fresh ? 0 : await this.engine.seen(key, contextRoot);
    let earlier: EventData[] = [];
    if (thread || dm || topLevel)
      try {
        const events = await withTimeout(
          this.deps.reads.read(
            thread && !topLevel
              ? [
                  // nodeClient requires kinds on every filter.
                  { ids: [rootId], kinds: CONTEXT_KINDS, "#h": [channelId], limit: 1 },
                  { kinds: CONTEXT_KINDS, "#h": [channelId], "#e": [rootId], limit: THREAD_CONTEXT_LIMIT },
                ]
              : [{ kinds: CONTEXT_KINDS, "#h": [channelId], limit: CONTEXT_LIMIT + 1 }],
          ),
          CONTEXT_READ_TIMEOUT_MS,
          "thread context read",
        );
        earlier = (events as unknown as EventData[])
          .filter(
            (item) =>
              CONTEXT_KINDS.includes(item.kind) &&
              item.tags.some(([name, value]) => name === "h" && value === channelId) &&
              item.id !== event.id &&
              item.created_at <= event.created_at,
          )
          .sort((a, b) => a.created_at - b.created_at);
      } catch (error) {
        this.deps.log.warn("conversation unreadable", { channel: channelId, error });
      }
    // A session already has its own replies; a new one is shown them too.
    const unseen = earlier.filter((item) => item.created_at > seen && (!seen || item.pubkey !== this.agent));
    const pubkeys = [
      ...new Set([
        event.pubkey,
        ...unseen.map((item) => item.pubkey),
        ...event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1] ?? ""),
      ]),
    ].filter(Boolean);
    const names = await withTimeout(this.deps.reads.names(pubkeys), NAMES_TIMEOUT_MS, "names read").catch(
      () => new Map<string, string>(),
    );
    return {
      key,
      event,
      scope,
      topLevel,
      channel: { id: channelId, ...(summary.name ? { name: summary.name } : {}), dm },
      ...(thread ? { thread } : {}),
      context: unseen,
      total: earlier.length + 1,
      name: (pubkey: string) => names.get(pubkey),
    };
  }

  /** Runs `deliver` under the global parallel-turn limit and the per-turn
   * wall-clock cap. Settles as the turn does. */
  private async dispatch(key: string, meta: TurnMeta, deliver: () => Promise<Settled>): Promise<Settled> {
    const { limiter, log } = this.deps;
    let slot = this.inflight.get(key);
    if (slot) {
      slot.count++;
      await slot.gate;
    } else {
      let open!: () => void;
      slot = { gate: new Promise<void>((resolve) => (open = resolve)), count: 1 };
      this.inflight.set(key, slot);
      try {
        slot.release = await limiter.acquire();
        // Observed from the moment it may run, as buzz-acp starts the turn
        // before session setup and context reads.
        slot.observed = this.deps.telemetry?.begin({
          key,
          channelId: meta.channelId,
          triggeringEventIds: [meta.trigger],
          threadRootEventId: meta.threadRoot,
        });
      } catch (error) {
        slot.failed = error instanceof Error ? error : new Error(String(error));
      } finally {
        open();
      }
    }
    const current = slot;
    // Called by the turn's end and by a forced stop; only the first counts.
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      if (--current.count > 0) return;
      if (this.inflight.get(key) === current) this.inflight.delete(key);
      current.release?.();
      current.release = undefined;
      current.observed?.end(current.failure);
      current.observed = undefined;
      // Its process is idle now and may be stopped for a waiting turn.
      this.deps.pool.notify();
    };
    if (current.failed || this.disposed) {
      done();
      return { ok: false, error: current.failed?.message ?? "The agent was stopped", undelivered: true };
    }
    // A new process needs a slot under the host's live-session cap.
    let admitted: () => void;
    try {
      admitted = await this.deps.pool.admit(this.member, this.engine.slot(key));
    } catch (error) {
      done();
      return { ok: false, error: errorMessage(error), undelivered: true };
    }
    let timedOut = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = setTimeout(() => {
      timedOut = true;
      // Set now: a forced stop may release the slot before delivery settles.
      current.failure = { outcome: OUTCOME_TIMEOUT, error: WALL_CLOCK_ERROR };
      log.warn("turn over wall-clock cap", { conversation: key, capMs: TURN_WALL_CLOCK_MS });
      void this.engine.interrupt(key).catch((error) => log.warn("interrupt failed", { conversation: key, error }));
      stopTimer = setTimeout(() => void this.hardStop(key, done), TURN_STOP_GRACE_MS);
    }, TURN_WALL_CLOCK_MS);
    try {
      const settled = await deliver();
      const result: Settled = timedOut ? { ok: false, error: WALL_CLOCK_ERROR } : settled;
      current.failure = result.ok
        ? undefined
        : { outcome: timedOut ? OUTCOME_TIMEOUT : OUTCOME_ERROR, error: result.error ?? this.stoppedError() };
      return result;
    } catch (error) {
      current.failure = { outcome: OUTCOME_ERROR, error: errorMessage(error) };
      throw error;
    } finally {
      clearTimeout(cap);
      clearTimeout(stopTimer);
      admitted();
      done();
    }
  }

  /** The interrupt did not end the turn: stop what runs it. */
  private async hardStop(key: string, release: () => void) {
    this.deps.log.error("turn stopped by force", { conversation: key });
    try {
      await this.engine.forceStop(key);
    } catch (error) {
      this.deps.log.error("force stop failed", { conversation: key, error });
    }
    // The slot must not stay taken if the process ignores the stop.
    release();
  }

  /** The owner's Stop. A DM is one conversation, so a thread id may name it. */
  async interrupt(channel: string, root: string | undefined) {
    for (const key of root ? [`${channel}/${root}`, channel] : [channel])
      if (this.engine.active(key)) {
        await this.engine.interrupt(key);
        this.deps.log.info("turn interrupted", { conversation: key });
        return true;
      }
    return false;
  }

  /** What a failed turn says when its harness gave no reason. */
  private stoppedError() {
    return `${HARNESS_CATALOG[this.deps.harness].title} stopped`;
  }

  /** Desktop `report`: says in the thread that a turn failed, so nobody
   * waits on it, tagging the owner. Unlike Desktop the post is generic: the
   * error can carry stderr, paths or host details, and every channel member
   * can read it. The details stay in the log. */
  private async report(channel: string, event: EventData, error: string, topLevel: boolean) {
    this.deps.log.warn("turn failed", { channel, event: event.id.slice(0, 12), error });
    if (this.disposed) return;
    await this.deps.client
      .publish({
        kind: KIND_CHAT,
        content: FAILURE_MESSAGE,
        tags: [
          ["h", channel],
          ...(topLevel ? [] : [["e", threadReference(event)?.rootId ?? event.id, "", "reply"]]),
          ["p", this.deps.config.ownerPubkey],
        ],
      })
      .catch((failure) => this.deps.log.warn("failure report not posted", { error: errorMessage(failure) }));
  }
}

/** Signature check for events read back from the relay (`attestedOwner`
 * expects a verified event). nostr-tools takes mutable tags; it only reads. */
function verified(event: BuzzEvent) {
  return verifyEvent({ ...event, tags: event.tags.map((tag) => [...tag]) });
}

/** The event's channel, from its `h` tag. */
function channelOf(event: { readonly tags: readonly (readonly string[])[] }) {
  return event.tags.find((tag) => tag[0] === "h" && tag[1])?.[1];
}

/** Buzz's message order: seconds, then the `ms` tag, as the reply-wake
 * plugin orders them, since seconds alone tie often. */
function orderKey(event: { readonly created_at: number; readonly tags: readonly (readonly string[])[] }) {
  const ms = Number(event.tags.find((tag) => tag[0] === "ms")?.[1]);
  return event.created_at * MS_PER_S + (Number.isInteger(ms) && ms >= 0 && ms < MS_PER_S ? ms : 0);
}
