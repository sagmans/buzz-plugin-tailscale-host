#!/usr/bin/env node
// Lets the plugin's Settings page read and save hosts.json, the one host
// list. Buzz Desktop lets a plugin neither write files nor change the
// origins it may reach, so the build (scripts/build-plugin.mjs) declares
// this helper as the plugin's one host command, with the hosts file and
// output folder fixed in the manifest. A save writes hosts.json and builds
// the plugin again, so Desktop offers Update with the new origins; an edit
// of hosts.json by hand, then a build, gives the same result.
//
// Usage: node scripts/hosts-helper.mjs --hosts <hosts.json> --out <dir>
// stdin: one JSON request, from the plugin (treated as untrusted input):
//   {"op":"read"}                  the hosts in the file
//   {"op":"save","hosts":[...]}    write the file, then build
//   {"op":"build"}                 build from the file as it is
// stdout: one JSON reply: {"ok":true,"hosts":[...],"built":bool} or
//   {"ok":false,"error":"..."}. A refused request still exits 0, because
//   Desktop drops the output of a command that fails, and the page must
//   show why. Exit 64 only for wrong arguments, which is a build fault.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { HELPER_INPUT_MAX, PluginBuildError, buildPlugin, readJson, validateHosts, writeAtomic } from "./build-plugin.mjs";

const OPS = ["read", "save", "build"];
const REQUEST_KEYS = { read: ["op"], save: ["op", "hosts"], build: ["op"] };
/** The page shows the reason as text; a long cause chain helps nobody there. */
const ERROR_MAX = 500;
const EXIT_USAGE = 64;
const USAGE = "usage: node scripts/hosts-helper.mjs --hosts <hosts.json> --out <dir>";

/** A request the helper refuses, with the reason the page shows. */
export class HostsHelperError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HostsHelperError";
  }
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (!value || !["--hosts", "--out"].includes(flag) || options[flag]) throw new PluginBuildError(USAGE, { exit: EXIT_USAGE });
    options[flag] = resolve(value);
  }
  if (!options["--hosts"] || !options["--out"]) throw new PluginBuildError(USAGE, { exit: EXIT_USAGE });
  return { hostsPath: options["--hosts"], outDir: options["--out"] };
}

/** The request as the plugin may send it, and nothing else. */
export function parseRequest(text) {
  if (Buffer.byteLength(text, "utf8") > HELPER_INPUT_MAX) throw new HostsHelperError(`request is larger than ${HELPER_INPUT_MAX} bytes`);
  let request;
  try {
    request = JSON.parse(text);
  } catch (cause) {
    throw new HostsHelperError("request is not JSON", { cause });
  }
  if (!request || typeof request !== "object" || Array.isArray(request) || !OPS.includes(request.op))
    throw new HostsHelperError(`request op must be one of ${OPS.join(", ")}`);
  const extra = Object.keys(request).filter((key) => !REQUEST_KEYS[request.op].includes(key));
  if (extra.length) throw new HostsHelperError(`unknown request keys: ${extra.join(", ")}`);
  return request;
}

/** Writes the new list, then builds. When the build fails, the earlier file
 * comes back, so hosts.json never holds a list that the plugin was not
 * built from by this helper. */
function save(hosts, { hostsPath, outDir }) {
  // The build checks it again; checking first keeps a bad list out of the file.
  const clean = validateHosts({ hosts }, "hosts");
  const before = existsSync(hostsPath) ? readFileSync(hostsPath, "utf8") : undefined;
  writeAtomic(hostsPath, `${JSON.stringify({ hosts: clean }, null, 2)}\n`);
  try {
    return buildPlugin({ hostsPath, outDir }).hosts;
  } catch (error) {
    if (before !== undefined) writeAtomic(hostsPath, before);
    throw error;
  }
}

/** Runs one request; returns the reply object. */
export function handle(request, paths) {
  if (request.op === "read") return { ok: true, hosts: validateHosts(readJson(paths.hostsPath, "hosts file"), paths.hostsPath), built: false };
  if (request.op === "build") return { ok: true, hosts: buildPlugin(paths).hosts, built: true };
  return { ok: true, hosts: save(request.hosts, paths), built: true };
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    // Stop reading at the bound instead of holding a flood in memory.
    if (size > HELPER_INPUT_MAX) throw new HostsHelperError(`request is larger than ${HELPER_INPUT_MAX} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let paths;
  try {
    paths = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`hosts-helper: ${error.message}`);
    process.exit(error.exit ?? EXIT_USAGE);
  }
  let op;
  try {
    const request = parseRequest(await readStdin());
    op = request.op;
    reply(handle(request, paths));
  } catch (error) {
    // stderr is for a person who runs the helper by hand; Desktop drops it.
    console.error(`hosts-helper: ${op ?? "request"} failed: ${error.message}`);
    reply({ ok: false, error: String(error.message).slice(0, ERROR_MAX) });
  }
}
