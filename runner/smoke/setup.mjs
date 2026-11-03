// Host setup scenarios of the smoke run: scripts/host-setup.mjs, as the
// Settings page runs it through the hosts helper, against fake-ssh.mjs and a
// fake `tailscale status`. They check the rules that keep a setup safe (a
// tagged Linux peer only, ssh pinned to Tailscale's host keys, the sudo
// password only on sudo's stdin, the stage removed on every exit) and what
// the user sees: each step's progress and the host added to hosts.json.
// The real install on a systemd machine is a host test (runner/README.md).
//
// Called from run.mjs with its `check`; adds PASS/FAIL lines.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SETUP_STEPS, setupHost } from "../../scripts/host-setup.mjs";
import { handle } from "../../scripts/hosts-helper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FAKE_SSH = resolve(HERE, "fake-ssh.mjs");
/** The files the setup copies (host-setup.mjs STAGE_FILES); the bundle
 * comes from FAKE_BUILD, so no runner build is needed. */
const TREE = ["runner/README.md", "runner/buzz-runner.service", "runner/config.example.json", "runner/deploy/install.sh", "runner/deploy/setup.sh", "runner/deploy/check-config.mjs", "runner/deploy/sudoers.template", "runner/deploy/claude-wrapper", "runner/deploy/harness-wrapper", "runner/deploy/buzz-login", "runner/deploy/buzz-login.mjs", "runner/deploy/pi-launch.mjs"];
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAISmokeHostKeySmokeHostKeySmokeHostKeySmoke";
const OTHER_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherHostKeyOtherHostKeyOtherHostKeyOther";
const PASSWORD = "smoke sudo pass";
const LOGIN = "owner@example.com";
const MACHINE = "smoke-box";
const DNS = `${MACHINE}.example.ts.net`;
/** The address as the owner types it, and as hosts.json keeps it: the
 * runner port is the setup's own. */
const ADDRESS = `https://${DNS}`;
const ORIGIN = ADDRESS;
const SERVE_ORIGIN = `${ORIGIN}:10000`;
/** The runner-only Node path (scripts/host-setup.mjs NODE_PATHS). */
const RUNNER_NODE = "/opt/buzz-runner/node";
/** Stands in for scripts/build-runner.mjs: writes a bundle where --out says. */
const FAKE_BUILD = `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/buzz-runner.mjs", "// bundle\\n");
`;
/** git for the fixture checkout only, without the user's own git config. */
const fixtureGit = (root, args) =>
  execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid" },
  });
const OWNER = "ef".repeat(32);
const RELAY = "wss://relay.example.ts.net";
const FACTS = Object.freeze({ os: "Linux", uid: "1000", node_bin: "/usr/bin/node", node: "24.1.0", systemd: "1", tailscale: "1", sudo: "1" });
const STAGE_PREFIX = "buzz-runner-setup.";

const peer = (overrides = {}) => ({
  DNSName: `${DNS}.`,
  HostName: "Smoke Box",
  OS: "linux",
  Online: true,
  Tags: ["tag:smoke"],
  sshHostKeys: [HOST_KEY],
  TailscaleIPs: ["100.64.0.7", "fd7a:115c:a1e0::7"],
  ...overrides,
});
const statusWith = (entry) => ({ Self: { UserID: 7 }, User: { 7: { LoginName: LOGIN } }, Peer: { node: entry } });
const leftoverStages = () => readdirSync("/tmp").filter((name) => name.startsWith(STAGE_PREFIX));

/** @param {{check: (name: string, ok: unknown, detail?: string) => void, temp: string}} deps */
export async function setupSmoke({ check, temp }) {
  const root = join(temp, "setup-root");
  for (const file of TREE) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    copyFileSync(join(REPO, file), join(root, file));
  }
  mkdirSync(join(root, "scripts"), { recursive: true });
  writeFileSync(join(root, "scripts/build-runner.mjs"), FAKE_BUILD);
  fixtureGit(root, ["init", "-q", "--template="]);
  fixtureGit(root, ["add", "-A"]);
  fixtureGit(root, ["commit", "-q", "--no-gpg-sign", "-m", "fixture"]);
  const hostsPath = join(temp, "setup-hosts.json");
  writeFileSync(hostsPath, `${JSON.stringify({ hosts: [{ id: "first", label: "first/host", origin: "https://first.example.ts.net:10000" }] }, null, 2)}\n`);
  const log = join(temp, "fake-ssh.log");
  const before = new Set(leftoverStages());
  const health = [];
  const fakeFetch = async (url) => {
    health.push(url);
    return { status: 200, json: async () => ({ ok: true, version: "0.0.0-smoke", agents: 0 }) };
  };

  /** One setup; returns its progress, its result or error, and the ssh calls. */
  async function attempt(request, { entry = peer(), facts = FACTS, env = {} } = {}) {
    writeFileSync(log, "");
    Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_HOST_KEY: HOST_KEY, FAKE_SSH_PASSWORD: PASSWORD, FAKE_SSH_CHECK: "0", FAKE_SSH_NODE_UNSAFE: "0", FAKE_SSH_FACTS: JSON.stringify(facts), ...env });
    const events = [];
    let result;
    let error;
    try {
      result = await setupHost(
        { address: ADDRESS, sshUser: "owner", sudoPassword: PASSWORD, ownerPubkey: OWNER, relay: RELAY, ...request },
        { hostsPath, onProgress: (event) => events.push(event), deps: { status: async () => statusWith(entry), ssh: FAKE_SSH, fetch: fakeFetch, root } },
      );
    } catch (caught) {
      error = caught;
    }
    const lines = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { events, result, error, calls: lines.filter((line) => line.argv), configs: lines.filter((line) => line.config).map((line) => line.config) };
  }
  const failedAt = (outcome, step) => outcome.error?.step === step && outcome.events.at(-1)?.state === "failed" && outcome.events.at(-1)?.step === step;

  const untagged = await attempt({}, { entry: peer({ Tags: [] }) });
  check("setup: an untagged machine is refused before any ssh call", failedAt(untagged, "machine") && untagged.calls.length === 0 && /no ACL tag.*Edit ACL tags/.test(untagged.error.message), untagged.error?.message);
  const mac = await attempt({}, { entry: peer({ OS: "macOS" }) });
  check("setup: a machine that is not Linux is refused", failedAt(mac, "machine") && mac.calls.length === 0 && /needs Linux/.test(mac.error.message), mac.error?.message);
  const unknown = await Promise.all(["https://elsewhere.example.ts.net", "https://100.64.0.7"].map((address) => attempt({ address })));
  check("setup: an address that is no tailnet peer's MagicDNS name is refused", unknown.every((outcome) => failedAt(outcome, "machine") && outcome.calls.length === 0 && /not a machine of this tailnet/.test(outcome.error.message)), unknown.map((outcome) => outcome.error?.message).join(" | "));
  const bad = await Promise.all(
    [{ address: `${ADDRESS}:8443` }, { address: `${ADDRESS}/v1` }, { address: `http://${DNS}` }, { ownerPubkey: "npub1x" }, { relay: "https://relay.example.ts.net" }, { sudoPassword: "a\nb" }, { sshUser: "root;id" }, { extra: 1 }].map((request) => attempt(request)),
  );
  check("setup: a bad address, owner key, relay, password, login or key is refused", bad.every((outcome) => failedAt(outcome, "machine") && outcome.calls.length === 0), bad.map((outcome) => outcome.error?.message).join(" | "));
  // Root runs the copied code, so only committed code may go.
  writeFileSync(join(root, "runner/deploy/install.sh"), `${readFileSync(join(root, "runner/deploy/install.sh"), "utf8")}\n# edit\n`);
  const edited = await attempt({});
  fixtureGit(root, ["checkout", "--", "runner/deploy/install.sh"]);
  writeFileSync(join(root, "runner/deploy/extra.sh"), "id\n");
  const added = await attempt({});
  rmSync(join(root, "runner/deploy/extra.sh"));
  check(
    "setup: an edit or a new file in the runner code stops the setup before any ssh call",
    [edited, added].every((outcome) => failedAt(outcome, "bundle") && outcome.calls.length === 0 && /not committed/.test(outcome.error.message)),
    [edited, added].map((outcome) => outcome.error?.message).join(" | "),
  );

  const pinned = await attempt({}, { env: { FAKE_SSH_HOST_KEY: OTHER_KEY } });
  check("setup: ssh refuses a machine whose key Tailscale does not report", failedAt(pinned, "connect") && /Host key verification failed/.test(pinned.error.message), pinned.error?.message);
  const oldNode = await attempt({}, { facts: { ...FACTS, node: "20.11.0" } });
  check("setup: Node older than 24 on the machine stops the setup before the copy", failedAt(oldNode, "connect") && oldNode.calls.length === 1 && /Node 24 or newer/.test(oldNode.error.message), oldNode.error?.message);
  const otherNode = await attempt({}, { facts: { ...FACTS, node_bin: "/opt/tools/bin/node" } });
  check("setup: a Node path that is not in the list stops the setup before the copy", failedAt(otherNode, "connect") && otherNode.calls.length === 1 && /at \/opt\/buzz-runner\/node or \/usr\/bin\/node/.test(otherNode.error.message), otherNode.error?.message);
  const userNode = await attempt({}, { env: { FAKE_SSH_NODE_UNSAFE: "1" } });
  check("setup: a Node that a non-root user can change fails the install step with that reason", failedAt(userNode, "install") && /not root can change \/usr\/bin\/node/.test(userNode.error.message), userNode.error?.message);
  const noPassword = await attempt({ sudoPassword: "" });
  check("setup: sudo that asks for a password, with none given, stops before the copy", failedAt(noPassword, "connect") && noPassword.calls.length === 1 && /enter it/.test(noPassword.error.message), noPassword.error?.message);

  const wrong = await attempt({ sudoPassword: "not it" });
  check("setup: a refused sudo password fails the install step with that reason", failedAt(wrong, "install") && wrong.error.message === "sudo refused the password", wrong.error?.message);
  check("setup: a failed setup removes its stage folder", leftoverStages().filter((name) => !before.has(name)).length === 0 && wrong.calls.at(-1)?.argv.at(-1).startsWith("rm -rf -- /tmp/buzz-runner-setup."), leftoverStages().join(","));
  const hostsAfterFailure = JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
  check("setup: a failed setup leaves hosts.json as it was", hostsAfterFailure.length === 1);

  const done = await attempt({ label: "smoke/box" }, { env: { FAKE_SSH_CHECK: "1" } });
  const stepsDone = done.events.filter((event) => event.state === "done").map((event) => event.step);
  check("setup: every step runs in order and ends done", !done.error && JSON.stringify(stepsDone) === JSON.stringify(SETUP_STEPS), done.error?.message ?? stepsDone.join(","));
  check("setup: a Tailscale SSH check shows its link as a waiting step", done.events.some((event) => event.step === "connect" && event.state === "waiting" && event.link === "https://login.tailscale.com/a/smoke-check"));
  const argvText = JSON.stringify(done.calls.map((call) => call.argv));
  check("setup: ssh goes to the peer's Tailscale address, pinned to its reported keys", done.calls.length === 3 && done.calls.every((call) => call.argv.includes("StrictHostKeyChecking=yes") && call.argv.includes(`HostKeyAlias=${DNS}`) && call.argv.includes("100.64.0.7") && call.argv.includes("GlobalKnownHostsFile=/dev/null") && call.argv.slice(0, 2).join(" ") === "-F /dev/null"), argvText.slice(0, 300));
  const install = done.calls.at(-1);
  check("setup: the sudo password is on sudo's stdin only, never in an argument", !argvText.includes(PASSWORD) && install?.stdin === `${PASSWORD}\n` && done.calls.slice(0, 2).every((call) => !call.stdin.includes(PASSWORD)) && !JSON.stringify(done.events).includes(PASSWORD));
  const config = done.configs[0];
  check("setup: the first-install config names this owner, relay and Tailscale login", config?.ownerPubkey === OWNER && JSON.stringify(config.relays) === JSON.stringify([RELAY]) && JSON.stringify(config.allowedLogins) === JSON.stringify([LOGIN]) && config.runAsUser === "buzz-agent", JSON.stringify(config));
  const hosts = JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
  check("setup: the machine joins hosts.json with its serve origin and the given name", hosts.length === 2 && hosts[1].id === MACHINE && hosts[1].label === "smoke/box" && hosts[1].origin === ORIGIN && done.result?.added === true, JSON.stringify(hosts));
  check("setup: the health check goes to the new origin, on the runner port", health.at(-1) === `${SERVE_ORIGIN}/v1/health` && done.result?.version === "0.0.0-smoke");
  check("setup: setup.sh gets the Node path that the probe found", install?.argv.at(-1).includes(`/runner/deploy/setup.sh /tmp/buzz-runner-setup.`) && install.argv.at(-1).includes(" 10000 /usr/bin/node"), install?.argv.at(-1));
  check("setup: the manual steps name the sign-in command and the tag's port rule", done.result?.manual?.some((step) => step.command === `ssh -t owner@${DNS} sudo -u buzz-agent /usr/local/bin/buzz-login`) && done.result.manual.some((step) => /port 10000 on tag:smoke/.test(step.text)), JSON.stringify(done.result?.manual));
  check("setup: a finished setup leaves no stage folder", leftoverStages().filter((name) => !before.has(name)).length === 0 && existsSync(tmpdir()));

  const again = await attempt({ address: SERVE_ORIGIN });
  check("setup: a second setup of the same machine, with the port this time, aligns it and keeps its hosts.json entry", !again.error && again.result?.added === false && JSON.parse(readFileSync(hostsPath, "utf8")).hosts.length === 2, again.error?.message);
  const passwordless = await attempt({ sudoPassword: "" }, { facts: { ...FACTS, sudon: "1" } });
  check("setup: sudo without a password runs `sudo -n` with nothing on stdin", !passwordless.error && passwordless.calls.at(-1)?.argv.at(-1).startsWith("sudo -n -- /bin/bash ") && passwordless.calls.at(-1)?.stdin === "", passwordless.error?.message);
  const asRoot = await attempt({ sudoPassword: "" }, { facts: { ...FACTS, uid: "0" } });
  const runnerNode = await attempt({}, { facts: { ...FACTS, node_bin: RUNNER_NODE } });
  check("setup: the runner-only Node goes to the copy and to setup.sh", !runnerNode.error && runnerNode.calls[1]?.argv.at(-1).startsWith(`${RUNNER_NODE} -e `) && runnerNode.calls.at(-1)?.argv.at(-1).includes(` 10000 ${RUNNER_NODE}'`), runnerNode.error?.message ?? runnerNode.calls.at(-1)?.argv.at(-1));
  check("setup: a root login runs setup.sh directly", !asRoot.error && asRoot.calls.at(-1)?.argv.at(-1).startsWith("/bin/bash /tmp/buzz-runner-setup."), asRoot.error?.message);

  // A host removed by hand whose id agents still name: the page reserves it.
  const OTHER = "other-box";
  const reserved = await attempt({ address: `https://${OTHER}.example.ts.net`, reservedIds: [OTHER] }, { entry: peer({ DNSName: `${OTHER}.example.ts.net.` }) });
  const otherHost = JSON.parse(readFileSync(hostsPath, "utf8")).hosts.find((host) => host.origin === `https://${OTHER}.example.ts.net`);
  check("setup: a reserved host id is not given to the new host", !reserved.error && otherHost?.id === `${OTHER}-2`, reserved.error?.message ?? JSON.stringify(otherHost));

  // The same setup through the hosts helper, as the page sends it.
  const setupDeps = { status: async () => statusWith(peer()), ssh: FAKE_SSH, fetch: fakeFetch, root };
  const helperPaths = { hostsPath, setupDeps };
  const request = { id: 2, op: "setup", setup: { address: ADDRESS, sshUser: "owner", sudoPassword: PASSWORD, ownerPubkey: OWNER, relay: RELAY } };
  const streamed = [];
  const first = handle(request, helperPaths, (event) => streamed.push(event));
  const second = await handle({ ...request, id: 3 }, helperPaths).then(
    () => "ran",
    (error) => error.message,
  );
  const save = await handle({ id: 5, op: "save", hosts: [{ id: "first", label: "first/host", origin: "https://first.example.ts.net:10000" }] }, helperPaths).then(
    () => "saved",
    (error) => error.message,
  );
  const firstReply = await first.catch((error) => ({ error: error.message }));
  check("setup: the helper runs one setup at a time", /already running/.test(second) && firstReply.host?.origin === ORIGIN, `${second} ${JSON.stringify(firstReply)}`);
  check("setup: the helper refuses a hosts.json save while a setup runs", /setup is running/.test(save) && JSON.parse(readFileSync(hostsPath, "utf8")).hosts.length === 3, save);
  check(
    "setup: the helper streams each step before its reply, and no event holds the password",
    JSON.stringify(streamed.filter((event) => event.state === "done").map((event) => event.step)) === JSON.stringify(SETUP_STEPS) && !JSON.stringify(streamed).includes(PASSWORD),
  );
  const extra = await handle({ id: 4, op: "setup", setup: { ...request.setup, host: "x" } }, helperPaths).then(
    () => "ran",
    (error) => error.message,
  );
  check("setup: the helper refuses a setup with an unknown key", extra === "unknown setup keys: host", extra);
}
