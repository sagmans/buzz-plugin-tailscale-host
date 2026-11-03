// What runs one hosted agent's conversations for `AgentRuntime`: the part
// that differs per harness. The runtime keeps everything Desktop's host does
// around a harness (sender gate, conversation key, thread context, Buzz tools,
// turn limits, typing, failure report); an engine only takes a built turn to
// the harness and says how it settled. Claude's engine is buzz-app's
// `AgentSessions` (one claude per conversation); Pi's is `pi-engine.ts` (one
// Pi host per agent); Goose's is `goose-engine.ts` (one `goose-acp` per
// agent, one ACP session per conversation).
import type { Context } from "@buzz/buzz-mcp/client";
import type { Settled, Spawn } from "@buzz/bundled/claude-code/claude";
import { steerPrompt } from "@buzz/bundled/claude-code/prompt";
import { AgentSessions, type SessionsOptions } from "@buzz/bundled/claude-code/sessions";
import type { LiveSession } from "./pool";
import type { AgentState } from "./store";

/** One turn as the runtime hands it over, once it holds a turn slot and a
 * live-session slot. */
export type EngineTurn = Readonly<{
  key: string;
  /** The triggering event: Pi files the request under it. */
  request: string;
  /** The event's time, recorded as what the conversation has seen. */
  at: number;
  /** Builds the prompt; `fresh` for a session that lost what it was shown.
   * Built here, after admission, because Pi reads what its conversation has
   * seen from its host, which must not start before the live-session cap
   * admits it. */
  prompt(fresh: boolean): Promise<string>;
  /** Where the conversation's tools default to. */
  context: Context;
  /** A channel conversation's thread, kept apart in what it has seen. */
  contextRoot?: string | undefined;
  /** What a new harness session is named (Goose): a titled session spares
   * the provider the model call that would name it. */
  title?: string | undefined;
}>;

export interface Engine {
  deliver(turn: EngineTurn): Promise<Settled>;
  /** What the conversation has been shown, in seconds; 0 for none. */
  seen(key: string, contextRoot: string | undefined): Promise<number>;
  /** Stops the conversation's running turn, if it has one. */
  interrupt(key: string): Promise<void>;
  /** Whether a turn runs or is being handed over in `key`. */
  active(key: string): boolean;
  /** Conversations working now, interrupted first on a stop. */
  busy(): readonly string[];
  /** The live-session cap's key for a conversation: Claude counts each
   * conversation's process, Pi its one host per agent. */
  slot(key: string): string;
  live(): readonly LiveSession[];
  holds(slot: string): boolean;
  evict(slot: string): boolean;
  /** An interrupt did not end the turn: stop what runs it. */
  forceStop(key: string): Promise<void>;
  /** The agent's settings changed. */
  reconfigure(): void;
  dispose(): void;
}

/** A fingerprint no settings produce: AgentSessions' `reconfigure` then
 * stops that conversation's process if, and only if, it is idle. */
const EVICTING = "\u0000evicting";

export type ClaudeEngineDeps = Readonly<{
  spawn: Spawn;
  state: AgentState;
  /** The settings a running process was started with; a change restarts it. */
  fingerprint(): string;
  launch: SessionsOptions["launch"];
  /** Conversations with a runner turn on its way: never stopped for the cap. */
  inflight: ReadonlyMap<string, unknown>;
  /** A process stopped or freed: a turn waiting on the cap checks again. */
  onChange(): void;
}>;

/** Claude: buzz-app's `AgentSessions`, unchanged. */
export class ClaudeEngine implements Engine {
  private readonly sessions: AgentSessions;
  /** The conversation being stopped for the live-session cap, during the
   * synchronous `reconfigure` call that stops it. */
  private evicting: string | undefined;

  constructor(private readonly deps: ClaudeEngineDeps) {
    this.sessions = new AgentSessions({
      spawn: deps.spawn,
      store: deps.state.sessions,
      fingerprint: (key) => (key !== undefined && key === this.evicting ? EVICTING : deps.fingerprint()),
      onChange: () => deps.onChange(),
      launch: (key) => deps.launch(key),
    });
  }

  async deliver(turn: EngineTurn) {
    const text = await turn.prompt(false);
    return this.sessions.deliver(turn.key, text, turn.at, {
      steer: steerPrompt(text),
      fresh: () => turn.prompt(true),
      ...(turn.contextRoot ? { contextRoot: turn.contextRoot } : {}),
    });
  }

  async seen(key: string, contextRoot: string | undefined) {
    return this.sessions.seen(key, contextRoot);
  }

  interrupt(key: string) {
    return this.sessions.interrupt(key);
  }

  active(key: string) {
    return this.sessions.active(key);
  }

  busy() {
    return this.sessions.snapshot().filter((session) => session.busy).map((session) => session.key);
  }

  slot(key: string) {
    return key;
  }

  live() {
    return this.sessions.snapshot().map(({ key, busy }) => ({
      key,
      at: this.deps.state.sessions.get(key)?.at ?? 0,
      evictable: !busy && !this.sessions.active(key) && !this.deps.inflight.has(key),
    }));
  }

  holds(key: string) {
    return this.sessions.active(key) || this.sessions.snapshot().some((session) => session.key === key);
  }

  /** Stops an idle conversation's process for the live-session cap, through
   * AgentSessions' own `reconfigure`: buzz-app is not edited, and its only
   * public stop that keeps the saved session is that one (`forget` deletes
   * it). `reconfigure` drops a process only when it is not busy, checked in
   * the same synchronous step, so a busy one is never stopped. Other idle
   * processes stop with it only if their settings already changed, which
   * `reconfigure` would do anyway. */
  evict(key: string) {
    if (this.deps.inflight.has(key)) return false;
    this.evicting = key;
    try {
      this.sessions.reconfigure();
    } finally {
      this.evicting = undefined;
    }
    return !this.sessions.snapshot().some((session) => session.key === key);
  }

  /** `forget` is the only public way to drop one conversation's process,
   * and it also deletes the saved session, so that is put back to keep
   * `--resume` working. */
  async forceStop(key: string) {
    const saved = this.deps.state.sessions.get(key);
    await this.sessions.forget(key);
    if (saved) this.deps.state.sessions.set(key, saved);
  }

  /** Name, instructions, model or effort changed: idle sessions restart on
   * their next message, busy ones once they fall idle (Desktop `reconfigure`). */
  reconfigure() {
    this.sessions.reconfigure();
  }

  dispose() {
    this.sessions.dispose();
  }
}
