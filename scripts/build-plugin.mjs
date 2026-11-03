#!/usr/bin/env node
// Builds the installable plugin from the user's own host list. Buzz grants
// network access only to the exact origins in `host.networkOrigins` (no
// wildcards), so the hosts cannot ship in the source: each user writes a
// local hosts.json (gitignored, see hosts.example.json) and this script
// writes dist/manifest.json with those origins and dist/plugin.js with the
// same list. Both must agree, which is why one script writes both.
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
/** The one place in plugin/plugin.js the host list goes. */
const HOSTS_MARKER = "/* @build:hosts */ []";
const PLUGIN_ID_PATTERN = /^const PLUGIN_ID = "([^"]+)";$/m;
/** Buzz's own limit on declared origins (crates/plugin-manager). */
const HOSTS_MAX = 16;
/** A host id is saved in each agent's config and shown nowhere else. */
const HOST_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
/** The plugin cuts runner-reported titles at 40 characters; labels match. */
const LABEL_MAX = 40;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HOST_KEYS = ["id", "label", "origin"];
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

/** One origin exactly as Buzz compares it: HTTPS, no credentials, path,
 * query or fragment, and written the way the URL standard serializes it
 * (lowercase host, no default :443), or Buzz rejects the manifest. */
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

/** Validates the parsed hosts file and returns the host list in file order. */
export function validateHosts(raw, source = "hosts.json") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid(source, 'must be an object: { "hosts": [ ... ] }');
  const extra = Object.keys(raw).filter((key) => key !== "hosts");
  if (extra.length) throw invalid(source, `unknown keys: ${extra.join(", ")}`);
  const { hosts } = raw;
  if (!Array.isArray(hosts) || !hosts.length) throw invalid(source, "hosts must be a non-empty array");
  if (hosts.length > HOSTS_MAX) throw invalid(source, `at most ${HOSTS_MAX} hosts (Buzz allows ${HOSTS_MAX} network origins)`);
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
    if (origins.has(origin)) throw invalid(where, `duplicate origin ${origin}`);
    ids.add(id);
    origins.add(origin);
    return { id, label, origin };
  });
}

function readJson(path, what) {
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
function writeAtomic(path, text) {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** Builds dist from a hosts file; returns what it wrote. */
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
    throw new PluginBuildError("plugin/manifest.json must not declare host: the build writes it from hosts.json");
  const parts = source.split(HOSTS_MARKER);
  if (parts.length !== 2) throw new PluginBuildError(`plugin.js must hold the marker ${HOSTS_MARKER} exactly once`);

  const built = parts.join(JSON.stringify(hosts, null, 2));
  const builtManifest = { ...manifest, host: { networkOrigins: hosts.map((host) => host.origin) } };
  mkdirSync(out, { recursive: true });
  const modulePath = join(out, MODULE);
  writeAtomic(modulePath, built);
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
