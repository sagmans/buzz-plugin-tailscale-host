// The host-wide cap on live claude processes (`maxLiveSessions`).
//
// buzz-app's AgentSessions keeps one process per conversation for 15 minutes
// after its last use, as Desktop does. On a 2 GB host each one holds about
// 190 MiB, so a handful of quiet threads is enough for the cgroup OOM killer.
// AgentSessions is imported unchanged and has no cap of its own, so this pool
// sits in front of it: before a turn makes AgentSessions start a process, the
// turn is admitted here. When the cap is reached, the least recently used
// idle process of any agent is stopped first (its saved session stays, so
// the next message resumes it with `--resume`, as after the idle stop). A
// busy process is never stopped; when every live process is busy, the turn
// waits, in arrival order, as it does on the turn limiter.
import { SESSION_CAP_RECHECK_MS } from "./constants";
import { ProcessError } from "./errors";
import { short, type Logger } from "./log";

/** One live conversation process of an agent. */
export type LiveSession = Readonly<{
  key: string;
  /** Last use, ms (the saved session's `at`); lower is older. */
  at: number;
  /** Idle, not starting, and no turn of the runner is on its way to it. */
  evictable: boolean;
}>;

/** What an agent runtime exposes to the pool. */
export type PoolMember = Readonly<{
  id: string;
  /** Conversations that hold a process now, or are starting one. */
  live(): readonly LiveSession[];
  /** Whether `key` already has a process (or one is starting). */
  holds(key: string): boolean;
  /** Stops `key`'s process if it is still idle; true when it is gone. */
  evict(key: string): boolean;
  stopped(): boolean;
}>;

export class SessionPool {
  private readonly members = new Set<PoolMember>();
  /** Admitted conversations whose process may not show as live yet. */
  private readonly pending = new Set<string>();
  /** Admissions run one at a time, so waiting turns go in arrival order and
   * two turns never take the same free slot. */
  private queue: Promise<unknown> = Promise.resolve();
  private wake: (() => void) | undefined;

  constructor(
    private readonly cap: number,
    private readonly log: Logger,
  ) {}

  register(member: PoolMember) {
    this.members.add(member);
  }

  unregister(member: PoolMember) {
    this.members.delete(member);
    this.notify();
  }

  /** Something changed (a process stopped, a turn ended): a waiting turn
   * checks again. */
  notify() {
    this.wake?.();
  }

  /** Resolves with a release once `key` of `member` may have a process. The
   * release is called when the delivery that needed it settles. */
  admit(member: PoolMember, key: string): Promise<() => void> {
    if (member.holds(key)) return Promise.resolve(() => undefined);
    const admitted = this.queue.then(() => this.take(member, key));
    // A failed admission (agent stopped) must not block the next one.
    this.queue = admitted.catch(() => undefined);
    return admitted;
  }

  private async take(member: PoolMember, key: string): Promise<() => void> {
    const token = `${member.id}\n${key}`;
    let waitingSince: number | undefined;
    // Processes that would not stop (busy since the check, or not one
    // AgentSessions can stop), so the next one is tried until the next wait.
    const refused = new Set<string>();
    for (;;) {
      if (member.stopped()) throw new ProcessError("The agent was stopped");
      // It may have got a process while it queued (a steer, an earlier turn),
      // or an earlier turn of the same conversation took its slot already.
      if (member.holds(key) || this.pending.has(token)) return () => undefined;
      const occupied = this.occupied();
      if (occupied.size < this.cap) {
        this.pending.add(token);
        if (waitingSince !== undefined)
          this.log.info("session slot free; turn continues", { agent: short(member.id), conversation: key, waitedMs: Date.now() - waitingSince });
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.pending.delete(token);
          this.notify();
        };
      }
      const victim = this.victim(refused);
      if (victim && !victim.member.evict(victim.key)) {
        refused.add(`${victim.member.id}\n${victim.key}`);
        continue;
      }
      if (victim) {
        this.log.info("idle session stopped for the live-session cap", {
          agent: short(victim.member.id),
          conversation: victim.key,
          idleMs: Date.now() - victim.at,
          live: occupied.size,
          cap: this.cap,
          for: short(member.id),
        });
        continue;
      }
      if (waitingSince === undefined) {
        waitingSince = Date.now();
        this.log.info("live-session cap reached and every session is busy; turn waits", {
          agent: short(member.id),
          conversation: key,
          live: occupied.size,
          cap: this.cap,
        });
      }
      await this.pause();
      refused.clear();
    }
  }

  /** Live and admitted processes of every agent, each counted once. */
  private occupied() {
    const tokens = new Set(this.pending);
    for (const member of this.members) for (const session of member.live()) tokens.add(`${member.id}\n${session.key}`);
    return tokens;
  }

  /** The idle process used longest ago, across all agents. */
  private victim(refused: ReadonlySet<string>) {
    let best: { member: PoolMember; key: string; at: number } | undefined;
    for (const member of this.members)
      for (const session of member.live())
        if (session.evictable && !refused.has(`${member.id}\n${session.key}`) && (!best || session.at < best.at))
          best = { member, key: session.key, at: session.at };
    return best;
  }

  /** Until `notify` or the recheck period, whichever comes first. */
  private pause() {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, SESSION_CAP_RECHECK_MS);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = () => {
        this.wake = undefined;
        done();
      };
    });
  }
}
