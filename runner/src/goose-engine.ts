// Goose's engine: buzz-app's goose module on its shared ACP client, imported
// unchanged (`GooseProcess`, `SharedProcess`, `AgentSessions`). Each hosted
// agent gets its own `goose-acp`, started as the harness user by
// `harness-wrapper goose <agent>`, with one ACP session per conversation.
// The Buzz tools reach Goose over a loopback HTTP MCP server per session
// (mcp-server.ts): Goose gets an address and a token, never the agent key,
// and every call is answered by the runtime's in-process tool server with
// the runtime's own context for the conversation.
//
// Desktop's goose runtime (bundled/goose/runtime.ts) cannot be imported (it
// needs Desktop's agent store); this engine passes what it passes to
// `AgentSessions.deliver` (prompt, steer form, fresh prompt, session title)
// and differs where the runner differs from Desktop:
//
// - One `goose-acp` per agent, not one for every agent: the wrapper starts
//   it in the agent's own workspace, under the agent's own Goose data.
// - Sessions are not resumed in a later process, as on Desktop: a new
//   session is shown the conversation again (`fresh`).
// - The process is stopped after GOOSE_IDLE_MS without a turn, and counts as
//   one live session under the host-wide cap, evictable when idle.
import type { Settled, Spawn } from "@buzz/bundled/claude-code/claude";
import { steerPrompt } from "@buzz/bundled/claude-code/prompt";
import type { Choice, ToolServer } from "@buzz/bundled/goose/goose";
import { AgentSessions, type Launch, ServerPool, SharedProcess } from "@buzz/bundled/goose/sessions";
import type { ServeMcp } from "@buzz/features/agent-harness/acp/types";
import {
  GOOSE_HOST_KEY,
  GOOSE_IDLE_MS,
  GOOSE_MODEL_SEPARATOR,
  GOOSE_TITLE_LIMIT,
  GOOSE_TITLE_ROOT_CHARS,
  GOOSE_UNNAMED_AGENT,
} from "./constants";
import type { Engine, EngineTurn } from "./engine";
import { errorMessage } from "./errors";
import type { Logger } from "./log";

/** What every session of the agent opens with, read when one opens. */
export type GooseSetup = Readonly<{
  /** The agent's absolute workspace. */
  cwd: string;
  /** The system prompt, with the core memory. */
  systemPrompt: string;
  /** `<provider>/<model>`, or a model of Goose's configured provider. */
  model?: string | undefined;
  effort?: string | undefined;
}>;

export type GooseEngineDeps = Readonly<{
  /** Starts `harness-wrapper goose <agent>`. */
  spawn: Spawn;
  /** Starts one session's loopback MCP server. */
  serve: ServeMcp;
  /** The servers every agent's sessions hold, runner-wide. */
  pool: ServerPool;
  /** Answers the Buzz tools for the conversation a session serves. */
  tools: ToolServer;
  /** The agent's settings now, without the system prompt (which reads
   * the core memory). */
  settings(): Omit<GooseSetup, "systemPrompt">;
  /** The settings with the core memory, for a new session. */
  launch(): Promise<GooseSetup>;
  /** Changes when a setting a session was opened with has changed. */
  fingerprint(): string;
  inflight: ReadonlyMap<string, unknown>;
  /** The process started or stopped: a turn waiting on the cap checks again. */
  onChange(): void;
  log: Logger;
}>;

export class GooseEngine implements Engine {
  private readonly process: SharedProcess;
  private readonly sessions: AgentSessions;
  /** Deliveries in progress, by conversation key. */
  private readonly working = new Map<string, number>();
  /** Processes running or starting: one normally, two while a stopped one
   * exits as the next starts. Any of them holds the live-session slot. */
  private running = 0;
  private lastUsed = Date.now();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly deps: GooseEngineDeps) {
    const spawn: Spawn = async (id, options) => {
      this.running++;
      deps.onChange();
      try {
        const child = await deps.spawn(id, options);
        void child.exited.then(() => this.exited());
        return child;
      } catch (error) {
        this.exited();
        throw error;
      }
    };
    // The wrapper picks the folder; the workspace is absolute, so `~` is
    // asked only for the process itself.
    const resolveDirectory = async () => deps.settings().cwd;
    this.process = new SharedProcess({ spawn, resolveDirectory }, deps.serve);
    this.sessions = new AgentSessions({
      resolveDirectory,
      tools: deps.tools,
      process: this.process,
      pool: deps.pool,
      launch: async (): Promise<Launch> => {
        const setup = await deps.launch();
        return { workspace: setup.cwd, systemPrompt: setup.systemPrompt };
      },
      // Read as each turn starts, so a model or level change needs no restart.
      choice: () => choice(deps.settings()),
      fingerprint: () => deps.fingerprint(),
      onChange: () => deps.onChange(),
    });
  }

  async deliver(turn: EngineTurn): Promise<Settled> {
    if (this.disposed) return { ok: false, error: "The agent was stopped", undelivered: true };
    this.enter(turn.key);
    const started = Date.now();
    try {
      const text = await turn.prompt(false);
      const settled = await this.sessions.deliver(turn.key, text, turn.at, {
        steer: steerPrompt(text),
        fresh: () => turn.prompt(true),
        ...(turn.title ? { title: turn.title } : {}),
      });
      if (!settled.ok)
        this.deps.log.warn("goose turn failed", {
          conversation: turn.key,
          delivered: !settled.undelivered,
          elapsedMs: Date.now() - started,
          error: settled.error,
        });
      // What Goose wrote without a Buzz tool stays in telemetry, as it stays
      // in Desktop's local activity: it answered nobody.
      return {
        ok: settled.ok,
        ...(settled.error !== undefined ? { error: settled.error } : {}),
        ...(settled.undelivered ? { undelivered: true as const } : {}),
        ...(settled.stopped ? { stopped: true as const } : {}),
      };
    } catch (error) {
      const message = errorMessage(error);
      this.deps.log.warn("goose turn failed", { conversation: turn.key, elapsedMs: Date.now() - started, error: message });
      return { ok: false, error: message, undelivered: true };
    } finally {
      this.leave(turn.key);
    }
  }

  /** What the conversation's session was shown; 0 once it closed. */
  async seen(key: string, _contextRoot: string | undefined) {
    return this.sessions.seen(key);
  }

  interrupt(key: string) {
    return this.sessions.interrupt(key);
  }

  active(key: string) {
    return this.working.has(key) || this.sessions.active(key);
  }

  busy() {
    const keys = new Set(this.working.keys());
    for (const session of this.sessions.snapshot()) if (session.busy) keys.add(session.key);
    return [...keys];
  }

  slot() {
    return GOOSE_HOST_KEY;
  }

  live() {
    if (!this.alive) return [];
    return [{ key: GOOSE_HOST_KEY, at: this.lastUsed, evictable: this.quiet() }];
  }

  holds(slot: string) {
    return slot === GOOSE_HOST_KEY && this.alive;
  }

  /** Stops the process while no turn uses it; its idle sessions close with it. */
  evict(slot: string) {
    if (slot !== GOOSE_HOST_KEY || !this.quiet()) return false;
    this.stopProcess("live-session cap");
    return true;
  }

  /** The process holds every conversation of the agent, so stopping one
   * turn by force stops them all; the others fail and are reported. */
  async forceStop(_key: string) {
    this.stopProcess("forced stop");
  }

  /** Idle sessions opened with old settings close; busy ones once idle. */
  reconfigure() {
    this.sessions.reconfigure();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.idle);
    this.sessions.dispose();
    this.stopProcess("agent stop");
  }

  /** The conversation a Goose session serves, for telemetry. */
  keyOf(session: string): string | undefined {
    return this.sessions.snapshot().find((item) => item.sessionId === session)?.key;
  }

  private get alive() {
    return this.running > 0;
  }

  private quiet() {
    return !this.working.size && !this.deps.inflight.size && !this.sessions.snapshot().some((item) => item.busy);
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
        if (this.quiet()) this.stopProcess("idle");
      }, GOOSE_IDLE_MS);
      this.idle.unref();
    }
    this.deps.onChange();
  }

  private exited() {
    this.running = Math.max(0, this.running - 1);
    this.deps.onChange();
  }

  /** Stops `goose-acp` (stdin EOF first); its sessions fail and close. */
  private stopProcess(why: string) {
    if (this.alive) this.deps.log.info("goose stopping", { why });
    this.process.stop();
  }
}

/** The agent's provider, model and level, as Goose picks them per turn. A
 * model without a provider runs on Goose's configured provider. */
export function choice(setup: Pick<GooseSetup, "model" | "effort">): Choice {
  const value = setup.model ?? "";
  const at = value.indexOf(GOOSE_MODEL_SEPARATOR);
  const [provider, model] = at > 0 ? [value.slice(0, at), value.slice(at + GOOSE_MODEL_SEPARATOR.length)] : ["", value];
  return { provider, model, ...(setup.effort ? { effort: setup.effort } : {}) };
}

/** A session's title, as Desktop's goose runtime words it (`sessionTitle`):
 * `Agent · place`, and the thread root when each thread is a session. */
export function sessionTitle(agent: string | undefined, place: string, root?: string) {
  const suffix = root ? ` · ${root.slice(0, GOOSE_TITLE_ROOT_CHARS)}` : "";
  const title = `${agent?.trim() || GOOSE_UNNAMED_AGENT} · ${place}`
    .replace(/\s+/g, " ")
    .slice(0, GOOSE_TITLE_LIMIT - suffix.length)
    .trim();
  return `${title}${suffix}`;
}
