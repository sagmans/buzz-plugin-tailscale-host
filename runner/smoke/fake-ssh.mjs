#!/usr/bin/env node
// Stand-in for /usr/bin/ssh in the host setup scenarios (setup.mjs). It
// takes the argv that scripts/host-setup.mjs builds and answers its four
// remote commands the way a Linux machine would: the probe, the copy (it
// runs the real unpack program, so the stage folder is made as on a host),
// the root run of setup.sh, and the stage removal. It never runs install.sh:
// that needs root and systemd, and has its own dry run.
//
// Every call is appended to $FAKE_SSH_LOG as one JSON line {argv, stdin},
// so the scenarios can check what reached "the machine".
// Behaviour comes from the environment, which the scenario sets:
//   FAKE_SSH_FACTS     JSON object of the probe's key=value facts
//   FAKE_SSH_PASSWORD  the sudo password the machine takes
//   FAKE_SSH_CHECK     "1": print a Tailscale SSH check link first
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, rmSync } from "node:fs";

const STAGE_RE = /\/tmp\/buzz-runner-setup\.[A-Za-z0-9]{6,}/;
const CHECK_LINK = "https://login.tailscale.com/a/smoke-check";
const EXIT_SSH = 255;
const EXIT_SUDO = 1;

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
if (command.includes("/runner/deploy/setup.sh ")) {
  const stage = STAGE_RE.exec(command)[0];
  if (command.includes("sudo -k -S")) {
    const typed = stdin.toString("utf8").split("\n")[0];
    if (typed !== process.env.FAKE_SSH_PASSWORD) {
      process.stderr.write("Sorry, try again.\nsudo: 1 incorrect password attempt\n");
      process.exit(EXIT_SUDO);
    }
  }
  // What setup.sh would install as the config, for the scenario to check.
  appendFileSync(process.env.FAKE_SSH_LOG, `${JSON.stringify({ config: JSON.parse(readFileSync(`${stage}/config.json`, "utf8")) })}\n`);
  process.stdout.write("@@step install\ninstall.sh: buzz-runner is active.\n@@step serve\n@@step done\n");
  rmSync(stage, { recursive: true, force: true });
  process.exit(0);
}
const removal = /^rm -rf -- (\S+)$/.exec(command);
if (removal && STAGE_RE.test(removal[1])) {
  rmSync(removal[1], { recursive: true, force: true });
  process.exit(0);
}
process.stderr.write(`fake-ssh: unexpected command: ${command.slice(0, 200)}\n`);
process.exit(EXIT_SSH);
