// Every tunable number and fixed name of the runner in one place, so limits
// that shape security (sizes, timeouts, modes) are reviewed together and never
// drift between modules.

/** Runner release and the buzz-app revision whose harness logic it bundles;
 * `/v1/health` reports both so the owner can tell which Desktop behavior a
 * host runs. */
export const RUNNER_VERSION = "0.1.0";
export const BUZZ_APP_REV = "c253fc051";
export const VERSION = `${RUNNER_VERSION}+buzz-app.${BUZZ_APP_REV}`;

/** Where the config path comes from when `--config` is absent. */
export const CONFIG_ENV = "BUZZ_RUNNER_CONFIG";
export const CONFIG_FLAG = "--config";
/** systemd ConfigurationDirectory / StateDirectory of the dedicated
 * `buzz-runner` system user (see buzz-runner.service). */
export const DEFAULT_CONFIG = "/etc/buzz-runner/config.json";
export const DEFAULT_STATE_DIR = "/var/lib/buzz-runner";

// ---- HTTP surface (docs/RUNNER_CONTRACT.md) ----
/** `tailscale serve` sets this from the tailnet identity; a direct localhost
 * caller has none, so the header is the authorization boundary. */
export const LOGIN_HEADER = "tailscale-user-login";
/** The API listens only on this Unix socket. A TCP port on loopback would let
 * any local user send a forged login header; the socket sits in a 0700
 * directory, so only the runner user and root (tailscaled) can connect. */
export const DEFAULT_SOCKET = "/run/buzz-runner/api.sock";
export const SOCKET_DIR_MODE = 0o700;
export const SOCKET_MODE = 0o600;
/** One body for every refused caller, so a probe cannot tell a missing
 * header from a wrong login. */
export const FORBIDDEN_MESSAGE = "Forbidden";
export const API_PREFIX = "/v1";
export const BODY_LIMIT_BYTES = 64 * 1024;
/** Whole request (headers + body) must arrive within this. */
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
/** Idle keep-alive sockets close quickly: the only client is one plugin. */
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** Activate publishes a profile, so it may take longer than a plain call;
 * the plugin waits 90 s, so the runner gives up first. */
export const ACTIVATE_DEADLINE_MS = 75_000;

// ---- Input limits ----
export const NAME_MAX = 256;
export const PICTURE_MAX = 2048;
export const INSTRUCTIONS_MAX = 20_000;
export const MODEL_MAX = 128;
/** Every effort level any harness takes (Pi's thinking levels, the widest
 * set); each harness then allows its own subset (HARNESS_EFFORTS). */
export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX128 = /^[0-9a-f]{128}$/;
/** Buzz channel ids are UUIDs (buzz-acp parses them as `Uuid`). */
export const CHANNEL_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Model ids and aliases Claude takes: letters, digits, `.-_:[]`. The first
 * character is alphanumeric, so a value can never be read as a CLI flag. */
export const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]]*$/;
/** Model ids any harness takes, checked before the harness is known:
 * Claude's characters plus `/` (Pi's `<provider>/<model>`, and providers'
 * `org/name` models) and `@` (dated provider ids). Still alphanumeric first. */
export const MODEL_ID_ANY = /^[A-Za-z0-9][A-Za-z0-9._:\-[\]/@]*$/;
export const LOGIN_MAX = 320;

// ---- State on disk ----
export const STATE_DIR_MODE = 0o700;
export const STATE_FILE_MODE = 0o600;
export const AGENTS_DIR = "agents";
export const SESSIONS_DIR = "sessions";
/** Empty per-agent directories that bound the Buzz tools' `path`/`files`
 * reads; see `agents.ts` for why they must stay empty. */
export const FILES_DIR = "files";
export const MEDIA_DIR = "media";
/** Saved sessions per agent, as Desktop keeps (sessions.ts SAVED_LIMIT). */
export const SAVED_SESSIONS_LIMIT = 200;
/** Event ids remembered across restarts so catch-up does not run a turn twice. */
export const RECENT_IDS_PERSISTED = 500;
/** Agent records this runner keeps at most (each holds a key and may run
 * claude processes), and how fast new ones may be created. */
export const AGENT_RECORDS_MAX = 20;
export const PROVISION_RATE_MAX = 10;
export const PROVISION_RATE_WINDOW_MS = 10 * 60_000;
/** All media an agent's `media_get` keeps on disk; the oldest files go first. */
export const MEDIA_TOTAL_MAX_BYTES = 200 * 1024 * 1024;

// ---- Relay ----
export const WS_CONNECT_TIMEOUT_MS = 10_000;
export const WS_AUTH_TIMEOUT_MS = 10_000;
/** A REQ probe proves a quiet socket still reaches the relay. */
export const WS_PROBE_INTERVAL_MS = 60_000;
export const WS_PROBE_TIMEOUT_MS = 15_000;
export const WS_FRAME_LIMIT = 1024 * 1024;
export const RECONNECT_BASE_MS = 1_000;
export const RECONNECT_MAX_MS = 60_000;
/** Seconds subtracted from the cursor on resubscribe, as buzz-acp does, to
 * tolerate clock skew between relay writers. */
export const RESUBSCRIBE_SKEW_S = 30;
/** Catch-up never replays more than this after downtime: an old mention is
 * not a request the owner still waits on. */
export const CATCHUP_MAX_S = 6 * 3600;
/** An event's created_at moves the cursor at most this far past the clock, so
 * a future-dated event cannot make catch-up skip real ones. */
export const FUTURE_SKEW_S = 60;
export const DEDUPE_LIMIT = 5_000;
/** NIP-01 subscription ids, one per purpose. */
export const SUB_MENTIONS = "mentions";
export const SUB_MEMBERSHIP = "membership";
export const SUB_DMS = "dms";
export const SUB_PROBE = "probe";
/** The owner's untagged thread replies, for the reply-wake rule (runtime.ts
 * `replyTarget`): Desktop's `sagmans.reply-wake` plugin can wake only the
 * agents its own app runs, so hosted agents apply the rule themselves. */
export const SUB_REPLIES = "replies";
/** The relay's membership notices to the agent (kinds 44100, 44101): the only
 * live signal of a join or leave (see `live.ts` `loadRosters`). */
export const SUB_NOTICES = "notices";
/** Thread history read to find the last agent; same page size as the
 * reply-wake plugin's THREAD_READ_LIMIT, so both pick the same agent. */
export const REPLY_THREAD_READ_LIMIT = 500;
/** Bound on the reply-wake reads (parent message, thread history). */
export const REPLY_READ_TIMEOUT_MS = 10_000;
export const KIND_AUTH = 22242;
export const KIND_PROFILE = 0;
/** Kind the liveness probe asks for with `limit: 0`; the Desktop live client uses the same. */
export const KIND_PROBE = 44100;
/** Relay-signed membership notices (buzz-core `kind.rs`): added, removed. */
export const KIND_MEMBER_ADDED = 44100;
export const KIND_MEMBER_REMOVED = 44101;
/** NIP-CL: the relay sends a system channel's notices only to a filter that
 * names this type in `#t`; a filter without `#t` gets the legacy types. */
export const NOTICE_SYSTEM_TYPE = "system";
export const KIND_CHANNEL_METADATA = 39000;
export const KIND_CHANNEL_MEMBERS = 39002;
/** Chat kinds Desktop reads as conversation context (runtime.ts CHAT). */
export const CONTEXT_KINDS = [9, 40002];
export const KIND_CHAT = 9;
/** Plain HTTP calls to the community: reads, writes, NIP-11. */
export const HTTP_TIMEOUT_MS = 30_000;
/** Blob transfers may be large (Buzz allows 500 MiB media). */
export const HTTP_MEDIA_TIMEOUT_MS = 300_000;
export const NIP11_TIMEOUT_MS = 10_000;
/** Reading thread context and names before a turn (runtime.ts NAMES_TIMEOUT_MS * 2). */
export const CONTEXT_READ_TIMEOUT_MS = 4_000;
export const NAMES_TIMEOUT_MS = 2_000;
export const CORE_MEMORY_TIMEOUT_MS = 10_000;
export const THREAD_CONTEXT_LIMIT = 200;

// ---- Retries (idempotent operations only) ----
export const RETRY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 500;
export const RETRY_MAX_MS = 4_000;
/** ±20 % jitter, as buzz-acp's REST retries use. */
export const RETRY_JITTER = 0.2;

// ---- Claude ----
/** The global per-turn wall-clock cap: a turn past it is interrupted. */
export const TURN_WALL_CLOCK_MS = 30 * 60_000;
/** After the interrupt, how long the turn may take to end before its
 * process is stopped. */
export const TURN_STOP_GRACE_MS = 60_000;
/** Stop sequence for a claude child: close stdin and wait this long, then
 * SIGTERM and wait again, then SIGKILL. */
export const PROCESS_KILL_GRACE_MS = 5_000;
/** The whole stop sequence gives up after this: under real sudo the runner
 * may not be allowed to signal the root-owned sudo process (EPERM), and a
 * child that ignores stdin EOF must not hold the caller forever. */
export const PROCESS_STOP_MAX_MS = 20_000;
/** One stream-json line from claude may not grow past this; a larger one is
 * runaway output that would otherwise sit in the runner's memory. */
export const STDOUT_LINE_MAX_BYTES = 8 * 1024 * 1024;
/** Turns waiting for a free slot; more are dropped and reported. */
export const TURN_QUEUE_LIMIT = 100;
/** Only what `sudo` itself needs; the wrapper sets claude's environment. */
export const CHILD_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const CHILD_CWD = "/";
/** What a failed turn posts in the channel. Details (stderr, paths, errors)
 * go to the log only: the channel is readable by every member. */
export const FAILURE_MESSAGE = "⚠️ I couldn't finish that. The host logged the details.";
export const WALL_CLOCK_ERROR = `The turn ran longer than ${TURN_WALL_CLOCK_MS / 60_000} minutes and was stopped`;

// ---- Working signals (typing is buzz-app typing.ts; telemetry below) ----
/** Desktop's agent observer frame (buzz-relay `handle_agent_observer_event`):
 * ephemeral, NIP-44 encrypted to the owner, WebSocket only. */
export const KIND_AGENT_OBSERVER = 24200;
/** The `frame` tag value the relay routes to the owner's telemetry feed. */
export const OBSERVER_FRAME_TELEMETRY = "telemetry";
/** One frame per tick per agent, as buzz-acp `OBSERVER_PUBLISH_TICK`; far
 * under the relay's 100 frames/s per agent. */
export const OBSERVER_TICK_MS = 1_000;
/** NIP-44 v2 plaintext limit; a larger frame is elided to fit. */
export const OBSERVER_PLAINTEXT_MAX_BYTES = 65_535;
/** Head and tail kept of an elided string, as buzz-acp. */
export const OBSERVER_LEAF_RETAIN_BYTES = 3_000;
/** Merged text chunks are cut here, as buzz-acp's chunk coalescer. */
export const OBSERVER_CHUNK_MAX_TEXT_BYTES = 60_000;
/** Frames waiting to go out; the oldest are dropped past this. */
export const OBSERVER_QUEUE_MAX_BYTES = 4 * 1024 * 1024;
/** `turn_liveness` cadence, as buzz-acp; the first comes one period in. */
export const OBSERVER_LIVENESS_MS = 10_000;
/** The relay's answer (`OK`) to one frame. */
export const OBSERVER_PUBLISH_TIMEOUT_MS = 10_000;
/** Each agent is one harness process here, so its frames name slot 0. */
export const OBSERVER_AGENT_INDEX = 0;
/** Tool uses remembered per claude process, to render their results. */
export const OBSERVER_TOOLS_REMEMBERED = 512;

// ---- Shutdown ----
/** The whole stop, signal to exit. It stays under the unit's
 * TimeoutStopSec (30 s), so systemd never has to SIGKILL the cgroup and cut
 * a claude session file mid-write. */
export const SHUTDOWN_DEADLINE_MS = 20_000;
/** Busy turns get this long to end on an interrupt before their process is
 * stopped: claude then closes the turn and flushes its session file. */
export const STOP_INTERRUPT_MS = 3_000;
/** How long a stop waits for claude children to exit after they are told
 * to stop (stdin EOF, SIGTERM at 5 s, SIGKILL at 10 s). Interrupt plus this
 * leaves a margin inside SHUTDOWN_DEADLINE_MS for the final log and exit. */
export const CHILD_STOP_BUDGET_MS = 16_000;

// ---- Live-session cap ----
/** A turn waiting for a free claude slot checks again this often, besides
 * the wake-ups when a process stops or a turn ends. */
export const SESSION_CAP_RECHECK_MS = 1_000;

// ---- Harnesses ----
/** Desktop's local agent harnesses (buzz-app `bundled/index.ts`: claude-code,
 * codex, goose, pi), with Desktop's titles. The hosted list mirrors it: every
 * one is offered and reports whether this runner can run it, so the owner
 * sees the same choices as on the desktop. `supported` is runner code, not
 * config: a harness runs here only once its runner engine exists. */
export const HARNESS_CATALOG = Object.freeze({
  "claude-code": Object.freeze({ title: "Claude", supported: true }),
  codex: Object.freeze({ title: "Codex", supported: true }),
  goose: Object.freeze({ title: "Goose", supported: true }),
  pi: Object.freeze({ title: "Pi", supported: true }),
});
export type HarnessId = keyof typeof HARNESS_CATALOG;
export const CLAUDE_HARNESS: HarnessId = "claude-code";
/** Desktop's own order of the harness choice. */
export const DEFAULT_HARNESSES: readonly HarnessId[] = Object.freeze(["claude-code", "codex", "goose", "pi"]);
/** Desktop's session scopes (claude-code `config.scope`): one session per
 * thread, or one per channel that every thread shares. */
export const SCOPES = ["thread", "channel"] as const;
export const DEFAULT_SCOPE = "thread";
/** The workspace name model discovery and the readiness probe run under.
 * The wrapper needs a 64-hex agent key for the folder; x = 0 is not a point
 * on secp256k1, so no real agent can own this folder. */
export const DISCOVERY_AGENT = "0".repeat(64);
/** How long a readiness answer is reused: each check starts `claude` twice. */
export const HARNESS_STATUS_TTL_MS = 60_000;
/** How long a model list is reused: discovery starts a full `claude`. */
export const HARNESS_MODELS_TTL_MS = 10 * 60_000;
/** How long Pi's, Goose's and Codex's lists are reused. Their sign-ins live
 * in the harness user's home, which the runner cannot read or watch, so a
 * `buzz-login` there shows in the picker within this long; their discovery
 * is one short process. */
export const HOSTED_MODELS_TTL_MS = 60_000;
/** Desktop's discovery bound (claude-code `setup.ts` CHECK_TIMEOUT_MS). */
export const HARNESS_DISCOVERY_TIMEOUT_MS = 15_000;
/** A probe waits at most this long for a live-session slot; the plugin's
 * request has 30 s in all. */
export const PROBE_ADMIT_TIMEOUT_MS = 10_000;
/** A harness install check is one stat; a host disk that does not answer in
 * this long is reported as not found rather than holding the list. */
export const HARNESS_PATH_CHECK_TIMEOUT_MS = 2_000;
/** Desktop runs `max` as `xhigh` in a stream-json session and does not offer
 * it for Claude (claude-code `runtime.ts` effortChoices). */
export const CLAUDE_HIDDEN_EFFORT = "max";
/** The effort levels each harness takes from the owner. Claude: Desktop's
 * picker without `max`. Pi: its thinking levels (pi `setup.ts` LEVELS), which
 * Pi clamps to what the model supports. Goose: every level, because each
 * model lists its own (`thinking_effort`) and Goose refuses one it lacks,
 * which fails that turn with Goose's own words. */
export const HARNESS_EFFORTS: Readonly<Partial<Record<HarnessId, readonly string[]>>> = Object.freeze({
  "claude-code": Object.freeze(["low", "medium", "high", "xhigh"]),
  goose: Object.freeze([...EFFORTS]),
  pi: Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  // Codex's reasoning efforts; a level the model lacks runs at the model's
  // default (Desktop codex `prepare`).
  codex: Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh"]),
});
export const PI_HARNESS: HarnessId = "pi";
export const GOOSE_HARNESS: HarnessId = "goose";
export const CODEX_HARNESS: HarnessId = "codex";
/** The model ids each harness takes once it is known. Claude's model is a
 * CLI argument, so it keeps the narrow set; Pi's and Goose's go over JSON. */
export const HARNESS_MODEL_IDS: Readonly<Partial<Record<HarnessId, RegExp>>> = Object.freeze({
  "claude-code": MODEL_ID,
  goose: MODEL_ID_ANY,
  pi: MODEL_ID_ANY,
  codex: MODEL_ID_ANY,
});
/** What each harness's buzz-app module may start through `harness-wrapper`
 * (its Desktop manifest's `host.processes` ids), and whether the module's
 * own args reach the wrapper. Pi's args are its launcher source, which the
 * wrapper replaces with its fixed launcher, so they are dropped. Goose's
 * module starts `goose` (its manifest's `goose-acp`) with no args. */
export const HARNESS_PROGRAMS: Readonly<Partial<Record<HarnessId, Readonly<{ programs: readonly string[]; passArgs: boolean }>>>> =
  Object.freeze({
    goose: Object.freeze({ programs: Object.freeze(["goose"]), passArgs: false }),
    // Codex's module starts `app-server`; the wrapper runs it with fixed args.
    codex: Object.freeze({ programs: Object.freeze(["app-server"]), passArgs: false }),
    pi: Object.freeze({ programs: Object.freeze(["pi-sh"]), passArgs: false }),
  });
/** The generic wrapper's self-report: `harness-wrapper <id> --path` prints
 * the binary path it runs for `id`, so the runner can check its config. */
export const WRAPPER_PATH_FLAG = "--path";
/** The wrapper's answer is one path line; anything longer is not one. */
export const WRAPPER_PATH_MAX_BYTES = 4_096;
/** How long the wrapper's path report may take (a sudo plus a shell). */
export const WRAPPER_PATH_TIMEOUT_MS = 5_000;
/** Pi model ids are `<provider>/<model>`: Pi needs both, and the runner's
 * config has one model field. Provider ids hold no slash; model ids may. */
export const PI_MODEL_SEPARATOR = "/";
/** A Pi host loads Pi's packages before it answers: longer than a claude. */
export const PI_DISCOVERY_TIMEOUT_MS = 30_000;
/** How long a Pi tool call or step may wait for the delivery that names its
 * conversation: the host can start a run before `deliver` answers. A
 * delivery answers in milliseconds; a host naming a conversation no
 * delivery made is not waited on longer. */
export const PI_KEY_WAIT_MS = 5_000;
/** The Pi host is one process per agent; the live-session cap counts it
 * under this key, whatever conversations it holds. */
export const PI_HOST_KEY = "pi-host";
/** A Pi host with no conversation working is stopped after this long, as
 * an idle claude session is (claude-code `sessions.ts` IDLE_MS). */
export const PI_IDLE_MS = 15 * 60_000;
/** Most model entries shown for Pi, across its signed-in providers. */
export const PI_MODELS_MAX = 64;
/** Goose model ids are `<provider>/<model>`, as Pi's: the agent's one model
 * field picks both. A model without a provider runs on Goose's configured
 * provider. */
export const GOOSE_MODEL_SEPARATOR = "/";
/** A Goose discovery starts several short `goose-acp` processes (providers,
 * then each provider's models and levels). */
export const GOOSE_DISCOVERY_TIMEOUT_MS = 60_000;
/** Most model entries shown for Goose, across its configured providers. */
export const GOOSE_MODELS_MAX = 64;
/** The `goose-acp` of an agent is one process; the live-session cap counts
 * it under this key, whatever sessions it holds. */
export const GOOSE_HOST_KEY = "goose-host";
/** A `goose-acp` with no conversation working is stopped after this long,
 * as an idle Pi host or claude session is. */
export const GOOSE_IDLE_MS = 15 * 60_000;
/** Desktop's session title cap (goose `runtime.ts` TITLE_LIMIT). A titled
 * session spares the provider the model call Goose makes to name it. */
export const GOOSE_TITLE_LIMIT = 80;
/** Desktop's title for an agent without a name (goose `sessionTitle`). */
export const GOOSE_UNNAMED_AGENT = "Buzz agent";
/** Leading characters of a thread root a session title shows. */
export const GOOSE_TITLE_ROOT_CHARS = 8;
/** Codex lists its models from one short `app-server`. */
export const CODEX_DISCOVERY_TIMEOUT_MS = 30_000;
/** Most model entries shown for Codex. */
export const CODEX_MODELS_MAX = 64;
/** The `codex app-server` of an agent is one process; the live-session cap
 * counts it under this key, whatever threads it holds. */
export const CODEX_HOST_KEY = "codex-host";
/** An `app-server` with no conversation working is stopped after this long,
 * as an idle Pi host or `goose-acp` is. */
export const CODEX_IDLE_MS = 15 * 60_000;
/** Desktop codex `STOP_LINGER_MS` and `LINGER_POLL_MS`: a stopped turn's
 * shell becomes a background terminal about 50 ms after the turn ends, so
 * the cleanup keeps looking this long, this often. */
export const CODEX_STOP_LINGER_MS = 1_000;
export const CODEX_LINGER_POLL_MS = 100;
/** Background terminals one list page asks for (Desktop's page size). */
export const CODEX_TERMINALS_PAGE = 100;
/** The dynamic tool namespace Desktop gives the Buzz tools; its developer
 * instructions name it. */
export const CODEX_TOOL_NAMESPACE = "buzz";
/** Codex's answer to a resume of a thread it has no rollout for (Desktop
 * codex `execute`): the thread then starts fresh. */
export const CODEX_MISSING_ROLLOUT = "no rollout found for thread id ";
/** Codex's answer to a steer that raced the turn's end (Desktop codex
 * `run`): the message then runs as the next turn. */
export const CODEX_NO_ACTIVE_TURN = "no active turn to steer";
/** Hex digits of the tool fingerprint a saved thread is filed under: a
 * resumed thread keeps the tools it started with, so other tools start fresh. */
export const CODEX_TOOLS_KEY_CHARS = 16;

/** Sessions, prompts and tokens one ACP telemetry tap remembers: old ones
 * belong to sessions long closed. */
export const ACP_TAP_REMEMBERED = 256;
/** What replaces a session's MCP token wherever a frame would carry it. */
export const ACP_TAP_REDACTED = "[redacted]";

// ---- Loopback MCP servers (Desktop src-tauri/src/host_mcp.rs) ----
/** Servers alive at once, for every agent: Desktop's MAX_SERVERS. */
export const MCP_MAX_SERVERS = 64;
/** Connections one server serves at once (Desktop CONNECTIONS). */
export const MCP_CONNECTIONS = 32;
/** Request head size and read time (Desktop HEAD_LIMIT, HEAD_TIMEOUT). */
export const MCP_HEAD_LIMIT_BYTES = 8192;
export const MCP_HEAD_TIMEOUT_MS = 5_000;
/** Request body size and read time (Desktop BODY_LIMIT, BODY_TIMEOUT). */
export const MCP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
export const MCP_BODY_TIMEOUT_MS = 30_000;
/** Largest reply sent; a larger one answers with an error (REPLY_LIMIT). */
export const MCP_REPLY_LIMIT_BYTES = 16 * 1024 * 1024;
/** Token and session id: 256 random bits each, base64url. */
export const MCP_SECRET_BYTES = 32;
export const MCP_ENDPOINT = "/mcp";
export const MCP_HOST = "127.0.0.1";

/** Pubkeys appear in logs only as this many leading hex digits. */
export const LOG_PUBKEY_CHARS = 12;
