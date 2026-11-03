// The runner's own config file: who may call it, which communities agents may
// join, and how `claude` is launched. Read once at startup and validated
// strictly, so a typo fails the service start instead of running open.
import { readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import {
  CONFIG_ENV,
  CLAUDE_HARNESS,
  CONFIG_FLAG,
  DEFAULT_CONFIG,
  DEFAULT_HARNESSES,
  DEFAULT_SOCKET,
  DEFAULT_STATE_DIR,
  EFFORTS,
  HARNESS_CATALOG,
  HEX64,
  type HarnessId,
  LOGIN_MAX,
  MODEL_ID,
  MODEL_MAX,
} from "./constants";
import { ConfigError } from "./errors";
import { LEVELS, type Level } from "./log";

export type Effort = (typeof EFFORTS)[number];

export type RunnerConfig = Readonly<{
  ownerPubkey: string;
  /** Pubkeys besides the owner whose events may wake an agent. Empty by
   * default: a NIP-OA attestation alone does not qualify, so another agent
   * of the owner cannot drive this host. */
  allowedSenders: readonly string[];
  allowedLogins: readonly string[];
  /** Community relay URLs agents may be created in (`community` allowlist). */
  relays: readonly string[];
  /** Unix socket of the API; its directory must be 0700 and owned by the
   * runner user (checked at startup). */
  socket: string;
  wrapper: string;
  /** The one wrapper every harness other than Claude runs through
   * (`harness-wrapper <id> <agentPk> [args…]`). It holds each harness's
   * binary path itself, root-owned, so this config cannot point a harness
   * elsewhere; the runner checks that both agree. */
  harnessWrapper: string;
  sudo: string;
  runAsUser: string;
  /** Where the wrapper puts each agent's workspace; shown to the model as its
   * working directory, never touched by the runner. */
  workspaceRoot: string;
  stateDir: string;
  maxParallelTurns: number;
  /** claude processes kept alive at once, for all agents together. Each
   * idle conversation keeps one for 15 min (Desktop parity) at ~190 MiB, so
   * on a small host the oldest idle one is stopped first when a new
   * conversation needs a process; it resumes with `--resume` later. */
  maxLiveSessions: number;
  /** Harnesses offered to the owner, in this order (`GET /v1/harnesses`).
   * Each must be one Desktop knows; the plugin makes one hosted type per
   * entry, so adding one later is config plus runner support, never plugin
   * code. Default: Desktop's full list; ones this runner cannot run yet are
   * listed as not ready, never hidden. */
  harnesses: readonly HarnessId[];
  /** Where each harness other than Claude is installed on this host
   * (`harnesses.<id>.path`). It must be the path `harnessWrapper` runs for
   * that id (checked before the harness counts as installed), so a stale
   * config shows as an error instead of a different binary. Claude has
   * none: `wrapper` decides its binary. */
  harnessPaths: Readonly<Partial<Record<HarnessId, string>>>;
  /** Whether agents' own events (messages, reactions, edits…) carry the
   * owner's NIP-OA `auth` tag, as Desktop's do. Default true: Desktop agents
   * wake on owner-attested events, so the tag is what lets hosted and desktop
   * agents address each other. False keeps it off everything except the
   * kind-0 profile; the NIP-42 AUTH event and the `x-auth-tag` membership
   * header always carry it, so relay membership works either way. */
  attestEvents: boolean;
  /** Whether a mention from an agent with a valid owner NIP-OA tag (the
   * owner's desktop agents, this runner's other agents) wakes an agent, as in
   * Desktop. Default true. False limits wakes to `ownerPubkey` and
   * `allowedSenders`, and drops events from this runner's other agents. */
  acceptAttested: boolean;
  /** Whether the owner's untagged thread reply wakes the agent it is for:
   * the author of the message it replies to, else the thread's last agent of
   * the owner (the `sagmans.reply-wake` plugin rule). Default true, since
   * that plugin cannot wake hosted agents. Owner messages only. */
  replyWake: boolean;
  /** Publish live activity (kind-24200 observer frames) for the owner's
   * Desktop, as buzz-acp does. Frames hold prompts and tool input and output,
   * so they are NIP-44 encrypted to the owner only; off sends none. */
  publishTelemetry: boolean;
  /** Host-wide defaults; an agent's own config wins. */
  model?: string;
  effort?: Effort;
  logLevel: Level;
}>;

const DEFAULTS = Object.freeze({
  sudo: "/usr/bin/sudo",
  harnessWrapper: "/usr/local/libexec/buzz-runner/harness-wrapper",
  runAsUser: "buzz-agent",
  workspaceRoot: "/home/buzz-agent/agents",
  stateDir: DEFAULT_STATE_DIR,
  attestEvents: true,
  acceptAttested: true,
  replyWake: true,
  publishTelemetry: true,
  socket: DEFAULT_SOCKET,
  maxParallelTurns: 2,
  maxLiveSessions: 4,
  logLevel: "info" as Level,
});
const MAX_PARALLEL_LIMIT = 16;
const MAX_LIVE_SESSIONS_LIMIT = 32;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
/** Linux sun_path is 108 bytes including the terminator. */
const SOCKET_PATH_MAX = 107;
const UNIX_USER = /^[a-z_][a-z0-9_-]{0,31}$/;
const KNOWN_KEYS = new Set([
  "ownerPubkey",
  "allowedSenders",
  "allowedLogins",
  "relays",
  "socket",
  "wrapper",
  "harnessWrapper",
  "sudo",
  "runAsUser",
  "workspaceRoot",
  "stateDir",
  "maxParallelTurns",
  "maxLiveSessions",
  "harnesses",
  "attestEvents",
  "acceptAttested",
  "replyWake",
  "publishTelemetry",
  "model",
  "effort",
  "logLevel",
]);

/** `--config <path>` wins over the environment, then the systemd
 * ConfigurationDirectory default, as most daemons do. */
export function configPath(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const at = argv.indexOf(CONFIG_FLAG);
  if (at >= 0 && !argv[at + 1]) throw new ConfigError(`${CONFIG_FLAG} needs a path`);
  return argv[at + 1] ?? env[CONFIG_ENV] ?? DEFAULT_CONFIG;
}

export function loadConfig(path: string): RunnerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw new ConfigError(`Cannot read config ${path}`, { cause });
  }
  return parseConfig(raw);
}

export function parseConfig(raw: unknown): RunnerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ConfigError("Config must be a JSON object");
  const value = raw as Record<string, unknown>;
  const unknown = Object.keys(value).filter((key) => !KNOWN_KEYS.has(key));
  if (unknown.length) throw new ConfigError(`Unknown config keys: ${unknown.join(", ")}`);

  const ownerPubkey = value.ownerPubkey;
  if (typeof ownerPubkey !== "string" || !HEX64.test(ownerPubkey))
    throw new ConfigError("ownerPubkey must be 64 lowercase hex characters");

  const allowedSenders = value.allowedSenders === undefined ? [] : hexList(value.allowedSenders, "allowedSenders");

  const allowedLogins = stringList(value.allowedLogins, "allowedLogins");
  for (const login of allowedLogins)
    if (!login.trim() || login.length > LOGIN_MAX || /\s/.test(login))
      throw new ConfigError("allowedLogins entries must be non-empty logins without spaces");

  const relays = stringList(value.relays, "relays").map(relayUrl);

  const socket = absolutePath(value.socket ?? DEFAULTS.socket, "socket");
  if (Buffer.byteLength(socket) > SOCKET_PATH_MAX)
    throw new ConfigError(`socket path must be at most ${SOCKET_PATH_MAX} bytes`);
  const wrapper = absolutePath(value.wrapper, "wrapper");
  const harnessWrapper = absolutePath(value.harnessWrapper ?? DEFAULTS.harnessWrapper, "harnessWrapper");
  const sudo = absolutePath(value.sudo ?? DEFAULTS.sudo, "sudo");
  const workspaceRoot = absolutePath(value.workspaceRoot ?? DEFAULTS.workspaceRoot, "workspaceRoot");
  const stateDir = absolutePath(value.stateDir ?? DEFAULTS.stateDir, "stateDir");

  const runAsUser = value.runAsUser ?? DEFAULTS.runAsUser;
  if (typeof runAsUser !== "string" || !UNIX_USER.test(runAsUser))
    throw new ConfigError("runAsUser must be a Unix user name");

  const maxParallelTurns = value.maxParallelTurns ?? DEFAULTS.maxParallelTurns;
  if (
    typeof maxParallelTurns !== "number" ||
    !Number.isInteger(maxParallelTurns) ||
    maxParallelTurns < 1 ||
    maxParallelTurns > MAX_PARALLEL_LIMIT
  )
    throw new ConfigError(`maxParallelTurns must be an integer 1..${MAX_PARALLEL_LIMIT}`);
  const maxLiveSessions = value.maxLiveSessions ?? DEFAULTS.maxLiveSessions;
  if (
    typeof maxLiveSessions !== "number" ||
    !Number.isInteger(maxLiveSessions) ||
    maxLiveSessions < 1 ||
    maxLiveSessions > MAX_LIVE_SESSIONS_LIMIT
  )
    throw new ConfigError(`maxLiveSessions must be an integer 1..${MAX_LIVE_SESSIONS_LIMIT}`);

  const { ids: harnesses, paths: harnessPaths } =
    value.harnesses === undefined ? { ids: [...DEFAULT_HARNESSES], paths: {} } : harnessMap(value.harnesses);

  const attestEvents = value.attestEvents ?? DEFAULTS.attestEvents;
  if (typeof attestEvents !== "boolean") throw new ConfigError("attestEvents must be true or false");
  const acceptAttested = value.acceptAttested ?? DEFAULTS.acceptAttested;
  if (typeof acceptAttested !== "boolean") throw new ConfigError("acceptAttested must be true or false");
  const replyWake = value.replyWake ?? DEFAULTS.replyWake;
  if (typeof replyWake !== "boolean") throw new ConfigError("replyWake must be true or false");
  const publishTelemetry = value.publishTelemetry ?? DEFAULTS.publishTelemetry;
  if (typeof publishTelemetry !== "boolean") throw new ConfigError("publishTelemetry must be true or false");

  const model = optionalModel(value.model);
  const effort = optionalEffort(value.effort);
  const logLevel = value.logLevel ?? DEFAULTS.logLevel;
  if (typeof logLevel !== "string" || !LEVELS.includes(logLevel as Level))
    throw new ConfigError(`logLevel must be one of ${LEVELS.join(", ")}`);

  return Object.freeze({
    ownerPubkey,
    allowedSenders: Object.freeze(allowedSenders),
    allowedLogins: Object.freeze(allowedLogins),
    relays: Object.freeze(relays),
    socket,
    wrapper,
    harnessWrapper,
    sudo,
    runAsUser,
    workspaceRoot,
    stateDir,
    maxParallelTurns,
    maxLiveSessions,
    harnesses: Object.freeze(harnesses),
    harnessPaths: Object.freeze(harnessPaths),
    attestEvents,
    acceptAttested,
    replyWake,
    publishTelemetry,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    logLevel: logLevel as Level,
  });
  // #lizard forgives: one check per config key, in key order, as the README table
}

/** Shared with request validation, so a per-agent model obeys the same
 * length rule. The runner's own default model is Claude's (`pattern`
 * MODEL_ID); a request may name any harness's model, checked again per
 * harness once the harness is known. */
export function optionalModel(value: unknown, pattern: RegExp = MODEL_ID): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > MODEL_MAX || !pattern.test(value))
    throw new ConfigError(
      pattern === MODEL_ID ? "model must be a Claude model id or alias" : "model must be a model id (letters, digits and ._:-[]/@)",
    );
  return value;
}
export function optionalEffort(value: unknown): Effort | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !EFFORTS.includes(value as Effort))
    throw new ConfigError(`effort must be one of ${EFFORTS.join(", ")}`);
  return value as Effort;
}

const HARNESS_ENTRY_KEYS = ["path"];

/** `{ "<id>": { path? } }`: a non-empty map of known harness ids, offered in
 * key order (JSON keeps it). Unknown ids or keys fail the start, so a typo
 * never silently hides a harness or drops its path. */
function harnessMap(value: unknown): { ids: HarnessId[]; paths: Partial<Record<HarnessId, string>> } {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.keys(value).length)
    throw new ConfigError('harnesses must be a non-empty object of { "<id>": { "path"?: "/abs/path" } }');
  const known = Object.keys(HARNESS_CATALOG);
  const ids: HarnessId[] = [];
  const paths: Partial<Record<HarnessId, string>> = {};
  for (const [id, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!known.includes(id)) throw new ConfigError(`harnesses keys must be among ${known.join(", ")}`);
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ConfigError(`harnesses.${id} must be an object`);
    const extra = Object.keys(entry).filter((key) => !HARNESS_ENTRY_KEYS.includes(key));
    if (extra.length) throw new ConfigError(`harnesses.${id} has unknown keys: ${extra.join(", ")}`);
    const path = (entry as { path?: unknown }).path;
    if (path !== undefined) {
      if (id === CLAUDE_HARNESS) throw new ConfigError(`harnesses.${id}.path is not used: \`wrapper\` starts Claude`);
      const checked = absolutePath(path, `harnesses.${id}.path`);
      // A path with `..` or doubled slashes is a typo or a trick; keep it plain.
      if (normalize(checked) !== checked) throw new ConfigError(`harnesses.${id}.path must be a normalized path`);
      paths[id as HarnessId] = checked;
    }
    ids.push(id as HarnessId);
  }
  return { ids, paths };
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((item) => typeof item === "string"))
    throw new ConfigError(`${name} must be a non-empty array of strings`);
  return [...new Set(value as string[])];
}

/** TLS is required, except to a loopback relay (local development and the
 * smoke harness), where there is no network to protect. */
function relayUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new ConfigError(`relays entry is not a URL: ${value}`, { cause });
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname.replace(/^\[|\]$/g, ""));
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && loopback))
    throw new ConfigError(`relays entries must use wss:// (got ${value})`);
  if (url.username || url.password || url.search || url.hash)
    throw new ConfigError(`relays entries must not carry credentials, query or fragment: ${value}`);
  return value;
}

/** A list of lowercase hex pubkeys; may be empty. */
function hexList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && HEX64.test(item)))
    throw new ConfigError(`${name} must be an array of 64-character lowercase hex pubkeys`);
  return [...new Set(value as string[])];
}

function absolutePath(value: unknown, name: string) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0"))
    throw new ConfigError(`${name} must be an absolute path`);
  return value;
}
