#!/usr/bin/env node
// install.sh's guard: the runner config must name the same users, paths and
// wrappers that install.sh puts on this host. The runner checks its own
// config for shape at start, but it cannot know what root installed; a
// mismatch would show only later as a sudo refusal or a harness reported as
// "error". So the install stops here instead, before the service starts.
//
// Usage: node check-config.mjs <config.json> key=value...
// The keys are install.sh's view of the host (see EXPECTED_KEYS). Exit 0 when
// the config agrees, 78 (EX_CONFIG) with one line per problem otherwise.
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

const EX_USAGE = 64;
const EX_CONFIG = 78;
/** What install.sh passes; every one is required. */
const EXPECTED_KEYS = ["runtimeDir", "stateDir", "runAsUser", "workspaceRoot", "wrapper", "harnessWrapper", "codex", "goose", "pi"];
/** The runner's own defaults for keys a config may leave out
 * (runner/src/config.ts DEFAULTS, runner/src/constants.ts). Keep in step. */
const RUNNER_DEFAULTS = Object.freeze({
  socket: "/run/buzz-runner/api.sock",
  stateDir: "/var/lib/buzz-runner",
  runAsUser: "buzz-agent",
  workspaceRoot: "/home/buzz-agent/agents",
  harnessWrapper: "/usr/local/libexec/buzz-runner/harness-wrapper",
});
/** config.example.json ships this placeholder; the runner would start with
 * it and no owner could ever activate an agent. */
const PLACEHOLDER_OWNER = "0".repeat(64);

function fail(code, lines) {
  for (const line of lines) console.error(`check-config: ${line}`);
  process.exit(code);
}

const [path, ...pairs] = process.argv.slice(2);
if (!path) fail(EX_USAGE, ["usage: check-config.mjs <config.json> key=value..."]);
const expected = Object.fromEntries(
  pairs.map((pair) => {
    const at = pair.indexOf("=");
    return at > 0 ? [pair.slice(0, at), pair.slice(at + 1)] : [pair, undefined];
  }),
);
const missing = EXPECTED_KEYS.filter((key) => !expected[key]);
if (missing.length) fail(EX_USAGE, [`missing expected values: ${missing.join(", ")}`]);

let config;
try {
  config = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  fail(EX_CONFIG, [`cannot read ${path} as JSON: ${error.message}`]);
}
if (!config || typeof config !== "object" || Array.isArray(config)) fail(EX_CONFIG, [`${path} must hold a JSON object`]);

const value = (key) => config[key] ?? RUNNER_DEFAULTS[key];
const problems = [];
const same = (key, want, shown = key) => {
  const got = value(key);
  if (got !== want) problems.push(`${shown} is ${JSON.stringify(got)}, but install.sh installs ${JSON.stringify(want)}`);
};

if (config.ownerPubkey === PLACEHOLDER_OWNER) problems.push("ownerPubkey is still the example placeholder");
// systemd creates only RuntimeDirectory, and the runner refuses a socket
// directory it does not own.
const socketDir = dirname(String(value("socket")));
if (socketDir !== expected.runtimeDir)
  problems.push(`socket must be in ${expected.runtimeDir} (systemd RuntimeDirectory), got ${JSON.stringify(value("socket"))}`);
same("stateDir", expected.stateDir);
same("runAsUser", expected.runAsUser);
same("workspaceRoot", expected.workspaceRoot);
same("wrapper", expected.wrapper);
same("harnessWrapper", expected.harnessWrapper);
// A harness path must be the one harness-wrapper reports for it, or the
// runner lists that harness as an error. An absent entry or path is fine:
// the harness is then not offered, or offered without a path.
const harnesses = config.harnesses && typeof config.harnesses === "object" ? config.harnesses : {};
for (const id of ["codex", "goose", "pi"]) {
  const path = harnesses[id]?.path;
  if (path !== undefined && path !== expected[id])
    problems.push(`harnesses.${id}.path is ${JSON.stringify(path)}, but harness-wrapper runs ${JSON.stringify(expected[id])}`);
}

if (problems.length) fail(EX_CONFIG, problems);
console.log(`check-config: ${path} agrees with this install`);
