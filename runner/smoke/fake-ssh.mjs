#!/usr/bin/env node
// Stand-in for /usr/bin/ssh in the host setup scenarios (setup.mjs). It
// takes the argv that scripts/host-setup.mjs builds and answers its four
// remote commands the way a Linux machine would: the probe, the copy (it
// runs the real unpack program, so the stage folder is made as on a host),
// the root run of setup.sh, and the stage removal. For the root run it does
// what setup.sh does before install.sh: it checks the stage against the
// manifest hash that the command pins. It never runs install.sh: that needs
// root and systemd, and has its own dry run. The real setup.sh is a host
// test (runner/README.md, "Deploy").
//
// Every call is appended to $FAKE_SSH_LOG as one JSON line {argv, stdin},
// so the scenarios can check what reached "the machine".
// Behaviour comes from the environment, which the scenario sets:
//   FAKE_SSH_FACTS     JSON object of the probe's key=value facts
//   FAKE_SSH_PASSWORD  the sudo password the machine takes
//   FAKE_SSH_CHECK     "1": print a Tailscale SSH check link first
//   FAKE_SSH_NODE_UNSAFE "1": setup.sh finds a Node that a non-root user
//                      can change (its exit 79)
//   FAKE_SSH_TAMPER    "1": a process of the SSH user changes a stage file
//                      after the copy, before root reads it (exit 80)
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const STAGE_RE = /\/tmp\/buzz-runner-setup\.[A-Za-z0-9]{6,}/;
/** The root command as host-setup.mjs installCommand builds it: the script
 * as base64, then setup.sh's arguments. */
const ROOT_RUN_RE = /\/bin\/bash -c "\$\(printf %s ([A-Za-z0-9+/=]+) \| \/usr\/bin\/base64 -d\)" setup\.sh (\S+) (\d+) (\S+) ([0-9a-f]{64})/;
const MANIFEST = "MANIFEST";
const TAMPERED_FILE = "runner/deploy/install.sh";
const EXIT_TAMPERED = 80;
const CHECK_LINK = "https://login.tailscale.com/a/smoke-check";
const EXIT_SSH = 255;
const EXIT_SUDO = 1;
const EXIT_UNSAFE_NODE = 79;

const argv = process.argv.slice(2);
const stdin = readFileSync(0);
appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ argv, stdin: stdin.toString("utf8") })}\n`);

/** The value of one `-o Key=value` option. */
const option = (key) => argv.find((arg, at) => argv[at - 1] === "-o" && arg.startsWith(`${key}=`))?.slice(key.length + 1);
const command = argv[argv.indexOf("--") + 2] ?? "";

// ssh with StrictHostKeyChecking=yes connects only to a key in the file.
const knownHosts = readFileSync(option("UserKnownHostsFile"), "utf8");
const alias = option("HostKeyAlias");
if (option("StrictHostKeyChecking") !== "yes" || !knownHosts.split("\n").some((line) => line.startsWith(`${alias} `) && line.includes(process.env.FAKE_SSH_HOST_KEY))) {
  process.stderr.write("Host key verification failed.\n");
  process.exit(EXIT_SSH);
}

if (command.startsWith("/bin/sh -c 'echo os=")) {
  if (process.env.FAKE_SSH_CHECK === "1") process.stderr.write(`# Tailscale SSH requires an additional check.\n# To authenticate, visit: ${CHECK_LINK}\n`);
  const facts = JSON.parse(process.env.FAKE_SSH_FACTS);
  process.stdout.write(Object.entries(facts).map(([key, value]) => `${key}=${value}\n`).join(""));
  process.exit(0);
}
if (command.includes("eval(Buffer.from(")) {
  const program = Buffer.from(/Buffer\.from\("([A-Za-z0-9+/=]+)"/.exec(command)[1], "base64").toString("utf8");
  const run = spawnSync(process.execPath, ["-e", program], { input: stdin });
  process.stdout.write(run.stdout);
  process.stderr.write(run.stderr);
  process.exit(run.status ?? EXIT_SSH);
}
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
/** Every file under a folder, as paths relative to it. */
const filesIn = (folder) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(folder, join(entry.parentPath, entry.name)));
/** setup.sh's copy_checked, on the stage itself: the manifest has the pinned
 * hash, and it lists every other file, each with its own hash. */
function stageMatches(stage, pinned) {
  const manifest = readFileSync(join(stage, MANIFEST), "utf8");
  if (sha256(manifest) !== pinned) return false;
  const listed = manifest.split("\n").filter(Boolean).map((line) => [line.slice(0, 64), line.slice(66)]);
  const present = filesIn(stage).filter((path) => path !== MANIFEST).sort();
  return JSON.stringify(listed.map(([, path]) => path).sort()) === JSON.stringify(present) && listed.every(([hash, path]) => sha256(readFileSync(join(stage, path))) === hash);
}

const rootRun = ROOT_RUN_RE.exec(command);
if (rootRun) {
  const [, script, stage, port, node, pinned] = rootRun;
  appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ rootRun: { script: Buffer.from(script, "base64").toString("utf8"), stage, port, node, pinned, files: filesIn(stage).sort() } })}\n`);
  if (command.includes("sudo -k -S")) {
    const typed = stdin.toString("utf8").split("\n")[0];
    if (typed !== process.env.FAKE_SSH_PASSWORD) {
      process.stderr.write("Sorry, try again.\nsudo: 1 incorrect password attempt\n");
      process.exit(EXIT_SUDO);
    }
  }
  if (process.env.FAKE_SSH_NODE_UNSAFE === "1") {
    process.stderr.write("setup.sh: a user who is not root can change the Node or a folder above it; the root runner does not run it\n");
    process.exit(EXIT_UNSAFE_NODE);
  }
  if (process.env.FAKE_SSH_TAMPER === "1") appendFileSync(join(stage, TAMPERED_FILE), "id\n");
  if (!stageMatches(stage, pinned)) {
    process.stderr.write(`setup.sh: the stage at ${stage} is not what the helper sent; nothing was installed\n`);
    process.exit(EXIT_TAMPERED);
  }
  // What setup.sh would install as the config, for the scenario to check.
  appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ config: JSON.parse(readFileSync(`${stage}/config.json`, "utf8")) })}\n`);
  process.stdout.write("@@step install\ninstall.sh: buzz-runner is active.\n@@step serve\n@@step done\n");
  process.exit(0);
}
const removal = /^rm -rf -- (\S+)$/.exec(command);
if (removal && STAGE_RE.test(removal[1])) {
  rmSync(removal[1], { recursive: true, force: true });
  process.exit(0);
}
process.stderr.write(`fake-ssh: unexpected command: ${command.slice(0, 200)}\n`);
process.exit(EXIT_SSH);
