#!/usr/bin/env node
// Stand-in for /usr/bin/ssh in the sign-in scenarios (signin.mjs). It takes
// the argv that scripts/host-signin.mjs builds and plays the machine's
// terminal the way sudo and buzz-login draw it: sudo's prompt (the marker
// that the command sets), then buzz-login's lines with colour, a spinner that
// redraws its line, and one hidden prompt. It never runs buzz-login: a real
// sign-in needs the harness's account (runner/README.md, "Sign in").
//
// Every call is appended to $FAKE_SSH_LOG as one JSON line {argv, stdin},
// written when the call ends, so the scenarios can check what reached "the
// machine": the password only once, and the typed line only to the terminal.
// Behaviour comes from the environment, which the scenario sets:
//   FAKE_SSH_PASSWORD  the sudo password the machine takes; empty: sudo
//                      asks for none
//   FAKE_SSH_CHECK     "1": print a Tailscale SSH check link first
//   FAKE_SSH_NO_TOOL   "1": the machine has no buzz-login (exit 69)
//   FAKE_SSH_ECHO      "1": the sign-in prints the typed line back, as a CLI
//                      that echoes a pasted code does
import { appendFileSync } from "node:fs";

/** The parts of the remote command that host-signin.mjs remoteCommand
 * writes: the sudo marker, and buzz-login's words after `sh`. */
const MARKER_RE = /sudo -k -p "([^"]+)" -u "\$u"/;
const WORDS_RE = / sh ((?:[a-z-]+ ?)+)$/;
const CHECK_LINK = "https://login.tailscale.com/a/smoke-signin";
const EXIT_NO_TTY = 2;
const EXIT_SUDO = 1;
const EXIT_NO_TOOL = 69;
const ESC = "\u001b";

const argv = process.argv.slice(2);
const command = argv.at(-1) ?? "";
const env = process.env;
let stdin = "";
let pending = "";
const lines = [];
let waiting;

/** One line from the terminal: the helper ends each with a carriage return,
 * as a key press of Enter does. */
function readLine() {
  return new Promise((done) => {
    if (lines.length) return done(lines.shift());
    waiting = done;
  });
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  stdin += chunk;
  pending += chunk;
  const parts = pending.split("\r");
  pending = parts.pop();
  lines.push(...parts);
  if (waiting && lines.length) {
    const done = waiting;
    waiting = undefined;
    done(lines.shift());
  }
});

/** Ends the call without process.exit: on macOS a pipe write is async, and
 * an exit would drop the last output that the scenario checks. */
function end(code) {
  appendFileSync(env.FAKE_SSH_LOG, `${JSON.stringify({ argv, stdin })}\n`);
  process.exitCode = code;
  process.stdin.destroy();
}

const say = (text) => process.stdout.write(text);

// The helper ends a refused or cancelled sign-in with SIGTERM; the call is
// still logged, so the scenario sees what reached the machine before it.
const EXIT_TERM = 143;
process.on("SIGTERM", () => {
  appendFileSync(env.FAKE_SSH_LOG, `${JSON.stringify({ argv, stdin })}\n`);
  process.exit(EXIT_TERM);
});

async function main() {
  if (!argv.includes("-tt")) {
    process.stderr.write("fake ssh: the sign-in asked for no terminal\n");
    return end(EXIT_NO_TTY);
  }
  if (env.FAKE_SSH_CHECK === "1") process.stderr.write(`# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${CHECK_LINK}\n`);
  if (env.FAKE_SSH_NO_TOOL === "1") return end(EXIT_NO_TOOL);
  const marker = MARKER_RE.exec(command)?.[1];
  const words = WORDS_RE.exec(command)?.[1]?.trim() ?? "";
  if (env.FAKE_SSH_PASSWORD) {
    for (let tries = 0; ; tries += 1) {
      say(marker);
      const given = await readLine();
      say("\r\n");
      if (given === env.FAKE_SSH_PASSWORD) break;
      if (tries === 2) {
        say("sudo: 3 incorrect password attempts\r\n");
        return end(EXIT_SUDO);
      }
      say("Sorry, try again.\r\n");
    }
  }
  say(`${ESC}[1mbuzz-login${ESC}[0m ${words}\r\n`);
  say(`${ESC}]8;;https://example.invalid/oauth${ESC}\\sign-in link${ESC}]8;;${ESC}\\\r\n`);
  say("working |\rworking /\rworking -\rready    \r");
  say("\n");
  say("Paste the key: ");
  const key = await readLine();
  say("\r\n");
  if (env.FAKE_SSH_ECHO === "1") say(`You typed: ${key}\r\n`);
  say(`Saved a key of ${key.length} characters.\r\n`);
  end(0);
}

await main();
