// The `Spawn` Desktop's `ClaudeProcess` expects, backed by node:child_process
// instead of the Tauri host. Every agent's `claude` runs as the unprivileged
// run-as user through one sudoers-allowed wrapper, so the model never runs as
// the user that owns the keys. The child gets argv and a bare PATH only: no
// key, no auth tag, no runner environment.
//
// Stopping a child cannot rely on signals: under real sudo the direct child
// is a root-owned sudo process, and the runner user may get EPERM. The stop
// sequence therefore starts with stdin EOF (which ends a stream-json
// session), treats signals as best effort, and gives up after a bound so the
// caller (and its turn slot) is never held by a child that will not die.
import { spawn as spawnChild } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { HostProcess, HostProcessOptions } from "@buzz/features/host/service";
import type { Spawn } from "@buzz/bundled/claude-code/claude";
import {
  CHILD_CWD,
  CHILD_PATH,
  PROCESS_KILL_GRACE_MS,
  PROCESS_STOP_MAX_MS,
  STDOUT_LINE_MAX_BYTES,
} from "./constants";
import { ProcessError } from "./errors";
import type { Logger } from "./log";
import type { StreamTap } from "./telemetry";

export type SpawnTarget = Readonly<{
  sudo: string;
  runAsUser: string;
  wrapper: string;
  agent: string;
  /** The agent's telemetry tap for a process launched with this session
   * (`fresh` for `--session-id`, else `--resume`); absent when telemetry is
   * off. It sees complete stdout lines and stdin writes, never alters them. */
  tap?: ((session: string, fresh: boolean, cwd: string | undefined) => StreamTap) | undefined;
  /** Every child this spawn starts is registered here until it exits, so a
   * stop can wait for all of them. */
  children: ChildTracker;
}>;

/** What a stop reports: children that exited and those still alive at the
 * deadline (their pids). */
export type ChildStop = Readonly<{ children: number; exited: number; alive: readonly number[]; elapsedMs: number }>;

/** One agent's claude children. AgentSessions stops processes with
 * `void kill()` and never awaits them; this is what lets the runner wait for
 * the real exits before it exits itself, so systemd does not SIGKILL a
 * claude in the middle of writing its session file. */
export class ChildTracker {
  private readonly live = new Map<number, { kill(): Promise<void>; exit: Promise<unknown> }>();

  add(pid: number, kill: () => Promise<void>, exit: Promise<unknown>) {
    this.live.set(pid, { kill, exit });
    const forget = () => this.live.delete(pid);
    void exit.then(forget, forget);
  }

  /** The children running now: a stop takes this list first, so processes
   * that exit during its earlier steps still count as stopped by it. */
  pids(): readonly number[] {
    return [...this.live.keys()];
  }

  /** Starts the stop sequence of each of `among` still running (the
   * sequence is idempotent) and waits for their exits, up to `budgetMs`. */
  async stopAll(budgetMs: number, among: readonly number[] = this.pids()): Promise<ChildStop> {
    const started = Date.now();
    const children = [...this.live].filter(([pid]) => among.includes(pid));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, budgetMs);
    });
    await Promise.race([
      Promise.allSettled(
        children.map(([, child]) => {
          // A failed stop shows as a pid still alive at the deadline.
          child.kill().catch(() => undefined);
          return child.exit;
        }),
      ),
      deadline,
    ]);
    clearTimeout(timer);
    const alive = among.filter((pid) => this.live.has(pid));
    return { children: among.length, exited: among.length - alive.length, alive, elapsedMs: Date.now() - started };
  }
}

/** Desktop names the binary `claude`; the wrapper is what runs it here. */
const CLAUDE_ID = "claude";
const NEWLINE = 0x0a;
const SESSION_FLAG = "--session-id";
const RESUME_FLAG = "--resume";

export function wrapperSpawn(target: SpawnTarget, log: Logger): Spawn {
  return async (id: string, options: HostProcessOptions = {}): Promise<HostProcess> => {
    if (id !== CLAUDE_ID) throw new ProcessError(`Only ${CLAUDE_ID} can be started, not ${id}`);
    const args = [...SUDO_PREFIX, target.runAsUser, "--", target.wrapper, target.agent, ...(options.args ?? [])];
    return startChild(
      { sudo: target.sudo, args, label: CLAUDE_ID, children: target.children },
      options,
      log,
      (pid) => openTap(target, options, log, pid),
    );
  };
}

/** What starts one harness other than Claude through the generic wrapper. */
export type HarnessSpawnTarget = Readonly<{
  sudo: string;
  runAsUser: string;
  /** `harness-wrapper`: `<harness> <agent> [args…]`. */
  wrapper: string;
  harness: string;
  agent: string;
  /** The program ids the harness module asks for (its Desktop manifest's
   * `host.processes`); any other id is refused. */
  programs: readonly string[];
  /** Whether the module's own args reach the wrapper. Pi's are its launcher
   * source, which the wrapper replaces with its fixed one, so they are
   * dropped: nothing but data crosses into the harness user. */
  passArgs: boolean;
  /** The agent's telemetry tap for each process (Goose's raw ACP); absent
   * when telemetry is off or the harness reports through its engine (Pi). */
  tap?: (() => StreamTap | undefined) | undefined;
  children: ChildTracker;
}>;

/** The `Spawn` (Desktop `HostProcess` shape) of a harness module other than
 * Claude, run as the harness user through `harness-wrapper`. */
export function harnessSpawn(target: HarnessSpawnTarget, log: Logger): Spawn {
  return async (id: string, options: HostProcessOptions = {}): Promise<HostProcess> => {
    if (!target.programs.includes(id))
      throw new ProcessError(`${target.harness} may start only ${target.programs.join(", ")}, not ${id}`);
    const args = [
      ...SUDO_PREFIX,
      target.runAsUser,
      "--",
      target.wrapper,
      target.harness,
      target.agent,
      ...(target.passArgs ? (options.args ?? []) : []),
    ];
    const tap = target.tap;
    return startChild(
      { sudo: target.sudo, args, label: target.harness, children: target.children },
      options,
      log,
      tap && ((pid) => lineTap(tap(), log, pid)),
    );
  };
}

/** `sudo -n -u`: never prompt, so a missing sudoers rule fails, not hangs. */
const SUDO_PREFIX = ["-n", "-u"] as const;

type ChildSpec = Readonly<{ sudo: string; args: readonly string[]; label: string; children: ChildTracker }>;

/** Starts one wrapped child and gives it Desktop's `HostProcess` shape with
 * the runner's stop sequence and stdout line cap. */
async function startChild(
  spec: ChildSpec,
  options: HostProcessOptions,
  log: Logger,
  makeTap?: (pid: number | undefined) => ReturnType<typeof lineTap>,
): Promise<HostProcess> {
  const { label } = spec;
  // Desktop's ENV (claude.ts) is applied by the wrapper's fixed environment:
  // sudo resets the environment anyway, and nothing secret may cross here.
  const child = spawnChild(spec.sudo, [...spec.args], {
    cwd: CHILD_CWD,
    env: { PATH: CHILD_PATH },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let spawned = false;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  // `childExit` is the real exit. `exited`, which ClaudeProcess waits on to
  // settle its turn, also resolves when a stop gives up, so a child that
  // cannot be stopped never holds its turn or slot.
  let release!: (code: number | null) => void;
  const exited = new Promise<number | null>((resolve) => (release = resolve));
  const childExit = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    // Node also emits "error" when a later kill() fails (EPERM under sudo).
    // That is not an exit; only a failed start is.
    child.on("error", (error) => {
      if (spawned) return log.error(`cannot signal ${label}`, { pid: child.pid, error });
      log.error(`${label} spawn failed`, { error });
      resolve(null);
    });
  });
  void childExit.then(release);
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => {
      spawned = true;
      resolve();
    });
    child.once("error", (cause) => reject(new ProcessError(`Cannot start the ${label} wrapper`, { cause })));
  });
  const pid = child.pid;
  log.debug(`${label} started`, { pid, args: options.args?.filter((arg) => arg.startsWith("--")) });
  const tap = makeTap?.(pid);

  /** True when the child exited within `ms`. */
  const waitExit = (ms: number) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      childExit.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  /** Best effort; a refused signal is logged once per attempt, not thrown. */
  const signal = (name: NodeJS.Signals) => {
    if (gone()) return;
    let delivered = false;
    try {
      delivered = child.kill(name);
    } catch (error) {
      log.error(`cannot signal ${label}`, { pid, signal: name, error });
      return;
    }
    if (!delivered && !gone())
      log.error(`${label} stop signal not delivered (sudo may run as root: EPERM); relying on stdin EOF`, {
        pid,
        signal: name,
      });
  };

  let killing: Promise<void> | undefined;
  const kill = () =>
    (killing ??= (async () => {
      if (gone()) return;
      const started = Date.now();
      child.stdin.end();
      if (await waitExit(PROCESS_KILL_GRACE_MS)) return;
      signal("SIGTERM");
      if (await waitExit(PROCESS_KILL_GRACE_MS)) return;
      signal("SIGKILL");
      if (await waitExit(Math.max(0, PROCESS_STOP_MAX_MS - (Date.now() - started)))) return;
      // Left running: systemd's stop (root) still ends it with the unit.
      log.error(`${label} did not exit; giving up on it and freeing its turn`, { pid, elapsedMs: Date.now() - started });
      release(null);
    })());

  // One stream-json line may not grow past the cap: ClaudeProcess buffers a
  // partial line in memory, so a runaway line would grow the runner.
  // Destroying the pipe also makes the child's next write fail (EPIPE),
  // which stops it even where signals are refused.
  const decoder = new StringDecoder("utf8");
  let lineBytes = 0;
  let overflowed = false;
  child.stdout.on("data", (chunk: Buffer) => {
    if (overflowed) return;
    const newline = chunk.lastIndexOf(NEWLINE);
    const longest = newline < 0 ? lineBytes + chunk.length : Math.max(lineBytes + chunk.indexOf(NEWLINE), chunk.length - newline - 1);
    lineBytes = newline < 0 ? lineBytes + chunk.length : chunk.length - newline - 1;
    if (longest > STDOUT_LINE_MAX_BYTES) {
      overflowed = true;
      log.error(`${label} output line over cap; stopping it`, { pid, capBytes: STDOUT_LINE_MAX_BYTES });
      child.stdout.destroy();
      void kill();
      return;
    }
    const text = decoder.write(chunk);
    options.onStdout?.(text);
    tap?.stdout(text);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (data: string) => options.onStderr?.(data));
  // A broken pipe after exit is reported through `exited`, not as a crash.
  child.stdin.on("error", () => undefined);

  const write = (data: string) =>
    new Promise<void>((resolve, reject) => {
      if (!child.stdin.writable) return reject(new ProcessError(`${label} stdin is closed`));
      tap?.stdin(data);
      child.stdin.write(data, "utf8", (error) =>
        error ? reject(new ProcessError(`${label} stdin write failed`, { cause: error })) : resolve(),
      );
    });
  const end = async (data?: string) => {
    if (data) await write(data);
    child.stdin.end();
  };
  if (pid !== undefined) spec.children.add(pid, kill, childExit);
  return Object.freeze({ write, end, kill, exited });
}

/** The telemetry tap of one claude process, which needs the session its
 * args launch: `--resume` resumes one, `--session-id` starts one. */
function openTap(target: SpawnTarget, options: HostProcessOptions, log: Logger, pid: number | undefined) {
  const args = options.args ?? [];
  const flag = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };
  const resume = flag(RESUME_FLAG);
  const session = resume ?? flag(SESSION_FLAG);
  if (!target.tap || !session) return undefined;
  return lineTap(target.tap(session, resume === undefined, options.cwd), log, pid);
}

/** `tap` fed with decoded stdout split into lines, and raw stdin writes. A
 * tap failure is logged once and the tap stops: telemetry must never break
 * the turn it observes. Line length is capped by `startChild`, so the
 * partial line kept here is bounded too. */
function lineTap(tap: StreamTap | undefined, log: Logger, pid: number | undefined) {
  if (!tap) return undefined;
  // A partial line is kept as pieces and joined once its newline arrives, so
  // a long line costs one copy, not one per chunk.
  let pieces: string[] = [];
  let broken = false;
  const guard = (run: () => void) => {
    if (broken) return;
    try {
      run();
    } catch (error) {
      broken = true;
      log.warn("telemetry tap failed; this process is no longer observed", { pid, error });
    }
  };
  return {
    stdout: (text: string) =>
      guard(() => {
        if (!text.includes("\n")) {
          pieces.push(text);
          return;
        }
        const lines = text.split("\n");
        const last = lines.pop() ?? "";
        lines[0] = pieces.join("") + lines[0];
        pieces = last ? [last] : [];
        for (const line of lines) tap.stdout(line);
      }),
    stdin: (data: string) => guard(() => tap.stdin(data)),
  };
}
