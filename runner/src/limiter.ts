// The host-wide cap on concurrent turns. The first host has 1 vCPU and 2 GB
// RAM and each `claude` takes hundreds of MB, so turns beyond the cap wait in
// a bounded FIFO queue rather than starting and getting the host OOM-killed.
import { RunnerError } from "./errors";

export class Limiter {
  private active = 0;
  private readonly waiting: { grant: (release: () => void) => void; refuse: (error: Error) => void }[] = [];
  private closed = false;

  constructor(
    private readonly max: number,
    private readonly queueLimit: number,
  ) {}

  get running() {
    return this.active;
  }
  get queued() {
    return this.waiting.length;
  }

  /** Resolves with a one-shot release once a slot is free. */
  acquire(): Promise<() => void> {
    if (this.closed) return Promise.reject(new RunnerError("shutting_down", 503, "The runner is stopping"));
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(this.releaser());
    }
    if (this.waiting.length >= this.queueLimit)
      return Promise.reject(new RunnerError("busy", 503, "Too many turns are waiting; try again later"));
    return new Promise((grant, refuse) => this.waiting.push({ grant, refuse }));
  }

  /** Refuses every waiting turn; running ones finish or are stopped by their owners. */
  close() {
    this.closed = true;
    for (const waiter of this.waiting.splice(0)) waiter.refuse(new RunnerError("shutting_down", 503, "The runner is stopping"));
  }

  private releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter, so `active` stays put.
      if (next) next.grant(this.releaser());
      else this.active--;
    };
  }
}
