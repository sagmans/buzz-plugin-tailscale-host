// Pi's engine: one Pi host per hosted agent, through buzz-app's own `Pi`
// client (bundled/pi/pi.ts), imported unchanged. The host is buzz-app's
// host.mjs on Pi durable, started as the harness user by `harness-wrapper
// pi <agent>`; it keeps each conversation in the agent's own SQLite file, so
// a conversation resumes in a later host. The Buzz tools stay here: a tool
// call from the host is answered by the runtime's in-process tool server, so
// the host never holds the agent key.
//
// Desktop's PiRuntime (bundled/pi/runtime.ts) cannot be imported (it needs
// Desktop's agent store); this engine follows its delivery rules: `open`
// with the session tools, `deliver` (which steers a working run), `wait`,
// `session interrupt`. It differs where the runner differs from Desktop:
//
// - Runs a stopped or crashed host left are dropped when the next host
//   opens, not continued. That matches the Claude engine here: a stop
//   interrupts busy turns, and their events are not run again.
// - A host that stops during a turn fails that turn (reported in its
//   thread) instead of reopening and waiting again.
// - The host is stopped after PI_IDLE_MS without a turn, and counts as one
//   live session under the host-wide cap, evictable when idle.
import { isFinalMessage } from "@buzz/buzz-mcp/session-tools";
import type { Settled, Spawn } from "@buzz/bundled/claude-code/claude";
import { steerPrompt } from "@buzz/bundled/claude-code/prompt";
import { Pi, type PiEvent, type ToolCall, type ToolResult } from "@buzz/bundled/pi/pi";
import { PI_HOST_KEY, PI_IDLE_MS, PI_KEY_WAIT_MS, PI_MODEL_SEPARATOR } from "./constants";
import type { Engine, EngineTurn } from "./engine";
import { errorMessage, ProcessError } from "./errors";
import type { Logger } from "./log";
import type { HarnessFeed } from "./telemetry";

/** How a request settled (host.mjs `wait`). */
type Waited =
  | Readonly<{ status: "done"; text?: string }>
  | Readonly<{ status: "unanswered"; reason?: string; detail?: string }>
  | Readonly<{ status: "reopen" }>
  | Readonly<{ status: "closed" }>;
type Submitted = Readonly<{ submission: number; conversation: number }>;
type Unfinished = Readonly<{ submissions: readonly Submitted[] }>;

/** What every turn of the agent runs with, read when it is handed over. */
export type PiSetup = Readonly<{
  cwd: string;
  /** The system prompt, without the core memory (Pi keeps that apart). */
  instructions: string;
  /** The `core` memory section and its no-memory placeholder; absent when
   * the memory could not be read. */
  core?: Readonly<{ text: string; placeholder: string }> | undefined;
  /** `<provider>/<model>`, or a model of Pi's default provider. */
  model?: string | undefined;
  effort?: string | undefined;
}>;

/** The Buzz tools as a session lists them (buzz-mcp `SessionTool`). */
export type PiTool = Readonly<{
  name: string;
  description: string;
  inputSchema: Readonly<Record<string, unknown>>;
  load: "always" | "search";
}>;

export type PiEngineDeps = Readonly<{
  agent: string;
  /** Starts `harness-wrapper pi <agent>`. */
  spawn: Spawn;
  tools: readonly PiTool[];
  hint: string;
  setup(): Promise<PiSetup>;
  /** Runs one Buzz tool for the conversation `key`, MCP-shaped. */
  tool(key: string | undefined, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  inflight: ReadonlyMap<string, unknown>;
  /** The host started or stopped: a turn waiting on the cap checks again. */
  onChange(): void;
  feed?: HarnessFeed | undefined;
  log: Logger;
}>;

/** The words of a request Pi left unanswered, as Desktop words them. */
const UNANSWERED: Readonly<Record<string, string>> = Object.freeze({
  no_model: "Pi has no model for this agent",
  aborted: "The turn was stopped",
});
const REOPEN_ERROR = "Pi's storage for this agent failed; the next message opens it again";

/** One host process and what this engine did with it. */
type Host = {
  pi: Pi;
  /** `open` plus dropping left runs, once per process. */
  ready?: Promise<void> | undefined;
  /** The process is running (or starting): it holds a live-session slot. */
  alive: boolean;
};

export class PiEngine implements Engine {
  private host: Host | undefined;
  /** Deliveries in progress, by conversation key. */
  private readonly working = new Map<string, number>();
  /** Each Pi conversation's key, from the deliveries that made it. */
  private readonly keys = new Map<number, string>();
  /** Tool calls and steps that name a conversation before its delivery has
   * answered (the host may start the run first), waiting for its key. */
  private readonly unknown = new Map<number, Set<(key: string | undefined) => void>>();
  /** What each key's conversation had seen when last asked, so telemetry
   * can tell a new conversation from a resumed one. */
  private readonly seenAt = new Map<string, number>();
  private lastUsed = Date.now();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly deps: PiEngineDeps) {}

  async deliver(turn: EngineTurn): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "The agent was stopped", undelivered: true };
    this.enter(turn.key);
    let submitted: Submitted | false | undefined;
    const started = Date.now();
    try {
      const pi = await this.ready();
      const [text, setup] = await Promise.all([turn.prompt(false), this.deps.setup()]);
      const { provider, model } = splitModel(setup.model);
      submitted = await pi.request<Submitted | false>("deliver", {
        agent: this.deps.agent,
        key: turn.key,
        at: turn.at,
        context: turn.context,
        request: turn.request,
        text,
        steer: steerPrompt(text),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(setup.effort ? { thinking: setup.effort } : {}),
        pick: {},
        instructions: setup.instructions,
        cwd: setup.cwd,
        ...(setup.core ? { core: setup.core } : {}),
      });
      // Pi took nothing (a refresh found the request gone): nothing to say.
      if (!submitted) return { ok: true };
      const session = String(submitted.conversation);
      this.learn(submitted.conversation, turn.key);
      this.deps.feed?.prompt(turn.key, session, !this.seenAt.get(turn.key), text);
      const waited = await pi.request<Waited>("wait", { agent: this.deps.agent, submission: submitted.submission });
      return this.settle(turn.key, session, waited, Date.now() - started);
    } catch (error) {
      const message = errorMessage(error);
      if (submitted) this.deps.feed?.settled(turn.key, String(submitted.conversation), { error: message });
      this.deps.log.warn("pi turn failed", { conversation: turn.key, delivered: Boolean(submitted), elapsedMs: Date.now() - started, error: message });
      return { ok: false, error: message, ...(submitted ? {} : { undelivered: true as const }) };
    } finally {
      this.leave(turn.key);
    }
  }

  /** What the conversation's Pi conversation was shown; its host knows. */
  async seen(key: string, _contextRoot: string | undefined) {
    const pi = await this.ready();
    const { seen } = await pi.request<{ seen: number }>("place", { agent: this.deps.agent, key });
    this.seenAt.set(key, seen);
    return seen;
  }

  async interrupt(key: string) {
    const host = this.host;
    if (!host?.ready || !this.working.has(key)) return;
    await host.ready;
    await host.pi.request("session", { agent: this.deps.agent, key, action: "interrupt" });
  }

  active(key: string) {
    return this.working.has(key);
  }

  busy() {
    return [...this.working.keys()];
  }

  slot() {
    return PI_HOST_KEY;
  }

  live() {
    if (!this.host?.alive) return [];
    return [{ key: PI_HOST_KEY, at: this.lastUsed, evictable: !this.working.size && !this.deps.inflight.size }];
  }

  holds(slot: string) {
    return slot === PI_HOST_KEY && this.host?.alive === true;
  }

  /** Stops the host while no turn uses it; its conversations stay in its
   * storage for the next one. */
  evict(slot: string) {
    if (slot !== PI_HOST_KEY || this.working.size || this.deps.inflight.size) return false;
    this.stopHost("live-session cap");
    return true;
  }

  /** The host holds every conversation of the agent, so stopping one turn
   * by force stops them all; the others fail and are reported. */
  async forceStop(_key: string) {
    this.stopHost("forced stop");
  }

  /** Every turn reads the settings when it is handed over: nothing to restart. */
  reconfigure() {}

  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    for (const waiters of this.unknown.values()) for (const resolve of waiters) resolve(undefined);
    this.unknown.clear();
    this.stopHost("agent stop");
  }

  /** The host, opened for the agent, with left runs dropped. One that
   * failed to open is tried again by the next turn. */
  private ready(): Promise<Pi> {
    if (this.disposed) return Promise.reject(new ProcessError("The agent was stopped"));
    const host = (this.host ??= this.start());
    if (!host.ready) {
      const ready = this.open(host.pi);
      host.ready = ready;
      ready.catch(() => {
        if (host.ready === ready) host.ready = undefined;
      });
    }
    return host.ready.then(() => host.pi);
  }

  /** A new host client. Its spawn starts one process only: a host that
   * stopped is replaced by a new client, so `open` always runs first in
   * every process. */
  private start(): Host {
    let used = false;
    const host: Host = {
      alive: false,
      pi: new Pi(
        () => async (id, options) => {
          if (used || this.host !== host) throw new ProcessError("The Pi host stopped; the next message starts it again");
          used = true;
          host.alive = true;
          this.deps.onChange();
          try {
            const child = await this.deps.spawn(id, options);
            void child.exited.then(() => this.exited(host));
            return child;
          } catch (error) {
            this.exited(host);
            throw error;
          }
        },
        {
          tool: (call) => this.tool(call),
          event: (event) => this.event(event),
        },
      ),
    };
    return host;
  }

  /** Opens the agent's storage with its Buzz tools, then drops the runs a
   * stopped host left: Pi would continue them on the next request, with
   * nothing here waiting for them. */
  private async open(pi: Pi) {
    const agent = this.deps.agent;
    await pi.request("open", { agent, tools: this.deps.tools, hint: this.deps.hint });
    const { submissions } = await pi.request<Unfinished>("unfinished", { agent });
    if (!submissions.length) return;
    await pi.request("drop", {
      agent,
      submissions: submissions.map(({ submission, conversation }) => ({ submission, conversation })),
    });
    this.deps.log.info("pi runs left by a stopped host dropped", { runs: submissions.length });
  }

  private settle(key: string, session: string, waited: Waited, elapsedMs: number): Settled {
    const feed = this.deps.feed;
    if (waited.status === "done") {
      if (waited.text) feed?.answer(key, session, waited.text);
      feed?.settled(key, session, { stop: "end_turn" });
      return { ok: true };
    }
    // The agent is stopping; its stop already says so.
    if (waited.status === "closed") {
      feed?.settled(key, session, { stop: "cancelled" });
      return { ok: true };
    }
    if (waited.status === "unanswered" && waited.reason === "aborted") {
      feed?.settled(key, session, { stop: "cancelled" });
      return { ok: true, stopped: true };
    }
    const error =
      waited.status === "reopen"
        ? REOPEN_ERROR
        : (waited.detail ?? UNANSWERED[waited.reason ?? ""] ?? `Pi did not answer (${waited.reason ?? "unknown"})`);
    // A failed storage closed the host's handle on it: open it again next time.
    if (waited.status === "reopen" && this.host) this.host.ready = undefined;
    feed?.settled(key, session, { error });
    this.deps.log.warn("pi left a turn unanswered", {
      conversation: key,
      reason: waited.status === "reopen" ? "reopen" : (waited.reason ?? "unknown"),
      elapsedMs,
    });
    return { ok: false, error };
  }

  /** A Buzz tool call from the host. The tool context is the runtime's own
   * for the conversation, not what the host says: the host runs as the
   * harness user and is not trusted with where the agent posts. */
  private async tool(call: ToolCall): Promise<ToolResult> {
    if (call.agent !== this.deps.agent) throw new ProcessError("Pi called a tool for another agent");
    const key = await this.keyOf(call.conversation);
    const result = await this.deps.tool(key, call.name, call.arguments ?? {});
    return { ...result, ...(isFinalMessage(call.name, call.arguments) && !result.isError ? { final: true } : {}) };
  }

  private event(event: PiEvent) {
    if (event.agent !== this.deps.agent || event.type !== "step") return;
    const step = (key: string | undefined) => {
      if (key) this.deps.feed?.step(key, String(event.conversation), event.tool, event.target);
    };
    const key = this.keys.get(event.conversation);
    // Known: shown now, in order. Not yet: shown once its delivery answers.
    if (key) step(key);
    else void this.keyOf(event.conversation).then(step);
  }

  /** The conversation's key, waiting up to PI_KEY_WAIT_MS for the delivery
   * that names it; undefined when none does, so the call runs with no
   * context (and the Buzz tools refuse what needs one). */
  private keyOf(conversation: number): Promise<string | undefined> {
    const key = this.keys.get(conversation);
    if (key !== undefined || this.disposed) return Promise.resolve(key);
    return new Promise((resolve) => {
      const waiters = this.unknown.get(conversation) ?? new Set();
      this.unknown.set(conversation, waiters);
      const done = (found: string | undefined) => {
        clearTimeout(timer);
        waiters.delete(done);
        if (!waiters.size && this.unknown.get(conversation) === waiters) this.unknown.delete(conversation);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.deps.log.warn("pi named a conversation no delivery made", { conversation, waitedMs: PI_KEY_WAIT_MS });
        done(undefined);
      }, PI_KEY_WAIT_MS);
      timer.unref();
      waiters.add(done);
    });
  }

  /** Records a conversation's key and hands it to what waited for it. */
  private learn(conversation: number, key: string) {
    this.keys.set(conversation, key);
    const waiters = this.unknown.get(conversation);
    if (waiters) for (const resolve of [...waiters]) resolve(key);
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
      this.idle = setTimeout(() => {
        if (!this.working.size) this.stopHost("idle");
      }, PI_IDLE_MS);
      this.idle.unref();
    }
    this.deps.onChange();
  }

  private exited(host: Host) {
    host.alive = false;
    this.drop(host);
    this.deps.onChange();
  }

  /** Forgets a host client that stopped; the next turn starts another. */
  private drop(host: Host | undefined) {
    if (host && this.host === host) this.host = undefined;
  }

  /** Stops the host: stdin EOF first, so it closes the agent's storage. */
  private stopHost(why: string) {
    const host = this.host;
    if (!host) return;
    this.host = undefined;
    const wasAlive = host.alive;
    host.alive = false;
    if (wasAlive) this.deps.log.info("pi host stopping", { why });
    void host.pi.dispose().catch((error) => this.deps.log.warn("pi host stop failed", { error: errorMessage(error) }));
    this.deps.onChange();
  }
}

/** `<provider>/<model>`: the provider holds no separator, the model may. A
 * model without one runs on Pi's default provider. */
export function splitModel(value: string | undefined): { provider?: string; model?: string } {
  if (!value) return {};
  const at = value.indexOf(PI_MODEL_SEPARATOR);
  if (at <= 0) return { model: value };
  return { provider: value.slice(0, at), model: value.slice(at + PI_MODEL_SEPARATOR.length) };
}
