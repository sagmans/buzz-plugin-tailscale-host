// Installs buzz-runner on one machine of the user's tailnet, or aligns the
// runner already there, when the plugin's Settings page adds the machine as a
// host (Add host). The page cannot reach a machine itself, so the hosts
// helper (scripts/hosts-helper.mjs) runs this module and streams each step
// back as progress. The steps repeat runner/README.md, "Deploy": copy a
// runner tree to the machine, install the harnesses and run install.sh as
// root, then `tailscale serve`, and add the machine to hosts.json, the one
// host list.
//
// Trust: this runs root commands on the chosen machine, with the user's own
// SSH access. So every value that reaches the machine is checked here, the
// machine must be a Linux peer that `tailscale status` lists, and ssh accepts
// only the host keys that Tailscale reports for that peer (no trust on first
// use). Only committed runner code goes, in a bundle built for this setup.
// The SSH user owns the stage folder on the machine, so root never runs a
// file from it: setup.sh comes in the root command itself, copies the
// listed stage files to a folder that only root can write, at most
// STAGE_BYTES_MAX bytes, and checks each file there against the SHA-256
// manifest that the command pins. The sudo password goes only to
// the stdin of sudo on the machine; it is never in an argument, a file, a
// log line or a progress event.
//
// The runner's own Node comes first (node-setup.sh, in its own root command),
// so the machine needs no Node before the setup, and setup.sh installs each
// missing harness at its pinned path (harnesses.sh) before the runner. The
// steps that need the user's own hands are returned as a list: the harness
// sign-ins (a browser or a key), which the page's Sign in does
// (host-signin.mjs), and the port rule in the tailnet policy (no policy
// token here). A machine without an ACL
// tag is refused before any change: on an untagged machine, a harness could
// call the runner as its owner (runner/README.md, "Security notes").
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RUNNER_PORT, readJson, runnerOrigin, validateHosts, writeAtomic } from "./build-plugin.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** The system ssh and git, by path: a program on PATH could be anything. */
export const SSH_BIN = "/usr/bin/ssh";
const GIT_BIN = "/usr/bin/git";
/** Where the Tailscale CLI is on macOS (Homebrew, the standalone package,
 * the App Store app) and on Linux; the first that exists is used. */
const TAILSCALE_BINS = Object.freeze([
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/usr/bin/tailscale",
]);
/** The Node paths setup.sh accepts (its NODE_PATHS), and the one a setup
 * uses: the runner-only Node that node-setup.sh installs or keeps. It is on
 * no PATH, so a newer Node there leaves the system Node (and the tools that
 * need it) as it is (runner/README.md, "Node"). */
export const NODE_PATHS = Object.freeze(["/opt/buzz-runner/node", "/usr/bin/node"]);
export const RUNNER_NODE = NODE_PATHS[0];
/** node-setup.sh's line that names the Node it installed or kept. */
const NODE_LINE_RE = /^@@node (\/\S+) (\d+\.\d+\.\d+)$/;
/** harnesses.sh's line for each harness: kept, installed, or missing (its
 * path is not the pin, so the setup does not install it). */
const HARNESS_LINE_RE = /^@@harness (claude|codex|goose|pi) (kept|installed|missing) (\/\S+)$/;
/** setup.sh's line as each of its steps starts (SETUP_STEPS). */
const STEP_LINE_RE = /^@@step (install|serve)$/;
/** Where the tailscale CLI may be on the machine, first match wins. setup.sh
 * has the same list (TAILSCALE_PATHS): root runs the CLI by path, because
 * its PATH leaves out /usr/local/bin, and the probe looks in the same places
 * so that it fails early where setup.sh would. */
export const HOST_TAILSCALE_PATHS = Object.freeze(["/usr/bin/tailscale", "/usr/local/bin/tailscale"]);
/** The stage folder prefix on the machine; setup.sh refuses any other. The
 * SSH user owns the stage, so root only reads it (setup.sh). */
const STAGE_PREFIX = "/tmp/buzz-runner-setup.";
const STAGE_RE = /^\/tmp\/buzz-runner-setup\.[A-Za-z0-9]{6,}$/;
/** The runner tree install.sh needs ("run from a full checkout"), relative
 * to the checkout, with the mode each file gets on the machine. setup.sh is
 * not in it: it goes in the root command (SETUP_SCRIPT). */
const STAGE_FILES = Object.freeze([
  ["runner/README.md", 0o644],
  ["runner/buzz-runner.service", 0o644],
  ["runner/config.example.json", 0o644],
  ["runner/deploy/install.sh", 0o755],
  ["runner/deploy/check-config.mjs", 0o644],
  ["runner/deploy/sudoers.template", 0o644],
  ["runner/deploy/claude-wrapper", 0o755],
  ["runner/deploy/harness-wrapper", 0o755],
  ["runner/deploy/buzz-login", 0o755],
  ["runner/deploy/buzz-login.mjs", 0o644],
  ["runner/deploy/pi-launch.mjs", 0o644],
  ["runner/deploy/harnesses.sh", 0o755],
]);
/** buzz-app's Pi package.json and lock, from the linked clone that the
 * bundle comes from (scripts/build-runner.mjs checks its revision and that it
 * has no edits), and where the stage puts them (setup.sh PI_DEPS): the Pi
 * packages that harnesses.sh installs must be the ones that pi.ts pins in the
 * bundle, or pi-launch.mjs refuses them. */
const PI_DEPS_SOURCE = "runner/buzz-app/src/bundled/pi/deps";
const PI_DEPS = "runner/pi";
const PI_DEPS_FILES = Object.freeze(["package.json", "package-lock.json"]);
const PI_DEPS_MODE = 0o644;
/** Where the bundle goes in the stage (install.sh reads it there), and its
 * mode on the machine. */
const BUNDLE = "runner/dist/buzz-runner.mjs";
const BUNDLE_MODE = 0o644;
/** The root half of the setup. Root runs it from the command line, never
 * from the stage that the SSH user could change. */
const SETUP_SCRIPT = "runner/deploy/setup.sh";
/** The root script that gives the runner its own Node, before the copy
 * needs one. Like setup.sh it goes in the root command. */
const NODE_SETUP_SCRIPT = "runner/deploy/node-setup.sh";
/** The stage file that lists every other stage file with its SHA-256, in
 * sha256sum's `<hex>  <path>` form; setup.sh checks the copy against it. */
const MANIFEST = "MANIFEST";
/** The most bytes of listed files that root copies into /run, a small tmpfs
 * that the whole machine needs (setup.sh STAGE_BYTES_MAX; scripts/check fails
 * when they differ). A bigger stage stops here, before any copy, with a
 * clear reason. */
const STAGE_BYTES_MAX = 16_777_216;
/** The checkout paths that the stage and the bundle come from. Root runs
 * them on the machine, so each must be as committed: no edit, no new file
 * (git leaves out what .gitignore names: the build output and the links). */
const TREE_PATHS = Object.freeze(["runner", "scripts/build-runner.mjs"]);
const CONFIG_EXAMPLE = "runner/config.example.json";
const BUILD_RUNNER = "scripts/build-runner.mjs";
/** The page's step list, in order (plugin.js SETUP_STEPS). */
export const SETUP_STEPS = Object.freeze(["machine", "bundle", "connect", "node", "copy", "harnesses", "install", "serve", "hosts", "health"]);

/** A Linux login name, as install.sh's USER_RE allows. Empty means ssh's
 * default, the local user name. */
export const SSH_USER_RE = /^[a-z_][a-z0-9_.-]{0,31}$/;
/** setup.sh's line that names the harness user the install kept or made
 * (install.sh USER_RE), and the name a first install gives it. */
const AGENT_USER_LINE_RE = /^@@agent-user ([a-z_][a-z0-9_-]{0,31})$/;
const DEFAULT_AGENT_USER = "buzz-agent";
/** One label of a MagicDNS name; the first one names the machine. */
const MACHINE_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DNS_MAX = 253;
const HEX64 = /^[0-9a-f]{64}$/;
/** A host id (scripts/build-plugin.mjs HOST_ID), and how many ids the page
 * may reserve: the hosts that agents on its device still name. */
const HOST_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const RESERVED_MAX = 256;
export const PASSWORD_MAX = 256;
const RELAY_MAX = 300;
const LABEL_MAX = 40;
const LOGIN_MAX = 254;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
/** The shapes of an OpenSSH public host key line that Tailscale reports. */
const HOST_KEY_RE = /^(?:ssh-ed25519|ecdsa-sha2-nistp(?:256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,2}$/;
/** A Tailscale SSH check prints a link the user must open; the page shows it. */
export const CHECK_LINK_RE = /https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.-]{1,200}/;
/** sudo's words for a refused password (sudo 1.9). */
const SUDO_REFUSED_RE = /incorrect password|Sorry, try again|no password was provided|a password is required/;

/** Timeouts. The first connect waits for a Tailscale SSH check, which the
 * user approves in a browser. The Node step downloads about 55 MB
 * (node-setup.sh DOWNLOAD_TIMEOUT_S, with a margin). The install builds
 * nothing on the machine, but its service start waits up to 10 s. The health
 * check waits for serve's first certificate, which can take a minute. */
const STATUS_TIMEOUT_MS = 15_000;
const BUILD_TIMEOUT_MS = 600_000;
const GIT_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 300_000;
const COPY_TIMEOUT_MS = 120_000;
const NODE_TIMEOUT_MS = 960_000;
/** setup.sh's harness step: three downloads (harnesses.sh DOWNLOAD_TIMEOUT_S
 * each, with a margin) and two npm runs (NPM_TIMEOUT_S each, with a margin).
 * setup.sh runs in one root command, so its timeout is this plus the
 * install's. */
const HARNESS_DOWNLOAD_MS = 960_000;
const HARNESS_NPM_MS = 360_000;
const HARNESSES_TIMEOUT_MS = 3 * HARNESS_DOWNLOAD_MS + 2 * HARNESS_NPM_MS;
const INSTALL_TIMEOUT_MS = 600_000;
const HEALTH_TIMEOUT_MS = 120_000;
const HEALTH_TRY_MS = 20_000;
const HEALTH_RETRY_MS = 3_000;
export const KILL_GRACE_MS = 3_000;
/** Bounds on what a child may write back; more is a broken child. */
const OUTPUT_MAX = 1_048_576;
const STATUS_MAX = 16_777_216;
/** Lines of install output a failure keeps for the page. */
const TAIL_LINES = 12;
const LINE_MAX = 300;
const SETUP_EXIT = Object.freeze({ readStdin: 90, noTag: 77, unsafeNode: 79, tampered: 80, unsafeTailscale: 81, harness: 82 });
/** A helper that is killed (the app quits, the process gets SIGKILL) never
 * runs its stage removal, so each copy removes the SSH user's own stages that
 * are older than any live setup can keep one: the install's timeout plus the
 * copy and the removal calls, twice for clock and slow-link margin. A live
 * setup of another device on the same machine is younger, so it keeps its
 * stage. The same distance into the future also counts as stale: only a clock
 * that stepped back or a touched folder gives such an mtime, and without this
 * that stage would stay until the clock catches up. A small step back keeps a
 * live stage. */
const STAGE_STALE_MS = 2 * (HARNESSES_TIMEOUT_MS + INSTALL_TIMEOUT_MS + 2 * COPY_TIMEOUT_MS);
/** The setup's own work folder on this device (the bundle, the pinned
 * known_hosts), in the user's temp folder, and the name mkdtemp gives it. */
const WORK_PREFIX = "buzz-setup-";
const WORK_RE = /^buzz-setup-[A-Za-z0-9]{6}$/;
/** A killed helper never runs its work folder removal either, so each setup
 * first removes this user's own work folders that are older than any live
 * setup can keep one: every step's timeout, the stage removal on both paths,
 * and the last health try, twice for clock and kill-grace margin. A setup that
 * still runs in another helper on this device is younger, so it keeps its
 * folder. As with stages, the same distance into the future also counts as
 * stale (a clock that stepped back), and a small step back keeps a live
 * folder. */
const WORK_STALE_MS =
  2 * (STATUS_TIMEOUT_MS + 2 * GIT_TIMEOUT_MS + BUILD_TIMEOUT_MS + CONNECT_TIMEOUT_MS + NODE_TIMEOUT_MS + 3 * COPY_TIMEOUT_MS + HARNESSES_TIMEOUT_MS + INSTALL_TIMEOUT_MS + HEALTH_TIMEOUT_MS + HEALTH_TRY_MS + HEALTH_RETRY_MS);

/** A setup step that failed, with the step and the reason the page shows. */
export class HostSetupError extends Error {
  constructor(message, { step, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "HostSetupError";
    this.step = step;
  }
}

/** Every control character, for clip: one left in would break a log line
 * or a progress event. */
const CONTROL_CHARS_ALL = new RegExp(CONTROL_CHARS.source, "g");
export const clip = (value, max = LINE_MAX) => String(value).replace(CONTROL_CHARS_ALL, " ").slice(0, max);

/** A relay URL as the runner config takes it: wss://, no credentials, no
 * query or fragment. */
function isRelay(value) {
  if (typeof value !== "string" || value.length > RELAY_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
/** The host address as the page saves it: an https origin whose host is a
 * MagicDNS name, with no port or the runner's port. The name, not an IP, is
 * what finds the peer and what serve's certificate holds. */
function isAddress(value) {
  if (typeof value !== "string" || value.length > DNS_MAX + 20) return false;
  try {
    const url = new URL(value);
    const labels = url.hostname.split(".");
    return (
      url.protocol === "https:" &&
      value === url.origin &&
      (url.port === "" || url.port === String(RUNNER_PORT)) &&
      url.hostname.length <= DNS_MAX &&
      labels.length > 1 &&
      labels.every((label) => MACHINE_RE.test(label))
    );
  } catch {
    return false;
  }
}
const isLabel = (value) => typeof value === "string" && !!value.trim() && value === value.trim() && value.length <= LABEL_MAX && !CONTROL_CHARS.test(value);

/** Each setup field's rule and the reason the page shows when it fails. */
const SETUP_RULES = Object.freeze({
  address: [isAddress, `the address must be the machine's https:// MagicDNS name, with no port or port ${RUNNER_PORT}`],
  sshUser: [(value) => typeof value === "string" && (!value || SSH_USER_RE.test(value)), "the SSH login must be a Linux user name"],
  sudoPassword: [
    (value) => typeof value === "string" && value.length <= PASSWORD_MAX && !/[\n\r\u0000]/.test(value),
    `the sudo password must be one line of at most ${PASSWORD_MAX} characters`,
  ],
  ownerPubkey: [(value) => typeof value === "string" && HEX64.test(value), "the owner key must be 64 lowercase hex characters"],
  relay: [isRelay, "the relay must be a wss:// URL without credentials or query"],
  label: [(value) => value === undefined || isLabel(value), `the name must be 1-${LABEL_MAX} printable characters`],
  reservedIds: [
    (value) => value === undefined || (Array.isArray(value) && value.length <= RESERVED_MAX && value.every((id) => typeof id === "string" && HOST_ID_RE.test(id))),
    `reserved ids must be at most ${RESERVED_MAX} host ids`,
  ],
});

const SETUP_KEYS = Object.keys(SETUP_RULES);

/** The setup request as the page may send it, and nothing else. */
export function parseSetupRequest(raw) {
  const fail = (message) => new HostSetupError(message, { step: "machine" });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw fail("setup must be an object");
  const extra = Object.keys(raw).filter((key) => !SETUP_KEYS.includes(key));
  if (extra.length) throw fail(`unknown setup keys: ${extra.join(", ")}`);
  const setup = { sshUser: "", sudoPassword: "", ...raw };
  for (const [key, [ok, message]] of Object.entries(SETUP_RULES)) if (!ok(setup[key])) throw fail(message);
  const { address, sshUser, sudoPassword, ownerPubkey, relay, label, reservedIds } = setup;
  return { address, sshUser, sudoPassword, ownerPubkey, relay, label, reservedIds };
}

/** Runs a program with a deadline; resolves with its exit and bounded output.
 * `onLine` gets each stdout line as it arrives, `onErrLine` each stderr line. */
function run(program, args, { input, timeoutMs, onLine, onErrLine, max = OUTPUT_MAX, cwd } = {}) {
  return new Promise((done, failed) => {
    const child = spawn(program, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const out = { stdout: "", stderr: "", tooLong: false };
    const partial = { stdout: "", stderr: "" };
    const read = (name, handler) =>
      child[name].on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (out[name].length + text.length > max) {
          out.tooLong = true;
          child.kill("SIGKILL");
          return;
        }
        out[name] += text;
        if (!handler) return;
        partial[name] += text;
        let newline;
        while ((newline = partial[name].indexOf("\n")) !== -1) {
          handler(partial[name].slice(0, newline));
          partial[name] = partial[name].slice(newline + 1);
        }
      });
    read("stdout", onLine);
    read("stderr", onErrLine);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    }, timeoutMs);
    child.on("error", (cause) => {
      clearTimeout(timer);
      failed(cause);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (partial.stdout && onLine) onLine(partial.stdout);
      if (partial.stderr && onErrLine) onErrLine(partial.stderr);
      done({ code, signal, timedOut, ...out });
    });
    // A child that exits before it reads its stdin closes the pipe; that is
    // its own failure, which its exit code reports.
    child.stdin.on("error", () => {});
    child.stdin.end(input ?? "");
  });
}

function tailscaleBin() {
  const found = TAILSCALE_BINS.find((path) => existsSync(path));
  if (!found) throw new HostSetupError(`no Tailscale CLI in ${TAILSCALE_BINS.join(", ")}`, { step: "machine" });
  return found;
}

/** `tailscale status --json` of this device. */
export async function tailscaleStatus() {
  const result = await run(tailscaleBin(), ["status", "--json"], { timeoutMs: STATUS_TIMEOUT_MS, max: STATUS_MAX });
  if (result.code !== 0) throw new HostSetupError(`tailscale status failed: ${clip(result.stderr || result.code)}`, { step: "machine" });
  try {
    return JSON.parse(result.stdout);
  } catch (cause) {
    throw new HostSetupError("tailscale status did not print JSON", { step: "machine", cause });
  }
}

const dnsOf = (peer) => String(peer.DNSName ?? "").replace(/\.$/, "").toLowerCase();
const machineOf = (peer) => dnsOf(peer).split(".")[0];

/** The peer that the address names, checked for every rule before anything
 * else runs. */
export function findPeer(status, hostAddress) {
  const dnsName = new URL(hostAddress).hostname;
  const peer = Object.values(status?.Peer ?? {}).find((entry) => dnsOf(entry) === dnsName);
  const fail = (message) => new HostSetupError(message, { step: "machine" });
  if (!peer) throw fail(`${dnsName} is not a machine of this tailnet. Use its MagicDNS name from the Tailscale admin console, Machines.`);
  const machine = machineOf(peer);
  if (peer.OS !== "linux") throw fail(`${machine} runs ${clip(peer.OS, 20)}; the runner needs Linux`);
  if (peer.Online !== true) throw fail(`${machine} is offline`);
  if (!Array.isArray(peer.Tags) || !peer.Tags.length)
    throw fail(`${machine} has no ACL tag. In the Tailscale admin console, open Machines > ${machine} > Edit ACL tags, add a tag, then run the setup again.`);
  const keys = (peer.sshHostKeys ?? []).filter((key) => typeof key === "string" && HOST_KEY_RE.test(key));
  if (!keys.length) throw fail(`${machine} reports no SSH host key: turn on Tailscale SSH there (tailscale set --ssh)`);
  const address = (peer.TailscaleIPs ?? []).find((ip) => typeof ip === "string" && /^100\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip));
  if (!address) throw fail(`${machine} has no Tailscale IPv4 address`);
  return { machine, dnsName: dnsOf(peer), name: clip(peer.HostName ?? machine, LABEL_MAX), address, keys, tags: peer.Tags.map((tag) => clip(tag, 64)) };
}

/** The user's own Tailscale login, which the runner's allowlist names. */
function selfLogin(status) {
  const login = status?.User?.[status?.Self?.UserID]?.LoginName;
  if (typeof login !== "string" || !login || login.length > LOGIN_MAX || CONTROL_CHARS.test(login) || /\s/.test(login))
    throw new HostSetupError("tailscale status names no login for this device", { step: "machine" });
  return login;
}

/** Refuses a checkout whose runner tree differs from its commit: the setup
 * would put code nobody committed on the machine, as root. Resolves with
 * the commit, which the page shows. */
async function cleanCommit(root) {
  const git = (args) => run(GIT_BIN, ["-C", root, ...args], { timeoutMs: GIT_TIMEOUT_MS });
  const fail = (message) => new HostSetupError(message, { step: "bundle" });
  const top = await git(["rev-parse", "--show-toplevel", "HEAD"]);
  const [topLevel, commit] = top.stdout.trim().split("\n");
  if (top.code !== 0 || !topLevel || realpathSync(topLevel) !== realpathSync(root))
    throw fail(`the plugin folder ${root} is not a git checkout with a commit, so its runner code cannot be checked`);
  const changes = await git(["status", "--porcelain=v1", "--untracked-files=all", "--", ...TREE_PATHS]);
  if (changes.code !== 0) throw fail(`git status failed: ${clip(changes.stderr.trim() || changes.code)}`);
  if (changes.stdout.trim())
    throw fail(`the runner code has changes that are not committed; commit or discard them, then run the setup again: ${clip(changes.stdout.trim().split("\n").slice(0, 3).join(", "))}`);
  return commit.slice(0, 12);
}

/** A fresh runner bundle of the clean commit, in the setup's own folder: a
 * bundle left in the checkout may come from code that is no longer there.
 * The Pi package files are read right after the build, from the clone that
 * the build just checked, so they match the lock in the bundle. */
async function buildBundle(root, work, progress) {
  const commit = await cleanCommit(root);
  progress("running", `Building the runner bundle of ${commit}`);
  const out = join(work, "bundle");
  const result = await run(process.execPath, [join(root, BUILD_RUNNER), "--out", out], { cwd: root, timeoutMs: BUILD_TIMEOUT_MS });
  const bundle = join(out, BUNDLE.split("/").pop());
  if (result.code !== 0 || !existsSync(bundle))
    throw new HostSetupError(`the runner build failed (see runner/README.md, "Build"): ${clip(result.stderr.trim().split("\n").pop() ?? result.code)}`, { step: "bundle" });
  let piDeps;
  try {
    piDeps = PI_DEPS_FILES.map((name) => ({ path: `${PI_DEPS}/${name}`, mode: PI_DEPS_MODE, data: readFileSync(join(root, PI_DEPS_SOURCE, name)).toString("base64") }));
  } catch (error) {
    throw new HostSetupError(`the Pi package files are not in the buzz-app clone (${PI_DEPS_SOURCE}; scripts/link-toolchain): ${clip(error.message)}`, { step: "bundle", cause: error });
  }
  return { bundle, commit, piDeps };
}

/** The runner config for a first install: the example, with this owner, this
 * relay and the user's own login. install.sh's check-config.mjs checks it
 * again on the machine. */
function runnerConfig(root, { ownerPubkey, relay, login }) {
  const example = JSON.parse(readFileSync(join(root, CONFIG_EXAMPLE), "utf8"));
  return `${JSON.stringify({ ...example, ownerPubkey, allowedLogins: [login], relays: [relay] }, null, 2)}\n`;
}

/** One ssh session to the peer, pinned to the keys Tailscale reports.
 * `tty` asks the machine for a terminal: a sign-in (host-signin.mjs) needs
 * one for sudo and for the prompts of buzz-login. */
export function sshArgs(peer, { sshUser, knownHosts, port, tty = false }, command) {
  return [
    "-F", "/dev/null",
    "-o", "BatchMode=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${knownHosts}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", `HostKeyAlias=${peer.dnsName}`,
    "-o", "ConnectTimeout=20",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    "-p", String(port),
    ...(tty ? ["-tt"] : []),
    ...(sshUser ? ["-l", sshUser] : []),
    "--", peer.address, command,
  ];
}

/** The probe: what the machine has, as key=value lines. It runs as the SSH
 * user and changes nothing. */
const PROBE = [
  "echo os=$(uname -s)",
  "echo uid=$(id -u)",
  "command -v systemctl >/dev/null && echo systemd=1",
  `for t in ${HOST_TAILSCALE_PATHS.join(" ")}; do if [ -x "$t" ]; then echo tailscale_bin=$t; break; fi; done`,
  "command -v sudo >/dev/null && echo sudo=1",
  "sudo -n true 2>/dev/null && echo sudon=1",
  "true",
].join("; ");

/** The copy: one Node program, as the SSH user, that makes a fresh stage
 * folder and writes the files from a JSON document on stdin. Base64 keeps it
 * free of quotes for any login shell. First it removes the stale stages of a
 * killed helper (STAGE_STALE_MS): only real folders (lstat, so no link is
 * followed) that this user owns, so it never touches a file of another user,
 * and /tmp's sticky bit keeps another user from swapping one in. It reports
 * the count, and the count it could not remove, on an @@swept line. */
const UNPACK = `
const fs = require("node:fs"), path = require("node:path");
const swept = [0, 0];
for (const name of fs.readdirSync(${JSON.stringify(dirname(STAGE_PREFIX))})) {
  const old = path.join(${JSON.stringify(dirname(STAGE_PREFIX))}, name);
  if (!${STAGE_RE}.test(old)) continue;
  try {
    const st = fs.lstatSync(old);
    if (!st.isDirectory() || st.uid !== process.getuid() || Math.abs(Date.now() - st.mtimeMs) < ${STAGE_STALE_MS}) continue;
    fs.rmSync(old, { recursive: true, force: true });
    swept[0] += 1;
  } catch { swept[1] += 1; }
}
process.stdout.write("@@swept " + swept.join(" ") + "\\n");
const chunks = []; let size = 0;
process.stdin.on("data", (c) => { size += c.length; if (size > ${64 * OUTPUT_MAX}) process.exit(65); chunks.push(c); });
process.stdin.on("end", () => {
  const files = JSON.parse(Buffer.concat(chunks).toString("utf8")).files;
  if (!files.every((f) => /^(?:runner\\/[A-Za-z0-9._/-]+|config\\.json|${MANIFEST})$/.test(f.path) && !f.path.split("/").includes(".."))) process.exit(65);
  const stage = fs.mkdtempSync(${JSON.stringify(STAGE_PREFIX)});
  for (const f of files) {
    const to = path.join(stage, f.path);
    fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
    fs.writeFileSync(to, Buffer.from(f.data, "base64"), { mode: f.mode });
  }
  process.stdout.write("@@stage " + stage + "\\n");
});`;
// eval runs UNPACK, a constant of this module: no text from the page or
// the machine is in it, and base64 only carries it past the login shell.
const unpackCommand = (node) => `${node} -e 'eval(Buffer.from("${Buffer.from(UNPACK).toString("base64")}","base64").toString())'`;

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The manifest of the stage files, and its SHA-256, which the root command
 * pins: setup.sh installs nothing unless the root-only copy matches it. */
function manifestOf(files) {
  const text = files.map((file) => `${sha256(Buffer.from(file.data, "base64"))}  ${file.path}\n`).join("");
  return { file: { path: MANIFEST, mode: 0o644, data: Buffer.from(text).toString("base64") }, sha: sha256(text) };
}

/** A root run of one of the setup's root scripts (setup.sh, node-setup.sh),
 * by the access the probe found. The script text goes in the command as
 * base64, so the root shell runs what this helper sent and not a file that
 * the SSH user could change. `args` are values this module made or checked,
 * never text from the page. With a password, the remote shell reads it from
 * stdin into a variable and gives it to sudo by a pipe, so it is in no
 * argument list; `-k` makes sudo ask even with a cached sign-in, so the
 * password never goes to the script's stdin instead. */
function rootCommand({ access, script, name, args = [] }) {
  const root = [`/bin/bash -c "$(printf %s ${Buffer.from(script).toString("base64")} | /usr/bin/base64 -d)"`, name, ...args].join(" ");
  if (access === "root") return `/bin/sh -c '${root}'`;
  if (access === "sudon") return `/bin/sh -c 'sudo -n -- ${root}'`;
  return `/bin/sh -c 'IFS= read -r P || exit ${SETUP_EXIT.readStdin}; printf "%s\\n" "$P" | sudo -k -S -p "" -- ${root}'`;
}

const tail = (text) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("@@"))
    .slice(-TAIL_LINES)
    .map((line) => clip(line))
    .join("\n");

/** The new host entry, or the one hosts.json already has for this machine
 * (with or without the runner's port), which a setup aligns and keeps.
 * A reserved id (a host removed by hand that agents still name) is never
 * given out, so the new host does not take over those agents. */
function addHost(hostsPath, peer, { label, reservedIds = [] }) {
  // Kept without the port, as the Settings page writes it (runnerOrigin).
  const origin = `https://${peer.dnsName}`;
  const hosts = existsSync(hostsPath) ? validateHosts(readJson(hostsPath, "hosts file"), hostsPath) : [];
  const known = hosts.find((host) => new URL(host.origin).hostname === peer.dnsName);
  if (known) return { host: known, added: false };
  const taken = new Set([...hosts.map((host) => host.id), ...reservedIds]);
  let id = peer.machine.slice(0, 32).replace(/-+$/, "");
  for (let n = 2; taken.has(id); n += 1) id = `${peer.machine.slice(0, 28).replace(/-+$/, "")}-${n}`;
  const host = { id, label: label ?? peer.name, origin };
  const next = validateHosts({ hosts: [...hosts, host] }, "hosts");
  writeAtomic(hostsPath, `${JSON.stringify({ hosts: next }, null, 2)}\n`);
  return { host, added: true };
}

/** GET /v1/health through serve, until it answers or the time is up. */
async function waitHealthy(origin, fetchImpl) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let last = "no answer";
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${origin}/v1/health`, { redirect: "manual", signal: AbortSignal.timeout(HEALTH_TRY_MS) });
      const body = await response.json().catch(() => ({}));
      if (response.status === 200 && body.ok === true) return clip(body.version ?? "", 40);
      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = clip(cause?.cause?.code || cause?.message || cause, 120);
    }
    await new Promise((wait) => setTimeout(wait, HEALTH_RETRY_MS));
  }
  throw new HostSetupError(`${origin} did not answer /v1/health (${last}). Check that the tailnet policy lets this device reach port ${RUNNER_PORT}.`, { step: "health" });
}

/** Removes the work folders of killed helpers (WORK_STALE_MS) from the temp
 * folder, the same way the copy removes stale stages on the machine: only
 * real folders (lstat, so no link is followed) that this user owns, so a
 * shared temp folder never loses a file of another user. Without a user id
 * (no POSIX) nothing can be checked, so nothing is removed. Returns
 * [removed, not removed]; a folder that stays holds no secret, so the counts
 * only show in the step's detail. */
function sweepWork(dir) {
  const swept = [0, 0];
  const uid = process.getuid?.();
  if (uid === undefined) return swept;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return swept;
  }
  for (const name of names) {
    if (!WORK_RE.test(name)) continue;
    const old = join(dir, name);
    try {
      const st = lstatSync(old);
      if (!st.isDirectory() || st.uid !== uid || Math.abs(Date.now() - st.mtimeMs) < WORK_STALE_MS) continue;
      rmSync(old, { recursive: true, force: true });
      swept[0] += 1;
    } catch {
      swept[1] += 1;
    }
  }
  return swept;
}

/** "N old <noun>s removed" and "N ... not removed", for a step's detail. */
const sweptText = ([removed, kept], noun) =>
  [removed && `${removed} old ${noun}${removed === 1 ? "" : "s"} removed`, kept && `${kept} old ${noun}${kept === 1 ? "" : "s"} not removed`].filter(Boolean);

/** The steps that stay with the user. The sign-ins are on the Settings page
 * (Sign in, host-signin.mjs), so none needs a shell on the machine; the
 * harness user is the one setup.sh reported, so an aligned host with its own
 * names shows its own. */
function manualSteps(peer, label, agentUser) {
  return [
    { id: "sign-in", text: `Sign each harness in: select Sign in on the row of ${label}. It runs buzz-login there as ${agentUser}.` },
    { id: "policy", text: `In the tailnet policy, let only your own login reach port ${RUNNER_PORT} on ${peer.tags.join(", ")}.` },
  ];
}

/** Why a root script failed, in the words the page shows: a refused sudo
 * password, the reason a known exit code stands for, or the script's last
 * lines. */
function rootFailure(result, access, reasons = {}) {
  if (result.timedOut) return undefined;
  if (access === "password" && SUDO_REFUSED_RE.test(result.stderr)) return "sudo refused the password";
  const reason = reasons[result.code];
  if (reason) return typeof reason === "function" ? reason(tail(result.stderr)) : reason;
  return tail(`${result.stdout}\n${result.stderr}`) || `exit ${result.code}`;
}

/** The connect step: the probe over ssh, pinned to the peer's keys. It
 * finds what the machine has and how this login becomes root, and changes
 * nothing. */
async function connectStep(peer, setup, { ssh, sshPort, work, progress }) {
  const fail = (message) => new HostSetupError(message, { step: "connect" });
  const knownHosts = join(work, "known_hosts");
  writeFileSync(knownHosts, peer.keys.map((key) => `${peer.dnsName} ${key}\n`).join(""), { mode: 0o600 });
  const session = { sshUser: setup.sshUser, knownHosts, port: sshPort };
  // A Tailscale SSH check holds the session until the user approves it.
  const onCheck = (line) => {
    const link = CHECK_LINK_RE.exec(line)?.[0];
    if (link) progress("waiting", "Approve the Tailscale SSH check in your browser", link);
  };
  const probe = await run(ssh, sshArgs(peer, session, `/bin/sh -c '${PROBE}'`), { timeoutMs: CONNECT_TIMEOUT_MS, onErrLine: onCheck });
  if (probe.timedOut) throw fail("ssh did not connect in time (a Tailscale SSH check waits for your approval)");
  if (probe.code !== 0) throw fail(`ssh failed: ${tail(probe.stderr) || `exit ${probe.code}`}`);
  const facts = Object.fromEntries(probe.stdout.split("\n").filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s, 2)));
  if (facts.os !== "Linux") throw fail(`the machine runs ${clip(facts.os || "an unknown system", 40)}; the runner needs Linux`);
  if (!facts.systemd) throw fail("the machine has no systemd");
  const tailscale = HOST_TAILSCALE_PATHS.find((path) => path === facts.tailscale_bin);
  if (!tailscale) throw fail(`the machine has no tailscale CLI at ${HOST_TAILSCALE_PATHS.join(" or ")}`);
  const access = facts.uid === "0" ? "root" : facts.sudon ? "sudon" : facts.sudo ? "password" : undefined;
  if (!access) throw fail("the SSH login is not root and has no sudo");
  if (access === "password" && !setup.sudoPassword) throw fail("sudo on the machine asks for a password: enter it, then run the setup again");
  progress("done", access === "root" ? "root" : "sudo");
  return { session, access, tailscale };
}

/** The node step: node-setup.sh, as root, installs the pinned Node at
 * RUNNER_NODE or keeps a safe, new enough one there. The copy and setup.sh
 * then run on it, so the machine needs no Node of its own. */
async function nodeStep(peer, session, { ssh, access, root, sudoPassword }) {
  const script = readFileSync(join(root, NODE_SETUP_SCRIPT), "utf8");
  const result = await run(ssh, sshArgs(peer, session, rootCommand({ access, script, name: "node-setup.sh" })), {
    input: access === "password" ? `${sudoPassword}\n` : "",
    timeoutMs: NODE_TIMEOUT_MS,
  });
  const fail = (message) => new HostSetupError(message, { step: "node" });
  if (result.code !== 0) throw fail(rootFailure(result, access) ?? "the Node install did not end in time");
  const found = result.stdout.split("\n").map((line) => NODE_LINE_RE.exec(line.trim())).find(Boolean);
  if (!found || found[1] !== RUNNER_NODE) throw fail(`node-setup.sh named no Node at ${RUNNER_NODE}`);
  return { path: found[1], version: found[2] };
}

/** The copy step: the runner tree, a fresh bundle, the Pi package files,
 * the first-install config and their manifest, into a new stage folder as
 * the SSH user. */
async function copyStep(peer, session, { ssh, root, bundle, piDeps, config }) {
  const fail = (message) => new HostSetupError(message, { step: "copy" });
  const files = STAGE_FILES.map(([path, mode]) => ({ path, mode, data: readFileSync(join(root, path)).toString("base64") }));
  files.push({ path: BUNDLE, mode: BUNDLE_MODE, data: readFileSync(bundle).toString("base64") }, ...piDeps);
  files.push({ path: "config.json", mode: 0o644, data: Buffer.from(config).toString("base64") });
  const stageBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.data, "base64"), 0);
  if (stageBytes > STAGE_BYTES_MAX) throw fail(`the runner files are ${stageBytes} bytes; setup.sh copies at most ${STAGE_BYTES_MAX}`);
  const manifest = manifestOf(files);
  files.push(manifest.file);
  const copy = await run(ssh, sshArgs(peer, session, unpackCommand(RUNNER_NODE)), { input: JSON.stringify({ files }), timeoutMs: COPY_TIMEOUT_MS });
  const stage = /^@@stage (\S+)$/m.exec(copy.stdout)?.[1];
  const reason = tail(copy.stderr) || `exit ${copy.code}`;
  if (copy.code !== 0 || !stage || !STAGE_RE.test(stage)) throw fail(`the copy failed: ${reason}`);
  const swept = (/^@@swept (\d+) (\d+)$/m.exec(copy.stdout) ?? []).slice(1).map(Number);
  return { stage, sha: manifest.sha, count: files.length, swept: [swept[0] ?? 0, swept[1] ?? 0] };
}

/** The harness, install and serve steps: setup.sh as root, which installs
 * from its root-only copy of the stage and reports each step it starts. Each
 * harness line shows on the page as it comes, so a long download is not an
 * idle step (plugin.js SETUP_IDLE_MS). */
async function installStep(peer, session, { ssh, access, root, staged, tailscale, sudoPassword, progress, begin }) {
  const script = readFileSync(join(root, SETUP_SCRIPT), "utf8");
  const command = rootCommand({ access, script, name: "setup.sh", args: [staged.stage, RUNNER_PORT, RUNNER_NODE, staged.sha] });
  let agentUser = DEFAULT_AGENT_USER;
  const harnesses = [];
  const install = await run(ssh, sshArgs(peer, session, command), {
    input: access === "password" ? `${sudoPassword}\n` : "",
    timeoutMs: HARNESSES_TIMEOUT_MS + INSTALL_TIMEOUT_MS,
    onLine: (line) => {
      const text = line.trim();
      agentUser = AGENT_USER_LINE_RE.exec(text)?.[1] ?? agentUser;
      const harness = HARNESS_LINE_RE.exec(text);
      if (harness) {
        harnesses.push(`${harness[1]} ${harness[2]}`);
        progress("running", harnesses.join(", "));
      }
      const next = STEP_LINE_RE.exec(text)?.[1];
      if (next) {
        progress("done", next === "install" ? harnesses.join(", ") : undefined);
        begin(next);
      }
    },
  });
  if (install.code !== 0)
    throw new HostSetupError(
      rootFailure(install, access, {
        [SETUP_EXIT.noTag]: "the machine has no ACL tag",
        [SETUP_EXIT.unsafeNode]: (last) => `${last || "a user who is not root can change the runner's Node or a folder above it"} (runner/README.md, "Node")`,
        [SETUP_EXIT.tampered]: "the stage folder on the machine changed after the copy, so nothing was installed; a process of the SSH user may have changed it",
        [SETUP_EXIT.unsafeTailscale]: `a user who is not root can change ${tailscale} or a folder above it; root does not run it (runner/README.md, "Tailscale CLI")`,
        [SETUP_EXIT.harness]: (last) => `${last || "a harness install failed"} (runner/README.md, "Harnesses")`,
      }) ?? "the install did not end in time",
    );
  return { agentUser };
}

/**
 * Sets up one machine. `onProgress({step, state, detail?, link?})` gets each
 * step as it starts and ends; state is running, waiting, done or failed.
 * Resolves with `{host, added, manual, version}`; rejects with a
 * HostSetupError that names the failed step.
 *
 * `deps` lets the smoke run replace what reaches outside this process:
 * `status` (tailscale status), `ssh` (the ssh program), `sshPort`, `fetch`
 * and `root` (the checkout).
 */
export async function setupHost(request, { hostsPath, onProgress = () => {}, deps = {} }) {
  const { status: getStatus = tailscaleStatus, ssh = SSH_BIN, sshPort = 22, fetch: fetchImpl = fetch, root = ROOT } = deps;
  let step = "machine";
  const progress = (state, detail, link) => onProgress({ step, state, ...(detail ? { detail: clip(detail) } : {}), ...(link ? { link } : {}) });
  const begin = (next) => {
    step = next;
    progress("running");
  };
  const workSwept = sweepWork(tmpdir());
  const work = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  // Set once the copy made a stage, and cleared once the install step has
  // removed it, so that a failure between the two still removes it.
  let cleanup;
  try {
    begin("machine");
    const setup = parseSetupRequest(request);
    const status = await getStatus();
    const peer = findPeer(status, setup.address);
    const login = selfLogin(status);
    progress("done", [peer.dnsName, ...peer.tags, ...sweptText(workSwept, "work folder")].join(", "));

    begin("bundle");
    const built = await buildBundle(root, work, progress);
    progress("done", `built from ${built.commit}`);

    begin("connect");
    const { session, access, tailscale } = await connectStep(peer, setup, { ssh, sshPort, work, progress });

    begin("node");
    const runnerNode = await nodeStep(peer, session, { ssh, access, root, sudoPassword: setup.sudoPassword });
    progress("done", `Node ${runnerNode.version} at ${runnerNode.path}`);

    begin("copy");
    const staged = await copyStep(peer, session, { ssh, root, bundle: built.bundle, piDeps: built.piDeps, config: runnerConfig(root, { ...setup, login }) });
    // The SSH user removes the stage: root never deletes in a folder that
    // another user owns.
    cleanup = () => run(ssh, sshArgs(peer, session, `rm -rf -- ${staged.stage}`), { timeoutMs: COPY_TIMEOUT_MS }).catch(() => undefined);
    // A stale stage that stays is no risk (it holds no secret), so it only
    // shows in the step's detail and does not stop the setup.
    progress("done", [`${staged.count} files`, ...sweptText(staged.swept, "stage")].join(", "));

    begin("harnesses");
    const installed = await installStep(peer, session, { ssh, access, root, staged, tailscale, sudoPassword: setup.sudoPassword, progress, begin }).finally(async () => {
      // setup.sh has its own root-only copy by now, so the stage goes on
      // every outcome of the install.
      await cleanup();
      cleanup = undefined;
    });
    const agentUser = installed.agentUser;
    progress("done", runnerOrigin(`https://${peer.dnsName}`));

    begin("hosts");
    const { host, added } = addHost(hostsPath, peer, setup);
    progress("done", added ? `added ${host.label}` : `${host.label} is already listed`);

    begin("health");
    const version = await waitHealthy(runnerOrigin(host.origin), fetchImpl);
    progress("done", version ? `buzz-runner ${version}` : "");
    return { host, added, version, manual: manualSteps(peer, host.label, agentUser) };
  } catch (error) {
    const failure = error instanceof HostSetupError ? error : new HostSetupError(clip(error?.message ?? error), { step, cause: error });
    failure.step ??= step;
    await cleanup?.();
    onProgress({ step: failure.step, state: "failed", detail: clip(failure.message, 500) });
    throw failure;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
