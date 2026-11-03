// The generic harness wrapper's self-report: `harness-wrapper <id> --path`
// prints the install path the root-owned wrapper runs for `id`. The runner's
// config names that path too (`harnesses.<id>.path`); a harness counts as
// installed only when both agree, so a config that drifted from what the
// wrapper really runs shows as not installed instead of running something
// other than what the owner sees.
import { spawn } from "node:child_process";
import { CHILD_CWD, CHILD_PATH, WRAPPER_PATH_FLAG, WRAPPER_PATH_MAX_BYTES, WRAPPER_PATH_TIMEOUT_MS } from "./constants";
import { ProcessError } from "./errors";

export type WrapperTarget = Readonly<{ sudo: string; runAsUser: string; wrapper: string }>;

/** `sudo -n -u`: never prompt, so a missing sudoers rule fails, not hangs. */
const SUDO_PREFIX = ["-n", "-u"] as const;

/** The path the wrapper runs for `harness`. Rejects when the wrapper cannot
 * be run, refuses the id, prints more than one path line, or does not
 * answer in WRAPPER_PATH_TIMEOUT_MS. */
export function wrapperPath(target: WrapperTarget, harness: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      target.sudo,
      [...SUDO_PREFIX, target.runAsUser, "--", target.wrapper, harness, WRAPPER_PATH_FLAG],
      // Nothing of the runner's environment crosses: sudo resets it anyway.
      { cwd: CHILD_CWD, env: { PATH: CHILD_PATH }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    let err = "";
    let settled = false;
    const finish = (error: Error | undefined, path?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (error) reject(error);
      else resolve(path as string);
    };
    const timer = setTimeout(
      () => finish(new ProcessError(`${harness} wrapper path check took over ${WRAPPER_PATH_TIMEOUT_MS} ms`)),
      WRAPPER_PATH_TIMEOUT_MS,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      out += data;
      if (Buffer.byteLength(out) > WRAPPER_PATH_MAX_BYTES)
        finish(new ProcessError(`${harness} wrapper path answer is over ${WRAPPER_PATH_MAX_BYTES} bytes`));
    });
    child.stderr.setEncoding("utf8");
    // Kept short: it is for the log, and the wrapper's words are not trusted.
    child.stderr.on("data", (data: string) => (err = (err + data).slice(-WRAPPER_PATH_MAX_BYTES)));
    child.once("error", (cause) => finish(new ProcessError(`Cannot run the ${harness} wrapper path check`, { cause })));
    child.once("close", (code) => {
      const path = out.replace(/\n$/, "");
      if (code !== 0)
        return finish(new ProcessError(`${harness} wrapper path check exited ${code ?? "on a signal"}: ${err.trim()}`));
      if (!path || path.includes("\n") || !path.startsWith("/"))
        return finish(new ProcessError(`${harness} wrapper path answer is not one absolute path`));
      finish(undefined, path);
    });
  });
}
