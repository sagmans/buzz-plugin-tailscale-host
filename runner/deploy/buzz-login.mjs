// buzz-login: signs the harnesses buzz-runner hosts in, as the harness user,
// into the same files the hosted agents read. Install to
// /usr/local/libexec/buzz-runner/buzz-login.mjs (root:root, 0644); the bash
// front /usr/local/bin/buzz-login checks the user, rebuilds the environment
// from nothing and runs this.
// install.sh rewrites the fixed-place constants below for the host; the
// values here are the defaults it starts from.
//
// Each harness keeps its own sign-in format, so each is written by the
// harness's own code, never by hand:
//   claude  `claude auth login` (the CLI's own sign-in, on the terminal)
//   codex   `codex login --device-auth`, or `--with-api-key` fed on stdin
//   goose   goose-acp's provider setup over ACP, as Buzz Desktop does
//   pi      pi-ai's `models.login` with Pi's auth.json under Pi's lock, as
//           buzz-app's Pi host does
//
// Secrets: a key or pasted code is read here from the terminal with echo
// off and goes only to the harness code that stores it: in memory to
// pi-ai, in an ACP request on goose-acp's stdin, on codex's stdin. It is
// never an argument or environment variable (both show in `ps`), never
// printed and never logged: every line this prints passes `redact`. Status
// output names providers and sign-in methods only, never values, account
// emails or organization ids.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants as osConstants, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// --- Fixed places: all root-owned installs or the harness user's home. ---

const RUN_AS = "buzz-agent";
const HOME_DIR = "/home/buzz-agent";
const SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
const CLAUDE_DIR = "/usr/local/lib/buzz-harness/claude/2.1.316";
const CLAUDE_BIN = `${CLAUDE_DIR}/claude`;
const CODEX_BIN = "/usr/local/lib/buzz-harness/codex/0.164.0/bin/codex";
const GOOSE_BIN = "/usr/local/lib/buzz-harness/goose/1.57.0/goose-acp";
const PI_MODULES = "/usr/local/lib/buzz-harness/pi/1.4.0/node_modules";
const PI_AI_PROVIDERS = `${PI_MODULES}/@earendil-works/pi-ai/dist/providers/all.js`;
/** pi-ai's thinking levels per model, as the Pi host (host.mjs) offers them. */
const PI_AI_MODELS = `${PI_MODULES}/@earendil-works/pi-ai/dist/models.js`;
/** The shared homes the wrapper (harness-wrapper) points every agent at. */
const CODEX_HOME = `${HOME_DIR}/.codex`;
const GOOSE_CONFIG_HOME = `${HOME_DIR}/.config`;
const PI_DIR = `${HOME_DIR}/.pi/agent`;
const PI_AUTH = `${PI_DIR}/auth.json`;
const PI_SETTINGS = `${PI_DIR}/settings.json`;
/** OpenAI's ChatGPT sign-in names the installation by a stable UUID. */
const STATE_DIR = `${HOME_DIR}/.local/share/buzz-login`;
const DEVICE_ID_FILE = `${STATE_DIR}/device-id`;
/** goose-acp's sessions and logs go to a throwaway folder: only its
 * config and secrets.yaml, under GOOSE_CONFIG_HOME, are the sign-in. */
const GOOSE_TMP_PREFIX = "/tmp/buzz-login-goose-";
/** goose opens a browser for a device code; on a server that is nothing,
 * and `BROWSER` is how its opener is told so. */
const NO_BROWSER = "/bin/true";

// --- Limits and timeouts. ---

/** A status child answers in seconds; past this it is stuck. */
const STATUS_TIMEOUT_MS = 30_000;
/** A person reads a code, signs in in a browser and comes back. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
/** One answer at the terminal; an unattended prompt fails closed. */
const PROMPT_TIMEOUT_MS = 10 * 60_000;
/** How long a device-code sign-in may stay without a code before the
 * owner is told it is still waiting. */
const GOOSE_CODE_WAIT_MS = 60_000;
/** goose-acp loads its provider catalog on start. */
const ACP_REQUEST_TIMEOUT_MS = 60_000;
/** Between SIGTERM and SIGKILL when a child must stop. */
const KILL_GRACE_MS = 3_000;
/** A key or a pasted redirect URL is far shorter; more is not one. */
const INPUT_MAX_CHARS = 8_192;
/** Child output kept for one message; more is cut. */
const OUTPUT_MAX_BYTES = 1024 * 1024;
/** One goose-acp message; the provider list is the largest. */
const ACP_LINE_MAX_BYTES = 32 * 1024 * 1024;
/** Text from a harness is shown at most this long. */
const SHOW_MAX_CHARS = 300;
const URL_MAX_CHARS = 4_096;
/** Pi's lock, as buzz-app's Pi host and the `pi` command take it. */
const PI_LOCK = {
  realpath: false,
  stale: 30_000,
  retries: { retries: 30, minTimeout: 20, maxTimeout: 2_000 },
};
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// --- Exit codes (sysexits), as the wrappers use. ---

const EXIT_FAIL = 1;
const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;
const EXIT_TEMPFAIL = 75;
const EXIT_NOPERM = 77;
const EXIT_CANCELLED = 130;

// --- Input shapes, checked before anything uses an argument. ---

const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;
/** A thinking level as pi-ai names them (off, minimal, low, …, max). */
const THINKING_LEVEL = /^[a-z]{1,16}$/;
/** Pi's `!command` and `$NAME` keys run or read something else; buzz-app's
 * Pi host refuses them, so they are not saved here either. */
const INDIRECT_KEY = /^(?:!|\$(?:\{\w+\}|\w+)$)/;
/** A device code and its page, before either is shown. */
const USER_CODE = /^[A-Za-z0-9-]{4,32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const GOOSE_DEVICE_CODE = "_goose/unstable/providers/authentication/device-code";

/** Sync undo steps for a run a signal ends (goose-acp and its folder). */
const onSignal = new Set();
/** Set while a sign-in CLI holds the terminal: Ctrl-C is its to handle,
 * and it reports the cancel in its exit code. */
let terminalChild = false;
const SIGNALS = [
  ["SIGINT", 2],
  ["SIGHUP", 1],
  ["SIGTERM", 15],
];

/** A failure with what the owner can do about it; `cause` keeps the chain. */
class LoginError extends Error {
  constructor(message, { cause, exit = EXIT_FAIL } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "LoginError";
    this.exit = exit;
  }
}
class Cancelled extends LoginError {
  constructor() {
    super("Cancelled.", { exit: EXIT_CANCELLED });
  }
}

// --- Output: everything shown passes here. ---

/** Every form an entered secret can come back in (as typed, JSON-escaped
 * in an error, URL-encoded in a link); no line that holds one is printed. */
const secrets = new Set();
const remember = (value) => {
  if (value)
    for (const form of [value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)]) if (form) secrets.add(form);
  return value;
};
/** Control characters, line and paragraph separators and format
 * characters (bidi overrides, zero-width): each can hide or fake text. */
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu;
/** One such character, for input checked a character at a time. */
const UNSAFE_CHAR = /^[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]$/u;
/** Harness text may carry terminal control sequences; only plain text is
 * shown, cut to a size, with any entered secret masked, longest form first. */
function clean(value, max = SHOW_MAX_CHARS) {
  let text = String(value ?? "").replace(UNSAFE_TEXT, " ").trim();
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join("<hidden>");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
/** Each line cleaned on its own, so a message keeps its lines. */
const lines = (text) => String(text ?? "").split("\n").map((line) => `${clean(line, URL_MAX_CHARS)}\n`).join("");
/** A reader that went away (`buzz-login pi list | head`) ends the output,
 * not the run: the run still closes goose-acp and removes its folder. */
const closed = new Set();
for (const stream of [process.stdout, process.stderr]) stream.on("error", () => closed.add(stream));
const write = (stream, text) => closed.has(stream) || stream.write(text);
const say = (text = "") => write(process.stdout, lines(text));
const note = (text) => write(process.stderr, lines(text));
/** Fixed-width rows; widths from the content, so long ids stay readable. */
function table(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => clean(row[column]).length)));
  for (const row of rows) say(`  ${row.map((cell, column) => clean(cell).padEnd(widths[column])).join("  ")}`.trimEnd());
}
/** A link as the URL parser reads it, or undefined: only https is shown. */
function httpsUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.href.length <= URL_MAX_CHARS ? url.href : undefined;
  } catch {
    return undefined;
  }
}

// --- Terminal input. ---

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const CTRL_U = "\u0015";
const ESC = "\u001b";
const BACKSPACE = new Set(["\u007f", "\b"]);
const ENTER = new Set(["\r", "\n"]);
/** After ESC, these open a sequence (CSI, SS3) that ends at a byte in
 * FINAL_BYTE; arrow keys and pasted-text markers are such sequences. */
const SEQUENCE_OPENERS = new Set(["[", "O"]);
const FINAL_BYTE = /[@-~]/;

/** Interactive steps need a person at a terminal: a key piped in would sit
 * in a shell history or a file. */
function requireTerminal() {
  if (!process.stdin.isTTY || !process.stderr.isTTY)
    throw new LoginError(`This step needs a terminal: run ${AS_HARNESS_USER} in one.`, { exit: EXIT_USAGE });
}

/** One line from the terminal, in raw mode so a secret is never echoed and
 * Ctrl-C cancels without leaving the terminal in raw mode. `signal` ends
 * the prompt when something else answers it (Pi's callback server). Escape
 * sequences are dropped whole, so an arrow key or a paste marker never
 * ends up inside a key. */
function ask(message, { secret = false, signal } = {}) {
  requireTerminal();
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Cancelled());
    let value = "";
    let escape = "";
    const finish = (error) => {
      clearTimeout(timer);
      input.off("data", onData);
      signal?.removeEventListener("abort", onAbort);
      input.setRawMode(false);
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new LoginError("No answer in time.", { exit: EXIT_TEMPFAIL })), PROMPT_TIMEOUT_MS);
    const onAbort = () => finish(signal.reason ?? new Cancelled());
    const onData = (chunk) => {
      // #lizard forgives: one branch per terminal control key
      for (const char of chunk.toString("utf8")) {
        if (escape === ESC) {
          escape = SEQUENCE_OPENERS.has(char) ? char : "";
          continue;
        }
        if (escape) {
          if (FINAL_BYTE.test(char)) escape = "";
          continue;
        }
        if (char === ESC) {
          escape = ESC;
          continue;
        }
        if (char === CTRL_C || (char === CTRL_D && !value)) return finish(new Cancelled());
        if (ENTER.has(char)) return finish();
        if (BACKSPACE.has(char)) {
          if (value) {
            value = value.slice(0, -1);
            if (!secret) process.stderr.write("\b \b");
          }
        } else if (char === CTRL_U) {
          if (!secret) process.stderr.write("\b \b".repeat(value.length));
          value = "";
        } else if (!UNSAFE_CHAR.test(char)) {
          if (value.length >= INPUT_MAX_CHARS) return finish(new LoginError("That is longer than any key or code.", { exit: EXIT_USAGE }));
          value += char;
          if (!secret) process.stderr.write(char);
        }
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    process.stderr.write(`${clean(message)}${secret ? " (input hidden)" : ""}: `);
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", onData);
    input.resume();
  });
}

/** A secret answer: never empty, and remembered so no output shows it. */
async function askSecret(message, options) {
  const value = (await ask(message, { ...options, secret: true })).trim();
  if (!value) throw new LoginError("Nothing was entered.", { exit: EXIT_CANCELLED });
  return remember(value);
}

/** A numbered choice; the owner types a number or the exact id. */
async function pick(message, options, signal) {
  if (!options.length) throw new LoginError(`${message}: there is nothing to choose.`, { exit: EXIT_UNAVAILABLE });
  note(message);
  options.forEach((option, index) => note(`  ${String(index + 1).padStart(3)}. ${option.label}`));
  for (;;) {
    const answer = (await ask("Number or id", { signal })).trim();
    const byNumber = /^\d+$/.test(answer) ? options[Number(answer) - 1] : undefined;
    const chosen = byNumber ?? options.find((option) => option.id === answer);
    if (chosen) return chosen.id;
    note("Not in the list.");
  }
}

/** The terminal's settings as the run found them. libuv keeps the settings
 * from before its first raw switch and restores them on every switch back,
 * so taking them first lets a sign-in CLI that dies in raw mode, without
 * echo, be undone after it. */
function saveTerminal() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.setRawMode(false);
}
const restoreTerminal = saveTerminal;

// --- Children: fixed binaries, an environment built here, no shell. ---

/** What every child starts from, as the wrapper's base environment. */
function baseEnv(extra = {}) {
  return {
    HOME: HOME_DIR,
    USER: RUN_AS,
    LOGNAME: RUN_AS,
    SHELL: "/bin/bash",
    PATH: SAFE_PATH,
    LANG: "C.UTF-8",
    TMPDIR: "/tmp",
    // Set by the bash front from a checked value; the interactive
    // sign-ins draw their screens with it.
    TERM: process.env.TERM || "dumb",
    ...extra,
  };
}

/** Signals a child and, when it leads its own session (`detached`), every
 * process it started, so no helper outlives the run. */
function signalChild(child, signal) {
  try {
    if (child.detachedGroup && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    // Already gone.
  }
}

/** Stops a child: SIGTERM, then SIGKILL if it stays. */
function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    // The leader is gone; its helpers may not be.
    if (child.detachedGroup) signalChild(child, "SIGKILL");
    return;
  }
  signalChild(child, "SIGTERM");
  setTimeout(() => signalChild(child, "SIGKILL"), KILL_GRACE_MS).unref();
}

/** Resolves when the child has exited and its output is read, or a grace
 * after it exited: a helper that keeps a pipe open must not hold the run. */
function ended(child) {
  return new Promise((resolve) => {
    let exit;
    let grace;
    const done = () => {
      clearTimeout(grace);
      for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy();
      resolve(exit ?? { code: child.exitCode, signal: child.signalCode });
    };
    child.once("exit", (code, signal) => {
      exit = { code, signal };
      grace = setTimeout(() => {
        stop(child);
        done();
      }, KILL_GRACE_MS);
    });
    child.once("close", (code, signal) => {
      exit ??= { code, signal };
      done();
    });
  });
}

/** Spawns a fixed binary. Without the terminal it leads a session of its
 * own (`detached`): it and anything it starts get no controlling terminal,
 * so none of them can read the next key typed or write to the screen. */
function start(bin, args, { env, cwd = HOME_DIR, terminal = false }) {
  const child = spawn(bin, args, {
    env,
    cwd,
    detached: !terminal,
    stdio: terminal ? "inherit" : ["pipe", "pipe", "pipe"],
  });
  child.detachedGroup = !terminal;
  return child;
}

/** Runs `bin args` to its end. `terminal` hands the terminal to it (an
 * interactive sign-in); otherwise output is kept, bounded, for the caller,
 * and `input` (a secret) is written to its stdin and nowhere else. */
async function run(bin, args, { env, timeoutMs, terminal = false, input } = {}) {
  let child;
  try {
    child = start(bin, args, { env, terminal });
  } catch (cause) {
    throw new LoginError(`Could not start ${bin}.`, { cause, exit: EXIT_UNAVAILABLE });
  }
  const failed = new Promise((_, reject) =>
    child.once("error", (cause) => reject(new LoginError(`Could not run ${bin}.`, { cause, exit: EXIT_UNAVAILABLE }))),
  );
  if (terminal) terminalChild = true;
  let output = Buffer.alloc(0);
  const keep = (chunk) => {
    if (output.length < OUTPUT_MAX_BYTES) output = Buffer.concat([output, chunk]).subarray(0, OUTPUT_MAX_BYTES);
  };
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stop(child);
  }, timeoutMs);
  const undo = () => signalChild(child, "SIGKILL");
  onSignal.add(undo);
  if (!terminal) {
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    // A child that exits before reading its input is an error at exit,
    // not a crash here.
    child.stdin.on("error", () => {});
    if (input !== undefined) child.stdin.end(`${input}\n`);
    else child.stdin.end();
  }
  try {
    const { code, signal } = await Promise.race([ended(child), failed]);
    if (timedOut) throw new LoginError(`${bin} ${args.join(" ")} did not finish in ${Math.round(timeoutMs / 1000)} s.`, { exit: EXIT_TEMPFAIL });
    return { code, signal, output: output.toString("utf8") };
  } finally {
    clearTimeout(timer);
    onSignal.delete(undo);
    if (terminal) {
      terminalChild = false;
      restoreTerminal();
    }
  }
}

/** A terminal sign-in that did not succeed, with the exit a shell would
 * give: 128 + the signal number for a killed one. */
function childFailed(what, { code, signal }) {
  const number = signal ? osConstants.signals[signal] : undefined;
  return new LoginError(`${what} stopped (${signal ?? `exit ${code}`}).`, { exit: number ? 128 + number : EXIT_FAIL });
}

// --- Claude. ---

const CLAUDE_ENV = () =>
  baseEnv({
    PATH: `${CLAUDE_DIR}:${SAFE_PATH}`,
    DISABLE_AUTOUPDATER: "1",
  });

/** Only these status fields are shown: the rest hold the account email
 * and organization. */
async function claudeStatus() {
  const { code, output } = await run(CLAUDE_BIN, ["auth", "status", "--json"], {
    env: CLAUDE_ENV(),
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  let status;
  try {
    status = JSON.parse(output);
  } catch (cause) {
    throw new LoginError(`claude auth status gave no status (exit ${code}).`, { cause });
  }
  if (!status?.loggedIn) return { signedIn: "no" };
  const how = [status.authMethod, status.apiProvider, status.subscriptionType].filter((part) => typeof part === "string" && part);
  return { signedIn: `yes (${how.join(", ")})` };
}

/** Claude Code takes no key on stdin: it signs in on the terminal, with a
 * claude.ai subscription or an Anthropic Console account (API billing). */
async function claudeLogin(args) {
  // Claude Code has no key entry: --api-key means the Console sign-in,
  // which bills the API.
  const consoleFlag = takeFlag(args, "--console");
  const apiKeyFlag = takeFlag(args, "--api-key");
  const billing = consoleFlag || apiKeyFlag;
  noMoreArgs(args);
  requireTerminal();
  const method = billing ? "--console" : "--claudeai";
  note(billing ? "Signing Claude in with an Anthropic Console account (API billing)." : "Signing Claude in with a claude.ai subscription.");
  note("Open the link Claude shows, sign in, then paste the code back here.");
  const { code, signal } = await run(CLAUDE_BIN, ["auth", "login", method], {
    env: CLAUDE_ENV(),
    timeoutMs: SIGN_IN_TIMEOUT_MS,
    terminal: true,
  });
  if (code !== 0) throw childFailed("claude auth login", { code, signal });
  say(`Claude: signed in: ${(await claudeStatus()).signedIn}.`);
}

// --- Codex. ---

const CODEX_ENV = () => baseEnv({ CODEX_HOME });

/** Codex says which sign-in it holds in words; only the kind is shown,
 * never the line, which can hold part of a key. */
async function codexStatus() {
  const { code, output } = await run(CODEX_BIN, ["login", "status"], {
    env: CODEX_ENV(),
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  if (/not logged in/i.test(output)) return { signedIn: "no" };
  if (code !== 0) throw new LoginError(`codex login status failed (exit ${code}).`);
  if (/chatgpt/i.test(output)) return { signedIn: "yes (ChatGPT)" };
  if (/api key/i.test(output)) return { signedIn: "yes (API key)" };
  return { signedIn: "yes" };
}

/** The shared home holds auth.json; only buzz-agent may read it. */
function privateCodexHome() {
  mkdirSync(CODEX_HOME, { recursive: true, mode: DIR_MODE });
  chmodSync(CODEX_HOME, DIR_MODE);
}

async function codexLogin(args) {
  let apiKey = takeFlag(args, "--api-key");
  let device = takeFlag(args, "--device");
  noMoreArgs(args);
  requireTerminal();
  if (apiKey && device) throw new LoginError("Choose one: --api-key or --device.", { exit: EXIT_USAGE });
  if (!apiKey && !device) {
    const way = await pick("How should Codex sign in?", [
      { id: "device", label: "ChatGPT account, with a code (device sign-in)" },
      { id: "api-key", label: "OpenAI API key" },
    ]);
    apiKey = way === "api-key";
    device = !apiKey;
  }
  if (device) {
    privateCodexHome();
    note("Open the link Codex shows and enter its code. ChatGPT must allow device code sign-in (Settings > Security).");
    const { code, signal } = await run(CODEX_BIN, ["login", "--device-auth"], {
      env: CODEX_ENV(),
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      terminal: true,
    });
    if (code !== 0) throw childFailed("codex login --device-auth", { code, signal });
  } else {
    const key = await askSecret("OpenAI API key");
    if (/\s/.test(key)) throw new LoginError("An API key has no spaces or line breaks.", { exit: EXIT_USAGE });
    privateCodexHome();
    const { code, output } = await run(CODEX_BIN, ["login", "--with-api-key"], {
      env: CODEX_ENV(),
      timeoutMs: STATUS_TIMEOUT_MS,
      input: key,
    });
    if (code !== 0) throw new LoginError(`codex login --with-api-key failed (exit ${code}): ${clean(output)}`);
  }
  say(`Codex: signed in: ${(await codexStatus()).signedIn}.`);
}

// --- Goose, over ACP, as Buzz Desktop's goose setup. ---

/** A goose-acp started for one command: its own throwaway data and state,
 * the shared config and secrets.yaml. */
class Goose {
  static async open() {
    const scratch = mkdtempSync(GOOSE_TMP_PREFIX);
    const goose = new Goose(scratch);
    try {
      await goose.request("initialize", {
        protocolVersion: 1,
        // Without it goose sends the device code nowhere.
        clientCapabilities: { _meta: { goose: { customNotifications: true } } },
        clientInfo: { name: "buzz-login", version: "1" },
      });
      return goose;
    } catch (error) {
      await goose.close();
      throw error;
    }
  }

  constructor(scratch) {
    this.scratch = scratch;
    // A signal ends the run without `finally`; this still stops goose-acp
    // and removes the folder.
    this.cleanup = () => {
      signalChild(this.child, "SIGKILL");
      rmSync(scratch, { recursive: true, force: true });
    };
    onSignal.add(this.cleanup);
    this.calls = new Map();
    this.handlers = new Map();
    this.nextId = 0;
    this.buffer = Buffer.alloc(0);
    this.stderr = "";
    this.child = start(GOOSE_BIN, [], {
      cwd: scratch,
      env: baseEnv({
        // No desktop keyring for a service user: goose reads secrets.yaml.
        GOOSE_DISABLE_KEYRING: "1",
        XDG_CONFIG_HOME: GOOSE_CONFIG_HOME,
        XDG_DATA_HOME: join(scratch, "data"),
        XDG_STATE_HOME: join(scratch, "state"),
        BROWSER: NO_BROWSER,
      }),
    });
    this.child.stdout.on("data", (chunk) => this.read(chunk));
    // Kept short for a start failure only; never shown unredacted.
    this.child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-SHOW_MAX_CHARS * 4);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (cause) => this.fail(new LoginError(`Could not start goose-acp.`, { cause, exit: EXIT_UNAVAILABLE })));
    this.child.on("exit", (code, signal) =>
      this.fail(new LoginError(`goose-acp stopped (${signal ?? `exit ${code}`}): ${clean(this.stderr)}`, { exit: EXIT_UNAVAILABLE })),
    );
  }

  fail(error) {
    this.failure = error;
    for (const call of this.calls.values()) call.reject(error);
    this.calls.clear();
  }

  read(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (let newline = this.buffer.indexOf(0x0a); newline >= 0; newline = this.buffer.indexOf(0x0a)) {
      const line = this.buffer.subarray(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.subarray(newline + 1);
      if (line) this.message(line);
    }
    if (this.buffer.length > ACP_LINE_MAX_BYTES) {
      this.fail(new LoginError("goose-acp sent a message too large to read."));
      stop(this.child);
    }
  }

  message(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return; // Not ACP: goose logs go to stderr, so this is noise.
    }
    if (message.method && message.id !== undefined) {
      // A request to the client (a permission, a file): nothing here serves it.
      this.send({ jsonrpc: "2.0", id: message.id, error: { code: JSONRPC_METHOD_NOT_FOUND, message: "Not supported" } });
    } else if (message.method) {
      this.handlers.get(message.method)?.(message.params ?? {});
    } else if (this.calls.has(message.id)) {
      const call = this.calls.get(message.id);
      this.calls.delete(message.id);
      if (message.error)
        call.reject(new LoginError(`goose: ${clean(errorText(message.error))}`, { cause: message.error }));
      else call.resolve(message.result ?? {});
    }
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  on(method, handler) {
    this.handlers.set(method, handler);
  }

  request(method, params, timeoutMs = ACP_REQUEST_TIMEOUT_MS) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      if (this.failure) return reject(this.failure);
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new LoginError(`goose-acp did not answer ${method} in ${Math.round(timeoutMs / 1000)} s.`));
      }, timeoutMs);
      this.calls.set(id, {
        resolve: (value) => (clearTimeout(timer), resolve(value)),
        reject: (error) => (clearTimeout(timer), reject(error)),
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Stops goose-acp and removes its throwaway folder on every path. */
  async close() {
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        // goose-acp ends on stdin EOF; one that stays is stopped.
        const done = ended(this.child);
        this.child.stdin.end();
        const timer = setTimeout(() => stop(this.child), KILL_GRACE_MS);
        await done;
        clearTimeout(timer);
      }
      // Anything goose-acp started and left behind goes with it.
      stop(this.child);
    } finally {
      rmSync(this.scratch, { recursive: true, force: true });
      onSignal.delete(this.cleanup);
    }
  }

  /** The providers Desktop offers: shown in setup, not deprecated, not an
   * agent of its own (ACP providers run other CLIs). */
  async providers() {
    const { entries } = await this.request("_goose/unstable/providers/list", { providerIds: [] });
    return (entries ?? [])
      .filter((entry) => entry.visibleInSetup && !entry.deprecated && !entry.acp && PROVIDER_ID.test(entry.providerId ?? ""))
      .sort((a, b) => String(a.providerName).localeCompare(String(b.providerName)));
  }

  async defaults() {
    const { providerId, modelId } = await this.request("_goose/unstable/defaults/read", {});
    return { provider: providerId ?? "", model: modelId ?? "" };
  }

  /** The names of a provider's fields goose holds; never their values. */
  async setKeys(providerId) {
    const { fields } = await this.request("_goose/unstable/providers/config/read", { providerId });
    return new Set((fields ?? []).filter((field) => field.isSet).map((field) => field.key));
  }
}

/** A JSON-RPC error's words: goose puts the detail in `data`, as text or
 * an object. */
function errorText(error) {
  const detail = error?.data ?? error?.message;
  return typeof detail === "string" ? detail : JSON.stringify(detail);
}

/** Runs `work` with a goose-acp that is closed after, on every path. */
async function withGoose(work) {
  const goose = await Goose.open();
  try {
    return await work(goose);
  } finally {
    await goose.close();
  }
}

const keyFields = (entry) => (entry.configKeys ?? []).filter((key) => !key.oauthFlow && !key.deviceCodeFlow);
/** Only a device code works on a server: a browser sign-in waits for a
 * callback on this host's localhost, which the owner's browser can't reach. */
const deviceSignIn = (entry) => (entry.configKeys ?? []).some((key) => key.deviceCodeFlow);
const gooseWays = (entry) =>
  [keyFields(entry).length ? "key" : "", deviceSignIn(entry) ? "sign-in" : (entry.configKeys ?? []).some((key) => key.oauthFlow) ? "browser only" : ""]
    .filter(Boolean)
    .join(", ");

/** How a provider is set up, from which of its fields are set; "" when
 * none is. goose calls a local server (LM Studio, Ollama) configured on its
 * built-in host alone, which is no sign-in. */
async function gooseMethod(goose, entry) {
  const set = await goose.setKeys(entry.providerId);
  const keys = entry.configKeys ?? [];
  if (keys.some((key) => (key.oauthFlow || key.deviceCodeFlow) && set.has(key.name))) return "sign-in";
  if (keys.some((key) => key.secret && set.has(key.name))) return "key";
  return keys.some((key) => set.has(key.name)) ? "settings" : "";
}

async function gooseStatus(goose) {
  const [providers, defaults] = await Promise.all([goose.providers(), goose.defaults()]);
  const signedIn = [];
  for (const entry of providers.filter((entry) => entry.configured)) {
    const method = await gooseMethod(goose, entry);
    if (method) signedIn.push(`${entry.providerId} (${method})`);
  }
  return {
    signedIn: signedIn.join(", ") || "no",
    defaults: defaults.provider ? `${defaults.provider} / ${defaults.model || "-"}` : "-",
  };
}

async function gooseProvider(goose, id, message, usable = () => true) {
  const providers = await goose.providers();
  if (id === undefined)
    id = await pick(
      message,
      providers.filter(usable).map((entry) => ({ id: entry.providerId, label: `${entry.providerId} (${entry.providerName})` })),
    );
  const entry = providers.find((entry) => entry.providerId === id);
  if (!entry) throw new LoginError(`goose has no provider ${id}. See: buzz-login goose list`, { exit: EXIT_USAGE });
  return entry;
}

async function gooseList() {
  await withGoose(async (goose) => {
    const [providers, defaults] = await Promise.all([goose.providers(), goose.defaults()]);
    say(`Goose providers (default: ${defaults.provider ? `${defaults.provider} / ${defaults.model || "-"}` : "none"})`);
    const rows = [["ID", "NAME", "SET UP", "WAYS"]];
    for (const entry of providers)
      rows.push([entry.providerId, entry.providerName, (entry.configured && (await gooseMethod(goose, entry))) || "-", gooseWays(entry) || "-"]);
    table(rows);
  });
}

/** Asks for each of the provider's fields, as Desktop's Edit configuration:
 * secrets hidden, the rest shown, a field already set kept when left empty. */
async function gooseKey(args) {
  const id = optionalId(args, PROVIDER_ID, "provider");
  noMoreArgs(args);
  requireTerminal();
  await withGoose(async (goose) => {
    const entry = await gooseProvider(goose, id, "Which goose provider gets a key?", (entry) => keyFields(entry).length > 0);
    const keys = keyFields(entry);
    if (!keys.length) throw new LoginError(`${entry.providerId} takes no key. Try: buzz-login goose oauth ${entry.providerId}`, { exit: EXIT_USAGE });
    const set = await goose.setKeys(entry.providerId);
    const fields = [];
    for (const key of keys) {
      const label = `${key.name}${key.required ? "" : " (optional)"}${set.has(key.name) ? " [set; Enter keeps it]" : key.default ? ` [Enter: ${key.default}]` : ""}`;
      const value = (await ask(label, { secret: key.secret })).trim();
      if (key.secret) remember(value);
      if (!value) {
        // Enter keeps what goose holds, else takes the default it offers.
        if (set.has(key.name)) continue;
        if (key.default) fields.push({ key: key.name, value: key.default });
        else if (key.required) throw new LoginError(`${key.name} is required.`, { exit: EXIT_USAGE });
        continue;
      }
      fields.push({ key: key.name, value });
    }
    if (!fields.length) return say(`Goose: nothing changed for ${entry.providerId}.`);
    await goose.request("_goose/unstable/providers/config/save", { providerId: entry.providerId, fields });
    const after = (await goose.providers()).find((listed) => listed.providerId === entry.providerId);
    say(`Goose: ${entry.providerId} ${after?.configured ? "is set up" : "is saved but goose does not call it set up yet; check the fields"}.`);
  });
}

/** goose's own sign-in, for providers with a device code. */
async function gooseOauth(args) {
  const id = optionalId(args, PROVIDER_ID, "provider");
  noMoreArgs(args);
  requireTerminal();
  await withGoose(async (goose) => {
    const entry = await gooseProvider(goose, id, "Which goose provider signs in?", deviceSignIn);
    if (!deviceSignIn(entry))
      throw new LoginError(
        `${entry.providerId} has no device-code sign-in in goose (${gooseWays(entry) || "no sign-in"}). A browser sign-in needs a browser on this server; use a key: buzz-login goose key ${entry.providerId}`,
        { exit: EXIT_UNAVAILABLE },
      );
    let shown = false;
    goose.on(GOOSE_DEVICE_CODE, ({ providerId, userCode, verificationUri, expiresIn }) => {
      if (providerId !== entry.providerId) return;
      const page = httpsUrl(verificationUri);
      if (!USER_CODE.test(String(userCode)) || !page) return note("goose sent a sign-in code that does not look right; it is not shown.");
      shown = true;
      note(`Open ${page} and enter the code ${userCode}${Number.isFinite(expiresIn) ? ` (within ${Math.round(expiresIn / 60)} min)` : ""}.`);
    });
    note(`Starting the ${entry.providerName} sign-in…`);
    // A provider already signed in may finish without a code; one that
    // sends none while it waits is said so, not left silent.
    const quiet = setTimeout(() => shown || note("goose has sent no code yet; it is still waiting. Ctrl-C stops."), GOOSE_CODE_WAIT_MS);
    try {
      await goose.request("_goose/unstable/providers/config/authenticate", { providerId: entry.providerId }, SIGN_IN_TIMEOUT_MS);
    } finally {
      clearTimeout(quiet);
    }
    say(`Goose: ${entry.providerId} is signed in.`);
  });
}

/** Goose's own default, as Desktop writes it: a model the provider lists,
 * or the one goose keeps for it. */
async function gooseDefault(args) {
  const id = optionalId(args, PROVIDER_ID, "provider");
  let model = optionalId(args, MODEL_ID, "model");
  noMoreArgs(args);
  await withGoose(async (goose) => {
    const entry = await gooseProvider(goose, id, "Which goose provider is the default?", (entry) => entry.configured);
    const known = new Set((entry.models ?? []).map((listed) => listed.id));
    try {
      const { models } = await goose.request("_goose/unstable/providers/supported-models/list", { providerId: entry.providerId });
      for (const listed of models ?? []) known.add(listed);
    } catch {
      // A provider not set up yet lists nothing live; its catalog stays.
    }
    if (model === undefined && process.stdin.isTTY)
      model = await pick(`Which ${entry.providerId} model?`, [...known].sort().map((listed) => ({ id: listed, label: listed })));
    if (model === undefined) model = entry.defaultModel || "";
    if (!model || !known.has(model)) throw new LoginError(`${entry.providerId} lists no model ${model || "(none given)"}.`, { exit: EXIT_USAGE });
    if (!entry.configured) note(`${entry.providerId} is not set up yet; agents fail until it is.`);
    await goose.request("_goose/unstable/defaults/save", { providerId: entry.providerId, modelId: model });
    say(`Goose: default is ${entry.providerId} / ${model}.`);
  });
}

// --- Pi, through pi-ai, as buzz-app's Pi host. ---

/** proper-lockfile is CommonJS, loaded by its absolute path in the
 * root-installed set: a bare name could fall back to a module folder in
 * buzz-agent's home, which agents can write. */
const lockfile = () => createRequire(import.meta.url)(join(PI_MODULES, "proper-lockfile"));

/** Pi's auth.json, read and written as buzz-app's Pi host (AuthFile in
 * src/bundled/pi/host.mjs) and the `pi` command do, under the same lock. */
class AuthFile {
  constructor(path) {
    this.path = path;
  }
  async load() {
    let text;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    const parsed = JSON.parse(text.replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new LoginError(`${this.path} is not a JSON object`);
    return parsed;
  }
  all() {
    return this.locked((all) => all, false);
  }
  async read(id) {
    const credential = (await this.all())[id];
    return credential?.type === "api_key" && credential.key ? { ...credential, key: this.resolve(credential.key) } : credential;
  }
  async list() {
    return Object.entries(await this.all()).map(([providerId, value]) => ({ providerId, type: value.type }));
  }
  modify(id, change) {
    return this.locked(async (all) => {
      const next = await change(all[id]);
      if (next?.type === "api_key" && next.key) this.resolve(next.key);
      if (next !== undefined) all[id] = next;
      return all[id];
    });
  }
  async delete(id) {
    await this.locked((all) => {
      delete all[id];
    });
  }
  /** A `!command` or `$NAME` key is refused, as buzz-app's Pi host does:
   * the hosted agents could not use it. */
  resolve(key) {
    if (INDIRECT_KEY.test(key)) throw new LoginError("Pi keys here are the key itself, not a `!command` or `$NAME`.", { exit: EXIT_USAGE });
    return key;
  }
  async locked(change, save = true) {
    await mkdir(dirname(this.path), { recursive: true, mode: DIR_MODE });
    await writeFile(this.path, "{}", { flag: "wx", mode: FILE_MODE }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const release = await lockfile().lock(this.path, PI_LOCK);
    try {
      const all = await this.load();
      const result = await change(all);
      if (save) await writeFile(this.path, `${JSON.stringify(all, null, 2)}\n`, { mode: FILE_MODE });
      return result;
    } finally {
      await release();
    }
  }
}

async function piModels() {
  let builtinModels;
  try {
    ({ builtinModels } = await import(pathToFileURL(PI_AI_PROVIDERS).href));
  } catch (cause) {
    throw new LoginError(`Pi's packages are not installed at ${PI_MODULES}.`, { cause, exit: EXIT_UNAVAILABLE });
  }
  return builtinModels({ credentials: new AuthFile(PI_AUTH) });
}

/** Pi's settings, with the BOM an editor may save; none is an empty set. */
function piSettings() {
  try {
    const parsed = JSON.parse(readFileSync(PI_SETTINGS, "utf8").replace(/^\uFEFF/, ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new LoginError(`${PI_SETTINGS} is not valid JSON; fix it with the pi command or by hand.`, { cause: error });
  }
}

/** The providers Pi can run: built in, with models. */
function piProviders(models) {
  return models
    .getProviders()
    .filter((provider) => PROVIDER_ID.test(provider.id) && models.getModels(provider.id).length)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
}
const piWays = (provider) => [provider.auth?.apiKey?.login ? "key" : "", provider.auth?.oauth?.login ? "sign-in" : ""].filter(Boolean).join(", ");
/** Checking can refresh a sign-in over the network; it is bounded. */
const piCheck = (models, id) => models.checkAuth(id, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }).catch(() => undefined);

async function piStatus(models) {
  const signedIn = [];
  for (const provider of piProviders(models)) {
    const auth = await piCheck(models, provider.id);
    if (auth) signedIn.push(`${provider.id} (${auth.type === "oauth" ? "sign-in" : "key"})`);
  }
  const settings = piSettings();
  return {
    signedIn: signedIn.join(", ") || "no",
    defaults: settings.defaultProvider ? `${settings.defaultProvider} / ${settings.defaultModel || "-"}` : "-",
  };
}

async function piList() {
  const models = await piModels();
  const settings = piSettings();
  say(`Pi providers (default: ${settings.defaultProvider ? `${settings.defaultProvider} / ${settings.defaultModel || "-"}` : "none"})`);
  const rows = [["ID", "NAME", "SIGNED IN", "WAYS"]];
  for (const provider of piProviders(models)) {
    const auth = await piCheck(models, provider.id);
    rows.push([provider.id, provider.name, auth ? (auth.type === "oauth" ? "sign-in" : `key${auth.source ? ` (${auth.source})` : ""}`) : "-", piWays(provider) || "-"]);
  }
  table(rows);
}

/** The same install ID for every ChatGPT sign-in from here. */
function deviceId() {
  try {
    const stored = readFileSync(DEVICE_ID_FILE, "utf8").trim();
    if (UUID.test(stored)) return stored;
  } catch (error) {
    if (error.code !== "ENOENT") throw new LoginError(`Could not read ${DEVICE_ID_FILE}.`, { cause: error });
  }
  const id = randomUUID();
  mkdirSync(STATE_DIR, { recursive: true, mode: DIR_MODE });
  writeFileSync(DEVICE_ID_FILE, `${id}\n`, { mode: FILE_MODE });
  return id;
}

/** pi-ai's login prompts and events, on this terminal. A `secret` or a
 * pasted code is hidden; a choice is a numbered list. */
function piInteraction(signal) {
  return {
    signal,
    async prompt(prompt) {
      const options = { signal: prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal };
      switch (prompt.type) {
        case "secret":
        case "manual_code":
          return askSecret(prompt.message, options);
        case "select":
          return pick(prompt.message, (prompt.options ?? []).map((option) => ({ id: option.id, label: option.label })), options.signal);
        default:
          return (await ask(prompt.message, options)).trim();
      }
    },
    notify(event) {
      if (event.type === "auth_url") {
        const link = httpsUrl(event.url);
        if (!link) return note("Pi sent a sign-in link that is not https; it is not shown.");
        note(`Open this link in your browser:\n${link}`);
        if (event.instructions) note(event.instructions);
        note("If the browser ends on a page that does not load (localhost), copy that page's full address and paste it here.");
      } else if (event.type === "device_code") {
        const page = httpsUrl(event.verificationUri);
        if (!USER_CODE.test(String(event.userCode)) || !page) return note("Pi sent a sign-in code that does not look right; it is not shown.");
        note(`Open ${page} and enter the code ${event.userCode}.`);
      } else if (event.message) {
        note(event.message);
        for (const { url, label } of event.links ?? []) {
          const link = httpsUrl(url);
          if (link) note(`  ${label ? `${label}: ` : ""}${link}`);
        }
      }
    },
  };
}

async function piProvider(models, id, message, usable) {
  const providers = piProviders(models);
  if (id === undefined)
    id = await pick(message, providers.filter(usable).map((provider) => ({ id: provider.id, label: `${provider.id} (${provider.name})` })));
  const provider = providers.find((provider) => provider.id === id);
  if (!provider) throw new LoginError(`Pi has no provider ${id}. See: buzz-login pi list`, { exit: EXIT_USAGE });
  return provider;
}

/** `type` is pi-ai's: "api_key" or "oauth". */
async function piLogin(args, type) {
  const id = optionalId(args, PROVIDER_ID, "provider");
  noMoreArgs(args);
  requireTerminal();
  const models = await piModels();
  const oauth = type === "oauth";
  const usable = (provider) => Boolean(oauth ? provider.auth?.oauth?.login : provider.auth?.apiKey?.login);
  const provider = await piProvider(models, id, oauth ? "Which Pi provider signs in?" : "Which Pi provider gets a key?", usable);
  if (!usable(provider))
    throw new LoginError(`${provider.id} has no ${oauth ? "sign-in" : "key entry"} in Pi (ways: ${piWays(provider) || "none"}).`, { exit: EXIT_USAGE });
  const signal = AbortSignal.timeout(SIGN_IN_TIMEOUT_MS);
  await models.login(provider.id, type, piInteraction(signal), oauth ? { getDeviceId: deviceId } : undefined);
  const auth = await piCheck(models, provider.id);
  say(`Pi: ${provider.id} ${auth ? `is signed in (${auth.type === "oauth" ? "sign-in" : "key"})` : "was saved, but Pi does not see it as usable"}.`);
  if (!piSettings().defaultProvider) note(`Pi has no default yet: buzz-login pi default ${provider.id}/<model>`);
}

/** Pi's defaults, written under Pi's lock and replaced whole, so a reader
 * never sees half a file; every other setting is kept. */
async function piDefault(args) {
  const spec = args.shift();
  let effort = args.shift();
  noMoreArgs(args);
  if (effort !== undefined && !THINKING_LEVEL.test(effort))
    throw new LoginError("Give the thinking level as `buzz-login pi list` shows it, e.g. high.", { exit: EXIT_USAGE });
  const models = await piModels();
  let id;
  let model;
  if (spec !== undefined) {
    const slash = spec.indexOf("/");
    id = slash > 0 ? spec.slice(0, slash) : spec;
    model = slash > 0 ? spec.slice(slash + 1) : undefined;
    if (!PROVIDER_ID.test(id) || (model !== undefined && !MODEL_ID.test(model)))
      throw new LoginError("Give the default as <provider>/<model>, as `buzz-login pi list` shows.", { exit: EXIT_USAGE });
  }
  const provider = await piProvider(models, id, "Which Pi provider is the default?", () => true);
  const listed = models.getModels(provider.id);
  if (model === undefined) {
    if (!process.stdin.isTTY) throw new LoginError("Give the default as <provider>/<model>.", { exit: EXIT_USAGE });
    model = await pick(`Which ${provider.id} model?`, listed.map((entry) => ({ id: entry.id, label: entry.name && entry.name !== entry.id ? `${entry.id} (${entry.name})` : entry.id })));
  }
  const chosen = listed.find((entry) => entry.id === model);
  if (!chosen) throw new LoginError(`Pi's ${provider.id} has no model ${model}.`, { exit: EXIT_USAGE });
  // The thinking level must be one the model supports: Pi clamps any other,
  // so a level it would not run is refused here rather than saved silently.
  const levels = await piThinkingLevels(chosen);
  if (effort === undefined && process.stdin.isTTY && levels.length)
    effort = await pick(`Which thinking level for ${model}?`, [
      { id: "", label: "Pi's default" },
      ...levels.map((level) => ({ id: level, label: level })),
    ]);
  if (effort && !levels.includes(effort))
    throw new LoginError(`${model} has no thinking level ${effort}; it has: ${levels.join(", ") || "none"}.`, { exit: EXIT_USAGE });
  if (!(await piCheck(models, provider.id))) note(`${provider.id} is not signed in yet; agents fail until it is.`);
  await mkdir(PI_DIR, { recursive: true, mode: DIR_MODE });
  await writeFile(PI_SETTINGS, "{}\n", { flag: "wx", mode: FILE_MODE }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const release = await lockfile().lock(PI_SETTINGS, PI_LOCK);
  try {
    const settings = { ...piSettings(), defaultProvider: provider.id, defaultModel: model };
    // "" (Pi's default) drops the key, so Pi's own level applies again.
    if (effort) settings.defaultThinkingLevel = effort;
    else if (effort === "") delete settings.defaultThinkingLevel;
    const next = `${PI_SETTINGS}.buzz-login`;
    // A leftover from a killed run is replaced, never written through.
    rmSync(next, { force: true });
    writeFileSync(next, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx", mode: FILE_MODE });
    renameSync(next, PI_SETTINGS);
  } finally {
    await release();
  }
  const thinking = effort === undefined ? piSettings().defaultThinkingLevel : effort;
  say(`Pi: default is ${provider.id} / ${model}, thinking ${thinking || "Pi's default"}.`);
  // #lizard forgives: one check per argument and Pi setting, in the order the CLI reads them
}

/** The model's thinking levels, lowest first, as the Pi host lists them. */
async function piThinkingLevels(model) {
  let getSupportedThinkingLevels;
  try {
    ({ getSupportedThinkingLevels } = await import(pathToFileURL(PI_AI_MODELS).href));
  } catch (cause) {
    throw new LoginError(`Pi's packages are not installed at ${PI_MODULES}.`, { cause, exit: EXIT_UNAVAILABLE });
  }
  return getSupportedThinkingLevels(model);
}

// --- Status for all four. ---

/** One harness failing to answer is shown in its row, not a stop. */
async function row(name, check) {
  try {
    const { signedIn, defaults = "-" } = await check();
    return [name, signedIn, defaults];
  } catch (error) {
    return [name, `unknown: ${clean(error.message)}`, "-"];
  }
}

async function status(args) {
  noMoreArgs(args);
  const rows = [["HARNESS", "SIGNED IN", "DEFAULT"]];
  rows.push(await row("claude", claudeStatus));
  rows.push(await row("codex", codexStatus));
  rows.push(await row("goose", () => withGoose(gooseStatus)));
  rows.push(await row("pi", async () => piStatus(await piModels())));
  table(rows);
  say();
  say("Pi agents use a new sign-in at once. A running Claude, Codex or Goose agent may need a stop and start to use it.");
}

// --- Arguments. ---

/** The owner runs this from their own shell, not a login shell of
 * buzz-agent: buzz-agent's ~/.bashrc and ~/.profile are files agents can write. */
const AS_HARNESS_USER = `sudo -u ${RUN_AS} /usr/local/bin/buzz-login`;
const USAGE = `Usage, from your own shell: ${AS_HARNESS_USER} <command>
  buzz-login                          choose from a menu
  buzz-login status                   every harness: what is signed in, never values
  buzz-login claude [--console]       claude.ai subscription; --console: Anthropic Console (API billing)
  buzz-login codex [--device|--api-key]
  buzz-login goose list
  buzz-login goose key [provider]     enter a provider's key and settings
  buzz-login goose oauth [provider]   sign in with a device code
  buzz-login goose default [provider [model]]
  buzz-login pi list
  buzz-login pi key [provider]
  buzz-login pi oauth [provider]      sign in in a browser or with a device code
  buzz-login pi default [provider/model [thinking]]`;

function takeFlag(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
function noMoreArgs(args) {
  if (args.length) throw new LoginError(`Unexpected: ${clean(args.join(" "))}\n${USAGE}`, { exit: EXIT_USAGE });
}
/** An id from the command line, checked for shape before any harness sees it. */
function optionalId(args, shape, what) {
  if (!args.length || args[0].startsWith("-")) return undefined;
  const value = args.shift();
  if (!shape.test(value)) throw new LoginError(`That is not a ${what} id: ${clean(value)}`, { exit: EXIT_USAGE });
  return value;
}
const COMMANDS = {
  status,
  claude: claudeLogin,
  codex: codexLogin,
  goose: (args) => sub("goose", args, { list: (rest) => (noMoreArgs(rest), gooseList()), key: gooseKey, oauth: gooseOauth, default: gooseDefault }),
  pi: (args) => sub("pi", args, { list: (rest) => (noMoreArgs(rest), piList()), key: (rest) => piLogin(rest, "api_key"), oauth: (rest) => piLogin(rest, "oauth"), default: piDefault }),
};

function sub(harness, args, actions) {
  const action = args.shift();
  if (!Object.hasOwn(actions, action ?? "")) throw new LoginError(`buzz-login ${harness}: choose ${Object.keys(actions).join(", ")}.\n${USAGE}`, { exit: EXIT_USAGE });
  return actions[action](args);
}

const MENU = [
  { id: "status", label: "Show what is signed in", args: ["status"] },
  { id: "claude", label: "Claude: sign in", args: ["claude"] },
  { id: "codex", label: "Codex: sign in", args: ["codex"] },
  { id: "goose-key", label: "Goose: enter a provider key", args: ["goose", "key"] },
  { id: "goose-oauth", label: "Goose: sign in with a device code", args: ["goose", "oauth"] },
  { id: "goose-default", label: "Goose: choose the default model", args: ["goose", "default"] },
  { id: "pi-key", label: "Pi: enter a provider key", args: ["pi", "key"] },
  { id: "pi-oauth", label: "Pi: sign in", args: ["pi", "oauth"] },
  { id: "pi-default", label: "Pi: choose the default model", args: ["pi", "default"] },
];

async function main(argv) {
  // The bash front checks this too; the files written here are buzz-agent's.
  if (userInfo().username !== RUN_AS || process.env.HOME !== HOME_DIR)
    throw new LoginError(`Run buzz-login as ${RUN_AS}: ${AS_HARNESS_USER} status`, { exit: EXIT_NOPERM });
  process.umask(0o077);
  saveTerminal();
  const args = [...argv];
  if (args[0] === "-h" || args[0] === "--help" || args[0] === "help") return say(USAGE);
  if (!args.length) {
    if (!process.stdin.isTTY) throw new LoginError(USAGE, { exit: EXIT_USAGE });
    const chosen = await pick("What do you want to do?", MENU);
    args.push(...MENU.find((item) => item.id === chosen).args);
  }
  const command = args.shift();
  if (!Object.hasOwn(COMMANDS, command)) throw new LoginError(`Unknown command: ${clean(command)}\n${USAGE}`, { exit: EXIT_USAGE });
  await COMMANDS[command](args);
}

// A raw terminal is never left behind, whatever ends the run.
process.on("exit", () => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
});
// Ctrl-C outside a prompt, a closed SSH session or a kill: what a run
// started is undone, then it ends as the signal would have ended it.
for (const [signal, number] of SIGNALS)
  process.on(signal, () => {
    if (signal === "SIGINT" && terminalChild) return;
    for (const cleanup of onSignal) {
      try {
        cleanup();
      } catch {
        // Best effort: the next cleanup still runs.
      }
    }
    process.exit(128 + number);
  });

try {
  await main(process.argv.slice(2));
} catch (error) {
  // The cause chain, so a failure is diagnosed from this one message.
  const causes = [];
  for (let cause = error?.cause; cause && causes.length < 4; cause = cause.cause)
    causes.push(clean(cause.message ?? (typeof cause === "object" ? JSON.stringify(cause) : cause)));
  note(`buzz-login: ${error?.message ?? error}${causes.length ? `\n  because: ${causes.join("; ")}` : ""}`);
  process.exitCode = error instanceof LoginError ? error.exit : EXIT_FAIL;
} finally {
  secrets.clear();
}
// Work a harness library left running (a callback server, a poll) ends
// with the run: every cleanup above has run.
process.exit(process.exitCode ?? 0);
