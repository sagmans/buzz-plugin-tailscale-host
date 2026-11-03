// Codex's engine: one `codex app-server` per hosted agent, started as the
// harness user by `harness-wrapper codex <agent>`, with one Codex thread per
// conversation. buzz-app's Codex pieces are imported unchanged: its JSONL
// client (`AppServer`, `listModels`), its settings rules (`config`,
// `resolveModel`), its prompts (`developerInstructions`, `turnContext`) and
// its step names (`codexStep`). The Buzz tools stay here: Codex calls them
// as dynamic tools in the `buzz` namespace, and each call is answered by the
// runtime's in-process tool server with the runtime's own context for the
// conversation, so Codex never holds the agent key.
//
// Desktop's `CodexRuntime` (buzz-app src/bundled/codex/runtime.ts; Apache-2.0,
// Copyright 2026 Block, Inc.; see NOTICE) cannot be imported (it
// needs Desktop's agent handle, reads and store); this engine follows its
// turn rules: a thread is resumed (or started) with the agent's developer
// instructions per turn, the turn carries the current custom instructions
// and core memory as application context, a message during a turn steers
// it, a final Buzz send ends the work at once, a stopped turn's shells are
// ended, and the thread is let go after each turn. It differs where the
// runner differs from Desktop:
//
// - One `app-server` per agent, not one for every agent: the wrapper starts
//   it in the agent's own workspace, under the agent's own Codex home.
// - The prompt is the runner's (the same as Claude's, Pi's and Goose's), not
//   Desktop's Codex wording; thread bindings live in the agent's state file.
// - No chat titling, compaction or transcript tabs: the runner has no UI.
// - The process is stopped after CODEX_IDLE_MS without a turn, and counts as
//   one live session under the host-wide cap, evictable when idle.
import { createHash } from "node:crypto";
import { isFinalMessage } from "@buzz/buzz-mcp/session-tools";
import type { Settled, Spawn } from "@buzz/bundled/claude-code/claude";
import { steerPrompt } from "@buzz/bundled/claude-code/prompt";
import type { SessionStore } from "@buzz/bundled/claude-code/sessions";
import { config as codexConfig, resolveModel } from "@buzz/bundled/codex/config";
import { developerInstructions, turnContext } from "@buzz/bundled/codex/prompt";
import { AppServer, listModels, Refused, type ToolCall, type ToolReply, type Wire } from "@buzz/bundled/codex/rpc";
import { codexStep } from "@buzz/bundled/codex/runtime";
import type { ToolResult } from "@buzz/bundled/pi/pi";
import {
  CODEX_HOST_KEY,
  CODEX_IDLE_MS,
  CODEX_LINGER_POLL_MS,
  CODEX_MISSING_ROLLOUT,
  CODEX_NO_ACTIVE_TURN,
  CODEX_STOP_LINGER_MS,
  CODEX_TERMINALS_PAGE,
  CODEX_TOOL_NAMESPACE,
  CODEX_TOOLS_KEY_CHARS,
} from "./constants";
import type { Engine, EngineTurn } from "./engine";
import { errorMessage, ProcessError } from "./errors";
import type { Logger } from "./log";
import type { FeedOutcome, HarnessFeed } from "./telemetry";

/** What a turn of the agent runs with, read as it starts. */
export type CodexSetup = Readonly<{
  /** The agent's absolute workspace. */
  cwd: string;
  name: string;
  instructions: string;
  scope: string;
  model?: string | undefined;
  effort?: string | undefined;
}>;

/** One Buzz tool as a Codex dynamic tool lists it. */
export type CodexTool = Readonly<{ name: string; description: string; inputSchema: Readonly<Record<string, unknown>> }>;

export type CodexEngineDeps = Readonly<{
  agent: string;
  /** Starts `harness-wrapper codex <agent>`. */
  spawn: Spawn;
  /** Where each conversation's thread is saved, so it resumes in a later
   * process (the agent's state file). */
  store: SessionStore;
  tools: readonly CodexTool[];
  /** The tool namespace's description. */
  hint: string;
  settings(): CodexSetup;
  /** The agent's `core` memory: `null` when it has none, undefined when it
   * could not be read. */
  coreMemory(): Promise<string | null | undefined>;
  /** Runs one Buzz tool for the conversation `key`, MCP-shaped. */
  tool(key: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  inflight: ReadonlyMap<string, unknown>;
  /** The process started or stopped: a turn waiting on the cap checks again. */
  onChange(): void;
  feed?: HarnessFeed | undefined;
  log: Logger;
}>;

/** One `app-server` and the threads it holds. */
type Server = {
  rpc: AppServer;
  opening: Promise<AppServer>;
};

/** A turn Codex runs (Desktop codex `Active`). */
type Active = {
  rpc: AppServer;
  key: string;
  threadId?: string;
  turnId?: string;
  /** Settles once the turn started, or failed to. */
  ready: Promise<void>;
  /** Codex ended the turn. */
  finished: boolean;
  /** The owner stopped it, so its interruption is not reported. */
  stopped: boolean;
  /** The one interrupt every stop of this turn shares. */
  stopping?: Promise<void> | undefined;
  /** How the work settled, for every delivery it took in: at a final Buzz
   * send, or when Codex ends the turn, whichever is first. */
  settled: Promise<Settled>;
  settle(result: Settled): void;
};

type Lane = {
  tail: Promise<void>;
  /** Turns waiting on `tail`: steering past them would reorder. */
  queued: number;
  active?: Active | undefined;
};

/** A started or completed item, as the app-server reports it. */
type Item = Record<string, unknown> & { type?: string; text?: string };

const FAILED_INTERRUPTED = "Codex’s turn was interrupted";
const ENDED_UNANSWERED = "Codex ended without a final reply";
const TURN_ENDED = "The Codex turn has ended";
const input = (text: string) => [{ type: "text", text, text_elements: [] }];

export class CodexEngine implements Engine {
  private server: Server | undefined;
  private readonly lanes = new Map<string, Lane>();
  /** Deliveries in progress, by conversation key. */
  private readonly working = new Map<string, number>();
  /** Processes running or starting; any of them holds the live-session slot. */
  private running = 0;
  private lastUsed = Date.now();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  /** Saved threads are filed under the tools they started with. */
  private readonly toolsKey: string;
  private readonly dynamicTools: readonly unknown[];

  constructor(private readonly deps: CodexEngineDeps) {
    this.toolsKey = createHash("sha256")
      .update(JSON.stringify(deps.tools))
      .digest("hex")
      .slice(0, CODEX_TOOLS_KEY_CHARS);
    // Desktop's `dynamicTools`: every Buzz tool loads up front, as the
    // runner lists them for every harness.
    this.dynamicTools = Object.freeze([
      {
        type: "namespace",
        name: CODEX_TOOL_NAMESPACE,
        description: deps.hint,
        tools: deps.tools.map((tool) => ({ type: "function", ...tool })),
      },
    ]);
  }

  async deliver(turn: EngineTurn): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "The agent was stopped", undelivered: true };
    this.enter(turn.key);
    try {
      const lane = this.lane(turn.key);
      const active = lane.active;
      if (active && !active.finished && !active.stopped && !lane.queued) {
        const steered = await this.steer(active, turn);
        if (steered) return steered;
      }
      return await this.queue(lane, turn);
    } catch (error) {
      const message = errorMessage(error);
      this.deps.log.warn("codex turn failed", { conversation: turn.key, error: message });
      return { ok: false, error: message, undelivered: true };
    } finally {
      this.leave(turn.key);
    }
  }

  /** What the conversation's thread was shown; 0 when it has none. */
  async seen(key: string, contextRoot: string | undefined) {
    const saved = this.deps.store.get(this.saveKey(key));
    if (!saved) return 0;
    return contextRoot ? (saved.threads?.[contextRoot] ?? 0) : saved.seen;
  }

  /** Stops the conversation's turn once it started (Desktop codex
   * `interrupt`); a failed stop can be tried again. */
  async interrupt(key: string) {
    const active = this.lanes.get(key)?.active;
    if (!active || active.finished) return;
    active.stopped = true;
    active.stopping ??= (async () => {
      try {
        await active.ready;
        if (active.finished || !active.threadId || !active.turnId) return;
        await active.rpc.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
      } catch (error) {
        active.stopping = undefined;
        if (!active.finished) active.stopped = false;
        throw error;
      }
    })();
    await active.stopping;
  }

  active(key: string) {
    return this.working.has(key) || Boolean(this.lanes.get(key)?.active);
  }

  busy() {
    return [...new Set([...this.working.keys(), ...[...this.lanes].filter(([, lane]) => lane.active).map(([key]) => key)])];
  }

  slot() {
    return CODEX_HOST_KEY;
  }

  live() {
    if (!this.alive) return [];
    return [{ key: CODEX_HOST_KEY, at: this.lastUsed, evictable: this.quiet() }];
  }

  holds(slot: string) {
    return slot === CODEX_HOST_KEY && this.alive;
  }

  /** Stops the process while no turn uses it; its threads resume in the next. */
  evict(slot: string) {
    if (slot !== CODEX_HOST_KEY || !this.quiet()) return false;
    this.stopServer("live-session cap");
    return true;
  }

  /** The process holds every conversation of the agent, so stopping one
   * turn by force stops them all; the others fail and are reported. */
  async forceStop(_key: string) {
    this.stopServer("forced stop");
  }

  /** Every turn reads the settings as it starts: nothing to restart. */
  reconfigure() {}

  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    this.stopServer("agent stop");
  }

  private get alive() {
    return this.running > 0;
  }

  private quiet() {
    return !this.working.size && !this.deps.inflight.size && ![...this.lanes.values()].some((lane) => lane.active);
  }

  private lane(key: string) {
    let lane = this.lanes.get(key);
    if (!lane) {
      lane = { tail: Promise.resolve(), queued: 0 };
      this.lanes.set(key, lane);
    }
    return lane;
  }

  /** The thread a conversation's binding is saved under. */
  private saveKey(key: string) {
    return `${this.toolsKey}:${key}`;
  }

  /** Steers a message into the running turn (Desktop codex `run`). Undefined
   * when it must run as the next turn instead: the turn ended meanwhile. */
  private async steer(active: Active, turn: EngineTurn): Promise<Settled | undefined> {
    await active.ready.catch(() => undefined);
    if (active.finished || active.stopped || !active.threadId || !active.turnId) return undefined;
    const text = await turn.prompt(false);
    if (active.finished || active.stopped) return undefined;
    try {
      await active.rpc.request("turn/steer", {
        threadId: active.threadId,
        expectedTurnId: active.turnId,
        input: input(steerPrompt(text)),
      });
    } catch (error) {
      // A completion racing the message means this is the next turn.
      if (errorMessage(error) === CODEX_NO_ACTIVE_TURN) return undefined;
      const reason = `Steering was not accepted: ${errorMessage(error)}`;
      this.deps.log.warn("codex steer refused", { conversation: turn.key, refused: error instanceof Refused, error: reason });
      return { ok: false, error: reason, undelivered: true };
    }
    this.remember(turn, active.threadId);
    this.deps.feed?.prompt(turn.key, active.threadId, false, text);
    return active.settled;
  }

  /** Runs the message as a turn of its own, after the conversation's
   * earlier turns. */
  private queue(lane: Lane, turn: EngineTurn): Promise<Settled> {
    lane.queued++;
    return new Promise<Settled>((resolve) => {
      // The lane waits for Codex to end the turn, not only for its answer.
      lane.tail = lane.tail.then(() => {
        lane.queued--;
        try {
          const { settled, ended } = this.execute(lane, turn);
          resolve(settled);
          return ended;
        } catch (error) {
          // The delivery is answered and the lane stays usable.
          resolve({ ok: false, error: errorMessage(error), undelivered: true });
          return undefined;
        }
      });
    });
  }

  /** Forgets an empty lane once its last turn is over. */
  private drained(lane: Lane, key: string) {
    if (!lane.active && !lane.queued && this.lanes.get(key) === lane) this.lanes.delete(key);
  }

  /** One turn (Desktop codex `execute`): resume or start the thread, start
   * the turn, and follow it to its end. Resolves as the work settles, which
   * a final Buzz send does before Codex ends its turn. */
  private execute(lane: Lane, turn: EngineTurn): { settled: Promise<Settled>; ended: Promise<void> } {
    // A turn queued before a stop must not start the process again.
    if (this.disposed) throw new ProcessError("The agent was stopped");
    const server = this.open();
    let ready!: () => void;
    let settle!: (result: Settled) => void;
    let done = false;
    const active: Active = {
      rpc: server.rpc,
      key: turn.key,
      ready: new Promise<void>((resolve) => (ready = resolve)),
      finished: false,
      stopped: false,
      settled: new Promise<Settled>((resolve) => (settle = resolve)),
      settle: (result) => {
        if (done) return;
        done = true;
        settle(result);
      },
    };
    lane.active = active;
    // `run` handles its own failures; this only clears the lane after it.
    const ended = this.run(server, active, turn, ready).finally(() => {
      ready();
      if (lane.active === active) lane.active = undefined;
      this.drained(lane, turn.key);
      this.deps.onChange();
    });
    return { settled: active.settled, ended };
  }

  private async run(server: Server, active: Active, turn: EngineTurn, ready: () => void) {
    const { key } = turn;
    const started = Date.now();
    const followed = follow(server.rpc, active, (method, item) => this.item(key, active, method, item));
    let reported = false;
    // The feed hears the outcome before the delivery settles: a settled
    // delivery ends its telemetry turn, which would answer the prompt itself.
    const report = (outcome: FeedOutcome) => {
      if (reported || !active.threadId) return;
      reported = true;
      this.deps.feed?.settled(key, active.threadId, outcome);
    };
    try {
      const rpc = await server.opening;
      const setup = this.deps.settings();
      const { params, model, effort, summary } = await prepare(rpc, setup, this.deps.agent);
      const saveKey = this.saveKey(key);
      const saved = this.deps.store.get(saveKey);
      type Started = { thread: { id: string } };
      const start = () => rpc.request<Started>("thread/start", { ...params, dynamicTools: this.dynamicTools });
      let thread: Started;
      let fresh = false;
      if (saved) {
        thread = await rpc.request<Started>("thread/resume", { ...params, threadId: saved.id, excludeTurns: true }).catch(
          async (error) => {
            if (errorMessage(error) !== `${CODEX_MISSING_ROLLOUT}${saved.id}`) throw error;
            // Its rollout is gone: a new thread is shown the conversation again.
            await this.deps.store.delete(saveKey);
            fresh = true;
            return start();
          },
        );
      } else thread = await start();
      const threadId = thread.thread.id;
      active.threadId = threadId;
      if (turn.title) await rpc.request("thread/name/set", { threadId, name: turn.title });
      const [text, memory] = await Promise.all([turn.prompt(fresh), this.deps.coreMemory()]);
      const settings = codexConfig({ ...setup, workspace: setup.cwd });
      const begun = await rpc.request<{ turn: { id: string } }>("turn/start", {
        threadId,
        input: input(text),
        model,
        effort,
        ...summary,
        // Application context is a developer message that updates on each
        // turn: a resumed thread keeps its first developer instructions.
        // turnContext reads only the agent's name and pubkey.
        additionalContext: turnContext(
          { name: setup.name, pubkey: this.deps.agent } as Parameters<typeof turnContext>[0],
          settings,
          "",
          memory,
        ),
      });
      active.turnId = begun.turn.id;
      this.remember(turn, threadId);
      this.deps.feed?.prompt(key, threadId, !saved || fresh, text);
      ready();
      const status = await followed.completed;
      if (status === "interrupted" && active.stopped) {
        report({ stop: "cancelled" });
        active.settle({ ok: true, stopped: true });
        await this.terminals(rpc, threadId, CODEX_STOP_LINGER_MS);
      } else if (status === "interrupted") {
        report({ error: FAILED_INTERRUPTED });
        active.settle({ ok: false, error: FAILED_INTERRUPTED });
        await this.terminals(rpc, threadId, 0);
      } else {
        // A turn may end without a reply when there is nothing new to say.
        report({ stop: "end_turn" });
        active.settle({ ok: true });
      }
    } catch (error) {
      const message = errorMessage(error);
      report({ error: message });
      this.deps.log.warn("codex turn failed", {
        conversation: key,
        delivered: Boolean(active.turnId),
        elapsedMs: Date.now() - started,
        error: message,
      });
      active.settle({ ok: false, error: message, ...(active.turnId ? {} : { undelivered: true as const }) });
    } finally {
      active.finished = true;
      active.settle({ ok: false, error: ENDED_UNANSWERED });
      followed.stop();
      if (active.threadId) {
        // Let go of the thread before its next resume: a loaded thread
        // ignores instruction and config overrides while subscribed.
        await active.rpc
          .request("thread/unsubscribe", { threadId: active.threadId })
          .catch(() => active.rpc.close());
      }
    }
    // #lizard forgives: lizard reads this class as the body of the one-line
    // `input` arrow above it; each method is within the limits
  }

  /** Records what the conversation's thread was shown. */
  private remember(turn: EngineTurn, threadId: string) {
    const saveKey = this.saveKey(turn.key);
    const prior = this.deps.store.get(saveKey);
    const same = prior?.id === threadId ? prior : undefined;
    this.deps.store.set(saveKey, {
      id: threadId,
      seen: Math.max(same?.seen ?? 0, turn.at),
      ...(turn.contextRoot || same?.threads
        ? {
            threads: {
              ...same?.threads,
              ...(turn.contextRoot ? { [turn.contextRoot]: Math.max(same?.threads?.[turn.contextRoot] ?? 0, turn.at) } : {}),
            },
          }
        : {}),
      at: Date.now(),
    });
  }

  /** A Codex item: a started one is a step, a completed reply is the turn's
   * text for telemetry. */
  private item(key: string, active: Active, method: string, item: Item) {
    const feed = this.deps.feed;
    if (!feed || !active.threadId) return;
    if (method === "item/started") {
      const step = codexStep(item);
      if (step) feed.step(key, active.threadId, step.tool, step.target);
    } else if (method === "item/completed" && item.type === "agentMessage" && typeof item.text === "string")
      feed.answer(key, active.threadId, item.text);
  }

  /** A Buzz tool call from Codex. Only the conversation's running turn may
   * call, and the tool context is the runtime's own for it, not what Codex
   * says: Codex runs as the harness user and is not trusted with where the
   * agent posts. */
  private async tool(call: ToolCall): Promise<ToolReply> {
    const active = [...this.lanes.values()]
      .map((lane) => lane.active)
      .find((turn) => turn && turn.threadId === call?.threadId && turn.turnId === call?.turnId);
    if (!active || call.namespace !== CODEX_TOOL_NAMESPACE || !this.deps.tools.some((tool) => tool.name === call.tool))
      throw new ProcessError("No active Buzz tool for this thread and turn");
    if (active.finished) throw new ProcessError(TURN_ENDED);
    if (!call.arguments || typeof call.arguments !== "object" || Array.isArray(call.arguments))
      throw new ProcessError("Buzz tool arguments must be an object");
    const args = call.arguments as Record<string, unknown>;
    const result = await this.deps.tool(active.key, call.tool, args);
    if (!result.isError && isFinalMessage(call.tool, args)) active.settle({ ok: true });
    return { success: !result.isError, contentItems: contentItems(result.content) };
  }

  /** Ends the thread's shells (Desktop codex `terminals`). `linger` keeps
   * looking that long: a command a stopped turn waited on becomes a
   * background terminal only just after the turn ends. */
  private async terminals(rpc: AppServer, threadId: string, linger: number) {
    try {
      await rpc.request("thread/backgroundTerminals/clean", { threadId });
      const until = Date.now() + linger;
      for (let cursor: string | null = null; ; ) {
        const page: { data: { processId: string }[]; nextCursor: string | null } = await rpc.request(
          "thread/backgroundTerminals/list",
          { threadId, limit: CODEX_TERMINALS_PAGE, cursor },
        );
        await Promise.all(
          page.data.map((terminal) =>
            rpc.request("thread/backgroundTerminals/terminate", { threadId, processId: terminal.processId }),
          ),
        );
        cursor = page.nextCursor;
        if (cursor) continue;
        if (Date.now() >= until) break;
        await new Promise((resolve) => setTimeout(resolve, CODEX_LINGER_POLL_MS));
      }
      const remaining = await rpc.request<{ data: unknown[] }>("thread/backgroundTerminals/list", { threadId, limit: 1 });
      if (remaining.data.length) throw new ProcessError("Codex background terminals could not be stopped");
    } catch (error) {
      // Shells that could not be ended must not outlive an idle process.
      this.deps.log.warn("codex terminal cleanup failed; stopping the process", { error: errorMessage(error) });
      await rpc.close();
    }
  }

  /** The agent's `app-server`, started on first use. One that exits fails
   * its turns, and the next message starts another. */
  private open(): Server {
    if (this.server) return this.server;
    const rpc = new AppServer((call) => this.tool(call));
    const spawn: Spawn = async (id, options) => {
      this.running++;
      this.deps.onChange();
      try {
        const child = await this.deps.spawn(id, options);
        void child.exited.then(() => this.exited());
        return child;
      } catch (error) {
        this.exited();
        throw error;
      }
    };
    // The wrapper starts it in the agent's workspace; threads name their cwd.
    const server: Server = { rpc, opening: rpc.open(spawn, this.deps.settings().cwd) };
    rpc.onMessage((wire: Wire) => {
      if (wire.method === "connection/closed" && this.server === server) this.server = undefined;
    });
    void server.opening.catch((error) => {
      this.deps.log.warn("codex did not start", { error: errorMessage(error) });
      if (this.server === server) this.server = undefined;
      void rpc.close();
    });
    this.server = server;
    return server;
  }

  private enter(key: string) {
    clearTimeout(this.idle);
    this.idle = undefined;
    this.working.set(key, (this.working.get(key) ?? 0) + 1);
  }

  private leave(key: string) {
    const left = (this.working.get(key) ?? 1) - 1;
    if (left > 0) this.working.set(key, left);
    else this.working.delete(key);
    this.lastUsed = Date.now();
    if (!this.working.size && !this.disposed) {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => {
        if (this.quiet()) this.stopServer("idle");
      }, CODEX_IDLE_MS);
      this.idle.unref();
    }
    this.deps.onChange();
  }

  private exited() {
    this.running = Math.max(0, this.running - 1);
    this.deps.onChange();
  }

  /** Stops `app-server` (stdin EOF first, so Codex ends its background
   * terminals); its turns fail, and its threads resume in the next. */
  private stopServer(why: string) {
    const server = this.server;
    this.server = undefined;
    if (this.alive) this.deps.log.info("codex stopping", { why });
    if (server) void server.rpc.close().catch((error) => this.deps.log.warn("codex stop failed", { error: errorMessage(error) }));
  }
}

/** What a thread for the agent resumes or starts with, and the model and
 * effort its turn runs on (Desktop codex `prepare`, without Desktop's native
 * hooks, which the runner has none of). */
async function prepare(rpc: AppServer, setup: CodexSetup, agent: string) {
  const normalized = await rpc.request<{
    config: { mcp_servers?: Record<string, Record<string, unknown>>; model_reasoning_summary?: string | null };
  }>("config/read", { cwd: setup.cwd });
  const models = await listModels(rpc);
  const own = resolveModel(setup.model ?? "", models);
  const selected = models.find((row) => row.model === own);
  if (!selected) throw new ProcessError("The selected Codex model is unavailable. Choose an available model.");
  const supported = selected.supportedReasoningEfforts.map((level) => level.reasoningEffort);
  // A model may not support the configured effort.
  const effort = setup.effort && supported.includes(setup.effort) ? setup.effort : selected.defaultReasoningEffort;
  // Inherited MCP servers are off: the Buzz tools are the dynamic ones. CLI
  // overrides replace the table, and a disabled server still needs a transport.
  const mcp = Object.fromEntries(
    Object.entries(normalized.config.mcp_servers ?? {}).map(([name, server]) => [
      name,
      { ...(typeof server.command === "string" ? { command: server.command } : { url: server.url }), enabled: false },
    ]),
  );
  const params = {
    model: selected.model,
    cwd: setup.cwd,
    developerInstructions: developerInstructions({ name: setup.name, pubkey: agent }),
    approvalPolicy: "never",
    // Matches Claude's bypassPermissions; only admitted messages start work.
    sandbox: "danger-full-access",
    config: { web_search: "disabled", mcp_servers: mcp, "features.plugins": false, "features.apps": false },
  };
  // Reasoning summaries, unless the shared config chose a summary mode.
  const summary = normalized.config.model_reasoning_summary ? {} : { summary: "auto" };
  return { params, model: selected.model, effort, summary };
}

/** Follows `active`'s thread on `rpc` (Desktop codex `follow`): notes its
 * turn id, passes its items on, and settles `completed` with the turn's
 * status. Rejects when the turn fails or the connection closes. */
function follow(rpc: AppServer, active: Active, onItem: (method: string, item: Item) => void) {
  let finish!: (status: string) => void;
  let fail!: (error: Error) => void;
  const completed = new Promise<string>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => undefined);
  const off = rpc.onMessage((wire) => {
    // #lizard forgives: one branch per app-server notification, as Desktop's Codex runtime
    const p = wire.params as
      | { threadId?: string; message?: string; turn?: { id: string; status: string; error?: { message: string } }; item?: Item }
      | undefined;
    if (wire.method === "connection/closed") {
      fail(new ProcessError(p?.message ?? "Codex connection closed"));
      return;
    }
    if (!p || !active.threadId || p.threadId !== active.threadId) return;
    if (wire.method === "turn/started" && p.turn) active.turnId = p.turn.id;
    if (p.item && wire.method) onItem(wire.method, p.item);
    if (wire.method === "turn/completed" && p.turn) {
      active.finished = true;
      if (p.turn.status === "failed") fail(new ProcessError(p.turn.error?.message ?? "Codex turn failed"));
      else finish(p.turn.status);
    }
  });
  return { completed, stop: off };
}

/** MCP tool content as Codex's tool reply (Desktop codex `tool`). */
function contentItems(content: readonly unknown[]): ToolReply["contentItems"] {
  const items: ToolReply["contentItems"] = [];
  for (const value of content) {
    const block = value as { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown } | null;
    if (block?.type === "text" && typeof block.text === "string") items.push({ type: "inputText", text: block.text });
    else if (block?.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string")
      items.push({ type: "inputImage", imageUrl: `data:${block.mimeType};base64,${block.data}` });
  }
  return items;
}
