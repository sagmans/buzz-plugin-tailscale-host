#!/usr/bin/env node
// Builds the installable plugin for the user's own host list. hosts.json
// (gitignored, see hosts.example.json) is the one host list, and it stays
// outside the build: the manifest grants one host process, node on
// scripts/hosts-helper.mjs with this hosts file fixed as its argument. The
// plugin reads and saves the list through it, and the helper carries every
// runner call to the origin the list names. So a host change, on the
// Settings page or by hand, works at once, without a new build or an Update.
// Buzz would grant a plugin only the origins of its installed manifest, and
// change them only at an Update, which is why the manifest declares none.
//
// A build is needed once per checkout (the manifest holds its absolute
// paths), and again only when the plugin's code changes.
//
// Usage: node scripts/build-plugin.mjs [--hosts <hosts.json>] [--out <dir>]
//   defaults: --hosts ./hosts.json  --out ./dist
// Exit codes: 0 built, 64 usage, 65 invalid hosts file, 1 other failure.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DIR = join(ROOT, "plugin");
const DEFAULT_HOSTS = join(ROOT, "hosts.json");
const DEFAULT_OUT = join(ROOT, "dist");
const MANIFEST = "manifest.json";
const MODULE = "plugin.js";
const PLUGIN_ID_PATTERN = /^const PLUGIN_ID = "([^"]+)";$/m;
/** The plugin asks each host for its status every minute, so the list
 * stays short (plugin.js HOSTS_MAX). */
const HOSTS_MAX = 16;
/** A host id is saved in each agent's config and shown nowhere else. */
const HOST_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** The plugin cuts runner-reported titles at 40 characters; labels match. */
const LABEL_MAX = 40;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HOST_KEYS = ["id", "label", "origin"];
/** The port of the runner's `tailscale serve` (runner/README.md, Deploy).
 * The user enters only the machine's address; the port is an internal fact
 * of the runner install, so the helper adds it to an origin without one
 * (plugin.js RUNNER_PORT). */
export const RUNNER_PORT = 10000;
/** The host process the plugin starts (plugin.js HOSTS_PROCESS). */
export const HOSTS_PROCESS = "hosts";
/** Desktop resolves a process's program by name on the login shell's PATH;
 * a path is not allowed there (crates/plugin-manager valid_program). */
const HELPER_PROGRAM = "node";
const HELPER = join(ROOT, "scripts", "hosts-helper.mjs");
/** Desktop's limit on one declared argument. */
const HELPER_ARG_MAX = 1024;
/** `node --check` of the output; local and fast, but still bounded. */
const CHECK_TIMEOUT_MS = 30_000;
const EXIT_USAGE = 64;
const EXIT_DATA = 65;

/** A build input that is wrong, with the file and field to fix. */
export class PluginBuildError extends Error {
  constructor(message, { exit = 1, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "PluginBuildError";
    this.exit = exit;
  }
}

const invalid = (where, message) => new PluginBuildError(`${where}: ${message}`, { exit: EXIT_DATA });

/** One origin exactly as the URL standard serializes it: HTTPS, no
 * credentials, path, query or fragment, lowercase host, no default :443. The
 * helper joins it with a runner path, so anything more would change where a
 * call goes. */
function checkOrigin(value, where) {
  if (typeof value !== "string" || !value) throw invalid(where, "origin must be a non-empty string");
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new PluginBuildError(`${where}: origin is not a URL: ${value}`, { exit: EXIT_DATA, cause });
  }
  if (url.protocol !== "https:") throw invalid(where, `origin must use https:// (got ${value})`);
  if (url.username || url.password) throw invalid(where, "origin must not carry credentials");
  if (url.origin !== value)
    throw invalid(where, `origin must be exactly scheme://host[:port] with no path or trailing slash; write it as ${url.origin}`);
  return value;
}

/** The origin a host's runner answers on: the host's origin, with
 * RUNNER_PORT when it names no port. A port that the user wrote stays, so a
 * runner served on another port can still be listed. The origin is already
 * checked, so `new URL` cannot fail here. */
export function runnerOrigin(origin) {
  const url = new URL(origin);
  if (!url.port) url.port = String(RUNNER_PORT);
  return url.origin;
}

/** Validates the parsed hosts file and returns the host list in file order. */
export function validateHosts(raw, source = "hosts.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(source, 'must be an object: { "hosts": [ ... ] }');
  const extra = Object.keys(raw).filter((key) => key !== "hosts");
  if (extra.length) throw invalid(source, `unknown keys: ${extra.join(", ")}`);
  const { hosts } = raw;
  if (!Array.isArray(hosts) || !hosts.length) throw invalid(source, "hosts must be a non-empty array");
  if (hosts.length > HOSTS_MAX) throw invalid(source, `at most ${HOSTS_MAX} hosts`);
  const ids = new Set();
  const origins = new Set();
  return hosts.map((host, index) => {
    const where = `${source} hosts[${index}]`;
    if (!host || typeof host !== "object" || Array.isArray(host)) throw invalid(where, "must be an object");
    const unknown = Object.keys(host).filter((key) => !HOST_KEYS.includes(key));
    if (unknown.length) throw invalid(where, `unknown keys: ${unknown.join(", ")}`);
    const { id, label, origin } = host;
    if (typeof id !== "string" || !HOST_ID.test(id))
      throw invalid(where, "id must be 1-32 lowercase letters, digits or inner hyphens (it is saved in each agent's config)");
    if (ids.has(id)) throw invalid(where, `duplicate id ${id}`);
    if (typeof label !== "string" || !label.trim() || label !== label.trim() || label.length > LABEL_MAX || CONTROL_CHARS.test(label))
      throw invalid(where, `label must be 1-${LABEL_MAX} printable characters without leading or trailing spaces`);
    checkOrigin(origin, where);
    // Two spellings of one runner (with and without RUNNER_PORT) are one host.
    if (origins.has(runnerOrigin(origin))) throw invalid(where, `duplicate origin ${origin}`);
    ids.add(id);
    origins.add(runnerOrigin(origin));
    return { id, label, origin };
  });
}

export function readJson(path, what) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (cause) {
    const hint = what === "hosts file" ? " (copy hosts.example.json to hosts.json and edit it)" : "";
    throw new PluginBuildError(`cannot read ${what} ${path}${hint}`, { exit: EXIT_USAGE, cause });
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new PluginBuildError(`${path}: not valid JSON`, { exit: EXIT_DATA, cause });
  }
}

/** Writes beside the target and renames, so an install never reads half a file. */
export function writeAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** The process that keeps this same hosts file and carries the plugin's
 * runner calls. Its arguments are fixed in the manifest, and the helper
 * refuses any the plugin adds, so the plugin can choose neither the program
 * nor the file. */
function helperProcess(hostsPath) {
  const args = [HELPER, "--hosts", hostsPath];
  const long = args.find((arg) => arg.length > HELPER_ARG_MAX);
  if (long) throw new PluginBuildError(`path longer than ${HELPER_ARG_MAX} characters, which Buzz refuses: ${long}`, { exit: EXIT_USAGE });
  return { id: HOSTS_PROCESS, program: HELPER_PROGRAM, args };
}

/** Builds dist for a hosts file; returns the folder and the file's hosts.
 * The file is checked so a first build names a mistake at once, but its
 * hosts do not go into the build. */
export function buildPlugin({ hostsPath = DEFAULT_HOSTS, outDir = DEFAULT_OUT } = {}) {
  const out = resolve(outDir);
  if (out === SOURCE_DIR) throw new PluginBuildError("--out must not be the plugin/ source folder", { exit: EXIT_USAGE });
  const hosts = validateHosts(readJson(hostsPath, "hosts file"), hostsPath);
  const manifest = readJson(join(SOURCE_DIR, MANIFEST), "manifest");
  const source = readFileSync(join(SOURCE_DIR, MODULE), "utf8");

  const declared = PLUGIN_ID_PATTERN.exec(source)?.[1];
  if (declared !== manifest.id)
    throw new PluginBuildError(`plugin.js PLUGIN_ID (${declared}) differs from manifest id (${manifest.id})`);
  if (manifest.host !== undefined)
    throw new PluginBuildError("plugin/manifest.json must not declare host: the build writes it for this checkout");

  const builtManifest = { ...manifest, host: { processes: [helperProcess(resolve(hostsPath))] } };
  mkdirSync(out, { recursive: true });
  const modulePath = join(out, MODULE);
  writeAtomic(modulePath, source);
  const check = spawnSync(process.execPath, ["--check", modulePath], { encoding: "utf8", timeout: CHECK_TIMEOUT_MS });
  if (check.error || check.status !== 0)
    throw new PluginBuildError(`built ${modulePath} does not parse: ${check.stderr || check.error?.message}`);
  writeAtomic(join(out, MANIFEST), `${JSON.stringify(builtManifest, null, 2)}\n`);
  return { outDir: out, hosts };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || !["--hosts", "--out"].includes(flag))
      throw new PluginBuildError("usage: node scripts/build-plugin.mjs [--hosts <hosts.json>] [--out <dir>]", { exit: EXIT_USAGE });
    options[flag === "--hosts" ? "hostsPath" : "outDir"] = resolve(value);
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const { outDir, hosts } = buildPlugin(parseArgs(process.argv.slice(2)));
    console.log(`built ${outDir} for ${hosts.length} host(s): ${hosts.map((host) => host.id).join(", ")}`);
  } catch (error) {
    console.error(`build-plugin: ${error.message}`);
    process.exit(error.exit ?? 1);
  }
}
