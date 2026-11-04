// Host setup scenarios of the smoke run: scripts/host-setup.mjs, as the
// Settings page runs it through the hosts helper, against fake-ssh.mjs and a
// fake `tailscale status`. They check the rules that keep a setup safe (a
// tagged Linux peer only, ssh pinned to Tailscale's host keys, the sudo
// password only on sudo's stdin, root running setup.sh from its command and
// a stage that matches the pinned manifest, the stage removed on every
// exit, a killed helper's old stage removed by the next copy, and its old
// work folder on this device removed by the next setup) and what
// the user sees: each step's progress and the host added to hosts.json.
// The real install on a systemd machine is a host test (runner/README.md).
// The scenarios hold a lock for this whole device, so two checkouts can run
// scripts/check at the same time (see SETUP_LOCK_PORT).
//
// Called from run.mjs with its `check`; adds PASS/FAIL lines.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { HOST_TAILSCALE_PATHS, SETUP_STEPS, setupHost } from "../../scripts/host-setup.mjs";
import { handle } from "../../scripts/hosts-helper.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const FAKE_SSH = resolve(HERE, "fake-ssh.mjs");
/** The files the setup copies (host-setup.mjs STAGE_FILES), and setup.sh
 * and node-setup.sh, which go in root commands; the bundle comes from FAKE_BUILD, so no
 * runner build is needed. */
const TREE = ["runner/README.md", "runner/buzz-runner.service", "runner/config.example.json", "runner/deploy/install.sh", "runner/deploy/setup.sh", "runner/deploy/node-setup.sh", "runner/deploy/check-config.mjs", "runner/deploy/sudoers.template", "runner/deploy/claude-wrapper", "runner/deploy/harness-wrapper", "runner/deploy/buzz-login", "runner/deploy/buzz-login.mjs", "runner/deploy/pi-launch.mjs"];
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
/** Stands in for scripts/build-runner.mjs: writes a bundle where --out says,
 * padded to FAKE_BUNDLE_BYTES when a scenario needs a big one. */
const FAKE_BUILD = `import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[process.argv.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/buzz-runner.mjs", "// bundle\\n".padEnd(Number(process.env.FAKE_BUNDLE_BYTES ?? 0), " "));
`;
/** setup.sh STAGE_BYTES_MAX: the most bytes of runner files root copies. */
const STAGE_BYTES_MAX = 16_777_216;
/** git for the fixture checkout only, without the user's own git config. */
const fixtureGit = (root, args) =>
  execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "smoke", GIT_AUTHOR_EMAIL: "smoke@example.invalid", GIT_COMMITTER_NAME: "smoke", GIT_COMMITTER_EMAIL: "smoke@example.invalid" },
  });
const OWNER = "ef".repeat(32);
const RELAY = "wss://relay.example.ts.net";
const FACTS = Object.freeze({ os: "Linux", uid: "1000", systemd: "1", tailscale_bin: "/usr/bin/tailscale", sudo: "1" });
/** A manual install of the static tailscale binary, outside root's PATH. */
const LOCAL_TAILSCALE = "/usr/local/bin/tailscale";
/** setup.sh's own tailscale list, and a command line that runs tailscale by
 * name, which root's PATH would not find in /usr/local/bin. */
const SETUP_TAILSCALE_RE = /^readonly TAILSCALE_PATHS=\(([^)]*)\)$/m;
const BARE_TAILSCALE_RE = /(?:^|[|;&(]|\$\()\s*tailscale\s/;
/** Where host-setup.mjs makes its stages, and their name prefix. */
const STAGE_DIR = "/tmp";
const STAGE_PREFIX = "buzz-runner-setup.";
/** The prefix of a setup's work folder on this device (host-setup.mjs
 * WORK_PREFIX), in the user's temp folder. */
const WORK_PREFIX = "buzz-setup-";
/** How old a killed helper's stage and work folder are in the sweep
 * scenario: far past host-setup.mjs STAGE_STALE_MS and WORK_STALE_MS. */
const STALE_AGE_S = 86_400;
/** A small clock step back on the machine: a live stage that looks this far
 * in the future stays. */
const SKEW_S = 60;
/** The lock of the setup scenarios. They make and sweep stages in the shared
 * /tmp and work folders in the user's temp folder, so the sweep of a run in
 * another checkout removes this run's test folders, and its live folders
 * break this run's counts. A loopback listen is the lock: the kernel frees it
 * when the holder dies, so a killed run leaves no stale lock, and Node has no
 * flock. The port is below the ephemeral ports of Linux (from 32768) and
 * macOS (from 49152), so an outgoing connection cannot hold it. */
const SETUP_LOCK_HOST = "127.0.0.1";
const SETUP_LOCK_PORT = 29_517;
/** How long a run waits for the lock: many setup runs (about 5 s each), and
 * well inside scripts/check SMOKE_TIMEOUT_SECONDS. */
const SETUP_LOCK_WAIT_MS = 180_000;
const SETUP_LOCK_RETRY_MS = 200;
const SETUP_SCRIPT = "runner/deploy/setup.sh";
const NODE_SETUP_SCRIPT = "runner/deploy/node-setup.sh";
/** What the stage holds when root reads it: every copied file, the bundle,
 * the config and the manifest, and no root script. */
const STAGE_TREE = [...TREE.filter((file) => file !== SETUP_SCRIPT && file !== NODE_SETUP_SCRIPT), "runner/dist/buzz-runner.mjs", "config.json", "MANIFEST"].sort();
/** The ssh calls that run setup.sh and node-setup.sh as root. */
const rootCall = (outcome) => outcome.calls.find((call) => / setup\.sh \/tmp\/buzz-runner-setup\./.test(call.argv.at(-1)));
const nodeCall = (outcome) => outcome.calls.find((call) => call.argv.at(-1).endsWith(" node-setup.sh'"));

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
const leftoverStages = () => readdirSync(STAGE_DIR).filter((name) => name.startsWith(STAGE_PREFIX));

/** One try to take the lock: the listening server, or the listen error. */
function listenOnce() {
  const server = createServer((socket) => socket.destroy());
  return new Promise((done) => {
    server.once("error", (error) => done({ error }));
    server.listen({ host: SETUP_LOCK_HOST, port: SETUP_LOCK_PORT, exclusive: true }, () => done({ server }));
  });
}

/** Waits for the lock while another run holds it. Returns the server that
 * holds it, or the reason that it could not take it. */
async function takeSetupLock() {
  const started = Date.now();
  for (let attempt = 1; ; attempt += 1) {
    const { server, error } = await listenOnce();
    if (server) {
      // A lost close must not keep the smoke process alive.
      server.unref();
      return { server };
    }
    const waited = Date.now() - started;
    if (error.code !== "EADDRINUSE" || waited >= SETUP_LOCK_WAIT_MS) {
      return { reason: `listen ${SETUP_LOCK_HOST}:${SETUP_LOCK_PORT} failed after ${attempt} attempts in ${waited} ms: ${error.code ?? error.message}` };
    }
    await sleep(SETUP_LOCK_RETRY_MS);
  }
}

/** @param {{check: (name: string, ok: unknown, detail?: string) => void, temp: string}} deps */
export async function setupSmoke(deps) {
  const lock = await takeSetupLock();
  // Without the lock the scenarios would give random results, so it is one
  // failed check and no scenario.
  deps.check("setup: the setup scenarios hold the lock of this device", lock.server, lock.reason);
  if (!lock.server) return;
  try {
    await setupScenarios(deps);
  } finally {
    await new Promise((done) => lock.server.close(done));
  }
}

/** @param {{check: (name: string, ok: unknown, detail?: string) => void, temp: string}} deps */
async function setupScenarios({ check, temp }) {
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
    Object.assign(process.env, { FAKE_SSH_LOG: log, FAKE_SSH_HOST_KEY: HOST_KEY, FAKE_SSH_PASSWORD: PASSWORD, FAKE_SSH_CHECK: "0", FAKE_SSH_NODE_UNSAFE: "0", FAKE_SSH_TAMPER: "0", FAKE_SSH_GROW: "0", FAKE_SSH_TAILSCALE_UNSAFE: "0", FAKE_BUNDLE_BYTES: "0", FAKE_SSH_AGENT_USER: "", FAKE_SSH_NODE_EXIT: "0", FAKE_SSH_FACTS: JSON.stringify(facts), ...env });
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
    return {
      events,
      result,
      error,
      calls: lines.filter((line) => line.argv),
      configs: lines.filter((line) => line.config).map((line) => line.config),
      rootRuns: lines.filter((line) => line.rootRun).map((line) => line.rootRun),
      nodeRuns: lines.filter((line) => line.nodeRun).map((line) => line.nodeRun),
    };
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
  const noNode = await attempt({}, { env: { FAKE_SSH_NODE_EXIT: "69" } });
  check("setup: a failed Node install stops the setup before the copy, with its reason", failedAt(noNode, "node") && noNode.calls.length === 2 && /no \/usr\/bin\/curl or \/usr\/bin\/wget/.test(noNode.error.message), noNode.error?.message);
  const userNode = await attempt({}, { env: { FAKE_SSH_NODE_UNSAFE: "1" } });
  check("setup: a Node that a non-root user can change fails the install step with that reason", failedAt(userNode, "install") && /not root can change \/opt\/buzz-runner\/node/.test(userNode.error.message), userNode.error?.message);
  // One at a time: each attempt reads the one fake-ssh log.
  const noTailscale = [];
  for (const facts of [{ ...FACTS, tailscale_bin: undefined }, { ...FACTS, tailscale_bin: "/opt/tools/bin/tailscale" }]) noTailscale.push(await attempt({}, { facts }));
  check(
    "setup: no tailscale CLI at a listed path stops the setup before the copy",
    noTailscale.every((outcome) => failedAt(outcome, "connect") && outcome.calls.length === 1 && /no tailscale CLI at \/usr\/bin\/tailscale or \/usr\/local\/bin\/tailscale/.test(outcome.error.message)),
    noTailscale.map((outcome) => outcome.error?.message).join(" | "),
  );
  const userTailscale = await attempt({}, { facts: { ...FACTS, tailscale_bin: LOCAL_TAILSCALE }, env: { FAKE_SSH_TAILSCALE_UNSAFE: "1" } });
  check("setup: a tailscale CLI that a non-root user can change fails the install step with that reason", failedAt(userTailscale, "install") && /not root can change \/usr\/local\/bin\/tailscale/.test(userTailscale.error.message), userTailscale.error?.message);
  const setupScript = readFileSync(join(REPO, SETUP_SCRIPT), "utf8");
  const setupCode = setupScript.split("\n").filter((line) => !/^\s*#/.test(line));
  check(
    "setup: setup.sh runs tailscale only by the paths that the probe looks in",
    SETUP_TAILSCALE_RE.exec(setupScript)?.[1].split(/\s+/).join(" ") === HOST_TAILSCALE_PATHS.join(" ") && !setupCode.some((line) => BARE_TAILSCALE_RE.test(line)),
    setupCode.filter((line) => BARE_TAILSCALE_RE.test(line)).join(" | "),
  );
  const noPassword = await attempt({ sudoPassword: "" });
  check("setup: sudo that asks for a password, with none given, stops before the copy", failedAt(noPassword, "connect") && noPassword.calls.length === 1 && /enter it/.test(noPassword.error.message), noPassword.error?.message);

  const wrong = await attempt({ sudoPassword: "not it" });
  check("setup: a refused sudo password fails the Node step, the first root run, before any copy", failedAt(wrong, "node") && wrong.error.message === "sudo refused the password" && wrong.calls.length === 2, wrong.error?.message);
  const tampered = await attempt({}, { env: { FAKE_SSH_TAMPER: "1" } });
  check(
    "setup: a stage file changed after the copy fails the install step, installs nothing and removes the stage",
    failedAt(tampered, "install") && /changed after the copy/.test(tampered.error.message) && tampered.configs.length === 0 && tampered.calls.at(-1)?.argv.at(-1).startsWith("rm -rf -- /tmp/buzz-runner-setup."),
    tampered.error?.message,
  );
  const grown = await attempt({}, { env: { FAKE_SSH_GROW: "1" } });
  check(
    "setup: a stage file grown past root's byte budget after the copy fails the install step and installs nothing",
    failedAt(grown, "install") && /changed after the copy/.test(grown.error.message) && grown.configs.length === 0 && grown.calls.at(-1)?.argv.at(-1).startsWith("rm -rf -- /tmp/buzz-runner-setup."),
    grown.error?.message,
  );
  const big = await attempt({}, { env: { FAKE_BUNDLE_BYTES: String(STAGE_BYTES_MAX + 1) } });
  check("setup: runner files bigger than root's byte budget stop the copy step before any copy", failedAt(big, "copy") && big.calls.length === 2 && big.error?.message.includes(`copies at most ${STAGE_BYTES_MAX}`), big.error?.message);
  check("setup: a failed setup removes its stage folder", leftoverStages().filter((name) => !before.has(name)).length === 0 && userNode.calls.at(-1)?.argv.at(-1).startsWith("rm -rf -- /tmp/buzz-runner-setup."), leftoverStages().join(","));
  const hostsAfterFailure = JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
  check("setup: a failed setup leaves hosts.json as it was", hostsAfterFailure.length === 1);

  const done = await attempt({ label: "smoke/box" }, { env: { FAKE_SSH_CHECK: "1" } });
  const stepsDone = done.events.filter((event) => event.state === "done").map((event) => event.step);
  check("setup: every step runs in order and ends done", !done.error && JSON.stringify(stepsDone) === JSON.stringify(SETUP_STEPS), done.error?.message ?? stepsDone.join(","));
  check("setup: a Tailscale SSH check shows its link as a waiting step", done.events.some((event) => event.step === "connect" && event.state === "waiting" && event.link === "https://login.tailscale.com/a/smoke-check"));
  const argvText = JSON.stringify(done.calls.map((call) => call.argv));
  check("setup: ssh goes to the peer's Tailscale address, pinned to its reported keys", done.calls.length === 5 && done.calls.every((call) => call.argv.includes("StrictHostKeyChecking=yes") && call.argv.includes(`HostKeyAlias=${DNS}`) && call.argv.includes("100.64.0.7") && call.argv.includes("GlobalKnownHostsFile=/dev/null") && call.argv.slice(0, 2).join(" ") === "-F /dev/null"), argvText.slice(0, 300));
  const install = rootCall(done);
  const nodeInstall = nodeCall(done);
  check(
    "setup: the sudo password is on sudo's stdin only, never in an argument",
    !argvText.includes(PASSWORD) && install?.stdin === `${PASSWORD}\n` && nodeInstall?.stdin === `${PASSWORD}\n` && done.calls.filter((call) => call !== install && call !== nodeInstall).every((call) => !call.stdin.includes(PASSWORD)) && !JSON.stringify(done.events).includes(PASSWORD),
  );
  check(
    "setup: root runs node-setup.sh as committed, from its command, before the copy",
    done.nodeRuns.length === 1 && done.nodeRuns[0].script === readFileSync(join(root, NODE_SETUP_SCRIPT), "utf8") && done.calls.indexOf(nodeInstall) === 1 && done.events.some((event) => event.step === "node" && event.state === "done" && event.detail === "Node 24.22.1 at /opt/buzz-runner/node"),
  );
  const rootRun = done.rootRuns[0];
  check(
    "setup: root runs setup.sh as committed, from its command, never from the stage",
    rootRun?.script === readFileSync(join(root, SETUP_SCRIPT), "utf8") && !install.argv.at(-1).includes(`${rootRun.stage}/`) && JSON.stringify(rootRun.files) === JSON.stringify(STAGE_TREE),
    JSON.stringify(rootRun?.files),
  );
  check("setup: the root command pins the manifest of every stage file", /^[0-9a-f]{64}$/.test(rootRun?.pinned ?? "") && done.configs.length === 1, rootRun?.pinned);
  check("setup: the stage goes after the install, as the SSH user", done.calls.at(-1)?.argv.at(-1) === `rm -rf -- ${rootRun?.stage}` && !done.calls.at(-1).argv.join(" ").includes("sudo"));
  const config = done.configs[0];
  check("setup: the first-install config names this owner, relay and Tailscale login", config?.ownerPubkey === OWNER && JSON.stringify(config.relays) === JSON.stringify([RELAY]) && JSON.stringify(config.allowedLogins) === JSON.stringify([LOGIN]) && config.runAsUser === "buzz-agent", JSON.stringify(config));
  const hosts = JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
  check("setup: the machine joins hosts.json with its serve origin and the given name", hosts.length === 2 && hosts[1].id === MACHINE && hosts[1].label === "smoke/box" && hosts[1].origin === ORIGIN && done.result?.added === true, JSON.stringify(hosts));
  check("setup: the health check goes to the new origin, on the runner port", health.at(-1) === `${SERVE_ORIGIN}/v1/health` && done.result?.version === "0.0.0-smoke");
  check("setup: the copy and setup.sh run on the runner-only Node", rootRun?.port === "10000" && rootRun.node === RUNNER_NODE && done.calls[2]?.argv.at(-1).startsWith(`${RUNNER_NODE} -e `), JSON.stringify(rootRun && { port: rootRun.port, node: rootRun.node }));
  check("setup: the manual steps name the sign-in command and the tag's port rule", done.result?.manual?.some((step) => step.command === `ssh -t owner@${DNS} sudo -u buzz-agent /usr/local/bin/buzz-login`) && done.result.manual.some((step) => /port 10000 on tag:smoke/.test(step.text)), JSON.stringify(done.result?.manual));
  check("setup: a finished setup leaves no stage folder", leftoverStages().filter((name) => !before.has(name)).length === 0 && existsSync(tmpdir()));

  // A killed helper's stage: the next copy removes it, also when its time is
  // far in the future (a clock that stepped back), but keeps a young stage and
  // one a small step in the future (a live setup of another device) and never
  // follows a stage-named link to what it points at.
  const now = Date.now() / 1000;
  const staleAt = now - STALE_AGE_S;
  const stale = mkdtempSync(`${STAGE_DIR}/${STAGE_PREFIX}`);
  writeFileSync(join(stale, "MANIFEST"), "old\n");
  utimesSync(stale, staleAt, staleAt);
  const future = mkdtempSync(`${STAGE_DIR}/${STAGE_PREFIX}`);
  utimesSync(future, now + STALE_AGE_S, now + STALE_AGE_S);
  const skewed = mkdtempSync(`${STAGE_DIR}/${STAGE_PREFIX}`);
  utimesSync(skewed, now + SKEW_S, now + SKEW_S);
  const young = mkdtempSync(`${STAGE_DIR}/${STAGE_PREFIX}`);
  const target = join(temp, "sweep-target");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "keep"), "keep\n");
  utimesSync(target, staleAt, staleAt);
  const link = `${STAGE_DIR}/${STAGE_PREFIX}smokeLink${process.pid}`;
  symlinkSync(target, link);
  lutimesSync(link, staleAt, staleAt);
  // The same for a killed helper's work folder on this device, past and
  // future: a link with a work folder's exact name (mkdtemp's six
  // characters) must stay too.
  const staleWork = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  writeFileSync(join(staleWork, "known_hosts"), "old\n");
  utimesSync(staleWork, staleAt, staleAt);
  const futureWork = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  utimesSync(futureWork, now + STALE_AGE_S, now + STALE_AGE_S);
  const skewedWork = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  utimesSync(skewedWork, now + SKEW_S, now + SKEW_S);
  const youngWork = mkdtempSync(join(tmpdir(), WORK_PREFIX));
  const workLink = join(tmpdir(), `${WORK_PREFIX}${`LinkXX${process.pid}`.slice(-6)}`);
  symlinkSync(target, workLink);
  lutimesSync(workLink, staleAt, staleAt);
  const again = await attempt({ address: SERVE_ORIGIN });
  const copyDone = again.events.find((event) => event.step === "copy" && event.state === "done");
  check(
    "setup: the next copy removes a killed helper's old and far-future stages, keeps a young and a near-future one and follows no link",
    !existsSync(stale) && !existsSync(future) && existsSync(skewed) && existsSync(young) && existsSync(join(target, "keep")) && /, 2 old stages removed$/.test(copyDone?.detail ?? ""),
    copyDone?.detail,
  );
  for (const kept of [young, skewed]) rmSync(kept, { recursive: true, force: true });
  const machineDone = again.events.find((event) => event.step === "machine" && event.state === "done");
  check(
    "setup: the next setup removes a killed helper's old and far-future work folders, keeps a young and a near-future one and follows no link",
    !existsSync(staleWork) && !existsSync(futureWork) && existsSync(skewedWork) && existsSync(youngWork) && existsSync(workLink) && existsSync(join(target, "keep")) && /, 2 old work folders removed$/.test(machineDone?.detail ?? ""),
    machineDone?.detail,
  );
  rmSync(link, { force: true });
  for (const kept of [youngWork, skewedWork]) rmSync(kept, { recursive: true, force: true });
  rmSync(workLink, { force: true });
  check("setup: a second setup of the same machine, with the port this time, aligns it and keeps its hosts.json entry", !again.error && again.result?.added === false && JSON.parse(readFileSync(hostsPath, "utf8")).hosts.length === 2, again.error?.message);
  const custom = await attempt({ address: SERVE_ORIGIN }, { env: { FAKE_SSH_AGENT_USER: "agents" } });
  check("setup: the sign-in command names the harness user that setup.sh reports", !custom.error && custom.result?.manual?.some((step) => step.command === `ssh -t owner@${DNS} sudo -u agents /usr/local/bin/buzz-login`), JSON.stringify(custom.result?.manual ?? custom.error?.message));
  const passwordless = await attempt({ sudoPassword: "" }, { facts: { ...FACTS, sudon: "1" } });
  check("setup: sudo without a password runs `sudo -n` with nothing on stdin", !passwordless.error && rootCall(passwordless)?.argv.at(-1).startsWith("/bin/sh -c 'sudo -n -- /bin/bash -c ") && rootCall(passwordless)?.stdin === "", passwordless.error?.message);
  const asRoot = await attempt({ sudoPassword: "" }, { facts: { ...FACTS, uid: "0" } });
  const localTailscale = await attempt({}, { facts: { ...FACTS, tailscale_bin: LOCAL_TAILSCALE } });
  check("setup: a tailscale CLI in /usr/local/bin only passes the probe and the setup ends done", !localTailscale.error && localTailscale.rootRuns.length === 1, localTailscale.error?.message);
  check("setup: a root login runs setup.sh and node-setup.sh without sudo", !asRoot.error && [rootCall(asRoot), nodeCall(asRoot)].every((call) => call?.argv.at(-1).startsWith("/bin/sh -c '/bin/bash -c ")), asRoot.error?.message);

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

  installValuesSmoke({ check, temp });
}

/** A deployment that install.sh made with its own names (the environment of
 * its first run), as files under one folder: the unit, the sudoers rule and
 * buzz-login, rendered from the repository's templates. */
const CUSTOM = Object.freeze({
  RUNNER_USER: "svc-run",
  RUNNER_DIRNAME: "svcrun",
  AGENT_USER: "agents",
  AGENT_HOME: "/srv/agents",
  NODE_BIN: "/opt/node/bin/node",
  LIB_DIR: "/opt/runner/lib",
  LIBEXEC_DIR: "/opt/runner/libexec",
  CLAUDE_WRAPPER: "/opt/runner/libexec/claude-agents",
  HARNESS_WRAPPER: "/opt/runner/libexec/harness-agents",
  CLAUDE_DIR: "/opt/harness/claude",
  CODEX_BIN: "/opt/harness/codex",
  GOOSE_BIN: "/opt/harness/goose-acp",
  PI_MODULES: "/opt/harness/pi/node_modules",
});
const INSTALL_SH = join(REPO, "runner/deploy/install.sh");

/** Writes CUSTOM's deployment under `base`, without the lines in `drop`. */
function writeDeployment(base, drop = []) {
  const v = CUSTOM;
  const put = (path, text) => {
    mkdirSync(dirname(join(base, path)), { recursive: true });
    writeFileSync(join(base, path), text.split("\n").filter((line) => !drop.some((prefix) => line.startsWith(prefix))).join("\n"));
  };
  const unit = readFileSync(join(REPO, "runner/buzz-runner.service"), "utf8")
    .replace(/^User=.*$/m, `User=${v.RUNNER_USER}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=${v.NODE_BIN} ${v.LIB_DIR}/buzz-runner.mjs --config /etc/${v.RUNNER_DIRNAME}/config.json`)
    .replace(/^StateDirectory=.*$/m, `StateDirectory=${v.RUNNER_DIRNAME}`)
    .replace(/^ReadWritePaths=\/home.*$/m, `ReadWritePaths=${v.AGENT_HOME}`);
  put("etc/systemd/system/buzz-runner.service", unit);
  put("etc/sudoers.d/buzz-runner", `# rules\n${v.RUNNER_USER} ALL=(${v.AGENT_USER}) NOPASSWD: ${v.CLAUDE_WRAPPER}\n${v.RUNNER_USER} ALL=(${v.AGENT_USER}) NOPASSWD: ${v.HARNESS_WRAPPER}\n`);
  put("usr/local/bin/buzz-login", readFileSync(join(REPO, "runner/deploy/buzz-login"), "utf8").replace(/^readonly LOGIN=.*$/m, `readonly LOGIN=${v.LIBEXEC_DIR}/buzz-login.mjs`));
  const consts = { RUN_AS: v.AGENT_USER, CLAUDE_DIR: v.CLAUDE_DIR, CODEX_BIN: v.CODEX_BIN, GOOSE_BIN: v.GOOSE_BIN, PI_MODULES: v.PI_MODULES };
  let login = readFileSync(join(REPO, "runner/deploy/buzz-login.mjs"), "utf8");
  for (const [name, value] of Object.entries(consts)) login = login.replace(new RegExp(`^const ${name} = ".*";$`, "m"), `const ${name} = "${value}";`);
  put(`${v.LIBEXEC_DIR.slice(1)}/buzz-login.mjs`, login);
}

/** install.sh's own reading of an installed deployment (`--print-values`,
 * which changes nothing). A run again must keep the names that the first
 * run's environment set; a default name next to them would make a second
 * runner user, rewrite the unit and the sudoers rule, and point serve at a
 * socket that is not there. */
function installValuesSmoke({ check, temp }) {
  const base = join(temp, "installed");
  const values = (env = {}, args = ["--print-values"]) => {
    const run = spawnSync("bash", [INSTALL_SH, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, INSTALLED_ROOT: base, ...env } });
    const pairs = Object.fromEntries(run.stdout.split("\n").filter((line) => line.includes("=")).map((line) => line.split(/=(.*)/s, 2)));
    return { code: run.status, pairs, stderr: run.stderr };
  };
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const fresh = values();
  check("install: a host without buzz-runner gets the default names", fresh.code === 0 && fresh.pairs.INSTALLED === "0" && fresh.pairs.RUNNER_DIRNAME === "buzz-runner" && fresh.pairs.AGENT_USER === "buzz-agent", JSON.stringify(fresh));

  writeDeployment(base);
  const kept = values();
  const differ = Object.entries(CUSTOM).filter(([name, value]) => kept.pairs[name] !== value);
  check("install: a run again keeps every name and path of the installed deployment", kept.code === 0 && kept.pairs.INSTALLED === "1" && differ.length === 0, differ.length ? JSON.stringify(differ.map(([name]) => [name, kept.pairs[name]])) : kept.stderr);
  const set = values({ AGENT_HOME: "/srv/other" });
  check("install: a value the environment sets wins over the installed one", set.code === 0 && set.pairs.AGENT_HOME === "/srv/other" && set.pairs.AGENT_USER === CUSTOM.AGENT_USER, JSON.stringify(set.pairs));

  writeDeployment(base, ["const GOOSE_BIN = "]);
  const unread = values();
  check("install: an installed value that cannot be read stops the run (exit 78), not a default", unread.code === 78 && /GOOSE_BIN cannot be read/.test(unread.stderr) && !unread.pairs.GOOSE_BIN, unread.stderr);
  writeDeployment(base);
  const real = values({}, ["--no-start"]);
  check("install: INSTALLED_ROOT is refused by a run that changes the host", real.code === 64 && /needs --dry-run or --print-values/.test(real.stderr), real.stderr);
}
