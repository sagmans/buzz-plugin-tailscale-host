#!/usr/bin/env node
// The plugin's one host process: it keeps hosts.json, the one host list, and
// carries the plugin's calls to each host's runner. Buzz Desktop lets a
// plugin reach only the origins of its installed manifest, and changes those
// only at an Update. A host added on the Settings page, or by hand in
// hosts.json, must work at once, so the plugin does not reach hosts itself:
// it names a host id here, and this helper takes that host's origin from
// hosts.json at each call. The plugin never sends a URL, so it can reach only
// the hosts the user listed, and only their runner API.
//
// The Settings page also adds a host here through a setup
// (scripts/host-setup.mjs), which installs or aligns buzz-runner on it: the
// page cannot reach a machine, and a setup runs for minutes, far past a
// command's limit. It is the one call that takes a secret (the sudo
// password), so the request is never logged and the password only goes on
// to sudo's stdin on the machine.
//
// The build (scripts/build-plugin.mjs) declares this helper as the plugin's
// one host process, with the hosts file fixed in the manifest. A one-shot
// host command would not do: Desktop ends a command after five seconds, and
// an agent's activation may take 90.
//
// Usage: node scripts/hosts-helper.mjs --hosts <hosts.json>
// stdin: one JSON request per line, from the plugin (untrusted input):
//   {"id":1,"op":"read"}                         the hosts in the file
//   {"id":2,"op":"save","hosts":[...]}           write the file
//   {"id":3,"op":"request","host":"<id>","method":"GET","path":"/harnesses","timeoutMs":45000}
//                                                one runner call; body is a JSON text
//   {"id":4,"op":"setup","setup":{"address":"https://…","sshUser":"…","sudoPassword":"…",
//     "ownerPubkey":"<hex>","relay":"wss://…","label":"…","reservedIds":["…"]}}
//                                                install or align buzz-runner there and
//                                                list it, one setup at a time
// stdout: one JSON reply per line, with the request's id:
//   {"id":1,"ok":true,"hosts":[...]}  {"id":3,"ok":true,"status":200,"body":"..."}
//   {"id":2,"ok":false,"error":"..."}
//   {"id":4,"progress":{"step":"copy","state":"running"}}  before a setup's reply
//   A line that cannot be read gets id null. Replies to runner calls come in
//   the order the calls end, not the order they came.
// Exit: 0 when stdin ends and every call is answered; 64 for wrong arguments.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PluginBuildError, readJson, runnerOrigin, validateHosts, writeAtomic } from "./build-plugin.mjs";
import { parseSetupRequest, setupHost } from "./host-setup.mjs";

const OPS = ["read", "save", "request", "setup"];
const REQUEST_KEYS = Object.freeze({
  read: ["id", "op"],
  save: ["id", "op", "hosts"],
  request: ["id", "op", "host", "method", "path", "body", "timeoutMs"],
  setup: ["id", "op", "setup"],
});
/** The runner contract's routes (docs/RUNNER_CONTRACT.md): every call stays
 * under this prefix, with the methods the contract uses. */
const API_PREFIX = "/v1";
const METHODS = ["GET", "POST", "PUT", "DELETE"];
const BODY_METHODS = ["POST", "PUT"];
/** Path segments the runner uses: pubkeys, harness ids, action names. No
 * dots, so neither `.` nor `..` can climb out of the prefix; no query. */
const PATH_RE = /^(?:\/[A-Za-z0-9_-]{1,128}){1,8}$/;
/** Desktop's own bound for one plugin request (180 s); the plugin asks for
 * at most 90 s. */
const TIMEOUT_MAX_MS = 180_000;
/** A save of 16 hosts is about 6 KB; an agent's instructions are at most
 * 20000 characters. The bound keeps a broken caller from filling memory. */
export const LINE_MAX = 262_144;
/** A runner reply is small JSON; a model list is the largest. */
const RESPONSE_MAX = 1_048_576;
/** Calls in flight at once: a host poll asks each of at most 16 hosts once,
 * and the pickers add a few. More means a runaway caller. */
const INFLIGHT_MAX = 32;
const ID_MAX = 2 ** 31;
/** The plugin shows the reason as text; a long cause chain helps nobody there. */
const ERROR_MAX = 500;
const EXIT_USAGE = 64;
const USAGE = "usage: node scripts/hosts-helper.mjs --hosts <hosts.json>";

/** A request the helper refuses, with the reason the plugin shows. */
export class HostsHelperError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HostsHelperError";
  }
}

/** Desktop puts the caller's process arguments after the declared ones, so
 * anything past the one fixed flag is refused: the plugin cannot point the
 * helper at another file. */
function parseArgs(argv) {
  if (argv.length !== 2 || argv[0] !== "--hosts" || !argv[1]) throw new PluginBuildError(USAGE, { exit: EXIT_USAGE });
  return { hostsPath: resolve(argv[1]) };
}

const isId = (value) => Number.isInteger(value) && value > 0 && value < ID_MAX;

/** The request as the plugin may send it, and nothing else. */
export function parseRequest(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (cause) {
    throw new HostsHelperError("request is not JSON", { cause });
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new HostsHelperError("request must be a JSON object");
  if (!isId(request.id)) throw new HostsHelperError("request id must be a positive whole number");
  if (!OPS.includes(request.op)) throw Object.assign(new HostsHelperError(`request op must be one of ${OPS.join(", ")}`), { id: request.id });
  const extra = Object.keys(request).filter((key) => !REQUEST_KEYS[request.op].includes(key));
  if (extra.length) throw Object.assign(new HostsHelperError(`unknown request keys: ${extra.join(", ")}`), { id: request.id });
  return request;
}

/** The runner URL for one call: the origin comes from hosts.json, never from
 * the caller, with the runner port when the user gave only the machine's
 * address, and the path stays under the contract's prefix. */
export function runnerUrl(hosts, request) {
  const host = hosts.find((entry) => entry.id === request.host);
  if (typeof request.host !== "string" || !host) throw new HostsHelperError(`no host ${JSON.stringify(String(request.host).slice(0, 40))} in hosts.json`);
  if (!METHODS.includes(request.method)) throw new HostsHelperError(`method must be one of ${METHODS.join(", ")}`);
  if (typeof request.path !== "string" || !PATH_RE.test(request.path)) throw new HostsHelperError("path is not a runner route");
  if (request.body !== undefined && (typeof request.body !== "string" || !BODY_METHODS.includes(request.method)))
    throw new HostsHelperError(`a body must be text, and only ${BODY_METHODS.join(" or ")} take one`);
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > TIMEOUT_MAX_MS)
    throw new HostsHelperError(`timeoutMs must be 1-${TIMEOUT_MAX_MS}`);
  const origin = runnerOrigin(host.origin);
  const url = new URL(`${origin}${API_PREFIX}${request.path}`);
  // validateHosts and PATH_RE make this hold; the check keeps it so if either changes.
  if (url.origin !== origin || url.pathname !== `${API_PREFIX}${request.path}`) throw new HostsHelperError("path leaves the runner API");
  return url;
}

/** Reads a reply body up to RESPONSE_MAX, so a broken runner cannot fill
 * this process's memory or the plugin's. */
async function boundedText(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > RESPONSE_MAX) {
      await reader.cancel();
      throw new HostsHelperError(`reply is larger than ${RESPONSE_MAX} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** One runner call. A redirect is not followed: its status goes back as
 * any other refusal, so the call never leaves the listed origin. */
async function runnerCall(request, { hostsPath }) {
  const hosts = validateHosts(readJson(hostsPath, "hosts file"), hostsPath);
  const url = runnerUrl(hosts, request);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: request.method,
      headers: { Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    return { status: response.status, body: await boundedText(response) };
  } catch (cause) {
    const reason = cause?.name === "TimeoutError" ? `no answer in ${request.timeoutMs} ms` : String(cause?.cause?.code || cause?.cause?.message || cause?.message || cause);
    throw new HostsHelperError(`${request.method} ${API_PREFIX}${request.path} on ${request.host} failed after ${Date.now() - started} ms: ${reason}`, { cause });
  }
}

/** True while a setup runs: two at once would race on hosts.json and ask
 * the user for two sudo passwords in one view. */
let settingUp = false;

/** One host setup; `emit` sends each progress event to the plugin. The
 * request is checked before anything reaches the machine. */
async function setup(request, paths, emit) {
  const parsed = parseSetupRequest(request.setup);
  if (settingUp) throw new HostsHelperError("a setup is already running; wait for it to end");
  settingUp = true;
  try {
    return await setupHost(parsed, { hostsPath: paths.hostsPath, onProgress: emit, deps: paths.setupDeps });
  } finally {
    settingUp = false;
  }
}

/** Runs one request; returns the reply fields without the id. `emit` sends
 * a progress event before the reply, for the calls that have them.
 * `paths.setupDeps` is for the smoke run only (host-setup.mjs `deps`); the
 * command line never sets it. */
export async function handle(request, paths, emit = () => {}) {
  if (request.op === "read") return { hosts: validateHosts(readJson(paths.hostsPath, "hosts file"), paths.hostsPath) };
  if (request.op === "setup") return setup(request, paths, emit);
  if (request.op === "save") {
    // The setup's own add would write over a save made while it runs.
    if (settingUp) throw new HostsHelperError("a setup is running; save again when it ends");
    const hosts = validateHosts({ hosts: request.hosts }, "hosts");
    writeAtomic(paths.hostsPath, `${JSON.stringify({ hosts }, null, 2)}\n`);
    return { hosts };
  }
  return runnerCall(request, paths);
}

const reply = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const errorReply = (id, error) => reply({ id: id ?? null, ok: false, error: String(error?.message ?? error).slice(0, ERROR_MAX) });

/** Reads request lines and answers each; resolves when stdin ends and every
 * call is answered. */
async function serve(paths) {
  let inflight = 0;
  let buffered = "";
  let skipping = false;
  const running = new Set();
  const dispatch = (line) => {
    if (!line.trim()) return;
    let request;
    try {
      request = parseRequest(line);
    } catch (error) {
      errorReply(error.id, error);
      return;
    }
    if (inflight >= INFLIGHT_MAX) {
      errorReply(request.id, new HostsHelperError(`more than ${INFLIGHT_MAX} calls at once`));
      return;
    }
    inflight += 1;
    const started = Date.now();
    const task = handle(request, paths, (progress) => reply({ id: request.id, progress }))
      .then(
        (fields) => reply({ id: request.id, ok: true, ...fields }),
        (error) => {
          // stderr is for a person who runs the helper by hand; Desktop gives it to the plugin's log.
          console.error(JSON.stringify({ event: "hosts-helper.failed", op: request.op, host: request.host, path: request.path, step: error?.step, elapsedMs: Date.now() - started, error: String(error?.message ?? error) }));
          errorReply(request.id, error);
        },
      )
      .finally(() => {
        inflight -= 1;
        running.delete(task);
      });
    running.add(task);
  };
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      // The rest of an overlong line is dropped up to its end.
      if (skipping) skipping = false;
      else dispatch(line);
    }
    if (buffered.length > LINE_MAX) {
      if (!skipping) errorReply(null, new HostsHelperError(`request line is longer than ${LINE_MAX} bytes`));
      skipping = true;
      buffered = "";
    }
  }
  if (!skipping) dispatch(buffered);
  await Promise.allSettled([...running]);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let paths;
  try {
    paths = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`hosts-helper: ${error.message}`);
    process.exit(error.exit ?? EXIT_USAGE);
  }
  // A missing or broken hosts.json is not fatal: each read answers with the
  // reason, which the Settings page shows next to the fix.
  await serve(paths);
}
