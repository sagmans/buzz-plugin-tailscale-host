// Signs a harness in on one host from the plugin's Settings page (Sign in),
// so that the owner never opens a shell on the machine. The hosts helper
// (scripts/hosts-helper.mjs) runs this module and streams the machine's
// terminal back to the page; the page sends back each line the owner types.
//
// On the machine this is the same command that runner/README.md, "Sign in",
// gives for a shell: `sudo -u <harness user> /usr/local/bin/buzz-login
// <command>`. buzz-login already does each harness's own sign-in, writes it
// where the hosted agents read it, never echoes a key and never prints one,
// so this module adds no sign-in logic: it only carries a terminal.
//
// Trust: the page names a host id and one command from SIGNIN_COMMANDS, and
// nothing else reaches the remote command line: the host's address comes
// from hosts.json, ssh accepts only the host keys that Tailscale reports for
// that peer (as host-setup.mjs does), and the command is fixed words. The
// harness user comes from buzz-login itself, which install.sh wrote as root.
// The sudo password goes only to sudo's prompt on the machine's terminal,
// which sudo reads with echo off; sudo's prompt is a random marker, so the
// password is sent only when sudo asks for it, and a second ask (a refused
// password) ends the run instead of sending it again. What the owner types
// goes only to the terminal. Both are masked in the output that goes back to
// the page, and neither is ever in an argument, a file or a log line.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJson, validateHosts } from "./build-plugin.mjs";
import { CHECK_LINK_RE, KILL_GRACE_MS, PASSWORD_MAX, SSH_BIN, SSH_USER_RE, clip, findPeer, sshArgs, tailscaleStatus } from "./host-setup.mjs";

/** The sign-ins the page offers, as buzz-login's own commands (its USAGE).
 * Only fixed words: a provider or a model is chosen at buzz-login's own
 * prompt, so nothing that the page sends becomes part of the command line
 * on the machine. */
export const SIGNIN_COMMANDS = Object.freeze({
  status: ["status"],
  claude: ["claude"],
  "claude-console": ["claude", "--console"],
  "codex-device": ["codex", "--device"],
  "codex-api-key": ["codex", "--api-key"],
  "goose-key": ["goose", "key"],
  "goose-oauth": ["goose", "oauth"],
  "goose-default": ["goose", "default"],
  "pi-key": ["pi", "key"],
  "pi-oauth": ["pi", "oauth"],
  "pi-default": ["pi", "default"],
});
const SIGNIN_KEYS = Object.freeze(["host", "sshUser", "sudoPassword", "command"]);
/** Where install.sh puts the sign-in tool, and the line in it that names the
 * harness user (install.sh rewrites RUN_AS for the host). */
const LOGIN_TOOL = "/usr/local/bin/buzz-login";
const RUN_AS_SED = "s/^readonly RUN_AS=\\([a-z_][a-z0-9_-]*\\)$/\\1/p";
/** The remote exit when the machine has no buzz-login with a harness user:
 * the setup never ran there, or another tool replaced it. */
const EXIT_NO_TOOL = 69;
/** ssh's own exit when it cannot connect or the session breaks. */
const EXIT_SSH = 255;
/** buzz-login waits up to 15 minutes for a browser sign-in and 10 for one
 * answer; a sign-in that outlives both and the connect is stuck. */
const SIGNIN_TIMEOUT_MS = 20 * 60_000;
/** buzz-login's own bound for a key or a pasted code (INPUT_MAX_CHARS). */
const INPUT_MAX = 8_192;
/** A sign-in prints a few KB; far more means a runaway program. */
const RAW_MAX = 4 * 1024 * 1024;
/** The page shows the last lines of the terminal; older ones are dropped,
 * so the progress events stay small. */
const SCREEN_LINES = 300;
const SCREEN_LINE_MAX = 2_000;
/** The output goes to the page at most this often: a spinner redraws many
 * times a second, and each event carries the whole screen. */
const EMIT_MS = 150;
/** Typed text shorter than this is a menu number or a yes, not a secret, and
 * masking it would hide every such digit in the output. */
const MASK_MIN = 4;
const MASK = "••••••••";
/** A dumb terminal and a wide screen: the sign-in CLIs then print plain
 * lines, and a long sign-in link stays on one line that the page can show
 * whole (claude and codex draw with TERM; buzz-login passes it on). */
const TERM_TYPE = "dumb";
const COLUMNS = 400;
const ROWS = 60;
/** An escape sequence that has not ended within this many characters is
 * not one; it is dropped instead of held. */
const ESCAPE_HOLD_MAX = 512;
const WORK_PREFIX = "buzz-signin-";
/** Terminal escape sequences: OSC (a link or a title), CSI (colour, cursor)
 * and the two-character ones. The page shows plain text. */
const ESCAPES = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g;
/** Control characters other than line ends and tabs: a bell or a backspace
 * means nothing on the page. */
const OTHER_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g;
const LINE_ENDS = /(\r\n|\n|\r)/;

/** A sign-in the helper refuses or that failed, with the reason the page
 * shows. */
export class HostSignInError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HostSignInError";
  }
}

/** The sign-in request as the page may send it, and nothing else. */
export function parseSignInRequest(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HostSignInError("sign-in must be an object");
  const extra = Object.keys(raw).filter((key) => !SIGNIN_KEYS.includes(key));
  if (extra.length) throw new HostSignInError(`unknown sign-in keys: ${extra.join(", ")}`);
  const { host, sshUser = "", sudoPassword = "", command } = raw;
  if (typeof host !== "string" || !host) throw new HostSignInError("the sign-in must name a host id");
  if (typeof sshUser !== "string" || (sshUser && !SSH_USER_RE.test(sshUser))) throw new HostSignInError("the SSH login must be a Linux user name");
  if (typeof sudoPassword !== "string" || sudoPassword.length > PASSWORD_MAX || /[\n\r\u0000]/.test(sudoPassword))
    throw new HostSignInError(`the sudo password must be one line of at most ${PASSWORD_MAX} characters`);
  if (typeof command !== "string" || !Object.hasOwn(SIGNIN_COMMANDS, command))
    throw new HostSignInError(`the command must be one of ${Object.keys(SIGNIN_COMMANDS).join(", ")}`);
  return { host, sshUser, sudoPassword, command };
}

/** One line that the owner typed, as the terminal may get it: a key, a
 * pasted code or a menu answer. An empty line is an Enter. */
export function parseSignInInput(text) {
  if (typeof text !== "string" || text.length > INPUT_MAX || /[\n\r\u0000]/.test(text))
    throw new HostSignInError(`the input must be one line of at most ${INPUT_MAX} characters`);
  return text;
}

/** The command for the machine's login shell. The script is in single
 * quotes and has none inside, and its arguments are SIGNIN_COMMANDS words,
 * so the shell parses only what this module wrote. `-k` makes sudo ask for
 * the password on each run, so the marker always comes when a password is
 * needed, and `-p` sets the marker. */
function remoteCommand(marker, words) {
  const script = [
    `stty cols ${COLUMNS} rows ${ROWS} 2>/dev/null`,
    `u=$(sed -n "${RUN_AS_SED}" ${LOGIN_TOOL})`,
    `[ -n "$u" ] || exit ${EXIT_NO_TOOL}`,
    `exec sudo -k -p "${marker}" -u "$u" -- ${LOGIN_TOOL} "$@"`,
  ].join("; ");
  return ["/bin/sh", "-c", `'${script}'`, "sh", ...words].join(" ");
}

/** The peer of a listed host: the page names an id, and the address comes
 * from hosts.json, never from the page. */
async function hostPeer(hostsPath, id, getStatus) {
  const hosts = validateHosts(readJson(hostsPath, "hosts file"), hostsPath);
  const host = hosts.find((entry) => entry.id === id);
  if (!host) throw new HostSignInError(`no host ${JSON.stringify(clip(id, 40))} in hosts.json`);
  const peer = findPeer(await getStatus(), `https://${new URL(host.origin).hostname}`);
  return { host, peer };
}

/** The terminal as plain lines: escape sequences out, a carriage return
 * starts its line again (a spinner or a progress line redraws in place), and
 * only the last lines stay. A sequence or a CR+LF that a chunk splits is
 * held for the next chunk. Lines are kept whole and cut only in `text`,
 * after the mask: a cut first could split a secret that is longer than a
 * line's bound, and its first part would then show unmasked. RAW_MAX bounds
 * what a whole line can hold. */
class Screen {
  lines = [];
  current = "";
  held = "";

  write(chunk) {
    let text = (this.held + chunk).replace(ESCAPES, "");
    this.held = "";
    const open = text.lastIndexOf("\u001b");
    if (open !== -1) {
      if (text.length - open < ESCAPE_HOLD_MAX) this.held = text.slice(open);
      text = text.slice(0, open).replaceAll("\u001b", "");
    }
    if (text.endsWith("\r")) {
      this.held = `\r${this.held}`;
      text = text.slice(0, -1);
    }
    for (const part of text.replace(OTHER_CONTROLS, "").split(LINE_ENDS)) {
      if (part === "\n" || part === "\r\n") {
        this.lines.push(this.current);
        this.current = "";
      } else if (part === "\r") this.current = "";
      else this.current += part;
    }
    this.lines.splice(0, Math.max(0, this.lines.length - SCREEN_LINES));
    return text;
  }

  /** The screen as the page may see it: `mask` runs on each whole line,
   * then the line is cut to its bound. */
  text(mask) {
    return [...this.lines, this.current].map((line) => mask(line).slice(0, SCREEN_LINE_MAX)).join("\n");
  }
}

/** One sign-in on one host. `run` resolves when the session ends; `input`
 * and `cancel` come from the page while it runs. `deps` is for the smoke
 * run only: a fake Tailscale status and a fake ssh. */
export class HostSignIn {
  #request;
  #hostsPath;
  #onProgress;
  #deps;
  #child;
  #secrets = [];
  #marker = `[sudo ${randomBytes(12).toString("hex")}] `;
  #markers = 0;
  #scan = "";
  #failure;
  #link;
  #screen = new Screen();
  #emitTimer;

  constructor(request, { hostsPath, onProgress = () => {}, deps = {} }) {
    this.#request = parseSignInRequest(request);
    this.#hostsPath = hostsPath;
    this.#onProgress = onProgress;
    this.#deps = deps;
    if (this.#request.sudoPassword) this.#secrets.push(this.#request.sudoPassword);
  }

  /** What the page may see: the screen with the sudo marker named and every
   * secret masked. */
  #output() {
    return this.#screen.text((line) => this.#mask(line.replaceAll(this.#marker, "sudo password: ")));
  }

  #mask(text) {
    let masked = text;
    for (const secret of this.#secrets) masked = masked.replaceAll(secret, MASK);
    return masked;
  }

  #emit() {
    if (this.#emitTimer) return;
    this.#emitTimer = setTimeout(() => {
      this.#emitTimer = undefined;
      this.#onProgress({ state: "running", output: this.#output(), ...(this.#link ? { link: this.#link } : {}) });
    }, EMIT_MS);
  }

  /** Ends the session on the machine: ssh's end closes the terminal there,
   * and the hangup ends sudo and buzz-login with it. */
  #stop(reason) {
    this.#failure ??= reason;
    const child = this.#child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
  }

  #watchLink(text) {
    const link = CHECK_LINK_RE.exec(text)?.[0];
    if (link && link !== this.#link) {
      this.#link = link;
      this.#emit();
    }
  }

  /** sudo prints the marker when it wants the password. The first time it
   * gets the password; a second time means sudo refused it, and sending it
   * again would only use up sudo's tries. */
  #watchMarker(text) {
    this.#scan += text;
    let at;
    while ((at = this.#scan.indexOf(this.#marker)) !== -1) {
      this.#scan = this.#scan.slice(at + this.#marker.length);
      this.#markers += 1;
      if (this.#markers > 1) return this.#stop("sudo refused the password");
      if (!this.#request.sudoPassword) return this.#stop("sudo on the machine asks for a password: enter it, then start the sign-in again");
      this.#child.stdin.write(`${this.#request.sudoPassword}\r`);
    }
    this.#scan = this.#scan.slice(-this.#marker.length);
  }

  /** One line that the owner typed, to the terminal. A typed line of
   * MASK_MIN characters or more may be a key, so it is masked from then on. */
  input(text) {
    const line = parseSignInInput(text);
    if (!this.#child || !this.#child.stdin.writable) throw new HostSignInError("the sign-in is not running");
    if (line.length >= MASK_MIN) this.#secrets.push(line);
    this.#child.stdin.write(`${line}\r`);
  }

  cancel() {
    this.#stop("the sign-in was cancelled");
  }

  /** Connects, runs the command, and resolves with its exit and the last
   * screen; rejects with the reason when the run failed. */
  async run() {
    const { status: getStatus = tailscaleStatus, ssh = SSH_BIN, sshPort = 22 } = this.#deps;
    const { host, peer } = await hostPeer(this.#hostsPath, this.#request.host, getStatus);
    const work = mkdtempSync(join(tmpdir(), WORK_PREFIX));
    try {
      const knownHosts = join(work, "known_hosts");
      writeFileSync(knownHosts, peer.keys.map((key) => `${peer.dnsName} ${key}\n`).join(""), { mode: 0o600 });
      const session = { sshUser: this.#request.sshUser, knownHosts, port: sshPort, tty: true };
      const command = remoteCommand(this.#marker, SIGNIN_COMMANDS[this.#request.command]);
      const { code, stderr } = await this.#session(ssh, sshArgs(peer, session, command));
      return this.#result(host, code, stderr);
    } finally {
      // The last screen goes out whole, also when the run failed: the page
      // shows what the machine said before the reason.
      clearTimeout(this.#emitTimer);
      this.#emitTimer = undefined;
      this.#onProgress({ state: "ended", output: this.#output() });
      rmSync(work, { recursive: true, force: true });
    }
  }

  #result(host, code, stderr) {
    if (this.#failure) throw new HostSignInError(this.#failure);
    if (code === EXIT_NO_TOOL) throw new HostSignInError(`${host.label} has no ${LOGIN_TOOL}: run Add host for it first`);
    if (code === EXIT_SSH) throw new HostSignInError(`ssh failed: ${clip(this.#mask(stderr).trim().split("\n").at(-1) || "exit 255")}`);
    return { code, output: this.#output() };
  }

  #session(ssh, args) {
    return new Promise((done, failed) => {
      const child = spawn(ssh, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: TERM_TYPE } });
      this.#child = child;
      let raw = 0;
      let stderr = "";
      const count = (chunk) => {
        raw += chunk.length;
        if (raw > RAW_MAX) this.#stop(`the machine printed more than ${RAW_MAX} bytes`);
      };
      child.stdout.on("data", (chunk) => {
        count(chunk);
        const text = this.#screen.write(chunk.toString("utf8"));
        this.#watchMarker(text);
        this.#watchLink(text);
        this.#emit();
      });
      // ssh's own messages, and a Tailscale SSH check's link, come here.
      child.stderr.on("data", (chunk) => {
        count(chunk);
        const text = chunk.toString("utf8");
        // Kept whole (RAW_MAX bounds it) and cut only after the mask.
        stderr += text;
        this.#watchLink(text);
      });
      // A write after the session ended is no error of the owner's.
      child.stdin.on("error", () => {});
      const timer = setTimeout(() => this.#stop(`the sign-in did not end in ${SIGNIN_TIMEOUT_MS / 60_000} minutes`), SIGNIN_TIMEOUT_MS);
      child.on("error", (cause) => {
        clearTimeout(timer);
        failed(new HostSignInError(`ssh did not start: ${cause.message}`, { cause }));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        done({ code, stderr });
      });
    });
  }
}
