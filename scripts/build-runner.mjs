#!/usr/bin/env node
// Type-checks and bundles buzz-runner with the linked buzz-app toolchain
// (scripts/link-toolchain). The bundle embeds buzz-app modules, so it is only
// built from the exact buzz-app revision the runner names (BUZZ_APP_REV in
// runner/src/constants.ts) with no local edits: /v1/health then tells the
// truth about which Desktop behavior a host runs.
//
// Usage: node scripts/build-runner.mjs [--out <dir>] [--check-only]
//   --out <dir>     write buzz-runner.mjs there instead of runner/dist
//   --check-only    type-check only, no bundle
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNNER = join(ROOT, "runner");
const CLONE_LINK = join(RUNNER, "buzz-app");
const MODULES_LINK = join(RUNNER, "node_modules");
const CONSTANTS = join(RUNNER, "src", "constants.ts");
const REV_PATTERN = /export const BUZZ_APP_REV = "([0-9a-f]{7,40})";/;
/** Read by runner/vite.config.ts. */
const OUT_DIR_ENV = "BUZZ_RUNNER_OUT_DIR";
/** Local compiles only, but a hung tool must still end the build. */
const GIT_TIMEOUT_MS = 30_000;
const TSC_TIMEOUT_MS = 5 * 60_000;
const VITE_TIMEOUT_MS = 5 * 60_000;
const EXIT_USAGE = 64;
const EXIT_CONFIG = 78;

/** A build precondition or step that failed, with what to do about it. */
class BuildError extends Error {
  constructor(message, { exit = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "BuildError";
    this.exit = exit;
  }
}

function parseArgs(argv) {
  const options = { out: undefined, checkOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check-only") options.checkOnly = true;
    else if (arg === "--out") {
      const value = argv[i + 1];
      if (!value) throw new BuildError("--out needs a directory", { exit: EXIT_USAGE });
      options.out = resolve(value);
      i += 1;
    } else throw new BuildError(`unknown argument: ${arg}`, { exit: EXIT_USAGE });
  }
  return options;
}

/** Runs a tool with a bounded wait; output goes straight to the terminal. */
function run(label, command, args, { cwd = ROOT, env = process.env, timeout, capture = false } = {}) {
  const started = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  const elapsedMs = Date.now() - started;
  if (result.error)
    throw new BuildError(`${label} could not run (${command}, ${elapsedMs} ms)`, { cause: result.error });
  if (result.signal) throw new BuildError(`${label} stopped by ${result.signal} after ${elapsedMs} ms (limit ${timeout} ms)`);
  if (result.status !== 0)
    throw new BuildError(`${label} failed with exit ${result.status} after ${elapsedMs} ms${capture ? `: ${result.stderr.trim()}` : ""}`);
  return capture ? result.stdout.trim() : "";
}

function checkLinks() {
  for (const path of [CLONE_LINK, MODULES_LINK]) {
    let isLink = false;
    try {
      isLink = lstatSync(path).isSymbolicLink();
    } catch {
      isLink = false;
    }
    if (!isLink || !existsSync(path))
      throw new BuildError(`${path} is missing: run scripts/link-toolchain <buzz-app clone> first`, { exit: EXIT_CONFIG });
  }
}

/** The clone must be at the runner's pinned revision with no tracked edits. */
function checkRevision() {
  const match = REV_PATTERN.exec(readFileSync(CONSTANTS, "utf8"));
  if (!match) throw new BuildError(`BUZZ_APP_REV not found in ${CONSTANTS}`, { exit: EXIT_CONFIG });
  const pinned = match[1];
  const git = (args) => run("git", "git", ["-C", CLONE_LINK, ...args], { capture: true, timeout: GIT_TIMEOUT_MS });
  const head = git(["rev-parse", "HEAD"]);
  if (!head.startsWith(pinned))
    throw new BuildError(`buzz-app clone is at ${head.slice(0, 12)}, the runner pins ${pinned}: check out ${pinned} and reinstall`, {
      exit: EXIT_CONFIG,
    });
  const dirty = git(["status", "--porcelain", "--untracked-files=no"]);
  if (dirty) throw new BuildError(`buzz-app clone has local edits; the bundle must hold its pinned code only:\n${dirty}`, { exit: EXIT_CONFIG });
  return pinned;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  checkLinks();
  const rev = checkRevision();
  const bin = (name) => join(MODULES_LINK, ".bin", name);
  run("tsc", bin("tsc"), ["-p", join(RUNNER, "tsconfig.json")], { timeout: TSC_TIMEOUT_MS });
  console.log(`typecheck ok (buzz-app ${rev})`);
  if (options.checkOnly) return;
  const env = { ...process.env };
  if (options.out) env[OUT_DIR_ENV] = options.out;
  else delete env[OUT_DIR_ENV];
  // From the clone, as buzz-app builds: the bundle names each module by its
  // path relative to the working directory, so no local path leaks into it.
  run("vite build", bin("vite"), ["build", "--config", join(RUNNER, "vite.config.ts")], { cwd: CLONE_LINK, env, timeout: VITE_TIMEOUT_MS });
  console.log(`bundle: ${join(options.out ?? join(RUNNER, "dist"), "buzz-runner.mjs")}`);
}

try {
  main();
} catch (error) {
  console.error(`build-runner: ${error.message}`);
  if (error.cause) console.error(`  cause: ${error.cause.message ?? error.cause}`);
  process.exit(error.exit ?? 1);
}
