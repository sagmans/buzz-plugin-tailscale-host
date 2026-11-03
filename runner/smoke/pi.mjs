// Pi scenarios of the smoke run: a runner whose generic harness wrapper
// (a stand-in for deploy/harness-wrapper) starts fake-pi.mjs, so the whole
// path runs as it does on the host: readiness by `--path`, model discovery
// through a short-lived host, turns through buzz-app's own Pi client, the
// Buzz tools answered in the runner, typing, telemetry, steer, interrupt,
// failure reports, a host crash and a graceful stop. Also the launcher
// deploy/pi-launch.mjs, against fake installed packages.
//
// Called from run.mjs with its helpers; adds PASS/FAIL lines through `check`.
import { spawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_PI = resolve(HERE, "fake-pi.mjs");
const PI_LAUNCH = resolve(HERE, "../deploy/pi-launch.mjs");
const PI_HARNESS = "pi";
/** Desktop's harness ids (buzz-app bundled/index.ts). */
const CLAUDE_HARNESS = "claude-code";
/** What fake-pi lists: only its configured provider's models count. */
const PI_MODEL_IDS = ["anthropic/claude-x", "anthropic/tiny"];
const PI_CURRENT = "anthropic/claude-x";
const PI_EFFORT_IDS = ["off", "low", "medium", "high"];
const PI_DEFAULT_EFFORT = "high";
/** What the Pi agent is set to run with. */
const PI_PICK = { model: "anthropic/claude-x", effort: "low" };
const PI_HINT = "Read and act in Buzz as this agent.";
const PI_REPLY_PREFIX = "pi reply: to ";
const PI_STEERED = "(steered)";
const REQUEST_CHARS = 12;
/** Exit codes of pi-launch.mjs. */
const LAUNCH_USAGE = 64;
const LAUNCH_UNAVAILABLE = 69;
const LAUNCH_WAIT_MS = 15_000;
const HOST_FILE_MODE = 0o600;
const DATA_DIR_MODE = 0o700;

/** Runs the Pi scenarios. `ctx` carries run.mjs's helpers and fixtures. */
export async function piSmoke(ctx) {
  const { temp, relay, relayUrl, ownerSecret, owner, channel, check, step, waitFor, sleep, lines, alive, sign, authTag, now } = ctx;
  const dir = join(temp, "pi-fixtures");
  mkdirSync(dir, { mode: 0o700 });
  const sudoLog = join(dir, "sudo-argv.log");
  const piLog = join(dir, "fake-pi.log");
  const piState = join(dir, "pi-state");
  mkdirSync(piState, { mode: 0o700 });
  const sudo = join(dir, "fake-sudo");
  writeFileSync(sudo, readFileSync(ctx.fakeSudo, "utf8").replace(ctx.sudoLog, sudoLog), { mode: 0o755 });
  const install = join(dir, "installs", "pi", "node_modules");
  mkdirSync(install, { recursive: true });
  const elsewhere = join(dir, "installs", "pi-other", "node_modules");
  mkdirSync(elsewhere, { recursive: true });
  // The generic wrapper's stand-in, with harness-wrapper's argument rules:
  // a fixed id list, `--path`, a 64-hex agent, and no arguments for Pi.
  const wrapper = join(dir, "fake-harness-wrapper");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'harness=$1; target=$2; shift 2',
      `case "$harness" in pi) install='${install}' ;; *) echo "unknown harness" >&2; exit 64 ;; esac`,
      'if [ "$target" = "--path" ]; then printf \'%s\\n\' "$install"; exit 0; fi',
      'printf \'%s\' "$target" | grep -Eq \'^[0-9a-f]{64}$\' || { echo "bad agent" >&2; exit 64; }',
      '[ $# -eq 0 ] || { echo "pi takes no arguments" >&2; exit 64; }',
      `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME='${dir}' FAKE_PI_LOG='${piLog}' FAKE_PI_STATE='${piState}' PI_CODING_AGENT_DIR='${join(dir, ".pi", "agent")}' '${process.execPath}' '${FAKE_PI}' "$target"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const harnesses = { [CLAUDE_HARNESS]: {}, [PI_HARNESS]: { path: install } };
  const pi = () => lines(piLog);
  const starts = () => pi().filter((line) => line.type === "start");

  // --- readiness and models ------------------------------------------------------
  const extra = await ctx.startExtra("pi", 0, { sudo, harnessWrapper: wrapper, harnesses, maxParallelTurns: 4 });
  const runnerLines = () => lines(join(temp, "pi", "runner.log"));
  let agent;
  let secret;
  try {
    await step("pi: readiness by the wrapper's --path", async () => {
      const listed = await extra.api("GET", "/v1/harnesses");
      const view = listed.json?.harnesses?.find((item) => item.id === PI_HARNESS);
      check("pi: listed supported, installed and ready", view?.supported && view.installed && view.ready && view.state === "ready", JSON.stringify(view));
      const argv = readFileSync(sudoLog, "utf8");
      check("pi: readiness ran `sudo -n -u buzz-agent -- <harness wrapper> pi --path`", argv.includes(`-n -u buzz-agent -- ${wrapper} pi --path`), argv);
      check("pi: readiness started no Pi host", starts().length === 0);
    });

    await step("pi: an empty model list is not kept, so a sign-in shows at once", async () => {
      const marker = join(piState, "signed-out");
      writeFileSync(marker, "");
      const empty = await extra.api("GET", `/v1/harnesses/${PI_HARNESS}/models`);
      check("pi: without a sign-in the model list is empty", empty.status === 200 && empty.json?.models?.length === 0, empty.text);
      rmSync(marker);
      const before = starts().length;
      const signedIn = await extra.api("GET", `/v1/harnesses/${PI_HARNESS}/models`);
      check(
        "pi: after a sign-in the next ask runs discovery again, without a runner restart",
        signedIn.status === 200 && signedIn.json?.models?.length === PI_MODEL_IDS.length && starts().length === before + 1,
        `${signedIn.text} starts ${before} -> ${starts().length}`,
      );
      await extra.api("GET", `/v1/harnesses/${PI_HARNESS}/models`);
      check("pi: a list with models is reused (no new discovery)", starts().length === before + 1, `${starts().length}`);
    });

    await step("pi: models from a discovery host", async () => {
      const models = await extra.api("GET", `/v1/harnesses/${PI_HARNESS}/models`);
      const list = models.json?.models ?? [];
      check("pi: models are <provider>/<model> of configured providers only", models.status === 200 && JSON.stringify(list.map((item) => item.id)) === JSON.stringify(PI_MODEL_IDS), models.text);
      check("pi: current model comes from Pi's settings", models.json?.current === PI_CURRENT, models.text);
      const first = list.find((item) => item.id === PI_CURRENT);
      check(
        "pi: thinking levels become efforts, resting at Pi's default",
        JSON.stringify(first?.efforts.map((item) => item.id)) === JSON.stringify(PI_EFFORT_IDS) && first?.effort === PI_DEFAULT_EFFORT && first?.efforts[0]?.label === "Off",
        JSON.stringify(first),
      );
      check("pi: a model without thinking lists no effort", list[1]?.efforts.length === 0 && list[1]?.effort === undefined, JSON.stringify(list[1]));
      const probe = starts()[0];
      check("pi: discovery ran the wrapper with the discovery key and no arguments", probe && JSON.stringify(probe.argv) === JSON.stringify(["0".repeat(64)]), JSON.stringify(probe?.argv));
      await waitFor(() => pi().some((line) => line.type === "exit" && line.pid === probe?.pid) || !alive(probe?.pid), "discovery host stops");
      check("pi: the discovery host stopped after listing (stdin EOF)", pi().some((line) => line.type === "exit" && line.pid === probe?.pid));
      check("pi: discovery opened no agent and ran no turn", !pi().some((line) => line.pid === probe?.pid && (line.type === "open" || line.type === "deliver")));
    });

    // --- turns ------------------------------------------------------------------
    const made = await extra.api("POST", "/v1/agents", { name: "Pi agent", community: relayUrl });
    agent = made.json?.pubkey;
    secret = JSON.parse(readFileSync(join(temp, "pi", "state", "agents", `${agent}.json`), "utf8")).secretKey;
    const replies = () => relay.published.filter((item) => item.event.kind === 9 && item.event.pubkey === agent);
    const replyTo = (event) => replies().find((item) => item.event.content.startsWith(`${PI_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`));
    const failureIn = (root) =>
      replies().find((item) => item.event.content === ctx.FAILURE_MESSAGE && item.event.tags.some((t) => t[0] === "e" && t[1] === root));
    const delivered = (event) => pi().find((line) => line.type === "deliver" && line.request === event.id);
    const mention = (text, root) => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent], ...(root ? [["e", root, "", "reply"]] : [])], text, now() + 1);
      relay.inject(event);
      return event;
    };
    let first;

    await step("pi: activate and a first turn", async () => {
      const on = await extra.api("POST", `/v1/agents/${agent}/activate`, {
        name: "Pi agent",
        community: relayUrl,
        auth: authTag(ownerSecret, agent),
        config: { instructions: "Be brief.", harness: PI_HARNESS, ...PI_PICK },
      });
      check("pi: activate with harness pi, a Pi model and effort gives 204", on.status === 204, on.text);
      const shown = await extra.api("GET", `/v1/agents/${agent}`);
      check("pi: GET shows harness pi and its model", shown.json?.config?.harness === PI_HARNESS && shown.json?.config?.model === PI_PICK.model, shown.text);
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === agent), "pi AUTH");
      const hostsBefore = starts().length;
      first = mention("hello pi");
      const reply = await waitFor(() => replyTo(first), "pi reply");
      check(
        "pi: the reply lands in the event's thread and channel, from the runner's own context",
        reply.event.tags.some((t) => t[0] === "h" && t[1] === channel) && reply.event.tags.some((t) => t[0] === "e" && t[1] === first.id),
        JSON.stringify(reply.event.tags),
      );
      const host = starts().slice(hostsBefore).find((line) => line.agent === agent);
      check("pi: one host started for the agent, wrapper argv is only its pubkey", host && JSON.stringify(host.argv) === JSON.stringify([agent]), JSON.stringify(host?.argv));
      check(
        "pi: sudo argv is -n -u buzz-agent -- <harness wrapper> pi <agentPk>, nothing more",
        readFileSync(sudoLog, "utf8").split("\n").includes(`-n -u buzz-agent -- ${wrapper} pi ${agent}`),
        readFileSync(sudoLog, "utf8"),
      );
      check("pi: host env has no runner variables", host && !host.env.some((key) => key.startsWith("BUZZ")), JSON.stringify(host?.env));
      check("pi: the launch line carries host, package and lock", pi().some((line) => line.type === "launch" && line.pid === host?.pid && line.ok), "");
      const open = pi().find((line) => line.type === "open" && line.pid === host?.pid);
      check(
        "pi: open lists the Buzz session tools, always loaded, no attention tools, with the hint",
        open?.tools.includes("send") && open.tools.includes("mem_get") && !open.tools.some((name) => ctx.ATTENTION_TOOLS.includes(name)) && JSON.stringify(open.loads) === JSON.stringify(["always"]) && open.hint === PI_HINT,
        JSON.stringify(open),
      );
      const deliver = delivered(first);
      check(
        "pi: deliver carries provider, model, thinking, workspace cwd and pick",
        deliver?.provider === "anthropic" && deliver.model === "claude-x" && deliver.thinking === PI_PICK.effort && deliver.cwd === join(ctx.workspaceRoot, agent) && JSON.stringify(deliver.pick) === "{}",
        JSON.stringify(deliver),
      );
      check(
        "pi: deliver carries the identity instructions, core memory, the event and a steer form",
        deliver?.identity && deliver.hasCore && deliver.text.includes("hello pi") && deliver.steerDiffers && deliver.at === first.created_at,
        JSON.stringify({ identity: deliver?.identity, core: deliver?.hasCore, steer: deliver?.steerDiffers }),
      );
      check("pi: deliver context is the runner's {channel, root}", deliver?.context?.channel === channel && deliver.context.root === first.id, JSON.stringify(deliver?.context));
      const tool = pi().find((line) => line.type === "tool" && line.key === deliver?.key);
      check("pi: the send tool ran in the runner without error and is final", tool && !tool.isError && tool.final, JSON.stringify(tool));
      check("pi: typing pulses sent for the turn", ctx.typingFor(agent, first.id).length > 0);
      // #lizard forgives: one scenario list that must read in run order
    });

    await step("pi: telemetry frames for a Pi turn", async () => {
      const turnId = await waitFor(() => ctx.turnOf(agent, first.id), "pi turn_started", ctx.TELEMETRY_WAIT_MS);
      const mine = () => ctx.frames(agent).filter((frame) => frame.turnId === turnId);
      await waitFor(() => mine().some((frame) => frame.kind === "turn_completed"), "pi turn_completed", ctx.TELEMETRY_WAIT_MS);
      const all = mine();
      const updates = all.filter((frame) => frame.kind === "acp_read" && frame.payload.method === "session/update").map((frame) => frame.payload.params.update);
      const resolved = all.filter((frame) => frame.kind === "session_resolved");
      check("pi: session_resolved once, naming the Pi conversation, new", resolved.length === 1 && resolved[0].payload.isNewSession === true && /^\d+$/.test(resolved[0].payload.sessionId), JSON.stringify(resolved.map((frame) => frame.payload)));
      const prompt = all.find((frame) => frame.kind === "acp_write" && frame.payload.method === "session/prompt");
      check("pi: the prompt is an acp_write session/prompt with the turn text", prompt?.payload.params.prompt[0].text.includes("hello pi"), JSON.stringify(prompt?.payload)?.slice(0, 200));
      const think = updates.find((item) => item.sessionUpdate === "tool_call" && item.name === "Thinking");
      const bash = updates.find((item) => item.sessionUpdate === "tool_call" && item.name === "bash");
      check("pi: steps become tool_call in_progress with ACP kinds", think?.kind === "think" && bash?.kind === "execute" && bash.title === "bash ls -la" && bash.status === "in_progress", JSON.stringify([think, bash]));
      check(
        "pi: each step completes",
        [think, bash].every((call) => updates.some((item) => item.sessionUpdate === "tool_call_update" && item.toolCallId === call?.toolCallId && item.status === "completed")),
        JSON.stringify(updates.filter((item) => item.sessionUpdate === "tool_call_update")),
      );
      check("pi: the answer becomes agent_message_chunk", updates.some((item) => item.sessionUpdate === "agent_message_chunk" && item.content.text.startsWith(PI_REPLY_PREFIX)));
      const answer = all.find((frame) => frame.kind === "acp_read" && frame.payload.result?.stopReason);
      check("pi: the prompt is answered with stopReason end_turn", answer?.payload.result.stopReason === "end_turn", JSON.stringify(answer?.payload));
    });

    await step("pi: follow-up and steer in one conversation", async () => {
      const hosts = starts().length;
      const follow = mention("pi follow-up", first.id);
      await waitFor(() => replyTo(follow), "pi follow-up reply");
      const [one, two] = [delivered(first), delivered(follow)];
      check("pi: a thread follow-up goes to the same Pi conversation", one && two && one.key === two.key && one.conversation === two.conversation, JSON.stringify([one?.conversation, two?.conversation]));
      check("pi: the follow-up reuses the live host", starts().length === hosts);
      check("pi: the follow-up asked Pi what the conversation has seen (place)", pi().some((line) => line.type === "request" && line.method === "place"));
      const slow = mention("SLOW pi base", first.id);
      await waitFor(() => delivered(slow), "pi slow delivered");
      const steer = mention("pi steer in", first.id);
      const steered = await waitFor(() => delivered(steer), "pi steer delivered");
      check("pi: a message during a working turn is delivered while busy (Pi steers it)", steered.busy === true, JSON.stringify(steered));
      const reply = await waitFor(() => replies().find((item) => item.event.content.includes(slow.id.slice(0, REQUEST_CHARS)) && item.event.content.endsWith(PI_STEERED)), "steered reply");
      check("pi: the working turn answered with the steer folded in", Boolean(reply));
      await sleep(500);
      check("pi: neither steered message reports a failure", !failureIn(first.id));
    });

    await step("pi: failures are reported in the thread", async () => {
      const fail = mention("FAIL pi please");
      const failed = await waitFor(() => failureIn(fail.id), "pi failure post");
      check("pi: an unanswered request posts the generic failure, tagged to the owner", failed.event.tags.some((t) => t[0] === "p" && t[1] === owner), JSON.stringify(failed.event.tags));
      check("pi: the failure detail is in the runner log", runnerLines().some((line) => line.msg === "turn failed" && line.error === "provider said no"));
      const noModel = mention("NOMODEL pi please");
      await waitFor(() => failureIn(noModel.id), "pi no-model failure post");
      check("pi: a missing model or sign-in fails the turn with a post", runnerLines().some((line) => line.msg === "turn failed" && /has no model/.test(line.error ?? "")));
    });

    await step("pi: owner Stop interrupts a Pi turn", async () => {
      const hang = mention("HANG pi please");
      await waitFor(() => delivered(hang), "pi hang delivered");
      const stop = await extra.api("POST", `/v1/agents/${agent}/interrupt`, { channelId: channel, threadRootId: hang.id });
      check("pi: interrupt gives {interrupted:true}", stop.status === 200 && stop.json?.interrupted === true, stop.text);
      await waitFor(() => pi().some((line) => line.type === "session" && line.action === "interrupt" && line.key === `${channel}/${hang.id}`), "pi session interrupt");
      check("pi: the host got session interrupt for that conversation", true);
      const turnId = await waitFor(() => ctx.turnOf(agent, hang.id), "pi hang turn", ctx.TELEMETRY_WAIT_MS);
      const cancelled = await waitFor(
        () => ctx.frames(agent).find((frame) => frame.turnId === turnId && frame.kind === "acp_read" && frame.payload.result?.stopReason),
        "pi cancelled",
        ctx.TELEMETRY_WAIT_MS,
      );
      check("pi: the interrupted prompt ends with stopReason cancelled", cancelled.payload.result.stopReason === "cancelled", JSON.stringify(cancelled.payload));
      check("pi: an interrupted turn posts no failure", !failureIn(hang.id));
    });

    await step("pi: a crashed host fails its turn; the next host drops the left run", async () => {
      const pidBefore = starts().filter((line) => line.agent === agent).at(-1)?.pid;
      const crash = mention("CRASH pi please");
      await waitFor(() => failureIn(crash.id), "pi crash failure post");
      check("pi: the turn of a host that crashed is reported", true);
      check("pi: the crashed host is gone", !alive(pidBefore));
      const after = mention("pi after crash");
      await waitFor(() => replyTo(after), "pi reply after crash");
      const host = starts().filter((line) => line.agent === agent).at(-1);
      check("pi: the next message starts a new host", host && host.pid !== pidBefore);
      const crashed = delivered(crash);
      check(
        "pi: the new host dropped the run the crashed one left",
        pi().some((line) => line.type === "drop" && line.pid === host?.pid) && runnerLines().some((line) => line.msg === "pi runs left by a stopped host dropped"),
        JSON.stringify(crashed?.conversation),
      );
    });

    await step("pi: an agent moves from Claude to Pi", async () => {
      const moved = await extra.api("POST", "/v1/agents", { name: "Mover", community: relayUrl });
      const pk = moved.json?.pubkey;
      const on = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Mover", community: relayUrl, auth: authTag(ownerSecret, pk), config: { instructions: "" } });
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "mover AUTH");
      const put = await extra.api("PUT", `/v1/agents/${pk}/config`, { instructions: "", harness: PI_HARNESS, ...PI_PICK });
      check("pi: activate on Claude, then PUT harness pi gives 204", on.status === 204 && put.status === 204, put.text);
      const event = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "mover on pi", now() + 1);
      relay.inject(event);
      const reply = await waitFor(
        () => relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === pk && item.event.content.startsWith(`${PI_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`)),
        "mover reply from pi",
      );
      check("pi: the moved agent's next turn runs on Pi", Boolean(reply) && starts().some((line) => line.agent === pk));
    });
  } finally {
    await ctx.stopHarnessRunner("pi", "Pi host with stdin EOF", extra, starts);
  }
  if (secret) {
    for (const [label, path] of [
      ["fake-pi log", piLog],
      ["Pi sudo log", sudoLog],
      ["Pi runner log", join(temp, "pi", "runner.log")],
    ])
      check(`pi: agent key absent from the ${label}`, !readFileSync(path, "utf8").includes(secret));
  }

  // --- config drift ---------------------------------------------------------------
  await step("pi: a config path the wrapper does not run shows not installed", async () => {
    const drift = await ctx.startExtra("pi-drift", 0, { sudo, harnessWrapper: wrapper, harnesses: { [CLAUDE_HARNESS]: {}, [PI_HARNESS]: { path: elsewhere } }, publishTelemetry: false });
    try {
      const hostsBefore = starts().length;
      const listed = await drift.api("GET", "/v1/harnesses");
      const view = listed.json?.harnesses?.find((item) => item.id === PI_HARNESS);
      check("pi: drifted path shows not installed with the reason", view && !view.ready && !view.installed && view.state === "missing" && /not the one the host wrapper runs/.test(view.message ?? ""), JSON.stringify(view));
      const models = await drift.api("GET", `/v1/harnesses/${PI_HARNESS}/models`);
      check("pi: models of a drifted Pi give 409 and start no host", models.status === 409 && starts().length === hostsBefore, models.text);
    } finally {
      await drift.stop();
    }
  });

  await launcherSmoke(ctx);
  // #lizard forgives: one scenario list that must read in run order
}

/** deploy/pi-launch.mjs against fake installed packages. */
async function launcherSmoke({ temp, check, step }) {
  const root = join(temp, "pi-launch");
  const modules = join(root, "pkgs", "node_modules");
  const data = join(root, "data", "agent");
  const pkg = (path, version, source) => {
    mkdirSync(join(modules, path), { recursive: true });
    writeFileSync(join(modules, path, "package.json"), JSON.stringify({ name: path.split("/node_modules/").at(-1), version, type: "module", main: "index.js" }));
    if (source) writeFileSync(join(modules, path, "index.js"), source);
  };
  pkg("pkg-a", "1.0.0", 'import b from "pkg-b"; export default `A+${b}`;\n');
  pkg("pkg-a/node_modules/pkg-b", "2.0.0", 'export default "B2";\n');
  pkg("pkg-b", "3.0.0", 'export default "B3";\n');
  const lock = {
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "pkg-a": "1.0.0" } },
      "node_modules/pkg-a": { version: "1.0.0" },
      "node_modules/pkg-a/node_modules/pkg-b": { version: "2.0.0" },
      "node_modules/pkg-b": { version: "3.0.0" },
      "node_modules/pkg-optional": { version: "9.0.0", optional: true },
      "node_modules/pkg-dev": { version: "1.0.0", dev: true },
    },
  };
  const packageJson = { dependencies: { "pkg-a": "1.0.0" } };
  const host = (tag) =>
    [
      'import a from "pkg-a";',
      "let rest = '';",
      "process.stdin.setEncoding('utf8').on('data', (chunk) => (rest += chunk)).on('end', () => {",
      `  console.log(JSON.stringify({ tag: ${JSON.stringify(tag)}, a, argv1: process.argv[1], cwd: process.cwd(), flag: process.env.BUZZ_PI_HOST, rest }));`,
      "});",
      "",
    ].join("\n");
  const env = { PATH: process.env.PATH, BUZZ_PI_DATA: data, BUZZ_PI_MODULES: modules };
  const first = (overrides = {}) => `${JSON.stringify({ host: host("one"), package: JSON.stringify(packageJson), lock: JSON.stringify(lock), ...overrides })}\n`;

  await step("pi-launch: runs the host against the pinned packages", async () => {
    const run = await launch(env, `${first()}rest-of-stdin\n`);
    let out;
    try {
      out = JSON.parse(run.stdout.trim());
    } catch {
      out = undefined;
    }
    check("pi-launch: exits 0 and the host ran", run.code === 0 && out?.tag === "one", `${run.code} ${run.stderr}`);
    check("pi-launch: host imports resolve to the installed packages, nested ones first", out?.a === "A+B2", JSON.stringify(out));
    check("pi-launch: argv[1] is the agent data folder, BUZZ_PI_HOST=1", out?.argv1 === data && out?.flag === "1", JSON.stringify(out));
    check("pi-launch: cwd is data/host", out && realpathSync(out.cwd) === realpathSync(join(data, "host")), out?.cwd);
    check("pi-launch: the rest of stdin reaches the host", out?.rest === "rest-of-stdin\n", JSON.stringify(out?.rest));
    const files = readdirSync(join(data, "host")).filter((name) => name.startsWith("host-"));
    check(
      "pi-launch: one host file 0600, data folders 0700, node_modules links to the install",
      files.length === 1 &&
        (statSync(join(data, "host", files[0])).mode & 0o777) === HOST_FILE_MODE &&
        (statSync(data).mode & 0o777) === DATA_DIR_MODE &&
        (statSync(join(data, "host")).mode & 0o777) === DATA_DIR_MODE &&
        lstatSync(join(data, "host", "node_modules")).isSymbolicLink() &&
        readlinkSync(join(data, "host", "node_modules")) === modules,
      files.join(","),
    );
    const again = await launch(env, first({ host: host("two") }));
    const after = readdirSync(join(data, "host")).filter((name) => name.startsWith("host-"));
    check("pi-launch: a new host source replaces the old file", again.code === 0 && after.length === 1 && after[0] !== files[0], `${again.code} ${after.join(",")}`);
  });

  await step("pi-launch: refuses what it must not run", async () => {
    const drifted = { ...lock, packages: { ...lock.packages, "node_modules/pkg-b": { version: "3.0.1" } } };
    // A fresh data folder: a refused start must not create it.
    const never = join(root, "data", "never");
    const drift = await launch({ ...env, BUZZ_PI_DATA: never }, first({ lock: JSON.stringify(drifted) }));
    check("pi-launch: a lock version not installed exits 69 and names it", drift.code === LAUNCH_UNAVAILABLE && /Differs: pkg-b 3\.0\.1 \(installed: 3\.0\.0\)/.test(drift.stderr), `${drift.code} ${drift.stderr}`);
    const absent = { ...lock, packages: { ...lock.packages, "node_modules/pkg-gone": { version: "1.0.0" } } };
    const gone = await launch(env, first({ lock: JSON.stringify(absent) }));
    check("pi-launch: a required package not installed exits 69", gone.code === LAUNCH_UNAVAILABLE && /pkg-gone 1\.0\.0 \(installed: none\)/.test(gone.stderr), `${gone.code} ${gone.stderr}`);
    const unsafe = { ...lock, packages: { ...lock.packages, "node_modules/../../etc": { version: "1.0.0" } } };
    const escape = await launch(env, first({ lock: JSON.stringify(unsafe) }));
    check("pi-launch: a lock path outside node_modules exits 64", escape.code === LAUNCH_USAGE && /unsafe path/.test(escape.stderr), `${escape.code} ${escape.stderr}`);
    const disagree = await launch(env, first({ package: JSON.stringify({ dependencies: { "pkg-a": "1.0.1" } }) }));
    check("pi-launch: package and lock that disagree exit 64", disagree.code === LAUNCH_USAGE, `${disagree.code} ${disagree.stderr}`);
    const notJson = await launch(env, "not json\n");
    check("pi-launch: a first line that is not JSON exits 64", notJson.code === LAUNCH_USAGE, `${notJson.code} ${notJson.stderr}`);
    const empty = await launch(env, "");
    check("pi-launch: no input exits 64", empty.code === LAUNCH_USAGE, `${empty.code} ${empty.stderr}`);
    const noData = await launch({ PATH: env.PATH, BUZZ_PI_MODULES: modules }, first());
    check("pi-launch: without BUZZ_PI_DATA it exits 64", noData.code === LAUNCH_USAGE, `${noData.code} ${noData.stderr}`);
    const relative = await launch({ ...env, BUZZ_PI_MODULES: "pkgs/node_modules" }, first());
    check("pi-launch: a relative BUZZ_PI_MODULES exits 64", relative.code === LAUNCH_USAGE, `${relative.code} ${relative.stderr}`);
    check("pi-launch: a refused start creates no data folder", !existsSync(never));
  });
}

/** One launcher run with `input` on stdin; resolves its exit code and output. */
function launch(env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [PI_LAUNCH], { env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill("SIGKILL"), LAUNCH_WAIT_MS);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}
