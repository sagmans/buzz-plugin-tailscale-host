// buzz-runner's Pi launcher: what `harness-wrapper pi <agent>` runs, as the
// harness user, in place of buzz-app's launch.mjs. Install to
// /usr/local/libexec/buzz-runner/pi-launch.mjs (root:root, 0644).
// Adapted from buzz-app src/bundled/pi/launch.mjs (Apache-2.0, Copyright 2026
// Block, Inc.; see NOTICE).
//
// buzz-app's launcher installs Pi's packages with `npm ci` on first start.
// Here they are installed once by root, read-only, at BUZZ_PI_MODULES, so a
// hosted agent never runs npm or reaches a registry. The first stdin line is
// still buzz-app's { host, package, lock } (pi.ts sends it): the packages
// `lock` pins must be exactly the ones installed, or the launcher stops, so
// a buzz-app upgrade that moves Pi's versions fails closed until root
// installs the new set. The host source then runs from the agent's own data
// folder, where `node_modules` links to the installed packages, as
// buzz-app's runs from its packages folder. The rest of stdin is the host's.
//
// Inputs, all set by the root-owned wrapper (env -i), none by the runner:
//   BUZZ_PI_DATA     the agent's Pi data folder (its SQLite storage)
//   BUZZ_PI_MODULES  the root-installed node_modules of Pi's packages
// The runner's only input is the first stdin line. It runs as the harness
// user, which the runner already drives with prompts, so it grants nothing
// new; it is still checked for shape and size before any of it is used.
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";

/** Exit codes: a usage or input fault, and a host that cannot run here. */
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
/** Pi's packages need `node:sqlite`, in Node 22.19 and later. */
const NODE_MIN = [22, 19];
/** The first line is about 90 KB today (host source plus lock); anything
 * past this is not what pi.ts sends. */
const FIRST_LINE_MAX_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
/** Private to the harness user: Pi's storage holds whole conversations. */
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const HOST_DIR = "host";
const HOST_PREFIX = "host-";
const HOST_SUFFIX = ".mjs";
const HASH_CHARS = 16;
const LOCK_ROOT = "";
const NODE_MODULES = "node_modules";

/** One line to stderr, which the runner keeps as the start failure's cause. */
const fail = (message, code = EXIT_UNAVAILABLE) => {
  console.error(`Pi could not start: ${message}`);
  process.exit(code);
};

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < NODE_MIN[0] || (major === NODE_MIN[0] && minor < NODE_MIN[1]))
  fail(`it needs Node.js ${NODE_MIN.join(".")} or later, not ${process.versions.node}`);
// `node:sqlite` says it is experimental on every start; nothing else is hidden.
process.removeAllListeners("warning").on("warning", (warning) => {
  if (warning.name !== "ExperimentalWarning") console.error(String(warning));
});

/** An absolute, normalized folder path from the wrapper's environment. */
function folder(name) {
  const value = process.env[name];
  if (!value || !isAbsolute(value) || normalize(value) !== value) fail(`${name} must be an absolute, normalized path`, EXIT_USAGE);
  return value;
}
const data = folder("BUZZ_PI_DATA");
const modules = folder("BUZZ_PI_MODULES");

/** The first line of stdin, at most FIRST_LINE_MAX_BYTES; what follows it
 * stays for the host (buzz-app launch.mjs reads it the same way). */
const firstLine = () =>
  new Promise((resolve, reject) => {
    let data = Buffer.alloc(0);
    const done = () => process.stdin.off("readable", read).off("end", end);
    const read = () => {
      for (let chunk = process.stdin.read(); chunk !== null; chunk = process.stdin.read()) {
        data = Buffer.concat([data, chunk]);
        const newline = data.indexOf(NEWLINE);
        if (newline < 0) {
          if (data.length > FIRST_LINE_MAX_BYTES) {
            done();
            reject(new Error(`its first input line is over ${FIRST_LINE_MAX_BYTES} bytes`));
          }
          continue;
        }
        done();
        if (newline + 1 < data.length) process.stdin.unshift(data.subarray(newline + 1));
        resolve(data.subarray(0, newline).toString("utf8"));
        return;
      }
    };
    const end = () => {
      done();
      reject(new Error("it was given nothing to run"));
    };
    process.stdin.on("readable", read).on("end", end);
  });

let input;
try {
  input = JSON.parse(await firstLine());
} catch (error) {
  fail(error instanceof SyntaxError ? "its first input line is not JSON" : error.message, EXIT_USAGE);
}
const { host, package: pkg, lock } = input ?? {};
if (typeof host !== "string" || typeof pkg !== "string" || typeof lock !== "string" || !host)
  fail("its first input line must hold host, package and lock text", EXIT_USAGE);

/** The installed version of the package at lock path `path`, if any. */
function installed(path) {
  try {
    return JSON.parse(readFileSync(join(dirname(modules), path, "package.json"), "utf8")).version;
  } catch {
    return undefined;
  }
}

// Every package the lock pins for production must be installed at exactly
// that version: the packages the host imports, and theirs. Optional ones
// (other platforms' builds) may be absent, never different.
let pinned;
try {
  pinned = JSON.parse(lock).packages;
  const wanted = JSON.parse(pkg).dependencies;
  if (!pinned || typeof pinned !== "object" || !wanted || typeof wanted !== "object") throw new Error("no packages");
  for (const [name, version] of Object.entries(wanted))
    if (pinned[`${NODE_MODULES}/${name}`]?.version !== version) throw new Error(`lock and package disagree on ${name}`);
} catch (error) {
  fail(`its package lock is unreadable (${error.message})`, EXIT_USAGE);
}
const drift = [];
for (const [path, entry] of Object.entries(pinned)) {
  if (path === LOCK_ROOT || entry?.dev === true || entry?.link === true) continue;
  if (!path.startsWith(`${NODE_MODULES}/`) || normalize(path) !== path || path.includes(".."))
    fail(`its package lock names an unsafe path ${JSON.stringify(path)}`, EXIT_USAGE);
  const found = installed(path);
  if (found === undefined && entry?.optional === true) continue;
  if (found !== entry?.version) drift.push(`${path.slice(NODE_MODULES.length + 1)} ${entry?.version} (installed: ${found ?? "none"})`);
}
if (drift.length)
  fail(`the installed Pi packages are not the ones this Buzz pins. Install them as root at ${modules}. Differs: ${drift.join(", ")}`);

// The agent's folder: its storage, and the host source beside a link to the
// installed packages, so the host's imports resolve there.
const hostDir = join(data, HOST_DIR);
try {
  mkdirSync(hostDir, { recursive: true, mode: DIR_MODE });
  chmodSync(data, DIR_MODE);
  chmodSync(hostDir, DIR_MODE);
  const link = join(hostDir, NODE_MODULES);
  let current;
  try {
    current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : null;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current !== modules) {
    if (current !== undefined) rmSync(link, { recursive: true, force: true });
    symlinkSync(modules, link, "dir");
  }
} catch (error) {
  fail(`cannot prepare ${hostDir} (${error.code ?? error.message})`);
}

// One file per host source, written whole (temp file, then rename), so a
// host starting meanwhile never reads half of one. Older sources go.
const name = `${HOST_PREFIX}${createHash("sha256").update(host).digest("hex").slice(0, HASH_CHARS)}${HOST_SUFFIX}`;
const file = join(hostDir, name);
try {
  const part = `${file}.${process.pid}`;
  writeFileSync(part, host, { mode: FILE_MODE });
  renameSync(part, file);
  for (const entry of readdirSync(hostDir))
    if (entry !== name && entry.startsWith(HOST_PREFIX)) rmSync(join(hostDir, entry), { force: true });
} catch (error) {
  fail(`cannot write the host source (${error.code ?? error.message})`);
}

process.chdir(hostDir);
process.env.BUZZ_PI_HOST = "1";
process.argv[1] = data;
await import(pathToFileURL(file).href);
