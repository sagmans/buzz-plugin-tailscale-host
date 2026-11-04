// Sign-in scenarios of the smoke run: scripts/host-signin.mjs, as the
// Settings page runs it through the hosts helper, against fake-ssh-tty.mjs
// and a fake `tailscale status`. They check the rules that keep a sign-in
// safe (a listed host only, ssh pinned to Tailscale's host keys and asked for
// a terminal, a fixed command, the sudo password sent once and only when
// sudo asks, every secret masked in what the page sees, one sign-in at a
// time) and what the owner sees: the terminal as plain lines, and the line
// they type reaching it. A real sign-in on a machine is a host test
// (runner/README.md, "Sign in").
//
// Called from run.mjs with its `check`; adds PASS/FAIL lines.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../../scripts/hosts-helper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_SSH = resolve(HERE, "fake-ssh-tty.mjs");
const DNS = "signin-box.example.ts.net";
const HOST_ID = "signin-box";
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISmokeSignInHostKey";
const PASSWORD = "smoke-sudo-pass";
/** A typed line long enough to be masked (host-signin.mjs MASK_MIN). */
const KEY = "typed smoke line";
/** host-signin.mjs MASK: what the page sees in place of a secret. */
const MASK = "••••••••";
/** The longest a scenario waits for the fake terminal's prompt. */
const PROMPT_WAIT_MS = 10_000;
const PROMPT = "Paste the key: ";

const peer = (overrides = {}) => ({
  DNSName: `${DNS}.`,
  HostName: "Sign-in Box",
  OS: "linux",
  Online: true,
  Tags: ["tag:smoke"],
  sshHostKeys: [HOST_KEY],
  TailscaleIPs: ["100.64.0.9"],
  ...overrides,
});
const statusWith = (entry) => ({ Self: { UserID: 7 }, User: { 7: { LoginName: "owner@example.com" } }, Peer: { node: entry } });

/** @param {{check: (name: string, ok: unknown, detail?: string) => void, temp: string}} deps */
export async function signinSmoke({ check, temp }) {
  const hostsPath = join(temp, "signin-hosts.json");
  writeFileSync(hostsPath, `${JSON.stringify({ hosts: [{ id: HOST_ID, label: "Sign-in Box", origin: `https://${DNS}` }] }, null, 2)}\n`);
  const log = join(temp, "fake-ssh-tty.log");
  const paths = { hostsPath, signInDeps: { status: async () => statusWith(peer()), ssh: FAKE_SSH } };
  let nextId = 1;
  const request = (signin) => ({ id: nextId++, op: "signin", signin: { host: HOST_ID, sshUser: "owner", sudoPassword: PASSWORD, command: "claude-console", ...signin } });
  const control = (op, fields = {}) =>
    handle({ id: nextId++, op, ...fields }, paths).then(
      (reply) => reply,
      (error) => ({ error: error.message }),
    );

  /** One sign-in through the helper. `answer` is typed when the prompt shows;
   * returns the streamed events, the reply or error, and the ssh calls. */
  async function attempt(signin = {}, { env = {}, answer = KEY, during } = {}) {
    writeFileSync(log, "");
    Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_PASSWORD: PASSWORD, FAKE_SSH_CHECK: "0", FAKE_SSH_NO_TOOL: "0", FAKE_SSH_ECHO: "0", ...env });
    const events = [];
    let prompted;
    const prompt = new Promise((done) => {
      prompted = done;
    });
    const run = handle(request(signin), paths, (event) => {
      events.push(event);
      if (event.output?.endsWith(PROMPT)) prompted(true);
    }).then(
      (reply) => ({ reply }),
      (error) => ({ error: error.message }),
    );
    const shown = await Promise.race([prompt, run.then(() => false), new Promise((done) => setTimeout(done, PROMPT_WAIT_MS, false))]);
    let duringResult;
    if (shown && during) duringResult = await during();
    if (shown && answer !== undefined) await control("signin-input", { text: answer });
    const outcome = await run;
    const calls = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { ...outcome, events, calls, shown, during: duringResult };
  }

  const ok = await attempt({}, { env: { FAKE_SSH_CHECK: "1", FAKE_SSH_ECHO: "1" } });
  const call = ok.calls[0];
  const seen = JSON.stringify([ok.events, ok.reply]);
  check("signin: a sign-in through the helper ends with exit 0", ok.reply?.code === 0, ok.error);
  check(
    "signin: ssh asks for a terminal, is pinned to Tailscale's host key and reaches the peer's Tailscale address",
    call?.argv.includes("-tt") && call.argv.includes("StrictHostKeyChecking=yes") && call.argv.includes(`HostKeyAlias=${DNS}`) && call.argv.includes("100.64.0.9") && call.argv.includes("owner"),
    JSON.stringify(call?.argv),
  );
  check("signin: the remote command runs buzz-login as the user it names, with the chosen words only", /exec sudo -k -p "[^"]+" -u "\$u" -- \/usr\/local\/bin\/buzz-login "\$@"' sh claude --console$/.test(call?.argv.at(-1) ?? ""), call?.argv.at(-1));
  check("signin: the password goes once, only after sudo's prompt, and the typed line goes to the terminal", call?.stdin === `${PASSWORD}\r${KEY}\r`, JSON.stringify(call?.stdin));
  check("signin: the page sees the terminal as plain lines, with the spinner's last state only", ok.reply?.output.includes("buzz-login claude --console\nsign-in link\nready") && !/[\u0000-\u0009\u000b-\u001f]/.test(ok.reply?.output ?? "") && !ok.reply?.output.includes("working"), JSON.stringify(ok.reply?.output));
  check("signin: no event or reply holds the password or the typed key, and both show masked", !seen.includes(PASSWORD) && !seen.includes(KEY) && ok.reply?.output.includes(`You typed: ${MASK}`), JSON.stringify(ok.reply?.output));
  check("signin: the Tailscale SSH check link is streamed to the page", ok.events.some((event) => event.link === "https://login.tailscale.com/a/smoke-signin"), JSON.stringify(ok.events.map((event) => event.link)));
  check("signin: the last event carries the whole last screen", ok.events.at(-1)?.state === "ended" && ok.events.at(-1)?.output === ok.reply?.output);

  // A key longer than a screen line's bound, which the CLI prints back: the
  // mask runs before the cut, so no part of it shows.
  const LONG_KEY = "long-typed-line ".repeat(500).trim();
  const long = await attempt({}, { env: { FAKE_SSH_ECHO: "1" }, answer: LONG_KEY });
  const longSeen = JSON.stringify([long.events, long.reply]);
  check("signin: a typed line longer than a screen line is masked whole", long.reply?.code === 0 && long.reply.output.includes(`You typed: ${MASK}\n`) && !longSeen.includes("long-typed-line"), long.error ?? JSON.stringify(long.reply?.output.slice(-300)));

  const wrong = await attempt({ sudoPassword: "not-it" }, { answer: undefined });
  check("signin: a refused sudo password ends the run and is not sent again", /sudo refused the password/.test(wrong.error ?? "") && wrong.calls[0]?.stdin === "not-it\r", `${wrong.error} ${JSON.stringify(wrong.calls[0]?.stdin)}`);
  const none = await attempt({ sudoPassword: "" }, { answer: undefined });
  check("signin: sudo that asks for a password, with none given, ends the run", /asks for a password/.test(none.error ?? "") && none.calls[0]?.stdin === "", none.error);
  const nopass = await attempt({ sudoPassword: "" }, { env: { FAKE_SSH_PASSWORD: "" } });
  check("signin: a login that sudo asks no password of signs in", nopass.reply?.code === 0 && nopass.calls[0]?.stdin === `${KEY}\r`, nopass.error);
  const noTool = await attempt({}, { env: { FAKE_SSH_NO_TOOL: "1" }, answer: undefined });
  check("signin: a machine without buzz-login sends the owner to Add host", /run Add host for it first/.test(noTool.error ?? ""), noTool.error);

  const busy = await attempt({}, {
    during: async () => ({
      second: await handle(request({}), paths).then(
        () => "ran",
        (error) => error.message,
      ),
      setup: await handle({ id: nextId++, op: "setup", setup: {} }, paths).then(
        () => "ran",
        (error) => error.message,
      ),
      badInput: await control("signin-input", { text: "two\nlines" }),
    }),
  });
  check("signin: the helper runs one sign-in at a time and no setup while it runs", /already running/.test(busy.during?.second) && /sign-in is running/.test(busy.during?.setup) && busy.reply?.code === 0, JSON.stringify(busy.during));
  check("signin: a typed line with a line break is refused", /one line/.test(busy.during?.badInput?.error ?? ""), JSON.stringify(busy.during?.badInput));
  const cancelled = await attempt({}, { answer: undefined, during: () => control("signin-cancel") });
  check("signin: Cancel ends the running sign-in", cancelled.during?.cancelled === true && /cancelled/.test(cancelled.error ?? ""), `${JSON.stringify(cancelled.during)} ${cancelled.error}`);

  // Refused before anything reaches the machine.
  writeFileSync(log, "");
  const refused = await Promise.all(
    [{ command: "claude --api-key" }, { command: "status; id" }, { host: "nowhere" }, { sshUser: "Root User" }, { extra: 1 }].map((signin) =>
      handle(request(signin), paths).then(
        () => "ran",
        (error) => error.message,
      ),
    ),
  );
  check("signin: a command, host, login or key outside the rules is refused before ssh", refused.every((reason) => reason !== "ran") && readFileSync(log, "utf8") === "", JSON.stringify(refused));
  const idle = await control("signin-input", { text: "x" });
  check("signin: an input with no sign-in running is refused", /no sign-in is running/.test(idle.error ?? ""), JSON.stringify(idle));
}
