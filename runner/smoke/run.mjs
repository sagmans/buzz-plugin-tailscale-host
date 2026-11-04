#!/usr/bin/env node
// End-to-end smoke run of the built runner (dist/buzz-runner.mjs) against a
// local mock relay and a fake `claude`, with a temporary config and state
// directory. It exercises the plugin HTTP contract, key custody, the live
// listener (NIP-42 AUTH, REQ filters, sender gate, DM wake, catch-up), and a
// full turn in which the fake claude calls the Buzz `send` tool over
// `mcp_message` and the mock relay receives the agent's reply. Nothing here
// talks to a real relay or a real claude.
//
// Usage: node runner/smoke/run.mjs   (after scripts/build-runner.mjs;
//        BUZZ_RUNNER_BUNDLE=<file> tests a bundle built with --out)
// Exit code: 0 when every scenario passes, 1 otherwise.
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1.js";
import { decrypt, getConversationKey } from "nostr-tools/nip44";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { MockRelay } from "./mock-relay.mjs";
import { gooseSmoke } from "./goose.mjs";
import { codexSmoke } from "./codex.mjs";
import { piSmoke } from "./pi.mjs";
import { pluginSmoke } from "./plugin.mjs";
import { setupSmoke } from "./setup.mjs";
import { signinSmoke } from "./signin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The bundle under test: runner/dist by default, or one built elsewhere
 * (scripts/build-runner.mjs --out), so a dogfood run needs no checkout build. */
const RUNNER = resolve(process.env.BUZZ_RUNNER_BUNDLE ?? resolve(HERE, "../dist/buzz-runner.mjs"));
const FAKE_CLAUDE = resolve(HERE, "fake-claude.mjs");
const LOGIN = "smoke@example.com";
const LOGIN_HEADER = "Tailscale-User-Login";
const RUN_AS = "buzz-agent";
const WAIT_MS = 15_000;
const POLL_MS = 50;
const BODY_LIMIT = 64 * 1024;
const INSTRUCTIONS_MAX = 20_000;
const EXIT_CONFIG = 78;
const SHUTDOWN_WAIT_MS = 25_000;
/** The runner's activate deadline (ACTIVATE_DEADLINE_MS) plus room for its
 * answer: the late-activate scenario waits it out. */
const LATE_ACTIVATE_WAIT_MS = 120_000;
/** How long a DELETE behind a timed-out activate must stay unanswered. */
const LATE_DELETE_GRACE_MS = 1_000;
const ATTENTION_TOOLS = ["interest_set", "watch_add", "attention_sources"];
/** Buzz memory entry kind (buzz-app buzz-mcp/node.ts). */
const MEMORY_KIND = 30174;
/** Runner limits the scenarios probe (src/constants.ts). */
const AGENT_RECORDS_MAX = 20;
const PROVISION_RATE_MAX = 10;
const MEDIA_TOTAL_MAX_BYTES = 200 * 1024 * 1024;
const FAILURE_MESSAGE = "⚠️ I couldn't finish that. The host logged the details.";
const FUTURE_SKEW_S = 60;
/** The runner's roster timings (src/constants.ts ROSTER_SETTLE_MS,
 * ROSTER_LOAD_TIMEOUT_MS) and its first reconnect delay with jitter. */
const ROSTER_SETTLE_MS = 12_000;
const ROSTER_LOAD_TIMEOUT_MS = 15_000;
const RECONNECT_WAIT_MS = 10_000;
/** Working signals: Desktop typing (buzz-app typing.ts) and observer
 * telemetry (buzz-acp, src/constants.ts). */
const KIND_TYPING = 20002;
const TYPING_PULSE_MS = 3_000;
/** Timer slack for pulse spacing on a loaded machine. */
const TYPING_SLACK_MS = 600;
const KIND_AGENT_OBSERVER = 24200;
const OBSERVER_PLAINTEXT_MAX = 65_535;
const OBSERVER_TICK_MS = 1_000;
/** One tick minus timer slack. */
const OBSERVER_TICK_SLACK_MS = 150;
const OBSERVER_LIVENESS_WAIT_MS = 15_000;
const TELEMETRY_WAIT_MS = 30_000;
/** Must appear only inside encrypted frames (fake-claude TOOLS mode). */
const PLAINTEXT_MARKER = "TELEMETRY-PLAINTEXT-MARKER";
/** The runner's stop sequence: stdin EOF, 5 s, SIGTERM, 5 s, SIGKILL. */
const STOP_SEQUENCE_WAIT_MS = 20_000;
/** The runner's whole-stop budget (SHUTDOWN_DEADLINE_MS); systemd waits 30 s. */
const SHUTDOWN_BUDGET_MS = 20_000;
/** The runner's maxLiveSessions bounds (config.ts). */
const LIVE_SESSIONS_MIN = 1;
const LIVE_SESSIONS_MAX = 32;
/** The live-session cap of the cap runner; small, so three threads reach it. */
const SMOKE_LIVE_CAP = 2;
/** Desktop's local harness list, in its order (buzz-app bundled/index.ts),
 * which the runner offers by default (src/constants.ts). */
const DESKTOP_HARNESSES = ["claude-code", "codex", "goose", "pi"];
/** What fake-claude reports to the readiness and model checks. */
const FAKE_VERSION = "2.1.200";
const FAKE_ACCOUNT = "smoke@example.invalid";
const FAKE_MODEL_IDS = ["opus", "sonnet", "haiku"];
const FAKE_MODEL_LABELS = ["Opus 4.1", "Sonnet 4.5", "Haiku 4.5"];
const FAKE_DEFAULT_MODEL = "sonnet";
const FAKE_DEFAULT_EFFORT = "medium";
/** Desktop's Claude effort choices for a model listing low..max. */
const CLAUDE_EFFORT_IDS = ["low", "medium", "high", "xhigh"];
const CLAUDE_EFFORT_LABELS = ["Low", "Medium", "High", "Extra high"];
/** The wrapper key the runner's own checks run under (src/constants.ts). */
const DISCOVERY_AGENT = "0".repeat(64);

const results = [];
const responses = [];
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  -- ${detail}` : ""}`);
}

async function waitFor(predicate, label, timeout = WAIT_MS) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const value = await predicate();
    if (value) return value;
    await sleep(POLL_MS);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** The scenario still reports a FAIL line when a wait times out, so one
 * broken step does not hide the rest. */
async function step(name, run) {
  try {
    await run();
  } catch (error) {
    check(name, false, error instanceof Error ? error.message : String(error));
  }
}

/** One HTTP call over the runner's Unix socket (fetch cannot use one
 * without undici's Agent, which is not a dependency here). */
function socketRequest(socketPath, method, path, headers, body, timeout = WAIT_MS) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers, timeout }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`request ${method} ${path} timed out`)));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** A private run directory, as systemd's RuntimeDirectory makes it. */
function runDir(parent, name = "run", mode = 0o700) {
  const dir = join(parent, name);
  mkdirSync(dir, { mode });
  chmodSync(dir, mode);
  return dir;
}

/** TCP sockets a process listens on, by lsof; undefined when lsof is absent. */
function tcpListeners(pid) {
  try {
    return execFileSync("lsof", ["-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN", "-Fn"], { encoding: "utf8" }).trim();
  } catch (error) {
    // lsof exits 1 when it finds nothing.
    if (error.status === 1) return "";
    return undefined;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Graceful stop of a harness suite's extra runner, with the checks every
 * harness shares: each harness process `starts()` logged must be gone, and
 * the stop must fit the budget. Survivors are killed so a failed check
 * cannot leave processes behind. One shared copy keeps the suites' finally
 * blocks to one call, which lizard's JavaScript reader also parses. */
async function stopHarnessRunner(prefix, processName, extra, starts) {
  const stopped = Date.now();
  await extra.stop();
  const elapsedMs = Date.now() - stopped;
  const hosts = starts();
  const survivors = hosts.filter((line) => alive(line.pid)).map((line) => line.pid);
  check(`${prefix}: runner stop ends every ${processName}`, hosts.length > 0 && survivors.length === 0, JSON.stringify(survivors));
  check(`${prefix}: runner stop is within the budget`, elapsedMs < SHUTDOWN_BUDGET_MS, `${elapsedMs} ms`);
  for (const pid of survivors) process.kill(pid, "SIGKILL");
}

/** NIP-OA proof: BIP-340 over sha256("nostr:agent-auth:<agent>:"), as
 * Desktop's owner signs it at hosted agent creation. */
function authTag(ownerSecret, agent) {
  const digest = createHash("sha256").update(`nostr:agent-auth:${agent}:`).digest();
  return ["auth", getPublicKey(ownerSecret), "", bytesToHex(schnorr.sign(digest, ownerSecret))];
}

function sign(secret, kind, tags, content = "", createdAt = now()) {
  return finalizeEvent({ kind, tags, content, created_at: createdAt }, secret);
}

const lines = (path) =>
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [{ raw: line }];
          }
        })
    : [];

async function main() {
  if (!existsSync(RUNNER)) throw new Error(`build first: ${RUNNER} is missing`);
  const temp = mkdtempSync(join(tmpdir(), "buzz-runner-smoke-"));
  const stateDir = join(temp, "state");
  const fakeLog = join(temp, "fake-claude.log");
  const sudoLog = join(temp, "sudo-argv.log");
  const runnerLog = join(temp, "runner.log");
  const configPath = join(temp, "config.json");
  const relay = new MockRelay();
  let runner;
  let runnerExit;

  try {
    // --- fixtures ---------------------------------------------------------
    const relayUrl = await relay.start();
    // The same relay under a second allowed name, to test the community check.
    const otherCommunity = relayUrl.replace("127.0.0.1", "localhost");
    const socketPath = join(runDir(temp), "api.sock");
    const ownerSecret = generateSecretKey();
    const owner = getPublicKey(ownerSecret);
    relay.owner = owner;
    const strangerSecret = generateSecretKey();
    const peerSecret = generateSecretKey();
    // An explicitly allowed sender (config allowedSenders), not the owner.
    const senderSecret = generateSecretKey();
    const node = process.execPath;

    // sudo stand-in: checks the argv shape the runner must use, records it,
    // and runs the wrapper as the same user.
    const fakeSudo = join(temp, "fake-sudo");
    writeFileSync(
      fakeSudo,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> '${sudoLog}'`,
        `[ "$1" = "-n" ] && [ "$2" = "-u" ] && [ "$3" = "${RUN_AS}" ] && [ "$4" = "--" ] || { echo "bad sudo argv" >&2; exit 64; }`,
        "shift 4",
        'exec "$@"',
        "",
      ].join("\n"),
    );
    // Wrapper stand-in: drops the agent pubkey and sets Desktop's claude
    // environment, as the host's real wrapper does.
    const fakeWrapper = join(temp, "fake-wrapper");
    writeFileSync(
      fakeWrapper,
      [
        "#!/bin/sh",
        "shift",
        `export FAKE_LOG='${fakeLog}' CLAUDE_CODE_ENTRYPOINT=sdk-ts CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1 DISABLE_AUTOUPDATER=1`,
        `exec '${node}' '${FAKE_CLAUDE}' "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(fakeSudo, 0o755);
    chmodSync(fakeWrapper, 0o755);

    const config = {
      ownerPubkey: owner,
      allowedSenders: [getPublicKey(senderSecret)],
      allowedLogins: [LOGIN],
      relays: [relayUrl, otherCommunity],
      socket: socketPath,
      wrapper: fakeWrapper,
      sudo: fakeSudo,
      runAsUser: RUN_AS,
      workspaceRoot: join(temp, "workspaces"),
      stateDir,
      maxParallelTurns: 2,
      logLevel: "debug",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Channels: a group stream and a one-to-one DM, signed by the relay key.
    const channel = randomUUID();
    const dm = randomUUID();

    // --- activate past its deadline, then DELETE -----------------------------
    // Runs beside the other scenarios on its own runner: it waits out the
    // runner's activate deadline, which alone is longer than the rest of the run.
    const lateActivate = step("activate: a DELETE after the activate deadline stays deleted", async () => {
      const dir = join(temp, "late-sudo");
      mkdirSync(dir, { mode: 0o700 });
      const sudo = join(dir, "fake-sudo");
      writeFileSync(sudo, readFileSync(fakeSudo, "utf8").replace(sudoLog, join(dir, "sudo-argv.log")), { mode: 0o755 });
      const extra = await startExtra("late", 0, { publishTelemetry: false, sudo });
      try {
        const made = await extra.api("POST", "/v1/agents", { name: "Late", community: relayUrl });
        const pk = made.json?.pubkey;
        relay.holdProfiles(pk);
        const late = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Late", community: relayUrl, auth: authTag(ownerSecret, pk) }, LATE_ACTIVATE_WAIT_MS);
        check("activate: a profile write held past the deadline gives 502 to the caller", late.status === 502 && /did not finish within/.test(late.text), late.text);
        let deletedAt;
        const removing = extra.api("DELETE", `/v1/agents/${pk}`, undefined, LATE_ACTIVATE_WAIT_MS).then((reply) => {
          deletedAt = Date.now();
          return reply;
        });
        await sleep(LATE_DELETE_GRACE_MS);
        check("activate: the DELETE waits while the timed-out activate still runs", deletedAt === undefined);
        // The relay now accepts the write, so the old activate would go on
        // to save the record and start the agent if nothing stopped it.
        const releasedAt = Date.now();
        relay.releaseProfiles(pk);
        const removed = await removing;
        check("activate: the DELETE then succeeds", removed.status === 204 && deletedAt >= releasedAt, removed.text);
        // Give work that outlived the DELETE the time to write, so a
        // resurrected record is seen.
        await waitFor(() => relay.published.some((item) => item.event.kind === 0 && item.event.pubkey === pk), "late profile accepted");
        await sleep(LATE_DELETE_GRACE_MS);
        const after = await extra.api("GET", `/v1/agents/${pk}`);
        check("activate: the deleted agent stays deleted", after.status === 404, after.text);
        check("activate: its key file stays deleted", !existsSync(join(temp, "late", "state", "agents", `${pk}.json`)));
        const logged = lines(join(temp, "late", "runner.log"));
        check("activate: the late work is logged once as stopped", logged.filter((line) => line.msg === "activate stopped after its deadline").length === 1);
        check("activate: the late work never starts the agent", !logged.some((line) => line.msg === "agent started"));
      } finally {
        await extra.stop();
      }
    });

    // --- startup validation ------------------------------------------------
    await step("config: missing config exits 78", async () => {
      const code = await runOnce([RUNNER], {});
      check("config: missing config exits 78", code === EXIT_CONFIG, `exit ${code}`);
    });
    await step("config: invalid config exits 78", async () => {
      const bad = join(temp, "bad.json");
      writeFileSync(bad, JSON.stringify({ ...config, listen: "127.0.0.1:8787" }));
      const code = await runOnce([RUNNER, "--config", bad], {});
      check("config: TCP `listen` key is refused (exit 78)", code === EXIT_CONFIG, `exit ${code}`);
      writeFileSync(bad, JSON.stringify({ ...config, allowedSenders: ["not-hex"] }));
      const senders = await runOnce([RUNNER, "--config", bad], {});
      check("config: bad allowedSenders entry exits 78", senders === EXIT_CONFIG, `exit ${senders}`);
      for (const value of [
        [],
        ["claude-code"],
        {},
        { nope: {} },
        { "claude-code": { path: "/usr/bin/claude" } },
        { codex: { path: "relative/codex" } },
        { codex: { path: "/opt/../codex" } },
        { codex: { bin: "/opt/codex" } },
        { codex: "/opt/codex" },
      ]) {
        writeFileSync(bad, JSON.stringify({ ...config, harnesses: value }));
        const code = await runOnce([RUNNER, "--config", bad], {});
        check(`config: harnesses ${JSON.stringify(value)} exits 78`, code === EXIT_CONFIG, `exit ${code}`);
      }
      for (const value of [LIVE_SESSIONS_MIN - 1, LIVE_SESSIONS_MAX + 1, 1.5, "4"]) {
        writeFileSync(bad, JSON.stringify({ ...config, maxLiveSessions: value }));
        const code = await runOnce([RUNNER, "--config", bad], {});
        check(`config: maxLiveSessions ${JSON.stringify(value)} exits 78`, code === EXIT_CONFIG, `exit ${code}`);
      }
    });
    await step("socket: unsafe socket directory refuses start", async () => {
      const bad = join(temp, "bad-socket.json");
      const open = runDir(temp, "open", 0o755);
      writeFileSync(bad, JSON.stringify({ ...config, socket: join(open, "api.sock") }));
      const code = await runOnce([RUNNER, "--config", bad], {});
      check("socket: directory mode 0755 refuses start (exit 78)", code === EXIT_CONFIG, `exit ${code}`);
      writeFileSync(bad, JSON.stringify({ ...config, socket: join(temp, "missing", "api.sock") }));
      const missing = await runOnce([RUNNER, "--config", bad], {});
      check("socket: missing directory refuses start (exit 78)", missing === EXIT_CONFIG, `exit ${missing}`);
      const occupied = runDir(temp, "occupied");
      writeFileSync(join(occupied, "api.sock"), "not a socket");
      writeFileSync(bad, JSON.stringify({ ...config, socket: join(occupied, "api.sock") }));
      const file = await runOnce([RUNNER, "--config", bad], {});
      check("socket: a regular file at the socket path refuses start (exit 78)", file === EXIT_CONFIG, `exit ${file}`);
      check("socket: no state written by a refused start", !existsSync(join(stateDir, "agents")) || readdirSync(join(stateDir, "agents")).length === 0);
    });

    const startRunner = async () => {
      runner = spawn(node, [RUNNER, "--config", configPath], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
      runnerExit = new Promise((resolve) => runner.once("exit", (code, signal) => resolve({ code, signal })));
      const append = (chunk) => writeFileSync(runnerLog, chunk, { flag: "a" });
      runner.stdout.on("data", append);
      runner.stderr.on("data", append);
      await waitFor(async () => (await api("GET", "/v1/health").catch(() => undefined))?.status === 200, "runner health");
    };
    const lastRunnerPid = () => runner.pid;

    /** One HTTP call; every body is kept for the key-leak check. */
    async function api(method, path, { body, login = LOGIN, raw, type = "application/json" } = {}) {
      const headers = {};
      if (login) headers[LOGIN_HEADER] = login;
      if (body !== undefined || raw !== undefined) headers["content-type"] = type;
      const payload = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
      const response = await socketRequest(socketPath, method, path, headers, payload);
      const text = response.text;
      responses.push(text);
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: response.status, json, text };
    }

    await startRunner();
    relay.inject(relay.relaySigned(39000, [["d", channel], ["t", "stream"], ["name", "general"]]));
    relay.inject(relay.relaySigned(39000, [["d", dm], ["t", "dm"]]));

    // --- authorization -----------------------------------------------------
    {
      const none = await api("GET", "/v1/health", { login: "" });
      check("auth: no login header gives 403", none.status === 403 && none.json?.error === "forbidden", none.text);
      const wrong = await api("GET", "/v1/health", { login: "mallory@example.com" });
      check("auth: wrong login gives 403", wrong.status === 403, wrong.text);
      check("auth: missing header and wrong login give the identical 403 body", none.text === wrong.text, `${none.text} vs ${wrong.text}`);
      const socketMode = statSync(socketPath).mode & 0o777;
      check("socket: API socket is mode 0600 in a 0700 directory", socketMode === 0o600 && (statSync(dirname(socketPath)).mode & 0o777) === 0o700, socketMode.toString(8));
      const tcp = tcpListeners(lastRunnerPid());
      check("socket: runner listens on no TCP port", tcp === "", tcp === undefined ? "lsof unavailable" : tcp);
      const hidden = await api("GET", "/v1/nope", { login: "" });
      check("auth: unknown path without login gives 403, not 404", hidden.status === 403, hidden.text);
      const health = await api("GET", "/v1/health");
      check(
        "health: 200 {ok, version, agents}",
        health.status === 200 && health.json?.ok === true && typeof health.json?.version === "string" && health.json?.agents === 0,
        health.text,
      );
    }

    // --- request validation ------------------------------------------------
    {
      const cases = [
        ["missing name", { community: relayUrl }],
        ["unknown field", { name: "A", community: relayUrl, extra: 1 }],
        ["non-https picture", { name: "A", community: relayUrl, picture: "http://x.test/a.png" }],
        ["control char in name", { name: "A\u0007", community: relayUrl }],
      ];
      for (const [label, body] of cases) {
        const reply = await api("POST", "/v1/agents", { body });
        check(`validate: ${label} gives 400`, reply.status === 400 && reply.json?.error && reply.json?.message, reply.text);
      }
      const foreign = await api("POST", "/v1/agents", { body: { name: "A", community: "wss://other.example" } });
      check(
        "validate: community outside allowlist gives 400 community_not_allowed",
        foreign.status === 400 && foreign.json?.error === "community_not_allowed",
        foreign.text,
      );
      const badJson = await api("POST", "/v1/agents", { raw: "{nope" });
      check("validate: malformed JSON gives 400", badJson.status === 400, badJson.text);
      const media = await api("POST", "/v1/agents", { raw: "name=A", type: "text/plain" });
      check("validate: non-JSON content type gives 415", media.status === 415, media.text);
      const big = await api("POST", "/v1/agents", { raw: JSON.stringify({ name: "x".repeat(BODY_LIMIT + 1024) }) });
      check("validate: body over 64 KiB gives 413", big.status === 413, big.text.slice(0, 120));
      const missing = await api("GET", `/v1/agents/${"0".repeat(64)}`);
      check("validate: unknown agent gives 404", missing.status === 404 && missing.json?.error === "not_found", missing.text);
      const method = await api("PATCH", `/v1/agents/${"0".repeat(64)}`);
      check("validate: wrong method gives 405", method.status === 405, method.text);
    }

    // --- provision -----------------------------------------------------------
    const first = await api("POST", "/v1/agents", { body: { name: "Smoke", community: relayUrl, picture: "https://x.test/a.png" } });
    const agent = first.json?.pubkey;
    check("provision: 200 with pubkey and picture", first.status === 200 && /^[0-9a-f]{64}$/.test(agent) && first.json?.picture === "https://x.test/a.png", first.text);
    const again = await api("POST", "/v1/agents", { body: { name: "Smoke", community: relayUrl } });
    check("provision: repeat with same name and community returns same pubkey", again.json?.pubkey === agent, again.text);
    const other = await api("POST", "/v1/agents", { body: { name: "Other", community: relayUrl } });
    check("provision: different name gives a new pubkey", other.json?.pubkey && other.json.pubkey !== agent, other.text);

    const keyFile = join(stateDir, "agents", `${agent}.json`);
    const secretOf = (path) => JSON.parse(readFileSync(path, "utf8")).secretKey;
    const agentSecret = secretOf(keyFile);
    const otherSecret = secretOf(join(stateDir, "agents", `${other.json.pubkey}.json`));
    const mode = (path) => statSync(path).mode & 0o777;
    check("state: key file mode 0600", mode(keyFile) === 0o600, mode(keyFile).toString(8));
    check("state: state dir mode 0700", mode(stateDir) === 0o700, mode(stateDir).toString(8));
    check("state: agents dir mode 0700", mode(join(stateDir, "agents")) === 0o700, mode(join(stateDir, "agents")).toString(8));

    const view = await api("GET", `/v1/agents/${agent}`);
    check(
      "view: 200 {pubkey, name, picture, community, activated:false, config}",
      view.status === 200 && view.json?.name === "Smoke" && view.json?.community === relayUrl && view.json?.activated === false && view.json?.config?.instructions === "",
      view.text,
    );

    // --- activate ------------------------------------------------------------
    const tag = authTag(ownerSecret, agent);
    {
      const forged = ["auth", owner, "", bytesToHex(randomBytes(64))];
      const bad = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: relayUrl, auth: forged } });
      check("activate: bad signature gives 400 invalid_auth", bad.status === 400 && bad.json?.error === "invalid_auth", bad.text);
      const stranger = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: relayUrl, auth: authTag(strangerSecret, agent) } });
      check("activate: tag from another owner gives 400", stranger.status === 400 && stranger.json?.error === "invalid_auth", stranger.text);
      const replay = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: relayUrl, auth: authTag(ownerSecret, other.json.pubkey) } });
      check("activate: owner tag for a different agent gives 400", replay.status === 400 && replay.json?.error === "invalid_auth", replay.text);
      const shape = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: relayUrl, auth: ["auth", owner, "kind=1", tag[3]] } });
      check("activate: conditional tag shape gives 400", shape.status === 400, shape.text);
      const moved = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: otherCommunity, auth: tag } });
      check("activate: different community gives 409", moved.status === 409 && moved.json?.error === "conflict", moved.text);
      check("activate: nothing published before a valid proof", relay.published.length === 0, `${relay.published.length} events`);

      const good = await api("POST", `/v1/agents/${agent}/activate`, {
        body: { name: "Smoke", community: relayUrl, auth: tag, config: { instructions: "Answer in one line." } },
      });
      check("activate: valid owner tag gives 204", good.status === 204, good.text);
    }

    await step("kind 0: published by agent with auth tag", async () => {
      const profile = await waitFor(() => relay.published.find((item) => item.event.kind === 0 && item.event.pubkey === agent), "kind 0");
      const body = JSON.parse(profile.event.content);
      const eventTag = profile.event.tags.find((item) => item[0] === "auth");
      check(
        "kind 0: published by agent, {name, bot:true, picture}, auth tag in event and x-auth-tag",
        body.name === "Smoke" && body.bot === true && body.picture === "https://x.test/a.png" &&
          JSON.stringify(eventTag) === JSON.stringify(tag) && profile.authTag === JSON.stringify(tag),
        JSON.stringify({ body, eventTag, header: profile.authTag }),
      );
    });

    // --- live listener -------------------------------------------------------
    await step("live: NIP-42 AUTH with auth tag", async () => {
      const auth = await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === agent), "AUTH");
      const eventTag = auth.event.tags.find((item) => item[0] === "auth");
      check("live: NIP-42 AUTH ok (relay, challenge, auth tag)", JSON.stringify(eventTag) === JSON.stringify(tag), JSON.stringify(auth.event.tags));
    });
    await step("live: REQ filters", async () => {
      const mentions = await waitFor(() => relay.reqs.find((item) => item.agent === agent && item.subId === "mentions"), "mentions REQ");
      const filter = mentions.filters[0];
      check(
        "live: mentions REQ {kinds: CHAT_KINDS, #p: [agent], since}",
        JSON.stringify(filter.kinds) === JSON.stringify([9, 40003, 40007, 46010]) && filter["#p"]?.[0] === agent && typeof filter.since === "number",
        JSON.stringify(filter),
      );
      const membership = await waitFor(() => relay.reqs.find((item) => item.agent === agent && item.subId === "membership"), "membership REQ");
      check("live: membership REQ {kinds:[39002], #p:[agent]}", membership.filters[0].kinds?.[0] === 39002 && membership.filters[0]["#p"]?.[0] === agent, JSON.stringify(membership.filters));
      const notices = await waitFor(() => relay.reqs.find((item) => item.agent === agent && item.subId === "notices"), "notices REQ");
      check(
        "live: notices REQ {kinds:[44100,44101], #p:[agent], limit:0}, and #t:[system]",
        notices.filters.length === 2 &&
          notices.filters.every((f) => JSON.stringify(f.kinds) === "[44100,44101]" && f["#p"]?.[0] === agent && f.limit === 0) &&
          !("#t" in notices.filters[0]) && JSON.stringify(notices.filters[1]["#t"]) === '["system"]',
        JSON.stringify(notices.filters),
      );
    });

    // The agent joins both channels after it connected. As on the real relay,
    // a roster never reaches the open membership REQ, and the add notice can
    // come before the relay stores the new roster.
    const membershipReqs = () => relay.reqs.filter((item) => item.agent === agent && item.subId === "membership").length;
    const mentionScopes = () => relay.reqs.filter((item) => item.agent === agent && item.subId === "mentions").map((item) => item.filters[0]["#h"] ?? []);
    const scopeIs = (ids) => JSON.stringify(mentionScopes().at(-1)) === JSON.stringify([...ids].sort());
    const loadsBefore = membershipReqs();
    await step("live: a join after connect scopes mentions at the notice", async () => {
      relay.inject(relay.relaySigned(39002, [["d", channel], ["p", owner], ["p", agent], ["p", getPublicKey(strangerSecret)]]));
      await new Promise((done) => setTimeout(done, POLL_MS * 4));
      check("live: a roster alone does not reach the membership REQ", membershipReqs() === loadsBefore && !scopeIs([channel]), JSON.stringify(mentionScopes()));
      relay.notice(agent, channel);
      await waitFor(() => scopeIs([channel]), "mentions REQ scoped to the joined channel");
      // The relay's order: the notice first, the stored roster after it.
      relay.notice(agent, dm, 44100, "dm");
      relay.inject(relay.relaySigned(39002, [["d", dm], ["p", owner], ["p", agent]]));
      await waitFor(() => scopeIs([channel, dm]), "mentions REQ with the DM");
      check("live: notice puts its channel in the mentions REQ #h before any roster load", membershipReqs() === loadsBefore, `${loadsBefore} -> ${membershipReqs()}`);
    });
    await step("live: a forged notice changes nothing", async () => {
      const scopes = mentionScopes().length;
      relay.inject(sign(strangerSecret, 44100, [["p", agent], ["h", randomUUID()], ["t", "stream"]]));
      await waitFor(() => lines(runnerLog).some((line) => line.msg === "event dropped" && line.reason === "bad-notice"), "bad-notice drop");
      check("live: notice not signed by the relay is dropped", mentionScopes().length === scopes && scopeIs([channel, dm]), JSON.stringify(mentionScopes().at(-1)));
    });
    await step("live: DM REQ", async () => {
      // A DM needs its full roster: it comes with the settled roster load.
      const dms = await waitFor(() => relay.reqs.find((item) => item.agent === agent && item.subId === "dms"), "dms REQ", ROSTER_SETTLE_MS + WAIT_MS);
      check("live: settled roster load follows the notices", membershipReqs() === loadsBefore + 1, `${loadsBefore} -> ${membershipReqs()}`);
      check("live: one-to-one DM found from relay roster, dms REQ {kinds:[9], #h:[dm]}", dms.filters[0]["#h"]?.length === 1 && dms.filters[0]["#h"][0] === dm, JSON.stringify(dms.filters));
    });

    await step("live: a leave after connect drops the channel from the scope", async () => {
      const late = randomUUID();
      relay.inject(relay.relaySigned(39000, [["d", late], ["t", "stream"], ["name", "late"]]));
      relay.notice(agent, late);
      relay.inject(relay.relaySigned(39002, [["d", late], ["p", owner], ["p", agent]]));
      await waitFor(() => scopeIs([channel, dm, late]), "mentions REQ with the late channel");
      relay.notice(agent, late, 44101);
      relay.inject(relay.relaySigned(39002, [["d", late], ["p", owner]]));
      await waitFor(() => scopeIs([channel, dm]), "mentions REQ without the left channel");
      check("live: join adds and leave removes a channel in the mentions REQ", scopeIs([channel, dm]), JSON.stringify(mentionScopes().slice(-2)));
    });
    await step("live: a roster load without EOSE ends the socket, and the next one loads", async () => {
      const sessions = () => lines(runnerLog).filter((line) => line.msg === "relay session ended" && JSON.stringify(line.error ?? "").includes("roster load timed out")).length;
      relay.withholdEose(agent, "membership");
      relay.drop(agent);
      await waitFor(() => sessions() === 1, "roster load timeout", ROSTER_LOAD_TIMEOUT_MS + WAIT_MS);
      const after = mentionScopes().length;
      await waitFor(() => mentionScopes().length > after && scopeIs([channel, dm]), "mentions REQ after the reconnect", RECONNECT_WAIT_MS);
      check("live: roster load timeout reconnects and restores the scope", scopeIs([channel, dm]), JSON.stringify(mentionScopes().at(-1)));
    });
    // The agent is granted a channel and then loses it while its socket is
    // down, so the remove notice never reaches it and no roster names it.
    await step("live: a grant whose remove was missed while down ends at the settled load", async () => {
      const gone = randomUUID();
      relay.inject(relay.relaySigned(39000, [["d", gone], ["t", "stream"], ["name", "gone"]]));
      relay.notice(agent, gone);
      await waitFor(() => scopeIs([channel, dm, gone]), "mentions REQ with the granted channel");
      const before = mentionScopes().length;
      relay.drop(agent);
      await waitFor(() => mentionScopes().length > before, "mentions REQ after the reconnect", RECONNECT_WAIT_MS);
      await waitFor(() => scopeIs([channel, dm]), "mentions REQ without the stale grant", ROSTER_SETTLE_MS + WAIT_MS);
      check("live: stale grant leaves the mentions REQ after a reconnect", scopeIs([channel, dm]), JSON.stringify(mentionScopes().slice(-3)));
    });

    const repeat = await api("POST", `/v1/agents/${agent}/activate`, { body: { name: "Smoke", community: relayUrl, auth: tag } });
    check("activate: repeat call gives 204", repeat.status === 204, repeat.text);

    // --- sender gate -----------------------------------------------------------
    const fake = () => lines(fakeLog);
    const runnerLines = () => lines(runnerLog);
    const dropped = (id, reason) => runnerLines().find((line) => line.msg === "event dropped" && line.event === id.slice(0, 12) && line.reason === reason);
    const replyTo = (root) => relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === agent && item.event.tags.some((t) => t[0] === "e" && t[1] === root));
    /** Typing pulses of `pk` answering `trigger`. */
    const typingFor = (pk, trigger) =>
      relay.published.filter((item) => item.event.kind === KIND_TYPING && item.event.pubkey === pk && item.event.tags.some((t) => t[0] === "e" && t[1] === trigger && t[3] === "reply"));
    /** Observer frames of `pk`, decrypted as the owner's Desktop does, with
     * batch envelopes opened. */
    const opened = new Map();
    const frames = (pk) =>
      relay.observed
        .filter((item) => item.ok && item.event.pubkey === pk)
        .flatMap((item) => {
          if (!opened.has(item.event.id)) {
            const frame = JSON.parse(decrypt(item.event.content, getConversationKey(ownerSecret, pk)));
            opened.set(item.event.id, frame.kind === "batch" ? frame.payload.events : [frame]);
          }
          return opened.get(item.event.id);
        });
    const turnOf = (pk, trigger) => frames(pk).find((frame) => frame.kind === "turn_started" && frame.payload.triggeringEventIds?.includes(trigger))?.turnId;

    await step("gate: stranger mention dropped as not-owner", async () => {
      const event = sign(strangerSecret, 9, [["h", channel], ["p", agent]], "hi from a stranger");
      relay.inject(event);
      await waitFor(() => dropped(event.id, "not-owner"), "not-owner drop");
      await sleep(300);
      check("gate: stranger mention dropped as not-owner, no claude started", !fake().some((line) => line.type === "start"), "claude started");
    });
    await step("gate: unaddressed message dropped", async () => {
      const event = sign(ownerSecret, 9, [["h", channel]], "not for the agent");
      relay.pushRaw(event);
      await waitFor(() => dropped(event.id, "not-addressed"), "not-addressed drop");
      check("gate: owner message without p-tag in a group dropped as not-addressed", true);
    });
    await step("gate: bad signature dropped", async () => {
      const event = { ...sign(ownerSecret, 9, [["h", channel], ["p", agent]], "tampered"), content: "changed" };
      relay.pushRaw(event);
      await waitFor(() => runnerLines().some((line) => line.msg === "event dropped" && line.reason === "bad-signature"), "bad-signature drop");
      check("gate: event with a bad signature dropped", true);
    });
    const sessionsFile = join(stateDir, "sessions", `${agent}.json`);
    const cursor = () => (existsSync(sessionsFile) ? JSON.parse(readFileSync(sessionsFile, "utf8")).cursor : undefined);
    await step("gate: unattested event from another hosted agent dropped", async () => {
      const event = sign(Buffer.from(otherSecret, "hex"), 9, [["h", channel], ["p", agent]], "ping from a sibling on this host");
      relay.inject(event);
      await waitFor(() => dropped(event.id, "not-owner"), "unattested sibling drop");
      check("gate: mention by a hosted sibling without an owner tag dropped as not-owner", true);
    });
    await step("gate: an agent never wakes on its own event", async () => {
      const event = sign(Buffer.from(agentSecret, "hex"), 9, [["h", channel], ["p", agent], tag], "talking to myself");
      relay.inject(event);
      await waitFor(() => dropped(event.id, "self"), "self drop");
      check("gate: own attested mention of itself dropped as self", true);
    });
    await step("cursor: dropped events do not move the cursor", async () => {
      const before = cursor();
      const event = sign(strangerSecret, 9, [["h", channel], ["p", agent]], "future stranger", now() + 3600);
      relay.inject(event);
      await waitFor(() => dropped(event.id, "not-owner"), "not-owner drop");
      await sleep(300);
      check("cursor: a dropped (future-dated) event leaves the cursor unchanged", cursor() === before, `${before} -> ${cursor()}`);
    });
    await step("cursor: events older than since are dropped", async () => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "very old", now() - 7 * 3600);
      relay.pushRaw(event);
      await waitFor(() => runnerLines().some((line) => line.reason === "before-since" && line.event === event.id.slice(0, 12)), "before-since drop");
      check("cursor: owner mention older than the subscription's since is dropped", !fake().some((line) => line.type === "start"));
    });
    await step("gate: no content in drop logs", async () => {
      const text = readFileSync(runnerLog, "utf8");
      check("log: dropped event content never logged", !text.includes("hi from a stranger") && !text.includes("not for the agent"), "content found");
    });

    // --- a full turn -------------------------------------------------------------
    const mention = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "ping @Smoke");
    relay.inject(mention);
    await step("turn: owner mention runs a turn and the reply reaches the relay", async () => {
      const reply = await waitFor(() => replyTo(mention.id), "agent reply");
      const start = fake().find((line) => line.type === "start");
      const init = fake().find((line) => line.type === "initialize");
      const turn = fake().find((line) => line.type === "turn");
      const list = fake().find((line) => line.type === "tools/list");
      const hook = await waitFor(() => fake().find((line) => line.type === "hook"), "hook");
      // Logged by the fake after the runner answers, so read after the hook.
      const call = fake().find((line) => line.type === "tools/call");
      check("turn: claude started with --session-id (new session)", start?.sessionIdFlag && !start?.resume, JSON.stringify(start?.argv));
      check(
        "turn: Desktop flags (stream-json io, replay, bypassPermissions, sdk mcp)",
        ["--output-format", "--input-format", "--replay-user-messages", "--verbose"].every((flag) => start.argv.includes(flag)) &&
          start.argv[start.argv.indexOf("--permission-mode") + 1] === "bypassPermissions" &&
          JSON.parse(start.mcpConfig).mcpServers.buzz.type === "sdk",
        JSON.stringify(start?.argv),
      );
      check(
        "turn: initialize carries appendSystemPrompt (identity, base, instructions, session model) and final hook",
        init?.identity?.[0] === "Smoke" && init?.identity?.[1] === agent && init.hasBase && init.hasInstructions && init.hasSessionModel && init.finalHook &&
          init.sdkMcpServers?.includes("buzz") && init.workspace === `${config.workspaceRoot}/${agent}`,
        JSON.stringify(init),
      );
      check("turn: user message is turnPrompt with the buzz event", turn?.hasBuzzEvent, JSON.stringify(turn));
      check(
        "turn: tools/list served in-process, all alwaysLoad, no attention tools",
        list?.count > 0 && list.alwaysLoad && list.names.includes("send") && !ATTENTION_TOOLS.some((name) => list.names.includes(name)),
        JSON.stringify(list),
      );
      check("turn: tools/call send answered in-process without error", call && !call.isError, JSON.stringify(call));
      check("turn: final hook answered {continue:false}", hook?.response?.continue === false, JSON.stringify(hook));
      check(
        "turn: reply kind 9 signed by agent, h=channel, e=root, content from claude",
        reply.event.content === "pong from fake claude" && reply.event.tags.some((t) => t[0] === "h" && t[1] === channel),
        JSON.stringify(reply.event.tags),
      );
      check(
        "attest: kind 9 carries the owner auth tag (attestEvents default true) and x-auth-tag",
        JSON.stringify(reply.event.tags.find((t) => t[0] === "auth")) === JSON.stringify(tag) && reply.authTag === JSON.stringify(tag),
        JSON.stringify({ tags: reply.event.tags, header: reply.authTag }),
      );
      const pulse = (await waitFor(() => typingFor(agent, mention.id)[0], "typing pulse")).event;
      check(
        "typing: kind 20002 by the agent, empty content, h + e reply only (root omitted when it is the trigger), owner auth tag, ms",
        pulse.content === "" &&
          JSON.stringify(pulse.tags.filter((t) => t[0] === "h" || t[0] === "e")) === JSON.stringify([["h", channel], ["e", mention.id, "", "reply"]]) &&
          JSON.stringify(pulse.tags.find((t) => t[0] === "auth")) === JSON.stringify(tag) &&
          pulse.tags.some((t) => t[0] === "ms"),
        JSON.stringify(pulse.tags),
      );
      check("spawn: child env has no key and no runner variables", !JSON.stringify(start.env).includes(agentSecret) && !Object.keys(start.env).some((key) => key.startsWith("BUZZ")), Object.keys(start.env).join(","));
    });

    await step("turn: follow-up in thread reuses the process with thread context", async () => {
      const startsBefore = fake().filter((line) => line.type === "start").length;
      const queriesBefore = relay.queries.length;
      const follow = sign(ownerSecret, 9, [["h", channel], ["p", agent], ["e", mention.id, "", "reply"]], "and again", now() + 1);
      relay.inject(follow);
      await waitFor(() => relay.published.filter((item) => item.event.pubkey === agent && item.event.kind === 9 && item.event.tags.some((t) => t[1] === mention.id)).length >= 2, "second reply");
      const contextRead = relay.queries.slice(queriesBefore).some((query) => query.filters.some((filter) => filter["#e"]?.includes(mention.id)));
      check("turn: thread follow-up reuses the live claude process", fake().filter((line) => line.type === "start").length === startsBefore);
      const pulse = await waitFor(() => typingFor(agent, follow.id)[0], "thread typing");
      check(
        "typing: thread reply carries e root and e reply",
        JSON.stringify(pulse.event.tags.filter((t) => t[0] === "e")) === JSON.stringify([["e", mention.id, "", "root"], ["e", follow.id, "", "reply"]]),
        JSON.stringify(pulse.event.tags),
      );
      check("turn: thread context read with #e root, as the agent (NIP-98 + x-auth-tag)", contextRead && relay.queries.at(-1).author === agent && relay.queries.at(-1).authTag === JSON.stringify(tag));
    });

    await step("telemetry: a hosted turn reaches the owner as encrypted observer frames", async () => {
      const tools = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "TOOLS please");
      relay.inject(tools);
      await waitFor(() => replyTo(tools.id), "tools reply");
      const turnId = await waitFor(() => turnOf(agent, tools.id), "turn_started", TELEMETRY_WAIT_MS);
      const mine = () => frames(agent).filter((frame) => frame.turnId === turnId);
      await waitFor(() => mine().some((frame) => frame.kind === "turn_completed"), "turn_completed", TELEMETRY_WAIT_MS);
      const all = mine();
      const ours = relay.observed.filter((item) => item.event.pubkey === agent);
      const reads = (type) =>
        all.filter((frame) => frame.kind === "acp_read" && frame.payload.method === "session/update" && frame.payload.params?.update?.sessionUpdate === type);
      const update = (type, id) => reads(type).map((frame) => frame.payload.params.update).find((item) => id === undefined || item.toolCallId === id);
      const writes = (method) => all.filter((frame) => frame.kind === "acp_write" && frame.payload.method === method).map((frame) => frame.payload);

      check(
        "telemetry: kind 24200 accepted by the relay rules, tags exactly p/agent/frame, fresh created_at",
        ours.length > 0 &&
          ours.every(
            (item) =>
              item.ok &&
              item.event.kind === KIND_AGENT_OBSERVER &&
              JSON.stringify(item.event.tags) === JSON.stringify([["p", owner], ["agent", agent], ["frame", "telemetry"]]) &&
              Math.abs(item.event.created_at - item.at / 1000) <= 5,
          ),
        JSON.stringify(ours.filter((item) => !item.ok).map((item) => item.reason)),
      );
      const gaps = ours.slice(1).map((item, index) => item.at - ours[index].at);
      check("telemetry: at most one frame per second per agent", gaps.every((gap) => gap >= OBSERVER_TICK_MS - OBSERVER_TICK_SLACK_MS), JSON.stringify(gaps.filter((gap) => gap < OBSERVER_TICK_MS - OBSERVER_TICK_SLACK_MS)));
      check(
        "telemetry: no plaintext in frame contents or the runner log",
        !ours.some((item) => item.event.content.includes(PLAINTEXT_MARKER)) && !readFileSync(runnerLog, "utf8").includes(PLAINTEXT_MARKER) &&
          all.some((frame) => JSON.stringify(frame).includes(PLAINTEXT_MARKER)),
      );
      const started = all.find((frame) => frame.kind === "turn_started");
      check(
        "telemetry: turn_started {source:channel, triggeringEventIds:[trigger], threadRootEventId}, channelId, startedAt, sessionId null, agentIndex 0",
        started.channelId === channel && started.sessionId === null && typeof started.startedAt === "string" && started.agentIndex === 0 &&
          started.payload.source === "channel" && JSON.stringify(started.payload.triggeringEventIds) === JSON.stringify([tools.id]) &&
          started.payload.threadRootEventId === tools.id && typeof started.seq === "number" && !Number.isNaN(Date.parse(started.timestamp)),
        JSON.stringify(started),
      );
      const resolved = all.find((frame) => frame.kind === "session_resolved");
      check("telemetry: session_resolved names the new claude session", resolved?.payload.isNewSession === true && typeof resolved.payload.sessionId === "string", JSON.stringify(resolved?.payload));
      const created = writes("session/new")[0];
      check("telemetry: acp_write session/new carries the system prompt", created?.params?._meta?.systemPrompt?.append?.includes("<base>"), JSON.stringify(created?.params?._meta)?.slice(0, 200));
      const prompt = writes("session/prompt")[0];
      check(
        "telemetry: acp_write session/prompt carries the turn prompt (buzz-event framing)",
        prompt?.jsonrpc === "2.0" && prompt.params.sessionId === resolved?.payload.sessionId && prompt.params.prompt[0].type === "text" &&
          prompt.params.prompt[0].text.includes("<buzz-event") && prompt.params.prompt[0].text.includes("TOOLS please"),
        JSON.stringify(prompt?.params?.prompt?.[0])?.slice(0, 200),
      );
      check("telemetry: thinking becomes agent_thought_chunk", update("agent_thought_chunk")?.content?.text?.startsWith("Planning the work."));
      const message = update("agent_message_chunk");
      check(
        "telemetry: text chunks of one message coalesce into one agent_message_chunk with messageId",
        reads("agent_message_chunk").length === 1 && message.content.text === "Reading the file. Then running a command." && message.messageId === "msg_fake_tools",
        JSON.stringify(reads("agent_message_chunk").map((frame) => frame.payload.params.update)),
      );
      const read = update("tool_call", "toolu_read");
      check(
        "telemetry: Read tool_call as claude-agent-acp (title, kind read, locations, pending, rawInput)",
        read?.title === "Read /etc/hosts (2 - 4)" && read.kind === "read" && read.status === "pending" && read.name === "Read" &&
          JSON.stringify(read.locations) === JSON.stringify([{ path: "/etc/hosts", line: 2 }]) && read.rawInput.file_path === "/etc/hosts",
        JSON.stringify(read),
      );
      const readDone = update("tool_call_update", "toolu_read");
      check(
        "telemetry: Read result is tool_call_update completed with text content",
        readDone?.status === "completed" && readDone.content?.[0]?.type === "content" && readDone.content[0].content.text.startsWith("line two"),
        JSON.stringify(readDone),
      );
      const bash = update("tool_call", "toolu_bash");
      const bashDone = update("tool_call_update", "toolu_bash");
      const bashFrame = all.find((frame) => frame.payload?.params?.update?.toolCallId === "toolu_bash" && frame.payload.params.update.sessionUpdate === "tool_call_update");
      check("telemetry: Bash tool_call title is the command, kind execute", bash?.title === "ls -la" && bash.kind === "execute", JSON.stringify(bash));
      check(
        "telemetry: failed oversized result is elided as buzz-acp does and fits the frame cap",
        bashDone?.status === "failed" && /…\[elided \d+ bytes\]…/.test(bashDone.content?.[0]?.content?.text ?? "") &&
          Buffer.byteLength(JSON.stringify(bashFrame)) <= OBSERVER_PLAINTEXT_MAX,
        `${bashDone?.status} ${Buffer.byteLength(JSON.stringify(bashFrame ?? {}))}`,
      );
      const plan = update("plan");
      check(
        "telemetry: TodoWrite is a plan, not a tool call",
        JSON.stringify(plan?.entries) === JSON.stringify([{ content: "Check hosts", status: "in_progress", priority: "medium" }]) &&
          !update("tool_call", "toolu_todo") && !update("tool_call_update", "toolu_todo"),
        JSON.stringify(plan),
      );
      const edit = update("tool_call", "toolu_edit");
      check(
        "telemetry: Edit tool_call carries the diff; its result adds no content",
        JSON.stringify(edit?.content) === JSON.stringify([{ type: "diff", path: "/tmp/fake.txt", oldText: "old", newText: "new" }]) &&
          edit.title === "Edit /tmp/fake.txt" && update("tool_call_update", "toolu_edit")?.status === "completed" && !update("tool_call_update", "toolu_edit").content,
        JSON.stringify(edit),
      );
      const answer = all.find((frame) => frame.kind === "acp_read" && frame.payload.id === prompt?.id && !frame.payload.method);
      check("telemetry: the prompt is answered with stopReason end_turn", answer?.payload.result?.stopReason === "end_turn", JSON.stringify(answer?.payload));
      const completed = all.find((frame) => frame.kind === "turn_completed");
      check(
        "telemetry: turn_completed {} without startedAt, last, seq increasing",
        JSON.stringify(completed.payload) === "{}" && completed.startedAt === undefined && completed.sessionId === null && all.at(-1) === completed &&
          all.every((frame, index) => index === 0 || frame.seq > all[index - 1].seq),
        JSON.stringify(completed),
      );
      check("telemetry: no turn_error on success", !all.some((frame) => frame.kind === "turn_error"));
    });

    await step("memory: mem_set and mem_get work without the auth tag on events", async () => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "MEMORY check");
      relay.inject(event);
      await waitFor(() => replyTo(event.id), "memory reply");
      const memory = fake().find((line) => line.type === "memory");
      const stored = relay.published.filter((item) => item.event.kind === MEMORY_KIND && item.event.pubkey === agent).at(-1);
      check("memory: mem_set saved", memory && !memory.set.isError && /^saved/.test(memory.set.reply ?? ""), JSON.stringify(memory?.set));
      check("memory: mem_get reads the text back (owner-key encryption round trip)", memory && !memory.get.isError && memory.get.reply?.endsWith(memory.expected), JSON.stringify(memory?.get));
      check(
        "memory: stored event is encrypted, p=owner, no auth tag, x-auth-tag header",
        stored && !stored.event.content.includes(memory?.expected ?? "") && stored.event.tags.some((t) => t[0] === "p" && t[1] === owner) &&
          !stored.event.tags.some((t) => t[0] === "auth") && stored.authTag === JSON.stringify(tag),
        JSON.stringify(stored?.event.tags),
      );
    });

    const accepted = (id, sender) => runnerLines().find((line) => line.msg === "event accepted" && line.event === id.slice(0, 12) && line.sender === sender);
    await step("gate: attested desktop agent wakes the agent (acceptAttested default)", async () => {
      const peer = getPublicKey(peerSecret);
      const event = sign(peerSecret, 9, [["h", channel], ["p", agent], authTag(ownerSecret, peer)], "from a desktop agent");
      relay.inject(event);
      await waitFor(() => replyTo(event.id), "reply to attested peer");
      check("gate: mention from an owner-attested agent on another host runs a turn", !!accepted(event.id, "attested"));
    });
    await step("gate: attested sibling on this runner wakes the agent", async () => {
      const event = sign(Buffer.from(otherSecret, "hex"), 9, [["h", channel], ["p", agent], authTag(ownerSecret, other.json.pubkey)], "from a sibling with a tag");
      relay.inject(event);
      await waitFor(() => replyTo(event.id), "reply to attested sibling");
      check("gate: mention from an owner-attested sibling on this runner runs a turn", !!accepted(event.id, "attested"));
    });
    await step("gate: forged and misbound owner tags rejected", async () => {
      const peer = getPublicKey(peerSecret);
      const forged = sign(peerSecret, 9, [["h", channel], ["p", agent], ["auth", owner, "", bytesToHex(randomBytes(64))]], "forged tag");
      // A real owner tag, but for another agent: the signature binds the target.
      const misbound = sign(peerSecret, 9, [["h", channel], ["p", agent], authTag(ownerSecret, agent)], "borrowed tag");
      const stranger = sign(peerSecret, 9, [["h", channel], ["p", agent], authTag(strangerSecret, peer)], "other owner");
      for (const event of [forged, misbound, stranger]) relay.inject(event);
      await waitFor(() => [forged, misbound, stranger].every((event) => dropped(event.id, "not-owner")), "forged drops");
      await sleep(300);
      check("gate: forged owner tag (bad signature) dropped as not-owner, no reply", !replyTo(forged.id));
      check("gate: owner tag bound to another agent dropped as not-owner, no reply", !replyTo(misbound.id));
      check("gate: tag from a different owner dropped as not-owner, no reply", !replyTo(stranger.id));
      check("gate: no turn started for any of them", ![forged, misbound, stranger].some((event) => accepted(event.id, "attested")), String(peer).slice(0, 8));
    });
    await step("gate: allowedSenders entry wakes the agent", async () => {
      const event = sign(senderSecret, 9, [["h", channel], ["p", agent]], "from an allowed sender");
      relay.inject(event);
      await waitFor(() => replyTo(event.id), "reply to allowed sender");
      check("gate: mention from a pubkey in allowedSenders runs a turn", true);
    });

    // --- reply-wake: the owner's untagged thread replies (config replyWake) ----
    const acceptedVia = (id, via) => runnerLines().find((line) => line.msg === "event accepted" && line.event === id.slice(0, 12) && line.via === via);
    await step("reply-wake: owner replies REQ scoped to the agent's channels", async () => {
      const replies = await waitFor(() => relay.reqs.findLast((item) => item.agent === agent && item.subId === "replies"), "replies REQ");
      const filter = replies.filters[0];
      check(
        "reply-wake: replies REQ {kinds:[9], authors:[owner], #h: channels, since}",
        JSON.stringify(filter.kinds) === JSON.stringify([9]) &&
          JSON.stringify(filter.authors) === JSON.stringify([owner]) &&
          filter["#h"]?.includes(channel) &&
          typeof filter.since === "number",
        JSON.stringify(filter),
      );
    });
    const wakeRoot = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "reply-wake root");
    relay.inject(wakeRoot);
    const rootReply = await waitFor(() => replyTo(wakeRoot.id), "reply to reply-wake root");
    // Thread replies land flat under the root, so count them instead of matching the trigger.
    const threadReplies = () =>
      relay.published.filter((item) => item.event.pubkey === agent && item.event.kind === 9 && item.event.tags.some((t) => t[0] === "e" && t[1] === wakeRoot.id)).length;
    const inThread = (secret, extra, content, at) =>
      sign(secret, 9, [["h", channel], ["e", wakeRoot.id, "", "root"], ...extra], content, at);
    await step("reply-wake: untagged owner reply wakes the thread's last agent", async () => {
      const before = threadReplies();
      const event = inThread(ownerSecret, [["e", wakeRoot.id, "", "reply"]], "untagged follow-up", now() + 1);
      relay.inject(event);
      await waitFor(() => acceptedVia(event.id, "reply (last agent)"), "last-agent accept");
      await waitFor(() => threadReplies() > before, "reply to untagged follow-up");
      check("reply-wake: untagged owner reply in the agent's thread runs a turn (last agent)", true);
    });
    const peerNote = inThread(peerSecret, [["e", wakeRoot.id, "", "reply"], authTag(ownerSecret, getPublicKey(peerSecret))], "desktop agent note", now() + 2);
    relay.inject(peerNote);
    await step("reply-wake: another owner agent spoke last, so this agent stays asleep", async () => {
      const event = inThread(ownerSecret, [["e", wakeRoot.id, "", "reply"]], "for the desktop agent", now() + 3);
      relay.inject(event);
      await waitFor(() => dropped(event.id, "not-addressed"), "last-agent-other drop");
      check("reply-wake: untagged owner reply after another agent's message dropped as not-addressed", !accepted(event.id, "owner"));
    });
    await step("reply-wake: reply to this agent's message wakes it (reply rule)", async () => {
      const before = threadReplies();
      const event = inThread(ownerSecret, [["e", rootReply.event.id, "", "reply"]], "reply to your message", now() + 4);
      relay.inject(event);
      await waitFor(() => acceptedVia(event.id, "reply (reply)"), "reply-rule accept");
      await waitFor(() => threadReplies() > before, "reply to reply-rule message");
      check("reply-wake: untagged owner reply to the agent's message runs a turn (reply)", true);
    });
    await step("reply-wake: reply to another agent's message and untagged non-owner replies do not wake", async () => {
      const toPeer = inThread(ownerSecret, [["e", peerNote.id, "", "reply"]], "reply to the desktop agent", now() + 5);
      const fromStranger = inThread(strangerSecret, [["e", wakeRoot.id, "", "reply"]], "stranger in the thread", now() + 5);
      relay.inject(toPeer);
      relay.inject(fromStranger);
      await waitFor(() => dropped(toPeer.id, "not-addressed"), "reply-to-peer drop");
      await sleep(300);
      check("reply-wake: owner reply to another agent's message dropped as not-addressed", !accepted(toPeer.id, "owner"));
      check("reply-wake: stranger's untagged thread reply never wakes the agent", !runnerLines().some((line) => line.msg === "event accepted" && line.event === fromStranger.id.slice(0, 12)));
    });
    await step("cursor: future-dated admitted event is clamped", async () => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "from the future", now() + 3600);
      relay.inject(event);
      await waitFor(() => replyTo(event.id), "reply to future event");
      await sleep(300);
      const value = cursor();
      check("cursor: admitted event dated +1 h moves the cursor at most now + 60 s", value <= now() + FUTURE_SKEW_S && value >= now() - 5, `cursor ${value}, now ${now()}`);
    });

    await step("dm: owner message in one-to-one DM wakes without mention", async () => {
      const event = sign(ownerSecret, 9, [["h", dm]], "dm without a mention");
      relay.inject(event);
      const reply = await waitFor(
        () => relay.published.find((item) => item.event.pubkey === agent && item.event.kind === 9 && item.event.tags.some((t) => t[0] === "h" && t[1] === dm)),
        "DM reply",
      );
      check("dm: owner DM without p-tag runs a turn and the reply lands in the DM", !!reply);
    });

    await step("steer: message during a busy turn is steered into it", async () => {
      const turnsBefore = fake().filter((line) => line.type === "turn").length;
      const slow = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "SLOW task");
      relay.inject(slow);
      await waitFor(() => fake().filter((line) => line.type === "turn").length > turnsBefore, "slow turn");
      await sleep(500);
      const also = sign(ownerSecret, 9, [["h", channel], ["p", agent], ["e", slow.id, "", "reply"]], "also this", now() + 1);
      relay.inject(also);
      const steer = await waitFor(() => fake().find((line) => line.type === "steer"), "steer");
      check("steer: second message reaches stdin wrapped in steerPrompt", steer.steer === true, JSON.stringify(steer));
      await waitFor(() => replyTo(slow.id), "slow reply");
      const pulses = typingFor(agent, slow.id);
      const gaps = pulses.slice(1).map((item, index) => item.at - pulses[index].at);
      check(
        "typing: one pulse every 3 s while the turn runs",
        pulses.length >= 2 && gaps.every((gap) => Math.abs(gap - TYPING_PULSE_MS) <= TYPING_SLACK_MS),
        JSON.stringify({ count: pulses.length, gaps }),
      );
      check("typing: a second message in the thread shares the running pulse", typingFor(agent, also.id).length === 0);
      await sleep(TYPING_PULSE_MS + TYPING_SLACK_MS);
      const settled = typingFor(agent, slow.id).length;
      await sleep(TYPING_PULSE_MS + TYPING_SLACK_MS);
      check("typing: pulse stops when the turn ends", typingFor(agent, slow.id).length === settled, `${settled} -> ${typingFor(agent, slow.id).length}`);
    });

    await step("interrupt: owner Stop interrupts the running turn", async () => {
      const hang = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "HANG please");
      relay.inject(hang);
      await waitFor(() => fake().some((line) => line.type === "hanging"), "hanging turn");
      const hangTurn = await waitFor(() => turnOf(agent, hang.id), "HANG turn_started", TELEMETRY_WAIT_MS);
      const liveness = await waitFor(
        () => frames(agent).find((frame) => frame.turnId === hangTurn && frame.kind === "turn_liveness"),
        "turn_liveness",
        OBSERVER_LIVENESS_WAIT_MS,
      );
      check(
        "telemetry: a running turn sends turn_liveness with startedAt and session",
        typeof liveness.startedAt === "string" && typeof liveness.sessionId === "string" && liveness.payload.threadRootEventId === hang.id,
        JSON.stringify(liveness),
      );
      const bad = await api("POST", `/v1/agents/${agent}/interrupt`, { body: { channelId: "not-a-uuid", threadRootId: hang.id } });
      check("interrupt: bad channelId gives 400", bad.status === 400, bad.text);
      const stop = await api("POST", `/v1/agents/${agent}/interrupt`, { body: { channelId: channel, threadRootId: hang.id } });
      check("interrupt: 200 {interrupted:true}", stop.status === 200 && stop.json?.interrupted === true, stop.text);
      await waitFor(() => fake().some((line) => line.type === "interrupt"), "interrupt control request");
      check("interrupt: claude got the interrupt control request", true);
      const idle = await api("POST", `/v1/agents/${agent}/interrupt`, { body: { channelId: channel, threadRootId: hang.id } });
      await waitFor(async () => (await api("POST", `/v1/agents/${agent}/interrupt`, { body: { channelId: channel, threadRootId: hang.id } })).json?.interrupted === false, "idle after interrupt");
      check("interrupt: nothing running gives {interrupted:false}", idle.status === 200);
      const cancelled = await waitFor(
        () => frames(agent).find((frame) => frame.turnId === hangTurn && frame.kind === "acp_read" && frame.payload.result?.stopReason),
        "cancelled answer",
        TELEMETRY_WAIT_MS,
      );
      check("telemetry: an interrupted prompt is answered with stopReason cancelled", cancelled.payload.result.stopReason === "cancelled", JSON.stringify(cancelled.payload));
    });

    await step("media: total saved media stays under the budget", async () => {
      const mediaDir = join(stateDir, "media", agent);
      // Two old 100 MiB files (sparse, so the test writes almost nothing).
      const old = [join(mediaDir, "old-1.bin"), join(mediaDir, "old-2.bin")];
      old.forEach((path, index) => {
        writeFileSync(path, "");
        truncateSync(path, 100 * 1024 * 1024);
        const at = new Date(Date.now() - (10 - index) * 60_000);
        utimesSync(path, at, at);
      });
      const blob = randomBytes(4096);
      const name = `${createHash("sha256").update(blob).digest("hex")}.bin`;
      relay.blobs.set(name, blob);
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], `MEDIA ${relayUrl.replace(/^ws/, "http")}/media/${name}`);
      relay.inject(event);
      const got = await waitFor(() => fake().find((line) => line.type === "media"), "media_get result");
      await waitFor(() => replyTo(event.id), "reply after media");
      const left = readdirSync(mediaDir);
      const total = left.reduce((sum, file) => sum + statSync(join(mediaDir, file)).size, 0);
      check("media: media_get saved the new file in-process", !got.isError && left.includes(name), JSON.stringify(got));
      check("media: oldest file evicted, total under 200 MiB", !left.includes("old-1.bin") && left.includes("old-2.bin") && total <= MEDIA_TOTAL_MAX_BYTES, `${left.join(",")} ${total}`);
    });

    await step("output cap: a stdout line over 8 MiB stops claude with a generic failure post", async () => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "FLOOD now");
      relay.inject(event);
      await waitFor(() => runnerLines().some((line) => line.msg === "claude output line over cap; stopping it"), "over-cap log", 30_000);
      const report = await waitFor(() => replyTo(event.id), "failure report", 30_000);
      check("output cap: runner logs the over-cap stop", true);
      check("output cap: child exits (stdout closed)", fake().some((line) => line.type === "stdout-error" || line.type === "exit"));
      check("failure: channel post is the generic message, tagged to the owner", report.event.content === FAILURE_MESSAGE && report.event.tags.some((t) => t[0] === "p" && t[1] === owner), report.event.content);
      check("failure: details are in the runner log", runnerLines().some((line) => line.msg === "turn failed" && line.error));
      const memory = runnerLines().filter((line) => line.msg === "claude output line over cap; stopping it").length;
      check("output cap: one stop per runaway child", memory === 1, String(memory));
      const floodTurn = await waitFor(() => turnOf(agent, event.id), "FLOOD turn_started", TELEMETRY_WAIT_MS);
      const ended = await waitFor(
        () => {
          const turn = frames(agent).filter((frame) => frame.turnId === floodTurn);
          return turn.some((frame) => frame.kind === "turn_completed") && turn;
        },
        "failed turn frames",
        TELEMETRY_WAIT_MS,
      );
      const error = ended.find((frame) => frame.kind === "turn_error");
      check(
        "telemetry: a failed turn sends turn_error {outcome, error} then turn_completed",
        error?.payload.outcome === "error" && typeof error.payload.error === "string" && ended.indexOf(error) < ended.findIndex((frame) => frame.kind === "turn_completed"),
        JSON.stringify(error?.payload),
      );
    });

    // --- profile and config ------------------------------------------------------
    await step("profile: rename republishes kind 0", async () => {
      const before = relay.published.filter((item) => item.event.kind === 0).length;
      const badName = await api("PUT", `/v1/agents/${agent}/profile`, { body: { name: "" } });
      check("profile: empty name gives 400", badName.status === 400, badName.text);
      const renamed = await api("PUT", `/v1/agents/${agent}/profile`, { body: { name: "Renamed" } });
      check("profile: 204", renamed.status === 204, renamed.text);
      const latest = await waitFor(() => relay.published.filter((item) => item.event.kind === 0).length > before && relay.published.filter((item) => item.event.kind === 0).at(-1), "new kind 0");
      const body = JSON.parse(latest.event.content);
      check("profile: new kind 0 with new name and no picture, newer created_at", body.name === "Renamed" && body.picture === undefined && latest.event.created_at > relay.published.filter((item) => item.event.kind === 0).at(-2).event.created_at, latest.event.content);
    });

    await step("config: update and validation", async () => {
      const effort = await api("PUT", `/v1/agents/${agent}/config`, { body: { effort: "turbo" } });
      check("config: bad effort gives 400", effort.status === 400, effort.text);
      const flag = await api("PUT", `/v1/agents/${agent}/config`, { body: { model: "--dangerously-skip-permissions" } });
      check("config: model starting with '-' gives 400", flag.status === 400, flag.text);
      const bracket = await api("PUT", `/v1/agents/${agent}/config`, { body: { model: "claude-opus-4[1m]" } });
      check("config: model alias with brackets accepted", bracket.status === 204, bracket.text);
      const long = await api("PUT", `/v1/agents/${agent}/config`, { body: { instructions: "x".repeat(INSTRUCTIONS_MAX + 1) } });
      check("config: instructions over 20000 gives 400", long.status === 400, long.text);
      const set = await api("PUT", `/v1/agents/${agent}/config`, { body: { instructions: "Be brief.", model: "sonnet", effort: "high" } });
      check("config: 204", set.status === 204, set.text);
      const shown = await api("GET", `/v1/agents/${agent}`);
      check("config: GET shows new config and name", shown.json?.config?.model === "sonnet" && shown.json?.config?.effort === "high" && shown.json?.config?.instructions === "Be brief." && shown.json?.name === "Renamed", shown.text);
      const startsBefore = fake().filter((line) => line.type === "start").length;
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent], ["e", mention.id, "", "reply"]], "with new config", now() + 1);
      relay.inject(event);
      const start = await waitFor(() => fake().filter((line) => line.type === "start")[startsBefore], "restarted claude");
      check(
        "config: idle session restarts with --resume, --model and --effort",
        start.argv.includes("--resume") && start.argv[start.argv.indexOf("--model") + 1] === "sonnet" && start.argv[start.argv.indexOf("--effort") + 1] === "high",
        JSON.stringify(start.argv),
      );
      const init = await waitFor(() => fake().filter((line) => line.type === "initialize").find((line) => line.pid === start.pid), "initialize after restart");
      check("config: new name reaches the system prompt", init.identity?.[0] === "Renamed", JSON.stringify(init.identity));
      await waitFor(() => fake().some((line) => line.type === "hook" && line.pid === start.pid), "reply after config");
    });

    // --- restart: persistence, catch-up, resume ----------------------------------
    await step("restart: SIGTERM stops gracefully, state survives, catch-up and resume work", async () => {
      const sessionsFile = join(stateDir, "sessions", `${agent}.json`);
      const saved = JSON.parse(readFileSync(sessionsFile, "utf8"));
      const threadSession = saved.sessions?.[`${channel}/${mention.id}`]?.id ?? saved.sessions?.[`${channel}/${mention.id}`]?.sessionId;
      // A turn still running at SIGTERM: the stop must end it, not leave it
      // to systemd's SIGKILL.
      const busy = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "HANG over a restart");
      relay.inject(busy);
      const hanging = fake().length;
      const busyPid = (await waitFor(() => fake().slice(hanging).find((line) => line.type === "hanging"), "busy turn before SIGTERM")).pid;
      const pids = [...new Set(fake().filter((line) => line.type === "start").map((line) => line.pid))];
      const logMark = runnerLines().length;
      const stopStarted = Date.now();
      runner.kill("SIGTERM");
      const exit = await Promise.race([runnerExit, sleep(SHUTDOWN_WAIT_MS).then(() => ({ timeout: true }))]);
      const stopMs = Date.now() - stopStarted;
      check("restart: SIGTERM exits 0 within the deadline", exit.code === 0 && stopMs < SHUTDOWN_BUDGET_MS, JSON.stringify({ ...exit, stopMs }));
      check("restart: claude children got stdin EOF on stop", fake().some((line) => line.type === "exit" || line.type === "sigterm"));
      const busyLines = fake().filter((line) => line.pid === busyPid).map((line) => line.type);
      check(
        "restart: busy turn is interrupted, then its claude exits on stdin EOF",
        busyLines.indexOf("interrupt") >= 0 && busyLines.indexOf("exit") > busyLines.indexOf("interrupt"),
        busyLines.join(","),
      );
      const leftover = pids.filter((pid) => alive(pid));
      check("restart: no claude child outlives the runner", leftover.length === 0, leftover.join(","));
      const stopLog = runnerLines().slice(logMark);
      const stoppedAt = stopLog.findIndex((line) => line.msg === "claude children stopped");
      const summary = stopLog[stoppedAt];
      check(
        "restart: one shutdown line counts the children, all exited, with the time",
        summary && stopLog.filter((line) => line.msg === "claude children stopped").length === 1 && summary.children >= 1 && summary.exited === summary.children && summary.alive === 0 && Number.isInteger(summary.elapsedMs),
        JSON.stringify(summary),
      );
      check("restart: runner stopped is logged after the children exited", stopLog.findIndex((line) => line.msg === "runner stopped") > stoppedAt && stoppedAt >= 0);
      check("restart: interrupted turn posts no failure message", !relay.published.some((item) => item.event.kind === 9 && item.event.tags.some((t) => t[0] === "e" && t[1] === busy.id)));
      const missed = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "sent while down");
      relay.inject(missed);
      const resumeStarts = fake().filter((line) => line.type === "start").length;
      await startRunner();
      await waitFor(() => replyTo(missed.id), "catch-up reply");
      check("restart: mention sent while down is caught up from the cursor", true);
      const back = sign(ownerSecret, 9, [["h", channel], ["p", agent], ["e", mention.id, "", "reply"]], "after restart", now() + 1);
      relay.inject(back);
      await waitFor(() => fake().slice().filter((line) => line.type === "start").slice(resumeStarts).some((line) => line.resume), "resumed claude");
      const resumed = fake().filter((line) => line.type === "start").slice(resumeStarts).find((line) => line.resume);
      check("restart: thread session resumes with --resume <saved id>", resumed.resume && (!threadSession || resumed.resume === threadSession), `${resumed.resume} vs ${threadSession}`);
    });

    // --- stop sequence -------------------------------------------------------------------
    // A child that ignores stdin EOF and SIGTERM stands in for one the runner
    // cannot stop at once; deleting the agent must still end it, in order.
    let stuckPid;
    await step("stop: stuck child set up", async () => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "STUCK forever");
      relay.inject(event);
      const stuck = await waitFor(() => fake().find((line) => line.type === "stuck"), "stuck child");
      stuckPid = stuck.pid;
      check("stop: stuck child is running", alive(stuckPid));
    });

    // --- delete ----------------------------------------------------------------------
    await step("delete: stops agent, removes key, idempotent", async () => {
      const logMark = runnerLines().length;
      const deleteStarted = Date.now();
      const del = await api("DELETE", `/v1/agents/${agent}`);
      const deleteMs = Date.now() - deleteStarted;
      check("delete: 204", del.status === 204, del.text);
      // halt() waits for the agent's claude children before it answers.
      check("delete: answers only after the stuck child is gone, within the bound", stuckPid !== undefined && !alive(stuckPid) && deleteMs <= STOP_SEQUENCE_WAIT_MS, `${deleteMs} ms`);
      const stopped = runnerLines().slice(logMark).find((line) => line.msg === "claude children stopped");
      check("delete: per-agent stop line names the agent, all exited", stopped?.agent === agent.slice(0, 12) && stopped.alive === 0 && stopped.exited >= 1, JSON.stringify(stopped));
      check("delete: key file removed", !existsSync(keyFile));
      check("delete: sessions file removed", !existsSync(join(stateDir, "sessions", `${agent}.json`)));
      const gone = await api("GET", `/v1/agents/${agent}`);
      check("delete: GET after delete gives 404", gone.status === 404, gone.text);
      const twice = await api("DELETE", `/v1/agents/${agent}`);
      check("delete: repeat delete gives 204", twice.status === 204, twice.text);
      await waitFor(() => ![...relay.connections].some((connection) => connection.authed === agent), "agent socket closed");
      check("delete: agent relay connection closed", true);
      const late = sign(ownerSecret, 9, [["h", channel], ["p", agent]], "after delete");
      const before = relay.published.length;
      relay.inject(late);
      await sleep(1000);
      check("delete: mention after delete runs no turn", relay.published.length === before);
      const unactivated = await api("DELETE", `/v1/agents/${other.json.pubkey}`);
      check("delete: never-activated agent gives 204", unactivated.status === 204, unactivated.text);
      const health = await api("GET", "/v1/health");
      check("health: agent count back to 0", health.json?.agents === 0, health.text);
    });

    await step("stop: stdin EOF, then SIGTERM, then SIGKILL, within the bound", async () => {
      if (!stuckPid) throw new Error("no stuck child");
      const started = Date.now();
      await waitFor(() => !alive(stuckPid), "stuck child gone", STOP_SEQUENCE_WAIT_MS);
      const mine = fake().filter((line) => line.pid === stuckPid).map((line) => line.type);
      check("stop: child saw stdin EOF first, then SIGTERM, then was killed", mine.indexOf("eof-ignored") >= 0 && mine.indexOf("sigterm-ignored") > mine.indexOf("eof-ignored"), mine.join(","));
      check("stop: stuck child ended within the 20 s bound", Date.now() - started <= STOP_SEQUENCE_WAIT_MS);
    });

    await step("socket: second runner on a live socket refuses start", async () => {
      const code = await runOnce([RUNNER, "--config", configPath], {});
      check("socket: a socket still answering is not replaced (exit 78)", code === EXIT_CONFIG, `exit ${code}`);
      const health = await api("GET", "/v1/health");
      check("socket: first runner still serves after the refused start", health.status === 200, health.text);
    });
    await step("socket: stale socket after a crash is replaced", async () => {
      runner.kill("SIGKILL");
      await runnerExit;
      check("socket: SIGKILL leaves the socket file behind", existsSync(socketPath));
      await startRunner();
      const health = await api("GET", "/v1/health");
      check("socket: restart after a crash serves again on a fresh 0600 socket", health.status === 200 && (statSync(socketPath).mode & 0o777) === 0o600, health.text);
    });

    await step("limits: provision rate limit", async () => {
      const extra = await startExtra("rate", 0);
      try {
        const codes = [];
        for (let index = 0; index < PROVISION_RATE_MAX; index++)
          codes.push((await extra.api("POST", "/v1/agents", { name: `Rate ${index}`, community: relayUrl })).status);
        const over = await extra.api("POST", "/v1/agents", { name: "Rate over", community: relayUrl });
        const repeat = await extra.api("POST", "/v1/agents", { name: "Rate 0", community: relayUrl });
        check(`limits: ${PROVISION_RATE_MAX} new agents accepted`, codes.every((code) => code === 200), codes.join(","));
        check("limits: next new agent in the window gives 429 rate_limited", over.status === 429 && over.json?.error === "rate_limited", over.text);
        check("limits: an idempotent repeat is not rate limited", repeat.status === 200, repeat.text);
      } finally {
        await extra.stop();
      }
    });
    await step("limits: agent record cap", async () => {
      const extra = await startExtra("cap", AGENT_RECORDS_MAX - 1);
      try {
        const last = await extra.api("POST", "/v1/agents", { name: "Last", community: relayUrl });
        const over = await extra.api("POST", "/v1/agents", { name: "Over", community: relayUrl });
        const repeat = await extra.api("POST", "/v1/agents", { name: "Last", community: relayUrl });
        const health = await extra.api("GET", "/v1/health");
        check(`limits: record ${AGENT_RECORDS_MAX} accepted`, last.status === 200, last.text);
        check(`limits: record ${AGENT_RECORDS_MAX + 1} gives 409 agent_limit`, over.status === 409 && over.json?.error === "agent_limit", over.text);
        check("limits: an idempotent repeat at the cap still works", repeat.status === 200 && repeat.json?.pubkey === last.json?.pubkey, repeat.text);
        check(`limits: health counts ${AGENT_RECORDS_MAX} agents`, health.json?.agents === AGENT_RECORDS_MAX, health.text);
      } finally {
        await extra.stop();
      }
    });

    await step("strict: attestEvents false and acceptAttested false", async () => {
      // Own sudo log, so the main argv check sees only the main agent.
      const dir = join(temp, "strict-sudo");
      mkdirSync(dir, { mode: 0o700 });
      const sudo = join(dir, "fake-sudo");
      writeFileSync(sudo, readFileSync(fakeSudo, "utf8").replace(sudoLog, join(dir, "sudo-argv.log")), { mode: 0o755 });
      const extra = await startExtra("strict", 0, { attestEvents: false, acceptAttested: false, publishTelemetry: false, sudo });
      try {
        const made = await extra.api("POST", "/v1/agents", { name: "Strict", community: relayUrl });
        const sibling = await extra.api("POST", "/v1/agents", { name: "Strict sibling", community: relayUrl });
        const pk = made.json?.pubkey;
        const strictTag = authTag(ownerSecret, pk);
        const on = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Strict", community: relayUrl, auth: strictTag });
        const auth = await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "strict AUTH");
        const strictLines = () => lines(join(temp, "strict", "runner.log"));
        const strictDropped = (id, reason) => strictLines().find((line) => line.msg === "event dropped" && line.event === id.slice(0, 12) && line.reason === reason);
        const strictReply = (id) =>
          relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === pk && item.event.tags.some((t) => t[0] === "e" && t[1] === id));

        const peer = getPublicKey(peerSecret);
        const attested = sign(peerSecret, 9, [["h", channel], ["p", pk], authTag(ownerSecret, peer)], "attested peer, strict host");
        const hostedSecret = Buffer.from(JSON.parse(readFileSync(join(temp, "strict", "state", "agents", `${sibling.json.pubkey}.json`), "utf8")).secretKey, "hex");
        const hosted = sign(hostedSecret, 9, [["h", channel], ["p", pk], authTag(ownerSecret, sibling.json.pubkey)], "attested sibling, strict host");
        relay.inject(attested);
        relay.inject(hosted);
        await waitFor(() => strictDropped(attested.id, "not-owner") && strictDropped(hosted.id, "hosted-agent"), "strict drops");
        const fromOwner = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "owner, strict host");
        relay.inject(fromOwner);
        const reply = await waitFor(() => strictReply(fromOwner.id), "strict reply");
        check("strict: activate 204, NIP-42 AUTH still carries the owner tag", on.status === 204 && JSON.stringify(auth.event.tags.find((t) => t[0] === "auth")) === JSON.stringify(strictTag), on.text);
        check("strict: attested agent on another host dropped as not-owner", !strictReply(attested.id));
        check("strict: attested sibling on this runner dropped as hosted-agent", !strictReply(hosted.id));
        check(
          "strict: owner still wakes; kind 9 has no auth tag but x-auth-tag header",
          !reply.event.tags.some((t) => t[0] === "auth") && reply.authTag === JSON.stringify(strictTag),
          JSON.stringify({ tags: reply.event.tags, header: reply.authTag }),
        );
        const pulse = typingFor(pk, fromOwner.id)[0];
        check("strict: typing still sent, without the auth tag", pulse && !pulse.event.tags.some((t) => t[0] === "auth"), JSON.stringify(pulse?.event.tags));
        await sleep(OBSERVER_TICK_MS * 2);
        check("strict: publishTelemetry false sends no observer frames", !relay.observed.some((item) => item.event.pubkey === pk));
        const profile = relay.published.find((item) => item.event.kind === 0 && item.event.pubkey === pk);
        check("strict: kind 0 still carries the owner tag", JSON.stringify(profile?.event.tags.find((t) => t[0] === "auth")) === JSON.stringify(strictTag));
      } finally {
        await extra.stop();
      }
    });

    // --- live-session cap -------------------------------------------------------------
    await step("cap: maxLiveSessions stops the LRU idle process, resumes it, and makes a turn wait when all are busy", async () => {
      const dir = join(temp, "livecap-sudo");
      mkdirSync(dir, { mode: 0o700 });
      const sudo = join(dir, "fake-sudo");
      writeFileSync(sudo, readFileSync(fakeSudo, "utf8").replace(sudoLog, join(dir, "sudo-argv.log")), { mode: 0o755 });
      const extra = await startExtra("livecap", 0, { maxLiveSessions: SMOKE_LIVE_CAP, maxParallelTurns: SMOKE_LIVE_CAP + 1, publishTelemetry: false, sudo });
      try {
        const made = await extra.api("POST", "/v1/agents", { name: "Capped", community: relayUrl });
        const pk = made.json?.pubkey;
        const on = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Capped", community: relayUrl, auth: authTag(ownerSecret, pk) });
        check("cap: agent activated", on.status === 204, on.text);
        await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "cap AUTH");
        const capLines = () => lines(join(temp, "livecap", "runner.log"));
        const reply = (root) => relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === pk && item.event.tags.some((t) => t[0] === "e" && t[1] === root));
        // This agent's claude processes, told apart by the pubkey in their prompt.
        const mine = () => {
          const ours = new Set(fake().filter((line) => line.type === "initialize" && line.identity?.[1] === pk).map((line) => line.pid));
          return fake().filter((line) => ours.has(line.pid));
        };
        const pidOf = (session) => fake().find((line) => line.type === "start" && line.session === session)?.pid;
        const saved = (root) => JSON.parse(readFileSync(join(temp, "livecap", "state", "sessions", `${pk}.json`), "utf8")).sessions?.[`${channel}/${root}`]?.id;
        // A reply inside a thread names its root, so in-thread turns are told
        // apart by the runner's send tool calls for that conversation.
        const sends = (root) => capLines().filter((line) => line.msg === "tool call" && line.tool === "send" && line.conversation === `${channel}/${root}`);
        const liveCount = () => new Set(mine().filter((line) => line.type === "initialize").map((line) => line.pid).filter((pid) => alive(pid))).size;
        const thread = async (text, root) => {
          const event = sign(ownerSecret, 9, [["h", channel], ["p", pk], ...(root ? [["e", root, "", "reply"]] : [])], text, now() + 1);
          relay.inject(event);
          return event;
        };

        const first = await thread("cap thread A");
        await waitFor(() => reply(first.id), "cap reply A");
        const second = await thread("cap thread B");
        await waitFor(() => reply(second.id), "cap reply B");
        const firstPid = pidOf(saved(first.id));
        check("cap: two threads hold two live processes", liveCount() === SMOKE_LIVE_CAP && alive(firstPid), `${liveCount()}`);
        const third = await thread("cap thread C");
        await waitFor(() => reply(third.id), "cap reply C");
        const evicted = capLines().find((line) => line.msg === "idle session stopped for the live-session cap");
        check("cap: a third thread stops the least recently used idle process (A)", evicted?.conversation === `${channel}/${first.id}` && evicted.cap === SMOKE_LIVE_CAP, JSON.stringify(evicted));
        await waitFor(() => !alive(firstPid), "evicted claude exits");
        check("cap: the evicted claude got stdin EOF and exited", mine().some((line) => line.pid === firstPid && line.type === "exit"));
        check("cap: live processes never exceed the cap", liveCount() <= SMOKE_LIVE_CAP, `${liveCount()}`);

        const firstSession = saved(first.id);
        const startsBefore = fake().filter((line) => line.type === "start").length;
        const sentBefore = sends(first.id).length;
        await thread("cap back to A", first.id);
        await waitFor(() => sends(first.id).length > sentBefore, "cap reply after eviction");
        const resumed = fake().filter((line) => line.type === "start").slice(startsBefore).find((line) => line.resume === firstSession);
        check("cap: the next message in the evicted thread resumes it with --resume <saved id>", Boolean(firstSession) && Boolean(resumed), firstSession);
        check("cap: still at most the cap after the resume", liveCount() <= SMOKE_LIVE_CAP, `${liveCount()}`);

        // Now the live pair is C and A. Both busy: a new thread must wait.
        const turnsBefore = mine().filter((line) => line.type === "turn").length;
        const slowBefore = { a: sends(first.id).length, c: sends(third.id).length };
        await thread("SLOW cap A", first.id);
        await thread("SLOW cap C", third.id);
        await waitFor(() => mine().filter((line) => line.type === "turn").length >= turnsBefore + 2, "both cap turns busy");
        const waiting = await thread("cap thread D");
        const waited = await waitFor(() => capLines().find((line) => line.msg === "live-session cap reached and every session is busy; turn waits" && line.conversation === `${channel}/${waiting.id}`), "cap D waits");
        check("cap: with every process busy the new turn waits (no rejection)", waited.live === SMOKE_LIVE_CAP && !reply(waiting.id), JSON.stringify(waited));
        await waitFor(() => reply(waiting.id), "cap reply D after a slot frees");
        const freed = capLines().find((line) => line.msg === "session slot free; turn continues" && line.conversation === `${channel}/${waiting.id}`);
        await waitFor(() => sends(first.id).length > slowBefore.a && sends(third.id).length > slowBefore.c, "cap slow replies");
        const firstFree = Math.min(Date.parse(sends(first.id)[slowBefore.a].ts), Date.parse(sends(third.id)[slowBefore.c].ts));
        check("cap: the waiting turn runs only after a busy turn ends", freed?.waitedMs > 0 && reply(waiting.id).at >= firstFree, JSON.stringify(freed));
        check("cap: live processes never exceed the cap", liveCount() <= SMOKE_LIVE_CAP, `${liveCount()}`);
      } finally {
        await extra.stop();
      }
    });

    // --- harnesses: Desktop's harness, model and effort pickers -----------------------
    await step("harnesses: list, readiness, models, validation and channel scope", async () => {
      const dir = join(temp, "harness-sudo");
      mkdirSync(dir, { mode: 0o700 });
      const probeSudoLog = join(dir, "sudo-argv.log");
      const sudo = join(dir, "fake-sudo");
      writeFileSync(sudo, readFileSync(fakeSudo, "utf8").replace(sudoLog, probeSudoLog), { mode: 0o755 });
      // Install fixtures: an executable file (Codex), a directory (Pi's
      // node_modules) and a path that does not exist (Goose).
      const installs = join(temp, "harness-installs");
      mkdirSync(join(installs, "pi", "node_modules"), { recursive: true });
      writeFileSync(join(installs, "codex"), "#!/bin/sh\necho must-never-run >&2\nexit 99\n", { mode: 0o755 });
      const harnessConfig = {
        "claude-code": {},
        codex: { path: join(installs, "codex") },
        goose: { path: join(installs, "goose", "goose-acp") },
        pi: { path: join(installs, "pi", "node_modules") },
      };
      const extra = await startExtra("harnesses", 0, { publishTelemetry: false, sudo, harnesses: harnessConfig });
      try {
        const listed = await extra.api("GET", "/v1/harnesses");
        const harnesses = listed.json?.harnesses ?? [];
        check(
          "harnesses: GET lists every Desktop harness, in Desktop's order",
          listed.status === 200 && JSON.stringify(harnesses.map((item) => item.id)) === JSON.stringify(DESKTOP_HARNESSES),
          listed.text,
        );
        const claude = harnesses.find((item) => item.id === "claude-code");
        check(
          "harnesses: Claude Code is supported, installed and ready, with version and account",
          claude?.supported && claude.installed && claude.ready && claude.state === "ready" && claude.version === FAKE_VERSION && claude.account === FAKE_ACCOUNT && claude.title === "Claude",
          JSON.stringify(claude),
        );
        const others = harnesses.filter((item) => item.id !== "claude-code" && item.id !== "pi");
        check(
          "harnesses: Codex and Goose are listed as supported and not ready, never hidden",
          others.length === DESKTOP_HARNESSES.length - 2 &&
            others.every((item) => !item.ready && item.message && item.title && item.supported),
          JSON.stringify(others),
        );
        const byId = Object.fromEntries(harnesses.map((item) => [item.id, item]));
        check(
          "harnesses: Codex installed at its path, without a working harness wrapper, shows not installed with the reason",
          byId.codex?.supported && !byId.codex.installed && byId.codex.state === "missing" && /did not report its path/.test(byId.codex.message ?? ""),
          JSON.stringify(byId.codex),
        );
        // No harness wrapper on this runner (the default path is not there).
        check(
          "harnesses: Pi without a working harness wrapper shows not installed, with the reason",
          byId.pi?.supported && !byId.pi.installed && !byId.pi.ready && byId.pi.state === "missing" && /did not report its path/.test(byId.pi.message ?? ""),
          JSON.stringify(byId.pi),
        );
        check("harnesses: a configured path that is not there shows not installed", byId.goose && !byId.goose.installed && byId.goose.state === "missing", JSON.stringify(byId.goose));
        check("harnesses: a configured install path is never run directly, only through the wrapper", !readFileSync(probeSudoLog, "utf8").includes(join(installs, "codex")) && !lines(join(temp, "harnesses", "runner.log")).some((line) => JSON.stringify(line).includes("must-never-run")));
        check("harnesses: readiness checks ran through sudo and the wrapper", readFileSync(probeSudoLog, "utf8").includes(`${DISCOVERY_AGENT} --version`));

        const startsBefore = fake().filter((line) => line.type === "start").length;
        const models = await extra.api("GET", "/v1/harnesses/claude-code/models");
        const list = models.json?.models ?? [];
        check(
          "harnesses: models drop `default` and carry Desktop's labels",
          models.status === 200 && JSON.stringify(list.map((item) => item.id)) === JSON.stringify(FAKE_MODEL_IDS) && JSON.stringify(list.map((item) => item.label)) === JSON.stringify(FAKE_MODEL_LABELS),
          models.text,
        );
        const opus = list.find((item) => item.id === "opus");
        check(
          "harnesses: Claude efforts use Desktop labels and never offer max",
          JSON.stringify(opus?.efforts.map((item) => item.id)) === JSON.stringify(CLAUDE_EFFORT_IDS) &&
            JSON.stringify(opus?.efforts.map((item) => item.label)) === JSON.stringify(CLAUDE_EFFORT_LABELS) &&
            !list.some((item) => item.efforts.some((level) => level.id === "max")),
          JSON.stringify(opus),
        );
        check("harnesses: a model without effort lists none", list.find((item) => item.id === "haiku")?.efforts.length === 0, models.text);
        check(
          "harnesses: current model and its resting effort come from claude's settings",
          models.json?.current === FAKE_DEFAULT_MODEL && list.find((item) => item.id === FAKE_DEFAULT_MODEL)?.effort === FAKE_DEFAULT_EFFORT,
          models.text,
        );
        const discovery = fake().filter((line) => line.type === "start").slice(startsBefore);
        check("harnesses: model discovery started one claude in discovery mode", discovery.length === 1 && discovery[0].argv.includes("--safe-mode"), JSON.stringify(discovery.map((line) => line.argv)));
        await waitFor(() => fake().some((line) => line.type === "exit" && line.pid === discovery[0]?.pid) || !alive(discovery[0]?.pid), "discovery claude exits");
        check("harnesses: the discovery claude stopped after listing", !alive(discovery[0]?.pid));
        const again = await extra.api("GET", "/v1/harnesses/claude-code/models");
        check("harnesses: a repeat within the cache starts no claude", again.status === 200 && fake().filter((line) => line.type === "start").length === startsBefore + 1, again.text);
        for (const id of DESKTOP_HARNESSES.slice(1)) {
          const refused = await extra.api("GET", `/v1/harnesses/${id}/models`);
          check(`harnesses: ${id} models give 409 harness_unavailable`, refused.status === 409 && refused.json?.error === "harness_unavailable", refused.text);
        }
        const unknown = await extra.api("GET", "/v1/harnesses/nope/models");
        check("harnesses: a harness not offered gives 404", unknown.status === 404, unknown.text);

        const made = await extra.api("POST", "/v1/agents", { name: "Shared", community: relayUrl });
        const pk = made.json?.pubkey;
        const auth = authTag(ownerSecret, pk);
        const goose = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Shared", community: relayUrl, auth, config: { instructions: "", harness: "goose" } });
        check("harnesses: activate on a not-ready harness gives 409 harness_unavailable", goose.status === 409 && goose.json?.error === "harness_unavailable", goose.text);
        const piOff = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Shared", community: relayUrl, auth, config: { instructions: "", harness: "pi" } });
        check("harnesses: activate on Pi without its wrapper gives 409 harness_unavailable", piOff.status === 409 && piOff.json?.error === "harness_unavailable", piOff.text);
        const max = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Shared", community: relayUrl, auth, config: { instructions: "", harness: "claude-code", effort: "max" } });
        check("harnesses: effort max for Claude gives 400", max.status === 400, max.text);
        const badScope = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Shared", community: relayUrl, auth, config: { instructions: "", scope: "galaxy" } });
        check("harnesses: an unknown scope gives 400", badScope.status === 400, badScope.text);
        const on = await extra.api("POST", `/v1/agents/${pk}/activate`, {
          name: "Shared",
          community: relayUrl,
          auth,
          config: { instructions: "", harness: "claude-code", scope: "channel", model: "opus", effort: "xhigh" },
        });
        check("harnesses: activate with Claude Code and channel scope gives 204", on.status === 204, on.text);
        const shown = await extra.api("GET", `/v1/agents/${pk}`);
        check(
          "harnesses: GET shows harness, scope and the read-only workspace",
          shown.json?.config?.harness === "claude-code" && shown.json?.config?.scope === "channel" && shown.json?.workspace === join(config.workspaceRoot, pk),
          shown.text,
        );
        const swap = await extra.api("PUT", `/v1/agents/${pk}/config`, { instructions: "", harness: "goose" });
        check(
          "harnesses: a move to a not-ready harness gives 409 harness_unavailable and says why",
          swap.status === 409 && swap.json?.error === "harness_unavailable" && /Goose is not ready on this host/.test(swap.json?.message ?? ""),
          swap.text,
        );
        const keep = await extra.api("PUT", `/v1/agents/${pk}/config`, { instructions: "", scope: "channel", model: "opus", effort: "xhigh" });
        const kept = await extra.api("GET", `/v1/agents/${pk}`);
        check("harnesses: a config PUT without harness keeps the agent's harness", keep.status === 204 && kept.json?.config?.harness === "claude-code", kept.text);

        await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "shared AUTH");
        const mine = () => {
          const ours = new Set(fake().filter((line) => line.type === "initialize" && line.identity?.[1] === pk).map((line) => line.pid));
          return fake().filter((line) => ours.has(line.pid));
        };
        const replies = () => relay.published.filter((item) => item.event.kind === 9 && item.event.pubkey === pk);
        const first = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "shared one", now() + 1);
        relay.inject(first);
        await waitFor(() => replies().length >= 1, "shared reply 1");
        const second = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "shared two", now() + 1);
        relay.inject(second);
        await waitFor(() => replies().length >= 2, "shared reply 2");
        const inThread = sign(ownerSecret, 9, [["h", channel], ["p", pk], ["e", first.id, "", "reply"]], "shared three", now() + 1);
        relay.inject(inThread);
        await waitFor(() => replies().length >= 3, "shared reply 3");
        const pids = new Set(mine().filter((line) => line.type === "initialize").map((line) => line.pid));
        const turns = mine().filter((line) => line.type === "turn");
        check("harnesses: channel scope runs three threads in one claude process", pids.size === 1 && turns.length === 3, JSON.stringify({ pids: [...pids], turns: turns.length }));
        check("harnesses: channel scope turns say so in the prompt", turns[1]?.scopeLine === "Scope: channel" && turns[2]?.scopeLine === "Scope: thread", JSON.stringify(turns.map((line) => line.scopeLine)));
        const start = fake().find((line) => line.type === "start" && pids.has(line.pid));
        check("harnesses: the agent runs with its picked model and effort", start?.argv[start.argv.indexOf("--model") + 1] === "opus" && start?.argv[start.argv.indexOf("--effort") + 1] === "xhigh", JSON.stringify(start?.argv));
        const sessions = JSON.parse(readFileSync(join(temp, "harnesses", "state", "sessions", `${pk}.json`), "utf8")).sessions ?? {};
        check("harnesses: the channel is one saved conversation", Object.keys(sessions).length === 1 && sessions[channel]?.id, JSON.stringify(Object.keys(sessions)));

        // The plugin as Desktop loads it, against this runner.
        await pluginSmoke({
          request: async (method, path, body) => {
            const reply = await socketRequest(extra.socket, method, path, { [LOGIN_HEADER]: LOGIN, ...(body ? { "content-type": "application/json" } : {}) }, body);
            responses.push(reply.text);
            return reply;
          },
          check,
          authTag: (agentPk) => authTag(ownerSecret, agentPk),
          community: relayUrl,
          workspaceRoot: config.workspaceRoot,
        });
      } finally {
        await extra.stop();
      }
      // A fresh runner, since readiness is cached for a minute.
      const marker = join(temp, "signed-out");
      writeFileSync(marker, "");
      const out = await startExtra("harnesses-out", 0, { publishTelemetry: false, sudo });
      try {
        const listed = await out.api("GET", "/v1/harnesses");
        const claude = listed.json?.harnesses?.find((item) => item.id === "claude-code");
        check("harnesses: signed-out Claude shows not ready with a reason", claude && !claude.ready && claude.installed && claude.state === "signed-out" && claude.message, JSON.stringify(claude));
        const models = await out.api("GET", "/v1/harnesses/claude-code/models");
        check("harnesses: models of a not-ready Claude give 409", models.status === 409 && models.json?.error === "harness_unavailable", models.text);
        const codex = listed.json?.harnesses?.find((item) => item.id === "codex");
        check("harnesses: a harness without a configured path shows not installed", codex && !codex.installed && codex.state === "missing", JSON.stringify(codex));
      } finally {
        rmSync(marker);
        await out.stop();
      }
    });

    // --- Pi and Goose: harnesses through the generic wrapper ---------------------
    const harnessCtx = {
      temp,
      relay,
      relayUrl,
      ownerSecret,
      owner,
      channel,
      workspaceRoot: config.workspaceRoot,
      fakeSudo,
      sudoLog,
      startExtra,
      typingFor,
      frames,
      turnOf,
      check,
      step,
      waitFor,
      sleep,
      lines,
      alive,
      stopHarnessRunner,
      sign,
      authTag,
      now,
      FAILURE_MESSAGE,
      ATTENTION_TOOLS,
      TELEMETRY_WAIT_MS,
      SHUTDOWN_BUDGET_MS,
    };
    await piSmoke(harnessCtx);
    await gooseSmoke(harnessCtx);
    await codexSmoke(harnessCtx);
    await setupSmoke({ check, temp });
    await signinSmoke({ check, temp });

    /** A separate runner with its own socket and state, seeded with `seed`
     * not-yet-activated records, for limits that need a fresh count. */
    async function startExtra(name, seed, overrides = {}) {
      const dir = join(temp, name);
      mkdirSync(dir, { mode: 0o700 });
      const state = join(dir, "state");
      const agents = join(state, "agents");
      mkdirSync(agents, { recursive: true, mode: 0o700 });
      chmodSync(state, 0o700);
      for (let index = 0; index < seed; index++) {
        const secret = generateSecretKey();
        const pubkey = getPublicKey(secret);
        const record = { pubkey, secretKey: bytesToHex(secret), name: `Seed ${index}`, community: relayUrl, activated: false, config: { instructions: "" }, createdAt: now() };
        writeFileSync(join(agents, `${pubkey}.json`), JSON.stringify(record), { mode: 0o600 });
      }
      const socket = join(runDir(dir), "api.sock");
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({ ...config, ...overrides, socket, stateDir: state }));
      const child = spawn(node, [RUNNER, "--config", path], { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } });
      const exit = new Promise((resolve) => child.once("exit", resolve));
      const logFile = join(dir, "runner.log");
      child.stdout.on("data", (chunk) => writeFileSync(logFile, chunk, { flag: "a" }));
      child.stderr.on("data", (chunk) => writeFileSync(logFile, chunk, { flag: "a" }));
      const call = async (method, route, body, timeout = WAIT_MS) => {
        const reply = await socketRequest(socket, method, route, { [LOGIN_HEADER]: LOGIN, ...(body ? { "content-type": "application/json" } : {}) }, body ? JSON.stringify(body) : undefined, timeout);
        responses.push(reply.text);
        let json;
        try {
          json = reply.text ? JSON.parse(reply.text) : undefined;
        } catch {
          json = undefined;
        }
        return { ...reply, json };
      };
      await waitFor(async () => (await call("GET", "/v1/health").catch(() => undefined))?.status === 200, `${name} runner health`);
      return {
        api: call,
        socket,
        stop: async () => {
          child.kill("SIGTERM");
          await Promise.race([exit, sleep(SHUTDOWN_WAIT_MS)]);
        },
      };
    }

    await lateActivate;

    // --- key custody ---------------------------------------------------------------------
    {
      const everything = [
        ["HTTP responses", responses.join("\n")],
        ["runner log", existsSync(runnerLog) ? readFileSync(runnerLog, "utf8") : ""],
        ["claude argv/env log", existsSync(fakeLog) ? readFileSync(fakeLog, "utf8") : ""],
        ["sudo argv log", existsSync(sudoLog) ? readFileSync(sudoLog, "utf8") : ""],
      ];
      for (const [label, text] of everything) {
        check(`secrets: agent keys absent from ${label}`, !text.includes(agentSecret) && !text.includes(otherSecret));
      }
      const log = readFileSync(runnerLog, "utf8");
      check("secrets: auth tag signature absent from runner log", !log.includes(tag[3]));
      check("secrets: caller login absent from runner log", !log.includes(LOGIN));
      const sudoLines = readFileSync(sudoLog, "utf8").split("\n").filter(Boolean);
      check(
        "spawn: argv is -n -u buzz-agent -- <wrapper> <agentPk> <claude args>",
        sudoLines.length > 0 && sudoLines.every((line) => line.startsWith(`-n -u ${RUN_AS} -- ${fakeWrapper} ${agent} --output-format`)),
        sudoLines[0],
      );
      check("log: every runner log line is JSON with level and msg", lines(runnerLog).every((line) => line.level && line.msg), lines(runnerLog).find((line) => !line.level)?.raw);
    }
  } finally {
    // No fake claude may outlive the run, whatever failed.
    for (const line of lines(fakeLog)) if (line.type === "start" && alive(line.pid)) process.kill(line.pid, "SIGKILL");
    if (runner && runner.exitCode === null) {
      runner.kill("SIGTERM");
      await Promise.race([runnerExit, sleep(SHUTDOWN_WAIT_MS)]);
    }
    await relay.stop().catch(() => undefined);
    if (process.env.SMOKE_KEEP) console.log(`kept ${temp}`);
    else rmSync(temp, { recursive: true, force: true });
  }
}

/** Runs the runner once and returns its exit code (startup validation). */
function runOnce(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: "ignore", env: { PATH: process.env.PATH, ...env } });
    const timer = setTimeout(() => child.kill("SIGKILL"), WAIT_MS);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

main()
  .catch((error) => {
    check("smoke harness", false, error instanceof Error ? error.stack ?? error.message : String(error));
  })
  .finally(() => {
    const failed = results.filter((result) => !result.ok);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  });
