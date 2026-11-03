// Goose scenarios of the smoke run: a runner whose generic harness wrapper
// (a stand-in for deploy/harness-wrapper) starts fake-goose.mjs, so the
// whole path runs as on the host: readiness by `--path`, model discovery
// through buzz-app's `GooseSetup`, turns through buzz-app's goose module and
// ACP client, the Buzz tools over a loopback HTTP MCP server per session
// answered in the runner, typing, telemetry, steer, interrupt, failure
// reports, the MCP server's refusals, a crash and a graceful stop.
//
// Called from run.mjs with its helpers; adds PASS/FAIL lines through `check`.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_GOOSE = resolve(HERE, "fake-goose.mjs");
const GOOSE_HARNESS = "goose";
const CLAUDE_HARNESS = "claude-code";
/** What fake-goose lists: only its configured provider counts. */
const GOOSE_MODEL_IDS = ["anthropic/claude-x", "anthropic/tiny"];
const GOOSE_CURRENT = "anthropic/claude-x";
const GOOSE_EFFORT_IDS = ["low", "medium", "high"];
const GOOSE_RESTING = "medium";
/** What the Goose agent is set to run with. */
const GOOSE_PICK = { model: "anthropic/claude-x", effort: "high" };
const GOOSE_REPLY_PREFIX = "goose reply: to ";
const GOOSE_STEERED = "(steered)";
const REQUEST_CHARS = 12;
const ROOT_CHARS = 8;
const DISCOVERY_AGENT = "0".repeat(64);
const MCP_WAIT_MS = 5_000;

/** Runs the Goose scenarios. `ctx` carries run.mjs's helpers and fixtures. */
export async function gooseSmoke(ctx) {
  const { temp, relay, relayUrl, ownerSecret, owner, channel, check, step, waitFor, sleep, lines, alive, sign, authTag, now } = ctx;
  const dir = join(temp, "goose-fixtures");
  mkdirSync(dir, { mode: 0o700 });
  const sudoLog = join(dir, "sudo-argv.log");
  const gooseLog = join(dir, "fake-goose.log");
  const gooseState = join(dir, "goose-state");
  mkdirSync(gooseState, { mode: 0o700 });
  const sudo = join(dir, "fake-sudo");
  writeFileSync(sudo, readFileSync(ctx.fakeSudo, "utf8").replace(ctx.sudoLog, sudoLog), { mode: 0o755 });
  const install = join(dir, "installs", "goose", "goose-acp");
  mkdirSync(dirname(install), { recursive: true });
  writeFileSync(install, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The generic wrapper's stand-in, with harness-wrapper's argument rules:
  // a fixed id list, `--path`, a 64-hex agent, and no arguments for Goose.
  const wrapper = join(dir, "fake-harness-wrapper");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'harness=$1; target=$2; shift 2',
      `case "$harness" in goose) install='${install}' ;; *) echo "unknown harness" >&2; exit 64 ;; esac`,
      'if [ "$target" = "--path" ]; then printf \'%s\\n\' "$install"; exit 0; fi',
      'printf \'%s\' "$target" | grep -Eq \'^[0-9a-f]{64}$\' || { echo "bad agent" >&2; exit 64; }',
      '[ $# -eq 0 ] || { echo "goose takes no arguments" >&2; exit 64; }',
      `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME='${dir}' GOOSE_MODE=auto GOOSE_DISABLE_KEYRING=1 FAKE_GOOSE_LOG='${gooseLog}' FAKE_GOOSE_STATE='${gooseState}' '${process.execPath}' '${FAKE_GOOSE}' "$target"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const harnesses = { [CLAUDE_HARNESS]: {}, [GOOSE_HARNESS]: { path: install } };
  const goose = () => lines(gooseLog);
  const starts = () => goose().filter((line) => line.type === "start");
  const tokens = () =>
    readdirSync(gooseState)
      .filter((name) => name.startsWith("mcp-"))
      .flatMap((name) => JSON.parse(readFileSync(join(gooseState, name), "utf8")).headers.map((header) => header.value.split(" ").at(-1)));

  const extra = await ctx.startExtra("goose", 0, { sudo, harnessWrapper: wrapper, harnesses, maxParallelTurns: 4 });
  const runnerLog = join(temp, "goose", "runner.log");
  const runnerLines = () => lines(runnerLog);
  let agent;
  let secret;
  try {
    await step("goose: readiness by the wrapper's --path", async () => {
      const listed = await extra.api("GET", "/v1/harnesses");
      const view = listed.json?.harnesses?.find((item) => item.id === GOOSE_HARNESS);
      check("goose: listed supported, installed and ready", view?.supported && view.installed && view.ready && view.state === "ready" && view.title === "Goose", JSON.stringify(view));
      check("goose: readiness ran `sudo -n -u buzz-agent -- <harness wrapper> goose --path`", readFileSync(sudoLog, "utf8").includes(`-n -u buzz-agent -- ${wrapper} goose --path`));
      check("goose: readiness started no goose-acp", starts().length === 0);
    });

    await step("goose: models from discovery processes", async () => {
      const models = await extra.api("GET", `/v1/harnesses/${GOOSE_HARNESS}/models`);
      const list = models.json?.models ?? [];
      check("goose: models are <provider>/<model> of configured providers only (no unset, no ACP provider)", models.status === 200 && JSON.stringify(list.map((item) => item.id)) === JSON.stringify(GOOSE_MODEL_IDS), models.text);
      check("goose: current model is Goose's configured default", models.json?.current === GOOSE_CURRENT, models.text);
      check("goose: a configured provider that cannot list its models is left out, not the whole list", models.status === 200 && !list.some((item) => item.id.startsWith("atomic_chat/")), models.text);
      const main = list.find((item) => item.id === GOOSE_CURRENT);
      check(
        "goose: a model's thinking levels become efforts, resting where Goose runs it",
        JSON.stringify(main?.efforts.map((item) => item.id)) === JSON.stringify(GOOSE_EFFORT_IDS) && main?.effort === GOOSE_RESTING && main?.efforts[0]?.label === "Low",
        JSON.stringify(main),
      );
      const plain = list.find((item) => item.id === "anthropic/tiny");
      check("goose: a model without levels lists no effort", plain?.efforts.length === 0 && plain.effort === undefined, JSON.stringify(plain));
      const probes = starts();
      check("goose: discovery ran the wrapper with the discovery key and no arguments", probes.length > 0 && probes.every((line) => JSON.stringify(line.argv) === JSON.stringify([DISCOVERY_AGENT])), JSON.stringify(probes.map((line) => line.argv)));
      await waitFor(() => probes.every((line) => !alive(line.pid)), "discovery processes stop");
      check("goose: every discovery process stopped after listing", probes.every((line) => !alive(line.pid)));
      check("goose: discovery deleted its throwaway session and served no tools", goose().some((line) => line.type === "delete") && !goose().some((line) => line.type === "mcp"));
    });

    // --- turns ------------------------------------------------------------------
    const made = await extra.api("POST", "/v1/agents", { name: "Goose agent", community: relayUrl });
    agent = made.json?.pubkey;
    secret = JSON.parse(readFileSync(join(temp, "goose", "state", "agents", `${agent}.json`), "utf8")).secretKey;
    const replies = () => relay.published.filter((item) => item.event.kind === 9 && item.event.pubkey === agent);
    const replyTo = (event) => replies().find((item) => item.event.content.startsWith(`${GOOSE_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`));
    const failureIn = (root) =>
      replies().find((item) => item.event.content === ctx.FAILURE_MESSAGE && item.event.tags.some((t) => t[0] === "e" && t[1] === root));
    const prompted = (event) => goose().find((line) => line.type === "prompt" && line.request === event.id);
    const sessionOf = (event) => goose().find((line) => line.type === "session" && line.session === prompted(event)?.session);
    const mention = (text, root) => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent], ...(root ? [["e", root, "", "reply"]] : [])], text, now() + 1);
      relay.inject(event);
      return event;
    };
    let first;

    await step("goose: activate and a first turn", async () => {
      const on = await extra.api("POST", `/v1/agents/${agent}/activate`, {
        name: "Goose agent",
        community: relayUrl,
        auth: authTag(ownerSecret, agent),
        config: { instructions: "Be brief.", harness: GOOSE_HARNESS, ...GOOSE_PICK },
      });
      check("goose: activate with harness goose, a Goose model and effort gives 204", on.status === 204, on.text);
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === agent), "goose AUTH");
      const before = starts().length;
      first = mention("hello goose");
      const reply = await waitFor(() => replyTo(first), "goose reply");
      check(
        "goose: the reply lands in the event's thread and channel",
        reply.event.tags.some((t) => t[0] === "h" && t[1] === channel) && reply.event.tags.some((t) => t[0] === "e" && t[1] === first.id),
        JSON.stringify(reply.event.tags),
      );
      const host = starts().slice(before).find((line) => line.agent === agent);
      check("goose: one goose-acp started for the agent, wrapper argv is only its pubkey", host && JSON.stringify(host.argv) === JSON.stringify([agent]) && starts().slice(before).length === 1, JSON.stringify(starts().slice(before).map((line) => line.argv)));
      check("goose: sudo argv is -n -u buzz-agent -- <harness wrapper> goose <agentPk>, nothing more", readFileSync(sudoLog, "utf8").split("\n").includes(`-n -u buzz-agent -- ${wrapper} goose ${agent}`), readFileSync(sudoLog, "utf8"));
      check("goose: goose-acp env has no runner variables", host && !host.env.some((key) => key.startsWith("BUZZ")), JSON.stringify(host?.env));
      const session = sessionOf(first);
      check("goose: session/new has the agent workspace as cwd", session?.cwd === join(ctx.workspaceRoot, agent), JSON.stringify(session));
      check(
        "goose: one loopback HTTP MCP server named buzz, with a Bearer token",
        JSON.stringify(session?.servers) === JSON.stringify([{ type: "http", name: "buzz", local: true }]) && session.bearer,
        JSON.stringify(session?.servers),
      );
      check("goose: the session's tool set is developer plus the Buzz server only", JSON.stringify(session?.extensions) === JSON.stringify(["developer", "buzz"]), JSON.stringify(session?.extensions));
      check("goose: the session is titled agent · place · thread root (no naming call)", typeof session?.title === "string" && session.title.startsWith("Goose agent · ") && session.title.endsWith(` · ${first.id.slice(0, ROOT_CHARS)}`), session?.title);
      check("goose: session/new names the agent's provider", session?.provider === "anthropic", JSON.stringify(session));
      const system = goose().find((line) => line.type === "system" && line.session === session?.session);
      check("goose: the system prompt is appended under Goose's, with identity and instructions", system?.mode === "append" && system.key === "buzz" && system.identity && system.brief, JSON.stringify(system));
      const configs = goose().filter((line) => line.type === "config" && line.session === session?.session);
      check(
        "goose: the turn runs on the picked model and level (set_config_option)",
        configs.some((line) => line.configId === "model" && line.value === "claude-x") && configs.some((line) => line.configId === "thinking_effort" && line.value === GOOSE_PICK.effort),
        JSON.stringify(configs),
      );
      const turn = prompted(first);
      check("goose: the prompt carries the event and ran on the pick", turn?.identity && turn.model === "claude-x" && turn.effort === GOOSE_PICK.effort, JSON.stringify(turn));
      const mcp = goose().find((line) => line.type === "mcp" && line.session === session?.session);
      check(
        "goose: MCP initialize claimed a session; tools/list has send and memory, no attention tools",
        mcp?.initStatus === 200 && mcp.claimed && mcp.notifyStatus === 202 && mcp.listStatus === 200 && mcp.tools.includes("send") && mcp.tools.includes("mem_get") && !mcp.tools.some((name) => ctx.ATTENTION_TOOLS.includes(name)),
        JSON.stringify(mcp),
      );
      // fake-goose logs the call once its answer is back, which can be after
      // the relay has the reply.
      const tool = await waitFor(() => goose().find((line) => line.type === "tool" && line.session === session?.session), "goose send logged");
      check("goose: send over MCP ran in the runner without error", tool?.status === 200 && !tool.isError, JSON.stringify(tool));
      check("goose: a permission prompt is answered allow_always", goose().some((line) => line.type === "permission" && line.outcome?.outcome === "selected" && line.outcome.optionId === "always"));
      check("goose: typing pulses sent for the turn", ctx.typingFor(agent, first.id).length > 0);
      // #lizard forgives: one scenario list that must read in run order
    });

    await step("goose: telemetry frames for a Goose turn", async () => {
      const turnId = await waitFor(() => ctx.turnOf(agent, first.id), "goose turn_started", ctx.TELEMETRY_WAIT_MS);
      const mine = () => ctx.frames(agent).filter((frame) => frame.turnId === turnId);
      await waitFor(() => mine().some((frame) => frame.kind === "acp_read" && frame.payload.result?.stopReason), "goose prompt answer frame", ctx.TELEMETRY_WAIT_MS);
      await waitFor(() => mine().some((frame) => frame.kind === "turn_completed"), "goose turn_completed", ctx.TELEMETRY_WAIT_MS);
      const all = mine();
      const session = prompted(first)?.session;
      const resolved = all.filter((frame) => frame.kind === "session_resolved");
      check("goose: session_resolved once, naming the Goose session, new", resolved.length === 1 && resolved[0].payload.isNewSession === true && resolved[0].payload.sessionId === session, JSON.stringify(resolved.map((frame) => frame.payload)));
      const opened = all.find((frame) => frame.kind === "acp_write" && frame.payload.method === "session/new");
      check(
        "goose: session/new frame is rebuilt: cwd and system prompt, no MCP server",
        opened?.payload.params.cwd === join(ctx.workspaceRoot, agent) && opened.payload.params.mcpServers.length === 0 && opened.payload.params._meta?.systemPrompt?.append?.includes("Be brief."),
        JSON.stringify(opened?.payload)?.slice(0, 300),
      );
      const prompt = all.find((frame) => frame.kind === "acp_write" && frame.payload.method === "session/prompt");
      check("goose: the prompt is the raw acp_write session/prompt", prompt?.payload.params.sessionId === session && prompt.payload.params.prompt[0].text.includes("hello goose"), JSON.stringify(prompt?.payload)?.slice(0, 200));
      const updates = all.filter((frame) => frame.kind === "acp_read" && frame.payload.method === "session/update").map((frame) => frame.payload.params.update);
      check("goose: Goose's session updates pass through (thought, tool call, update)", ["agent_thought_chunk", "tool_call", "tool_call_update"].every((kind) => updates.some((item) => item.sessionUpdate === kind)), JSON.stringify(updates.map((item) => item.sessionUpdate)));
      // The final send ends the work (buzz-app AcpSession `finished`); what
      // Goose writes after it answers nobody and is not in the turn.
      check("goose: text after the final message is not in the ended turn", !updates.some((item) => item.sessionUpdate === "agent_message_chunk"), JSON.stringify(updates.map((item) => item.sessionUpdate)));
      const answer = all.find((frame) => frame.kind === "acp_read" && frame.payload.result?.stopReason);
      check("goose: the prompt is answered with stopReason end_turn", answer?.payload.result.stopReason === "end_turn" && answer.payload.id === prompt?.payload.id, JSON.stringify(answer?.payload));
      check("goose: no config switch, provider read or permission reaches the feed", !all.some((frame) => /set_config_option|providers\/list|request_permission|system-prompt/.test(JSON.stringify(frame.payload))));
    });

    await step("goose: follow-up and steer in one session", async () => {
      const hosts = starts().length;
      const follow = mention("goose follow-up", first.id);
      await waitFor(() => replyTo(follow), "goose follow-up reply");
      check("goose: a thread follow-up goes to the same session", prompted(first)?.session === prompted(follow)?.session, JSON.stringify([prompted(first)?.session, prompted(follow)?.session]));
      check("goose: the follow-up reuses the live goose-acp", starts().length === hosts);
      const slow = mention("SLOW goose base", first.id);
      await waitFor(() => prompted(slow), "goose slow prompted");
      mention("goose steer in", first.id);
      const steer = await waitFor(() => goose().find((line) => line.type === "steer"), "goose steer");
      check("goose: a message during a working turn is steered into its run", steer.ok && steer.text, JSON.stringify(steer));
      const reply = await waitFor(() => replies().find((item) => item.event.content.includes(slow.id.slice(0, REQUEST_CHARS)) && item.event.content.endsWith(GOOSE_STEERED)), "steered reply");
      check("goose: the working turn answered with the steer folded in", Boolean(reply));
      const turnId = await waitFor(() => ctx.turnOf(agent, slow.id), "goose slow turn", ctx.TELEMETRY_WAIT_MS);
      const steering = await waitFor(() => ctx.frames(agent).find((frame) => frame.turnId === turnId && frame.payload?.method === "_session/steering"), "steer frame", ctx.TELEMETRY_WAIT_MS);
      check("goose: the steer shows as _session/steering", steering.payload.params.sessionId === prompted(slow)?.session);
      await sleep(500);
      check("goose: neither steered message reports a failure", !failureIn(first.id));
    });

    await step("goose: failures are reported in the thread", async () => {
      const fail = mention("FAIL goose please");
      const failed = await waitFor(() => failureIn(fail.id), "goose failure post");
      check("goose: a failed prompt posts the generic failure, tagged to the owner", failed.event.tags.some((t) => t[0] === "p" && t[1] === owner), JSON.stringify(failed.event.tags));
      check("goose: the failure detail is in the runner log", runnerLines().some((line) => line.msg === "turn failed" && line.error === "provider said no"), JSON.stringify(runnerLines().filter((line) => line.msg === "turn failed")));
    });

    await step("goose: owner Stop interrupts a Goose turn", async () => {
      const hang = mention("HANG goose please");
      await waitFor(() => prompted(hang), "goose hang prompted");
      const stop = await extra.api("POST", `/v1/agents/${agent}/interrupt`, { channelId: channel, threadRootId: hang.id });
      check("goose: interrupt gives {interrupted:true}", stop.status === 200 && stop.json?.interrupted === true, stop.text);
      await waitFor(() => goose().some((line) => line.type === "cancelled" && line.session === prompted(hang)?.session), "goose cancelled");
      check("goose: goose-acp got session/cancel for that session", goose().some((line) => line.type === "cancel" && line.session === prompted(hang)?.session));
      const turnId = await waitFor(() => ctx.turnOf(agent, hang.id), "goose hang turn", ctx.TELEMETRY_WAIT_MS);
      const cancelled = await waitFor(
        () => ctx.frames(agent).find((frame) => frame.turnId === turnId && frame.kind === "acp_read" && frame.payload.result?.stopReason),
        "goose cancelled frame",
        ctx.TELEMETRY_WAIT_MS,
      );
      check("goose: the interrupted prompt ends with stopReason cancelled", cancelled.payload.result.stopReason === "cancelled", JSON.stringify(cancelled.payload));
      await sleep(500);
      check("goose: an interrupted turn posts no failure", !failureIn(hang.id));
    });

    await step("goose: the MCP server refuses what is not its session", async () => {
      const session = prompted(first)?.session;
      const saved = JSON.parse(readFileSync(join(gooseState, `mcp-${session}.json`), "utf8"));
      const token = saved.headers[0].value;
      const base = { authorization: token, "content-type": "application/json", "mcp-session-id": saved.session };
      const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
      const right = await post(saved.url, base, list);
      check("goose: with token and session id it answers (200, JSON, no-store)", right.status === 200 && right.headers["content-type"] === "application/json" && right.headers["cache-control"] === "no-store", `${right.status}`);
      const wrongToken = await post(saved.url, { ...base, authorization: `Bearer ${"A".repeat(43)}` }, list);
      check("goose: a wrong token gives 404, never 401/403", wrongToken.status === 404, `${wrongToken.status}`);
      const noToken = await post(saved.url, { "content-type": "application/json", "mcp-session-id": saved.session }, list);
      check("goose: no token gives 404", noToken.status === 404, `${noToken.status}`);
      const origin = await post(saved.url, { ...base, origin: "http://evil.example" }, list);
      check("goose: a request with Origin gives 404", origin.status === 404, `${origin.status}`);
      const path = await post(saved.url.replace(/\/mcp$/, "/other"), base, list);
      check("goose: another path gives 404", path.status === 404, `${path.status}`);
      const host = await post(saved.url, { ...base, host: "localhost" }, list);
      check("goose: a Host that is not the bound address gives 404", host.status === 404, `${host.status}`);
      const get = await post(saved.url, base, undefined, "GET");
      check("goose: GET gives 405 with Allow: POST", get.status === 405 && get.headers.allow === "POST", `${get.status} ${get.headers.allow}`);
      const text = await post(saved.url, { ...base, "content-type": "text/plain" }, list);
      check("goose: a non-JSON body type gives 415", text.status === 415, `${text.status}`);
      const noSession = await post(saved.url, { authorization: token, "content-type": "application/json" }, list);
      check("goose: a claimed server refuses a request without the session id (404)", noSession.status === 404, `${noSession.status}`);
      const otherSession = await post(saved.url, { ...base, "mcp-session-id": "x".repeat(43) }, list);
      check("goose: a wrong session id gives 404", otherSession.status === 404, `${otherSession.status}`);
      const big = await post(saved.url, { ...base, "content-length": String(5 * 1024 * 1024) }, undefined, "POST", true);
      check("goose: a body over 4 MiB gives 413", big.status === 413, `${big.status}`);
      // A second initialize: two clients hold the token, so the server stops.
      const again = await post(saved.url, { authorization: token, "content-type": "application/json" }, { jsonrpc: "2.0", id: 2, method: "initialize", params: {} });
      check("goose: a second initialize gives 404", again.status === 404, `${again.status}`);
      const after = await post(saved.url, base, list).catch((error) => ({ status: 0, error: String(error) }));
      check("goose: after it the server is gone", after.status === 0, `${after.status}`);
      await waitFor(() => goose().some((line) => line.type === "close" && line.session === session), "stopped session closed", MCP_WAIT_MS);
      check("goose: the session whose server stopped is closed in goose-acp", true);
      const next = mention("goose after stop", first.id);
      await waitFor(() => replyTo(next), "goose reply after server stop");
      check("goose: the next message opens a new session and answers", prompted(next)?.session && prompted(next).session !== session, JSON.stringify([session, prompted(next)?.session]));
      check("goose: the MCP server logged nothing about refused requests", !runnerLines().some((line) => /mcp/.test(line.component ?? "") && line.level !== "info"), JSON.stringify(runnerLines().filter((line) => line.component === "mcp")));
    });

    await step("goose: a crashed goose-acp fails its turn; the next message starts another", async () => {
      const pidBefore = starts().filter((line) => line.agent === agent).at(-1)?.pid;
      const crash = mention("CRASH goose please");
      await waitFor(() => failureIn(crash.id), "goose crash failure post");
      check("goose: the turn of a process that crashed is reported", true);
      check("goose: the crashed process is gone", !alive(pidBefore));
      const after = mention("goose after crash");
      await waitFor(() => replyTo(after), "goose reply after crash");
      const host = starts().filter((line) => line.agent === agent).at(-1);
      check("goose: the next message starts a new goose-acp", host && host.pid !== pidBefore);
    });

    await step("goose: an agent moves from Claude to Goose", async () => {
      const moved = await extra.api("POST", "/v1/agents", { name: "Goose mover", community: relayUrl });
      const pk = moved.json?.pubkey;
      const on = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Goose mover", community: relayUrl, auth: authTag(ownerSecret, pk), config: { instructions: "" } });
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "goose mover AUTH");
      const put = await extra.api("PUT", `/v1/agents/${pk}/config`, { instructions: "", harness: GOOSE_HARNESS });
      check("goose: activate on Claude, then PUT harness goose (no model) gives 204", on.status === 204 && put.status === 204, put.text);
      const event = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "mover on goose", now() + 1);
      relay.inject(event);
      const reply = await waitFor(
        () => relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === pk && item.event.content.startsWith(`${GOOSE_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`)),
        "mover reply from goose",
      );
      const turn = goose().find((line) => line.type === "prompt" && line.request === event.id);
      check("goose: the moved agent's next turn runs on Goose's configured model", Boolean(reply) && turn?.provider === "anthropic" && turn.model === "claude-x", JSON.stringify(turn));
    });
  } finally {
    await ctx.stopHarnessRunner("goose", "goose-acp", extra, starts);
  }
  const known = tokens();
  check("goose: MCP tokens were captured for the leak checks", known.length > 0, `${known.length}`);
  for (const [label, path] of [
    ["fake-goose log", gooseLog],
    ["Goose sudo log", sudoLog],
    ["Goose runner log", runnerLog],
  ]) {
    const text = readFileSync(path, "utf8");
    if (secret) check(`goose: agent key absent from the ${label}`, !text.includes(secret));
    check(`goose: MCP tokens absent from the ${label}`, known.every((token) => !text.includes(token)));
  }
  const feed = JSON.stringify(ctx.frames(agent));
  check("goose: MCP tokens absent from every telemetry frame", feed.length > 0 && known.every((token) => !feed.includes(token)));
  // #lizard forgives: one scenario list that must read in run order
}

/** One raw HTTP request, with headers exactly as given. */
function post(url, headers, body, method = "POST", noBody = false) {
  const target = new URL(url);
  const text = body === undefined ? "" : JSON.stringify(body);
  const sent = { ...headers };
  if (!noBody && !("content-length" in sent)) sent["content-length"] = String(Buffer.byteLength(text));
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: target.hostname, port: target.port, path: target.pathname, method, headers: sent, agent: false, timeout: MCP_WAIT_MS }, (res) => {
      let out = "";
      res.setEncoding("utf8").on("data", (chunk) => (out += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: out }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (noBody) req.end();
    else req.end(text);
  });
}
