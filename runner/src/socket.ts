// The API's only listener: a Unix socket. On a loopback TCP port any local
// user could connect and send a forged `Tailscale-User-Login` header; a socket
// in a 0700 directory owned by the runner user can be reached only by that
// user and root, which is what `tailscale serve` (tailscaled) runs as.
import { chmodSync, lstatSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import type { Server } from "node:http";
import { dirname } from "node:path";
import { SOCKET_DIR_MODE, SOCKET_MODE } from "./constants";
import { ConfigError } from "./errors";

/** How long a probe of an existing socket may take before it is called stale. */
const PROBE_TIMEOUT_MS = 1_000;
/** Mask while binding, so the socket is never briefly wider than 0600. */
const BIND_UMASK = 0o177;

const mode = (value: number) => (value & 0o777).toString(8).padStart(3, "0");

/** Refuses a directory another user could reach: the socket's safety rests
 * entirely on it. */
function checkDirectory(dir: string) {
  let info;
  try {
    info = lstatSync(dir);
  } catch (cause) {
    throw new ConfigError(`Socket directory ${dir} does not exist`, { cause });
  }
  if (!info.isDirectory()) throw new ConfigError(`Socket directory ${dir} is not a directory`);
  if ((info.mode & 0o777) !== SOCKET_DIR_MODE)
    throw new ConfigError(`Socket directory ${dir} must have mode ${mode(SOCKET_DIR_MODE)}, has ${mode(info.mode)}`);
  if (info.uid !== process.getuid?.())
    throw new ConfigError(`Socket directory ${dir} must be owned by the runner user (uid ${process.getuid?.()}), is uid ${info.uid}`);
}

/** Whether something answers on `path` (another runner still running). */
function answers(path: string) {
  return new Promise<boolean>((resolve) => {
    const probe = connect(path);
    const done = (alive: boolean) => {
      clearTimeout(timer);
      probe.destroy();
      resolve(alive);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

/** A socket left by a crash is removed; anything else at the path, or a
 * socket that still answers, stops the start instead of being replaced. */
async function clearStale(path: string) {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (!info.isSocket() || info.uid !== process.getuid?.())
    throw new ConfigError(`${path} exists and is not a socket of the runner user`);
  if (await answers(path)) throw new ConfigError(`${path} is in use by another process`);
  unlinkSync(path);
}

/** The startup checks alone, so a bad directory stops the runner before any
 * agent connects to its relay. `listenSocket` runs them again at bind time. */
export async function checkSocket(path: string) {
  checkDirectory(dirname(path));
  await clearStale(path);
}

export async function listenSocket(server: Server, path: string) {
  await checkSocket(path);
  const previous = process.umask(BIND_UMASK);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } finally {
    process.umask(previous);
  }
  chmodSync(path, SOCKET_MODE);
}
