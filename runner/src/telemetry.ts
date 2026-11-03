// Live agent activity for hosted agents, as Buzz Desktop shows it for its own
// (buzz-app `activity.ts`, `activity-transcript.ts`). Desktop reads it from
// the owner's observer feed: kind-24200 frames that buzz-acp publishes
// (`crates/buzz-acp/src/lib.rs`, `observer.rs`, `pool.rs`). Hosted agents run
// no buzz-acp, so this module produces the same frames from what the runner
// already has: the turn slots of `runtime.ts`, the claude stream-json that
// `spawn.ts` carries, what Pi's host reports, and the raw ACP of `goose-acp`.
//
// Shape parity, so Desktop needs no change:
// - Turn lifecycle as buzz-acp's pool: `turn_started` (triggering event ids),
//   `turn_liveness` every 10 s, `turn_error`, `turn_completed` on every exit.
// - The harness conversation as buzz-acp observes ACP: `acp_write` for what
//   the harness sends (session/new, session/prompt, _session/steering) and
//   `acp_read` for what the agent sends (session/update notifications and the
//   prompt response). claude stream-json is mapped to the session/update
//   payloads claude-agent-acp would send (titles, kinds, locations, diffs).
// - Publishing as buzz-acp: chunk coalescing, one frame per 1 s tick,
//   same-channel batch envelopes, elision to the NIP-44 plaintext cap, a
//   4 MiB queue that drops the oldest.
//
// Security: frames can hold prompts, tool inputs and tool outputs. Each is
// NIP-44 v2 encrypted from the agent key to the owner's pubkey only, and a
// frame that cannot be encrypted is dropped (fail closed). Nothing here
// logs frame content, the conversation key or the agent key. Goose's
// `session/new` carries its MCP server's Bearer token, so it is never passed
// on, and that token is redacted from any frame that would still hold it.
import { relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { encrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent } from "nostr-tools/pure";
import type { BuzzEvent } from "@buzz/buzz-mcp/client";
import {
  KIND_AGENT_OBSERVER,
  OBSERVER_AGENT_INDEX,
  OBSERVER_CHUNK_MAX_TEXT_BYTES,
  OBSERVER_FRAME_TELEMETRY,
  OBSERVER_LEAF_RETAIN_BYTES,
  OBSERVER_LIVENESS_MS,
  OBSERVER_PLAINTEXT_MAX_BYTES,
  OBSERVER_PUBLISH_TIMEOUT_MS,
  OBSERVER_QUEUE_MAX_BYTES,
  OBSERVER_TICK_MS,
  OBSERVER_TOOLS_REMEMBERED,
  ACP_TAP_REDACTED,
  ACP_TAP_REMEMBERED,
} from "./constants";
import { errorMessage } from "./errors";
import type { Logger } from "./log";

type Json = Record<string, unknown>;

/** buzz-acp `ObserverEvent`, serialized camelCase. */
export type ObserverFrame = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  startedAt?: string;
  payload: unknown;
};

/** What `spawn.ts` hands over: complete stdout lines and raw stdin writes. */
export type StreamTap = Readonly<{ stdin(data: string): void; stdout(line: string): void }>;

/** How a harness turn ended, for its prompt's response. */
export type FeedOutcome = Readonly<{ stop: "end_turn" | "cancelled" } | { error: string }>;

/** What a harness without a stream to tap (Pi, whose host speaks its own
 * protocol) reports of one conversation's turn. `session` names the
 * harness conversation the turn runs in. */
export type HarnessFeed = Readonly<{
  prompt(key: string, session: string, fresh: boolean, text: string): void;
  step(key: string, session: string, tool: string, target?: string): void;
  answer(key: string, session: string, text: string): void;
  settled(key: string, session: string, outcome: FeedOutcome): void;
}>;

export type TelemetryOptions = Readonly<{
  agent: string;
  owner: string;
  /** Agent secret key; used only to sign and to derive the owner key. */
  secret: Uint8Array;
  /** Sends a signed frame over the agent's authenticated WebSocket. */
  publish(event: BuzzEvent, timeoutMs: number): Promise<void>;
  /** The claude session a conversation key runs in (the saved session). */
  sessionOf(key: string): string | undefined;
  log: Logger;
}>;

export type TurnStart = Readonly<{
  key: string;
  channelId: string;
  triggeringEventIds: readonly string[];
  threadRootEventId?: string | undefined;
}>;

export type TurnFailure = Readonly<{ outcome: string; error: string }>;
export type TurnHandle = Readonly<{ end(failure?: TurnFailure): void }>;

type Turn = {
  key: string;
  turnId: string;
  channelId: string;
  startedAt: string;
  threadRootEventId?: string | undefined;
  sessionId?: string;
  /** JSON-RPC id of the open session/prompt, answered by the next result,
   * or when the turn ends first. */
  prompt?: number | string | undefined;
  liveness?: ReturnType<typeof setInterval>;
  ended: boolean;
};

/** What a frame's metadata carries, as buzz-acp's observer contexts. */
type Context = Readonly<{ startedAt: boolean; session: boolean }>;
const STARTED: Context = { startedAt: true, session: false };
const RUNNING: Context = { startedAt: true, session: true };
const ENDED: Context = { startedAt: false, session: false };

const JSONRPC = "2.0";
const SOURCE_CHANNEL = "channel";
const BATCH_KIND = "batch";
const CHUNK_UPDATES = new Set(["agent_message_chunk", "user_message_chunk", "agent_thought_chunk"]);
/** claude result subtypes and the ACP stop reason claude-agent-acp gives them. */
const STOP_SUCCESS = "end_turn";
const STOP_MAX_TURNS = "max_turn_requests";
const STOP_CANCELLED = "cancelled";
const RESULT_MAX_TURNS = "error_max_turns";
const RESULT_ABORTED = "aborted_streaming";
/** JSON-RPC internal error, as an ACP adapter answers a failed prompt. */
const RPC_INTERNAL_ERROR = -32603;
/** claude-agent-acp reports these as a plan, never as a tool call. */
const PLAN_TOOL = "TodoWrite";
const PLAN_PRIORITY = "medium";
const MS_PER_S = 1000;
const now = () => Math.floor(Date.now() / MS_PER_S);
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const object = (value: unknown): Json | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : undefined;
const str = (value: unknown) => (typeof value === "string" ? value : undefined);

/** One agent's observer feed. */
export class Telemetry {
  private seq = 0;
  private rpc = 0;
  private readonly turns = new Map<string, Turn>();
  private readonly queue: FrameQueue;
  /** NIP-44 key shared by agent and owner; undefined if the owner key is
   * unusable, which disables publishing (fail closed). */
  private readonly conversation: Uint8Array | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  private sending = false;
  /** True during a run of dropped frames, so it is logged once. */
  private failing = false;
  private dropped = 0;
  private disposed = false;

  constructor(private readonly options: TelemetryOptions) {
    let conversation: Uint8Array | undefined;
    try {
      conversation = getConversationKey(options.secret, options.owner);
    } catch (error) {
      options.log.error("telemetry disabled: owner key unusable for encryption", { error: errorMessage(error) });
    }
    this.conversation = conversation;
    this.queue = new FrameQueue((dropped, pending) =>
      options.log.warn("telemetry queue over budget; dropped oldest frames", { dropped, pendingBytes: pending }),
    );
    this.timer = setInterval(() => void this.tick(), OBSERVER_TICK_MS);
    // Telemetry never holds the runner open at shutdown.
    this.timer.unref();
  }

  dispose() {
    this.disposed = true;
    clearInterval(this.timer);
    for (const turn of this.turns.values()) clearInterval(turn.liveness);
    this.turns.clear();
  }

  /** A turn slot opened (runtime `dispatch`). The handle ends it. */
  begin(start: TurnStart): TurnHandle {
    // One live turn per conversation: a leftover one is closed first.
    const prior = this.turns.get(start.key);
    if (prior) this.finish(prior);
    const turn: Turn = {
      key: start.key,
      turnId: randomUUID(),
      channelId: start.channelId,
      startedAt: new Date().toISOString(),
      ...(start.threadRootEventId ? { threadRootEventId: start.threadRootEventId } : {}),
      ended: false,
    };
    if (this.disposed) return { end: () => undefined };
    this.turns.set(start.key, turn);
    const root = turn.threadRootEventId ? { threadRootEventId: turn.threadRootEventId } : {};
    this.emit(turn, "turn_started", { source: SOURCE_CHANNEL, triggeringEventIds: [...start.triggeringEventIds], ...root }, STARTED);
    turn.liveness = setInterval(() => this.emit(turn, "turn_liveness", { ...root }, RUNNING), OBSERVER_LIVENESS_MS);
    turn.liveness.unref();
    return { end: (failure) => this.finish(turn, failure) };
  }

  private finish(turn: Turn, failure?: TurnFailure) {
    if (turn.ended) return;
    turn.ended = true;
    clearInterval(turn.liveness);
    if (this.turns.get(turn.key) === turn) this.turns.delete(turn.key);
    // The work can count as done before the harness answers its prompt (a
    // final Buzz message ends it; Goose then ends its own turn later), so
    // the open prompt is answered here, as the runner settled it: the feed
    // never shows a prompt still running in a turn that ended.
    if (turn.prompt !== undefined) {
      const id = turn.prompt;
      turn.prompt = undefined;
      this.acp(
        turn,
        false,
        failure
          ? { jsonrpc: JSONRPC, id, error: { code: RPC_INTERNAL_ERROR, message: "Internal error", data: { error: failure.error } } }
          : { jsonrpc: JSONRPC, id, result: { stopReason: STOP_SUCCESS } },
      );
    }
    if (failure) this.emit(turn, "turn_error", { outcome: failure.outcome, error: failure.error }, ENDED);
    this.emit(turn, "turn_completed", {}, ENDED);
  }

  private emit(turn: Turn, kind: string, payload: unknown, context: Context) {
    if (this.disposed) return;
    this.queue.ingest({
      seq: ++this.seq,
      timestamp: new Date().toISOString(),
      kind,
      agentIndex: OBSERVER_AGENT_INDEX,
      channelId: turn.channelId,
      sessionId: context.session ? (turn.sessionId ?? null) : null,
      turnId: turn.turnId,
      ...(context.startedAt ? { startedAt: turn.startedAt } : {}),
      payload,
    });
  }

  /** A stream tap for one claude process, launched with `session` (from
   * `--session-id` when `fresh`, else `--resume`) in `cwd`. */
  tap(session: string, fresh: boolean, cwd: string | undefined): StreamTap {
    return new ProcessTap(this, session, fresh, cwd);
  }

  /** The feed of a harness that has no stream-json to tap, working in
   * `cwd`; its steps name `harness` in their metadata, as each ACP adapter
   * names itself. */
  feed(cwd: string, harness: string = FEED_DEFAULT_HARNESS): HarnessFeed {
    return new FeedTap(this, cwd, harness);
  }

  /** The tap of one ACP harness process (Goose), whose sessions `keyOf`
   * maps to conversations. */
  acpTap(keyOf: (session: string) => string | undefined): StreamTap {
    return new AcpTap(this, keyOf);
  }

  /** The live turn of conversation `key`, if one is open. */
  turnOf(key: string): Turn | undefined {
    return this.turns.get(key);
  }

  /** The live turn whose conversation runs in `session`, if any. A process
   * idle between turns has none, and its output is not observed. */
  turnFor(session: string): Turn | undefined {
    for (const turn of this.turns.values()) if (turn.sessionId === session) return turn;
    for (const turn of this.turns.values())
      if (this.options.sessionOf(turn.key) === session) {
        turn.sessionId = session;
        return turn;
      }
    return undefined;
  }

  /** Records one ACP message of `turn`: `write` is harness to agent. */
  acp(turn: Turn, write: boolean, message: Json) {
    this.emit(turn, write ? "acp_write" : "acp_read", message, RUNNING);
  }

  sessionResolved(turn: Turn, session: string, isNewSession: boolean) {
    this.emit(turn, "session_resolved", { sessionId: session, isNewSession }, RUNNING);
  }

  nextId() {
    return ++this.rpc;
  }

  /** Sends at most one frame per tick, as buzz-acp. A failure drops that
   * frame: observer frames are ephemeral, a late one is noise. */
  private async tick() {
    if (this.sending || this.disposed || !this.conversation) return;
    const frame = this.queue.next();
    if (!frame) return;
    this.sending = true;
    try {
      let content: string;
      try {
        content = encrypt(JSON.stringify(frame), this.conversation);
      } catch (error) {
        return this.drop(frame, "encrypt", error);
      }
      const event = finalizeEvent(
        {
          kind: KIND_AGENT_OBSERVER,
          content,
          tags: [
            ["p", this.options.owner],
            ["agent", this.options.agent],
            ["frame", OBSERVER_FRAME_TELEMETRY],
          ],
          created_at: now(),
        },
        this.options.secret,
      ) as BuzzEvent;
      try {
        await this.options.publish(event, OBSERVER_PUBLISH_TIMEOUT_MS);
      } catch (error) {
        return this.drop(frame, "publish", error);
      }
      if (this.failing) {
        this.options.log.info("telemetry publishing again", { dropped: this.dropped });
        this.failing = false;
        this.dropped = 0;
      }
    } finally {
      this.sending = false;
    }
  }

  /** Logs the first drop of a run, by stage and frame kind only. */
  private drop(frame: ObserverFrame, stage: string, error: unknown) {
    this.dropped++;
    if (this.failing) return;
    this.failing = true;
    this.options.log.warn("telemetry frame dropped", { stage, frameKind: frame.kind, error: errorMessage(error) });
  }
}

/** Maps one claude process's stream-json to ACP messages of its live turn. */
class ProcessTap implements StreamTap {
  /** The system prompt from `initialize`, shown with the first turn as
   * buzz-acp's session/new carries it. */
  private system: string | undefined;
  /** The turn this process last served, to announce each new one once. */
  private turn: Turn | undefined;
  /** Tool uses by id, to render their results as claude-agent-acp does. */
  private readonly tools = new Map<string, { name: string; input: unknown }>();
  private stdinRest = "";

  constructor(
    private readonly telemetry: Telemetry,
    private session: string,
    private fresh: boolean,
    private readonly cwd: string | undefined,
  ) {}

  stdin(data: string) {
    const lines = (this.stdinRest + data).split("\n");
    this.stdinRest = lines.pop() ?? "";
    for (const line of lines) {
      const message = parse(line);
      if (!message) continue;
      const request = object(message.request);
      if (message.type === "control_request" && request?.subtype === "initialize") {
        this.system = str(request.appendSystemPrompt);
        continue;
      }
      if (message.type !== "user") continue;
      const turn = this.current();
      if (!turn) continue;
      const text = messageText(object(message.message)?.content);
      // A message while a prompt is open is folded into it: claude's steer.
      const steer = turn.prompt !== undefined;
      const id = this.telemetry.nextId();
      if (!steer) turn.prompt = id;
      this.telemetry.acp(turn, true, {
        jsonrpc: JSONRPC,
        id,
        method: steer ? "_session/steering" : "session/prompt",
        params: { sessionId: this.session, prompt: [{ type: "text", text }] },
      });
    }
  }

  stdout(line: string) {
    const message = parse(line);
    if (!message) return;
    const session = str(message.session_id);
    // claude may answer a resume with a new session id.
    if (session && session !== this.session) this.session = session;
    if (message.type === "assistant") return this.assistant(message);
    if (message.type === "user" && message.isReplay !== true) return this.results(message);
    if (message.type === "result") return this.result(message);
  }

  /** The live turn for this process, announced (session_resolved and, for a
   * new session, session/new with the system prompt) the first time. */
  private current() {
    const turn = this.telemetry.turnFor(this.session);
    if (!turn || turn === this.turn) return turn;
    this.turn = turn;
    this.telemetry.sessionResolved(turn, this.session, this.fresh);
    if (this.fresh && this.system)
      this.telemetry.acp(turn, true, {
        jsonrpc: JSONRPC,
        id: this.telemetry.nextId(),
        method: "session/new",
        params: { cwd: this.cwd ?? "", mcpServers: [], _meta: { systemPrompt: { append: this.system } } },
      });
    this.fresh = false;
    return turn;
  }

  private update(turn: Turn, update: Json) {
    this.telemetry.acp(turn, false, {
      jsonrpc: JSONRPC,
      method: "session/update",
      params: { sessionId: this.session, update },
    });
  }

  /** Assistant content blocks: text, thinking and tool uses. */
  private assistant(message: Json) {
    const turn = this.current();
    if (!turn) return;
    const body = object(message.message);
    const messageId = str(body?.id);
    const parent = str(message.parent_tool_use_id);
    const meta = (toolName?: string) => ({
      claudeCode: { ...(toolName ? { toolName } : {}), ...(parent ? { parentToolUseId: parent } : {}) },
    });
    for (const value of Array.isArray(body?.content) ? body.content : []) {
      const block = object(value);
      if (!block) continue;
      const text = block.type === "text" ? str(block.text) : block.type === "thinking" ? str(block.thinking) : undefined;
      if (text) {
        this.update(turn, {
          ...(parent ? { _meta: meta() } : {}),
          sessionUpdate: block.type === "text" ? "agent_message_chunk" : "agent_thought_chunk",
          content: { type: "text", text },
          ...(messageId ? { messageId } : {}),
        });
        continue;
      }
      if (block.type !== "tool_use") continue;
      const id = str(block.id);
      const name = str(block.name) ?? "";
      if (!id) continue;
      this.remember(id, name, block.input);
      if (name === PLAN_TOOL) {
        const todos = object(block.input)?.todos;
        const entries = Array.isArray(todos)
          ? todos.flatMap((todo) => {
              const entry = object(todo);
              return entry ? [{ content: str(entry.content) ?? "", status: str(entry.status) ?? "", priority: PLAN_PRIORITY }] : [];
            })
          : [];
        this.update(turn, { sessionUpdate: "plan", entries });
        continue;
      }
      const facts = toolFacts(name, block.input, this.cwd);
      this.update(turn, {
        _meta: meta(name),
        toolCallId: id,
        sessionUpdate: "tool_call",
        name,
        rawInput: block.input ?? {},
        status: "pending",
        title: facts.title,
        kind: facts.kind,
        content: facts.content ?? [],
        ...(facts.locations ? { locations: facts.locations } : {}),
      });
    }
  }

  /** Tool results come back as a user message of tool_result blocks. */
  private results(message: Json) {
    const content = object(message.message)?.content;
    if (!Array.isArray(content)) return;
    const turn = this.current();
    if (!turn) return;
    for (const value of content) {
      const block = object(value);
      const id = str(block?.tool_use_id);
      if (!block || block.type !== "tool_result" || !id) continue;
      const tool = this.tools.get(id);
      if (tool?.name === PLAN_TOOL) continue;
      const failed = block.is_error === true;
      // Edit and Write already show their diff; the result is only a
      // confirmation, which claude-agent-acp leaves out too.
      const shown = tool && (tool.name === "Edit" || tool.name === "Write") && !failed ? [] : resultContent(block.content);
      this.update(turn, {
        _meta: { claudeCode: { toolName: tool?.name ?? "" } },
        toolCallId: id,
        sessionUpdate: "tool_call_update",
        status: failed ? "failed" : "completed",
        ...(shown.length ? { content: shown } : {}),
      });
    }
  }

  /** The end of one claude turn answers the open session/prompt. */
  private result(message: Json) {
    const turn = this.current();
    if (!turn || turn.prompt === undefined) return;
    const id = turn.prompt;
    turn.prompt = undefined;
    const stop =
      message.subtype === "success"
        ? STOP_SUCCESS
        : message.subtype === RESULT_MAX_TURNS
          ? STOP_MAX_TURNS
          : message.terminal_reason === RESULT_ABORTED
            ? STOP_CANCELLED
            : undefined;
    this.telemetry.acp(
      turn,
      false,
      stop
        ? { jsonrpc: JSONRPC, id, result: { stopReason: stop } }
        : { jsonrpc: JSONRPC, id, error: { code: RPC_INTERNAL_ERROR, message: "Internal error", data: { subtype: str(message.subtype) ?? "" } } },
    );
  }

  private remember(id: string, name: string, input: unknown) {
    this.tools.set(id, { name, input });
    if (this.tools.size > OBSERVER_TOOLS_REMEMBERED) this.tools.delete(this.tools.keys().next().value as string);
  }
}

/** Maps what a harness host reports (its prompts, steps and answers) to
 * the ACP messages of the conversation's live turn, as ProcessTap does for
 * claude stream-json. A step has no result, so it shows as in progress until
 * the next step or the end of the turn completes it. */
class FeedTap implements HarnessFeed {
  /** Per live turn: whether it was announced, and its open step. */
  private readonly turns = new WeakMap<Turn, { step?: string | undefined }>();
  private steps = 0;

  constructor(
    private readonly telemetry: Telemetry,
    private readonly cwd: string,
    private readonly harness: string,
  ) {}

  prompt(key: string, session: string, fresh: boolean, text: string) {
    const turn = this.current(key, session, fresh);
    if (!turn) return;
    // A prompt while one is open is folded into it: the harness's steer.
    const steer = turn.prompt !== undefined;
    const id = this.telemetry.nextId();
    if (!steer) turn.prompt = id;
    this.telemetry.acp(turn, true, {
      jsonrpc: JSONRPC,
      id,
      method: steer ? "_session/steering" : "session/prompt",
      params: { sessionId: session, prompt: [{ type: "text", text }] },
    });
  }

  step(key: string, session: string, tool: string, target?: string) {
    const turn = this.current(key, session, false);
    if (!turn) return;
    this.close(turn, session);
    const id = `${FEED_STEP_PREFIX}${++this.steps}`;
    (this.turns.get(turn) as { step?: string | undefined }).step = id;
    const facts = FEED_STEP_KINDS[tool];
    this.update(turn, session, {
      _meta: { [this.harness]: { toolName: tool } },
      toolCallId: id,
      sessionUpdate: "tool_call",
      name: tool,
      rawInput: target ? { target } : {},
      status: "in_progress",
      title: target ? `${tool} ${displayPath(target, this.cwd)}` : tool,
      kind: facts ?? "other",
      content: [],
    });
  }

  answer(key: string, session: string, text: string) {
    const turn = this.current(key, session, false);
    if (!turn || !text) return;
    this.close(turn, session);
    this.update(turn, session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  }

  settled(key: string, session: string, outcome: FeedOutcome) {
    const turn = this.current(key, session, false);
    if (!turn) return;
    this.close(turn, session);
    if (turn.prompt === undefined) return;
    const id = turn.prompt;
    turn.prompt = undefined;
    this.telemetry.acp(
      turn,
      false,
      "stop" in outcome
        ? { jsonrpc: JSONRPC, id, result: { stopReason: outcome.stop } }
        : { jsonrpc: JSONRPC, id, error: { code: RPC_INTERNAL_ERROR, message: "Internal error", data: { error: outcome.error } } },
    );
  }

  /** The conversation's live turn, announced (session_resolved) once. */
  private current(key: string, session: string, fresh: boolean) {
    const turn = this.telemetry.turnOf(key);
    if (!turn) return undefined;
    if (!this.turns.has(turn)) {
      this.turns.set(turn, {});
      turn.sessionId = session;
      this.telemetry.sessionResolved(turn, session, fresh);
    }
    return turn;
  }

  /** Completes the turn's open step. */
  private close(turn: Turn, session: string) {
    const state = this.turns.get(turn);
    if (!state?.step) return;
    const id = state.step;
    state.step = undefined;
    this.update(turn, session, { toolCallId: id, sessionUpdate: "tool_call_update", status: "completed" });
  }

  private update(turn: Turn, session: string, update: Json) {
    this.telemetry.acp(turn, false, { jsonrpc: JSONRPC, method: "session/update", params: { sessionId: session, update } });
  }
}

/** What a Goose session was opened with, until its first turn shows it. */
type Opened = { cwd: string; system?: string | undefined };

/** Passes one ACP harness process's own messages to the live turn of the
 * conversation each session serves, as buzz-acp observes ACP: what the
 * runner writes (`session/prompt`, Goose's steer as `_session/steering`,
 * `session/cancel`) as `acp_write`, what the harness answers (session
 * updates and the prompt's response) as `acp_read`. A session's first turn
 * also shows a `session/new` rebuilt with its cwd and system prompt only:
 * the real one carries the MCP token. Messages outside a turn, provider
 * reads and config switches are not shown. */
class AcpTap implements StreamTap {
  private stdinRest = "";
  /** `session/new` requests waiting for their session id, with their cwd. */
  private readonly opening = new Map<string, string>();
  /** Sessions this process opened, not yet shown in a turn. */
  private readonly opened = new Map<string, Opened>();
  /** `session/prompt` requests waiting for their response, by id. */
  private readonly prompts = new Map<string, string>();
  /** The sessions each live turn has announced. */
  private readonly announced = new WeakMap<Turn, Set<string>>();
  /** Every MCP token this process was given; none may reach a frame. */
  private readonly tokens = new Set<string>();

  constructor(
    private readonly telemetry: Telemetry,
    private readonly keyOf: (session: string) => string | undefined,
  ) {}

  stdin(data: string) {
    const lines = (this.stdinRest + data).split("\n");
    this.stdinRest = lines.pop() ?? "";
    for (const line of lines) {
      const message = parse(line);
      const method = str(message?.method);
      if (!message || !method) continue;
      const params = object(message.params) ?? {};
      const session = str(params.sessionId);
      if (method === "session/new") {
        this.secrets(params);
        if (message.id !== undefined) remember(this.opening, String(message.id), str(params.cwd) ?? "");
        continue;
      }
      if (!session) continue;
      if (method === "_goose/unstable/session/system-prompt/set") {
        const opened = this.opened.get(session);
        if (opened) opened.system = str(params.text);
        continue;
      }
      if (method === "session/prompt") {
        const turn = this.current(session);
        if (!turn) continue;
        if (message.id !== undefined && message.id !== null) {
          remember(this.prompts, String(message.id), session);
          turn.prompt = message.id as number | string;
        }
        this.send(turn, true, message);
        continue;
      }
      if (method === "_goose/unstable/session/steer") {
        const turn = this.current(session);
        if (turn)
          this.send(turn, true, {
            jsonrpc: JSONRPC,
            id: this.telemetry.nextId(),
            method: "_session/steering",
            params: { sessionId: session, prompt: params.prompt ?? [] },
          });
        continue;
      }
      if (method === "session/cancel") {
        const turn = this.current(session);
        if (turn) this.send(turn, true, message);
      }
    }
  }

  stdout(line: string) {
    const message = parse(line);
    if (!message) return;
    const method = str(message.method);
    if (method === "session/update" && message.id === undefined) {
      const session = str(object(message.params)?.sessionId);
      const turn = session ? this.current(session) : undefined;
      if (turn) this.send(turn, false, message);
      return;
    }
    if (method !== undefined || message.id === undefined || message.id === null) return;
    const id = String(message.id);
    const cwd = this.opening.get(id);
    if (cwd !== undefined) {
      this.opening.delete(id);
      const session = str(object(message.result)?.sessionId);
      if (session) remember(this.opened, session, { cwd });
      return;
    }
    const session = this.prompts.get(id);
    if (session === undefined) return;
    this.prompts.delete(id);
    const turn = this.current(session);
    // Answered already when the turn ended first (Telemetry `finish`).
    if (!turn || turn.prompt === undefined || String(turn.prompt) !== id) return;
    turn.prompt = undefined;
    this.send(turn, false, message);
  }

  /** The live turn of the conversation `session` serves, announced
   * (session_resolved, and a new session's rebuilt session/new) once. */
  private current(session: string) {
    const key = this.keyOf(session);
    const turn = key === undefined ? undefined : this.telemetry.turnOf(key);
    if (!turn) return undefined;
    let sessions = this.announced.get(turn);
    if (!sessions) this.announced.set(turn, (sessions = new Set()));
    if (sessions.has(session)) return turn;
    sessions.add(session);
    turn.sessionId = session;
    const opened = this.opened.get(session);
    this.opened.delete(session);
    this.telemetry.sessionResolved(turn, session, opened !== undefined);
    if (opened)
      this.send(turn, true, {
        jsonrpc: JSONRPC,
        id: this.telemetry.nextId(),
        method: "session/new",
        params: {
          cwd: opened.cwd,
          mcpServers: [],
          ...(opened.system ? { _meta: { systemPrompt: { append: opened.system } } } : {}),
        },
      });
    return turn;
  }

  /** Notes every header value of the session's MCP servers as a secret. */
  private secrets(params: Json) {
    const servers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    for (const server of servers) {
      const headers = object(server)?.headers;
      for (const header of Array.isArray(headers) ? headers : []) {
        const value = str(object(header)?.value);
        if (!value) continue;
        this.tokens.add(value);
        // The Bearer value alone, should a frame quote it without the scheme.
        const bare = value.split(" ").at(-1);
        if (bare) this.tokens.add(bare);
      }
    }
    while (this.tokens.size > ACP_TAP_REMEMBERED) this.tokens.delete(this.tokens.values().next().value as string);
  }

  /** Records one message, with every known token replaced. */
  private send(turn: Turn, write: boolean, message: Json) {
    let json = JSON.stringify(message);
    let changed = false;
    for (const token of this.tokens)
      if (json.includes(token)) {
        json = json.split(token).join(ACP_TAP_REDACTED);
        changed = true;
      }
    this.telemetry.acp(turn, write, changed ? (JSON.parse(json) as Json) : message);
  }
}

/** Adds to a bounded map, forgetting the oldest entry past the bound. */
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value);
  if (map.size > ACP_TAP_REMEMBERED) map.delete(map.keys().next().value as string);
}

/** Step tool call ids, unique within one feed. */
const FEED_STEP_PREFIX = "step-";
/** The harness a feed's steps name when none is given: Pi was its first. */
const FEED_DEFAULT_HARNESS = "pi";
/** ACP kinds of the steps a Pi host names (host.mjs `watch`, and Pi's own
 * coding tools) and of buzz-app's `codexStep` names; any other step is
 * `other`. */
const FEED_STEP_KINDS: Readonly<Record<string, string>> = Object.freeze({
  Thinking: "think",
  Read: "read",
  Edit: "edit",
  Shell: "execute",
  Grep: "search",
  ListFiles: "search",
  WebSearch: "fetch",
  read: "read",
  edit: "edit",
  write: "edit",
  bash: "execute",
  grep: "search",
  find: "search",
  ls: "search",
});

function parse(line: string): Json | undefined {
  if (!line.trim()) return undefined;
  try {
    return object(JSON.parse(line));
  } catch {
    return undefined;
  }
}

/** A user message's text: a string, or its text blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((value) => str(object(value)?.text) ?? []).join("\n");
}

/** A tool result as ACP tool content (claude-agent-acp `toAcpContentUpdate`).
 * Only text travels: an image result would mostly be elided anyway. */
function resultContent(content: unknown) {
  const text = (value: string) => ({ type: "content", content: { type: "text", text: value } });
  if (typeof content === "string") return content ? [text(content)] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((value) => {
    const block = object(value);
    if (!block) return [];
    if (block.type === "text") return str(block.text) ? [text(block.text as string)] : [];
    return [text(`[${str(block.type) ?? "content"}]`)];
  });
}

type Facts = {
  title: string;
  kind: string;
  locations?: { path: string; line?: number }[];
  content?: Json[];
};

/** claude-agent-acp's display path: relative inside the working directory. */
function displayPath(path: string, cwd: string | undefined) {
  if (!cwd) return path;
  const root = resolve(cwd);
  const file = resolve(path);
  return file === root || file.startsWith(root + sep) ? relative(root, file) : path;
}

/** Title, kind, locations and content of a tool call, as claude-agent-acp's
 * reporters (`dist/tool-calls/reporters`) give them. */
function toolFacts(name: string, raw: unknown, cwd: string | undefined): Facts {
  const input = object(raw) ?? {};
  const path = str(input.file_path);
  switch (name) {
    case "Read": {
      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;
      const range =
        limit && limit > 0
          ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
          : offset
            ? ` (from line ${offset})`
            : "";
      return {
        title: `Read ${path ? displayPath(path, cwd) : "File"}${range}`,
        kind: "read",
        locations: path ? [{ path, line: offset ?? 1 }] : [],
      };
    }
    case "Write":
      return {
        title: path ? `Write ${displayPath(path, cwd)}` : "Preparing file…",
        kind: "edit",
        locations: path ? [{ path }] : [],
        ...(path ? { content: [{ type: "diff", path, oldText: null, newText: str(input.content) ?? "" }] } : {}),
      };
    case "Edit": {
      const oldText = str(input.old_string);
      const newText = str(input.new_string);
      return {
        title: path ? `Edit ${displayPath(path, cwd)}` : "Edit",
        kind: "edit",
        locations: path ? [{ path }] : [],
        ...(path && (oldText || newText) ? { content: [{ type: "diff", path, oldText: oldText || null, newText: newText ?? "" }] } : {}),
      };
    }
    case "Bash":
    case "PowerShell": {
      const description = str(input.description) ?? str(input.command_description);
      return {
        title: str(input.command) || "Terminal",
        kind: "execute",
        ...(description ? { content: [{ type: "content", content: { type: "text", text: description } }] } : {}),
      };
    }
    case "Glob": {
      const where = str(input.path);
      const pattern = str(input.pattern);
      return {
        title: ["Find", ...(where ? [`\`${where}\``] : []), ...(pattern ? [`\`${pattern}\``] : [])].join(" "),
        kind: "search",
        locations: where ? [{ path: where }] : [],
      };
    }
    case "Grep": {
      const pattern = str(input.pattern);
      const where = str(input.path);
      return { title: ["grep", ...(pattern ? [`"${pattern}"`] : []), ...(where ? [where] : [])].join(" "), kind: "search" };
    }
    case "WebFetch": {
      const url = str(input.url);
      return { title: url ? `Fetch ${url}` : "Fetch", kind: "fetch" };
    }
    case "WebSearch": {
      const query = str(input.query);
      return { title: query ? `Search "${query}"` : "Web search", kind: "fetch" };
    }
    case "Agent":
    case "Task":
      return { title: str(input.description) || "Task", kind: "think" };
    case "Skill": {
      const skill = str(input.skill);
      return { title: skill ? `Load skill: ${skill}` : "Load skill", kind: "other" };
    }
    default:
      return { title: name || "Unknown Tool", kind: "other" };
  }
}

// ---- Publish queue: buzz-acp `ObserverPublishQueue` and its coalescer ----

type Queued = { bytes: number; sources: number; frame: ObserverFrame };
type Pending = { key: string; frame: ObserverFrame; text: string; bytes: number; sources: number };

class FrameQueue {
  private frames: Queued[] = [];
  private frameBytes = 0;
  private chunks: Pending[] = [];
  private chunkBytes = 0;

  constructor(private readonly onDrop: (dropped: number, pendingBytes: number) => void) {}

  ingest(frame: ObserverFrame) {
    const chunk = chunkKey(frame);
    if (!chunk) {
      this.flushChunks();
      this.enqueue(1, frame);
    } else {
      const pending = this.chunks.find((item) => item.key === chunk.key);
      if (pending && bytes(pending.text) + bytes(chunk.text) >= OBSERVER_CHUNK_MAX_TEXT_BYTES) {
        this.flushChunks();
        this.push(chunk.key, frame, chunk.text);
      } else if (pending) {
        pending.text += chunk.text;
        pending.bytes += bytes(chunk.text);
        pending.sources++;
        this.chunkBytes += bytes(chunk.text);
        pending.frame.seq = frame.seq;
        pending.frame.timestamp = frame.timestamp;
      } else this.push(chunk.key, frame, chunk.text);
    }
    this.enforceBudget();
  }

  /** The next frame to send: every queued frame of the first frame's channel
   * that fits one envelope. A frame without a channel is a barrier. */
  next(): ObserverFrame | undefined {
    this.flushChunks();
    const first = this.frames[0];
    if (!first) return undefined;
    const channel = first.frame.channelId;
    const picked: ObserverFrame[] = [];
    const kept: Queued[] = [];
    let gathering = true;
    for (const item of this.frames) {
      if (gathering && item.frame.channelId === channel) {
        picked.push(item.frame);
        if (picked.length > 1 && serialized(envelope(picked)) > OBSERVER_PLAINTEXT_MAX_BYTES) {
          picked.pop();
          kept.push(item);
          gathering = false;
        } else this.frameBytes -= item.bytes;
      } else {
        if (gathering && (channel === null || item.frame.channelId === null)) gathering = false;
        kept.push(item);
      }
    }
    this.frames = kept;
    return picked.length === 1 ? picked[0] : envelope(picked);
  }

  private push(key: string, frame: ObserverFrame, text: string) {
    const size = serialized(frame) + bytes(text);
    this.chunkBytes += size;
    this.chunks.push({ key, frame, text, bytes: size, sources: 1 });
  }

  private flushChunks() {
    const chunks = this.chunks;
    this.chunks = [];
    this.chunkBytes = 0;
    for (const pending of chunks) {
      const content = object(object(object(object(pending.frame.payload)?.params)?.update)?.content);
      if (content) content.text = pending.text;
      this.enqueue(pending.sources, pending.frame);
    }
  }

  private enqueue(sources: number, frame: ObserverFrame) {
    fit(frame);
    const size = serialized(frame);
    this.frameBytes += size;
    this.frames.push({ bytes: size, sources, frame });
  }

  private enforceBudget() {
    let dropped = 0;
    while (this.frameBytes + this.chunkBytes > OBSERVER_QUEUE_MAX_BYTES && this.frames.length + this.chunks.length > 1) {
      const oldest = this.frames.shift();
      if (oldest) {
        this.frameBytes -= oldest.bytes;
        dropped += oldest.sources;
        continue;
      }
      const chunk = this.chunks.shift();
      if (!chunk) break;
      this.chunkBytes -= chunk.bytes;
      dropped += chunk.sources;
    }
    if (dropped) this.onDrop(dropped, this.frameBytes + this.chunkBytes);
  }
}

function chunkKey(frame: ObserverFrame): { key: string; text: string } | undefined {
  const update = object(object(object(frame.payload)?.params)?.update);
  const type = str(update?.sessionUpdate);
  const text = str(object(update?.content)?.text);
  if (!type || !CHUNK_UPDATES.has(type) || text === undefined) return undefined;
  return {
    key: JSON.stringify([type, str(update?.messageId) ?? null, frame.channelId, frame.sessionId, frame.turnId, frame.agentIndex]),
    text,
  };
}

/** buzz-acp `batch_envelope`: metadata of the last inner frame. */
function envelope(frames: ObserverFrame[]): ObserverFrame {
  const last = frames[frames.length - 1]!;
  return {
    seq: last.seq,
    timestamp: last.timestamp,
    kind: BATCH_KIND,
    agentIndex: last.agentIndex,
    channelId: last.channelId,
    sessionId: last.sessionId,
    turnId: last.turnId,
    ...(last.startedAt ? { startedAt: last.startedAt } : {}),
    payload: { events: frames },
  };
}

const serialized = (value: unknown) => bytes(JSON.stringify(value));

// ---- Elision: buzz-acp `fit_observer_event_to_budget` ----

/** Shrinks the largest string leaves until the frame fits the NIP-44 cap;
 * if none can shrink further, the payload becomes a stub. */
function fit(frame: ObserverFrame) {
  if (serialized(frame) <= OBSERVER_PLAINTEXT_MAX_BYTES) return;
  const original = serialized(frame.payload);
  for (;;) {
    const leaf = largestLeaf(frame);
    if (!leaf) break;
    leaf.holder[leaf.key] = elided(leaf.holder[leaf.key] as string);
    if (serialized(frame) <= OBSERVER_PLAINTEXT_MAX_BYTES) return;
  }
  frame.payload = { elided: `${frame.kind} payload too large`, originalBytes: original };
}

type Leaf = { holder: Record<string | number, unknown>; key: string | number; size: number };

/** The longest string in the payload that would strictly shrink. */
function largestLeaf(frame: ObserverFrame): Leaf | undefined {
  let best: Leaf | undefined;
  const visit = (holder: Record<string | number, unknown>, key: string | number) => {
    const value = holder[key];
    if (typeof value === "string") {
      const size = bytes(value);
      if ((!best || size > best.size) && shrinks(value)) best = { holder, key, size };
    } else if (Array.isArray(value)) value.forEach((_, index) => visit(value as unknown as Record<number, unknown>, index));
    else if (value && typeof value === "object")
      for (const child of Object.keys(value)) visit(value as Record<string, unknown>, child);
  };
  visit(frame as unknown as Record<string, unknown>, "payload");
  return best;
}

const CONTINUATION_MASK = 0xc0;
const CONTINUATION = 0x80;
const isContinuation = (data: Buffer, at: number) => at < data.length && (data[at]! & CONTINUATION_MASK) === CONTINUATION;
const marker = (removed: number) => `…[elided ${removed} bytes]…`;

/** Head end and tail start in bytes, on UTF-8 character boundaries. */
function bounds(data: Buffer) {
  let head = Math.min(OBSERVER_LEAF_RETAIN_BYTES, data.length);
  while (head > 0 && isContinuation(data, head)) head--;
  let tail = Math.max(0, data.length - OBSERVER_LEAF_RETAIN_BYTES);
  while (tail < data.length && isContinuation(data, tail)) tail++;
  return { head, tail: Math.max(tail, head) };
}

function shrinks(value: string) {
  const data = Buffer.from(value, "utf8");
  const { head, tail } = bounds(data);
  return tail > head && head + bytes(marker(tail - head)) + (data.length - tail) < data.length;
}

function elided(value: string) {
  const data = Buffer.from(value, "utf8");
  const { head, tail } = bounds(data);
  return `${data.subarray(0, head).toString("utf8")}${marker(tail - head)}${data.subarray(tail).toString("utf8")}`;
}
