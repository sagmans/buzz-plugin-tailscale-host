// Codex scenarios of the smoke run: a runner whose generic harness wrapper
// (a stand-in for deploy/harness-wrapper) starts fake-codex.mjs, so the whole
// path runs as on the host: readiness by `--path`, model discovery through
// buzz-app's `AppServer` and `listModels`, turns through the runner's Codex
// engine, the Buzz tools as dynamic tools answered in the runner, thread
// resume across processes, typing, telemetry, steer, interrupt with its
// background-terminal cleanup, refused approvals, failure reports, a crash,
// a lost rollout and a graceful stop.
//
// Called from run.mjs with its helpers; adds PASS/FAIL lines through `check`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = resolve(HERE, "fake-codex.mjs");
const CODEX_HARNESS = "codex";
const CLAUDE_HARNESS = "claude-code";
/** What fake-codex lists, over two pages. */
const CODEX_MODEL_IDS = ["gpt-x", "gpt-mini"];
const CODEX_CURRENT = "gpt-x";
const CODEX_EFFORT_IDS = ["low", "medium", "high"];
const CODEX_RESTING = "medium";
/** What the Codex agent is set to run with. */
const CODEX_PICK = { model: "gpt-x", effort: "high" };
const CODEX_REPLY_PREFIX = "codex reply: to ";
const CODEX_STEERED = "(steered)";
const REQUEST_CHARS = 12;
const DISCOVERY_AGENT = "0".repeat(64);
/** What the engine answers a tool call that is not from a running turn. */
const STRAY_REFUSAL = "No active Buzz tool for this thread and turn";
/** JSON-RPC "method not found": every approval request gets it. */
const METHOD_NOT_FOUND = -32601;

/** Runs the Codex scenarios. `ctx` carries run.mjs's helpers and fixtures. */
export async function codexSmoke(ctx) {
  const { temp, relay, relayUrl, ownerSecret, owner, channel, check, step, waitFor, sleep, lines, alive, sign, authTag, now } = ctx;
  const dir = join(temp, "codex-fixtures");
  mkdirSync(dir, { mode: 0o700 });
  const sudoLog = join(dir, "sudo-argv.log");
  const codexLog = join(dir, "fake-codex.log");
  const codexState = join(dir, "codex-state");
  mkdirSync(codexState, { mode: 0o700 });
  const sudo = join(dir, "fake-sudo");
  writeFileSync(sudo, readFileSync(ctx.fakeSudo, "utf8").replace(ctx.sudoLog, sudoLog), { mode: 0o755 });
  const install = join(dir, "installs", "codex", "bin", "codex");
  mkdirSync(dirname(install), { recursive: true });
  writeFileSync(install, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  // The generic wrapper's stand-in, with harness-wrapper's argument rules:
  // a fixed id list, `--path`, a 64-hex agent, and no arguments for Codex.
  const wrapper = join(dir, "fake-harness-wrapper");
  writeFileSync(
    wrapper,
    [
      "#!/bin/sh",
      'harness=$1; target=$2; shift 2',
      `case "$harness" in codex) install='${install}' ;; *) echo "unknown harness" >&2; exit 64 ;; esac`,
      'if [ "$target" = "--path" ]; then printf \'%s\\n\' "$install"; exit 0; fi',
      'printf \'%s\' "$target" | grep -Eq \'^[0-9a-f]{64}$\' || { echo "bad agent" >&2; exit 64; }',
      '[ $# -eq 0 ] || { echo "codex takes no arguments" >&2; exit 64; }',
      `exec /usr/bin/env -i PATH=/usr/bin:/bin HOME='${dir}' CODEX_HOME='${dir}/codex-home' FAKE_CODEX_LOG='${codexLog}' FAKE_CODEX_STATE='${codexState}' '${process.execPath}' '${FAKE_CODEX}' "$target"`,
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const harnesses = { [CLAUDE_HARNESS]: {}, [CODEX_HARNESS]: { path: install } };
  const codex = () => lines(codexLog);
  const starts = () => codex().filter((line) => line.type === "start");

  const extra = await ctx.startExtra("codex", 0, { sudo, harnessWrapper: wrapper, harnesses, maxParallelTurns: 4 });
  const runnerLog = join(temp, "codex", "runner.log");
  const runnerLines = () => lines(runnerLog);
  let agent;
  let secret;
  try {
    await step("codex: readiness by the wrapper's --path", async () => {
      const listed = await extra.api("GET", "/v1/harnesses");
      const view = listed.json?.harnesses?.find((item) => item.id === CODEX_HARNESS);
      check("codex: listed supported, installed and ready", view?.supported && view.installed && view.ready && view.state === "ready" && view.title === "Codex", JSON.stringify(view));
      check("codex: readiness ran `sudo -n -u buzz-agent -- <harness wrapper> codex --path`", readFileSync(sudoLog, "utf8").includes(`-n -u buzz-agent -- ${wrapper} codex --path`));
      check("codex: readiness started no app-server", starts().length === 0);
    });

    await step("codex: models from a discovery app-server", async () => {
      const models = await extra.api("GET", `/v1/harnesses/${CODEX_HARNESS}/models`);
      const list = models.json?.models ?? [];
      check("codex: models are every page of Codex's model/list, in order", models.status === 200 && JSON.stringify(list.map((item) => item.id)) === JSON.stringify(CODEX_MODEL_IDS), models.text);
      check("codex: current model is Codex's recommended one", models.json?.current === CODEX_CURRENT, models.text);
      const main = list.find((item) => item.id === CODEX_CURRENT);
      check(
        "codex: a model's reasoning efforts carry Desktop's labels, resting at Codex's default",
        JSON.stringify(main?.efforts.map((item) => item.id)) === JSON.stringify(CODEX_EFFORT_IDS) && main?.effort === CODEX_RESTING && main.label === "GPT X" && Boolean(main.efforts[0]?.label),
        JSON.stringify(main),
      );
      const plain = list.find((item) => item.id === "gpt-mini");
      check("codex: a model without efforts or a name lists its id and no effort", plain?.efforts.length === 0 && plain.effort === undefined && plain.label === "gpt-mini", JSON.stringify(plain));
      const probes = starts();
      check("codex: discovery ran the wrapper with the discovery key and no arguments", probes.length === 1 && JSON.stringify(probes[0].argv) === JSON.stringify([DISCOVERY_AGENT]), JSON.stringify(probes.map((line) => line.argv)));
      check("codex: discovery initialized with the experimental API", codex().some((line) => line.type === "initialize" && line.experimental && line.pid === probes[0]?.pid));
      await waitFor(() => probes.every((line) => !alive(line.pid)), "codex discovery process stops");
      check("codex: the discovery process stopped after listing, and started no thread", probes.every((line) => !alive(line.pid)) && !codex().some((line) => line.type === "thread"));
    });

    // --- turns ------------------------------------------------------------------
    const made = await extra.api("POST", "/v1/agents", { name: "Codex agent", community: relayUrl });
    agent = made.json?.pubkey;
    secret = JSON.parse(readFileSync(join(temp, "codex", "state", "agents", `${agent}.json`), "utf8")).secretKey;
    const threadsFile = join(codexState, `threads-${agent}.json`);
    const replies = () => relay.published.filter((item) => item.event.kind === 9 && item.event.pubkey === agent);
    const replyTo = (event) => replies().find((item) => item.event.content.startsWith(`${CODEX_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`));
    const failureIn = (root) =>
      replies().find((item) => item.event.content === ctx.FAILURE_MESSAGE && item.event.tags.some((t) => t[0] === "e" && t[1] === root));
    const turnOf = (event) => codex().find((line) => line.type === "turn" && line.request === event.id);
    const mention = (text, root) => {
      const event = sign(ownerSecret, 9, [["h", channel], ["p", agent], ...(root ? [["e", root, "", "reply"]] : [])], text, now() + 1);
      relay.inject(event);
      return event;
    };
    const hostOf = (pid) => starts().find((line) => line.pid === pid);
    let first;

    await step("codex: activate and a first turn", async () => {
      const on = await extra.api("POST", `/v1/agents/${agent}/activate`, {
        name: "Codex agent",
        community: relayUrl,
        auth: authTag(ownerSecret, agent),
        config: { instructions: "Be brief.", harness: CODEX_HARNESS, ...CODEX_PICK },
      });
      check("codex: activate with harness codex, a Codex model and effort gives 204", on.status === 204, on.text);
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === agent), "codex AUTH");
      const before = starts().length;
      first = mention("hello codex");
      const reply = await waitFor(() => replyTo(first), "codex reply");
      check(
        "codex: the reply lands in the event's thread and channel",
        reply.event.tags.some((t) => t[0] === "h" && t[1] === channel) && reply.event.tags.some((t) => t[0] === "e" && t[1] === first.id),
        JSON.stringify(reply.event.tags),
      );
      const fresh = starts().slice(before);
      const host = fresh.find((line) => line.agent === agent);
      check("codex: one app-server started for the agent, wrapper argv is only its pubkey", host && JSON.stringify(host.argv) === JSON.stringify([agent]) && fresh.length === 1, JSON.stringify(fresh.map((line) => line.argv)));
      check("codex: sudo argv is -n -u buzz-agent -- <harness wrapper> codex <agentPk>, nothing more", readFileSync(sudoLog, "utf8").split("\n").includes(`-n -u buzz-agent -- ${wrapper} codex ${agent}`), readFileSync(sudoLog, "utf8"));
      check("codex: app-server env has no runner variables", host && !host.env.some((key) => key.startsWith("BUZZ")), JSON.stringify(host?.env));
      const turn = turnOf(first);
      const thread = codex().find((line) => line.type === "thread" && line.thread === turn?.thread);
      check("codex: config/read names the agent workspace", codex().some((line) => line.type === "config" && line.pid === host?.pid && line.cwd === join(ctx.workspaceRoot, agent)));
      check("codex: the new thread runs in the agent workspace on the picked model", thread?.cwd === join(ctx.workspaceRoot, agent) && thread.model === CODEX_PICK.model, JSON.stringify(thread));
      check(
        "codex: the thread never asks and has full access (approvalPolicy never, danger-full-access)",
        thread?.approvalPolicy === "never" && thread.sandbox === "danger-full-access",
        JSON.stringify(thread),
      );
      check("codex: developer instructions name the agent", thread?.identity === true, JSON.stringify(thread));
      check(
        "codex: web search, plugins and apps are off; inherited MCP servers are disabled",
        thread?.webSearch === "disabled" && thread.plugins === false && thread.apps === false && JSON.stringify(thread.inherited) === JSON.stringify({ command: "/bin/true", enabled: false }),
        JSON.stringify(thread),
      );
      check(
        "codex: the Buzz tools are dynamic functions in the buzz namespace: send and memory, no attention tools",
        thread?.namespace === "buzz" && thread.functions && !thread.deferred && thread.tools.includes("send") && thread.tools.includes("mem_get") && !thread.tools.some((name) => ctx.ATTENTION_TOOLS.includes(name)),
        JSON.stringify(thread?.tools),
      );
      check("codex: the thread is named for the conversation", codex().some((line) => line.type === "name" && line.thread === turn?.thread && typeof line.name === "string" && line.name.startsWith("Codex agent")), JSON.stringify(codex().filter((line) => line.type === "name")));
      check(
        "codex: the turn carries the event, the picked effort and summaries",
        turn?.identity && turn.model === CODEX_PICK.model && turn.effort === CODEX_PICK.effort && turn.summary === "auto",
        JSON.stringify(turn),
      );
      check("codex: the turn's application context has the agent and its instructions", turn?.contextKeys.includes("buzz.instructions") && turn.brief && turn.named, JSON.stringify(turn));
      const tool = await waitFor(() => codex().find((line) => line.type === "tool" && line.thread === turn?.thread), "codex send logged");
      check("codex: send as a dynamic tool ran in the runner without error", tool?.success === true, JSON.stringify(tool));
      const stray = await waitFor(() => codex().find((line) => line.type === "stray" && line.thread === turn?.thread), "codex stray logged");
      check("codex: a tool call from a turn that is not running is refused", stray?.success === false && stray.said === STRAY_REFUSAL, JSON.stringify(stray));
      check("codex: no stray message was posted", !replies().some((item) => item.event.content === "stray"));
      await waitFor(() => codex().some((line) => line.type === "unsubscribe" && line.thread === turn?.thread), "codex unsubscribe");
      check("codex: the thread is let go after its turn", true);
      check("codex: typing pulses sent for the turn", ctx.typingFor(agent, first.id).length > 0);
      // #lizard forgives: one scenario list that must read in run order
    });

    await step("codex: telemetry frames for a Codex turn", async () => {
      const turnId = await waitFor(() => ctx.turnOf(agent, first.id), "codex turn_started", ctx.TELEMETRY_WAIT_MS);
      const mine = () => ctx.frames(agent).filter((frame) => frame.turnId === turnId);
      await waitFor(() => mine().some((frame) => frame.kind === "turn_completed"), "codex turn_completed", ctx.TELEMETRY_WAIT_MS);
      const all = mine();
      const thread = turnOf(first)?.thread;
      const resolved = all.filter((frame) => frame.kind === "session_resolved");
      check("codex: session_resolved once, naming the Codex thread, new", resolved.length === 1 && resolved[0].payload.isNewSession === true && resolved[0].payload.sessionId === thread, JSON.stringify(resolved.map((frame) => frame.payload)));
      const prompt = all.find((frame) => frame.kind === "acp_write" && frame.payload.method === "session/prompt");
      check("codex: the prompt is an acp_write session/prompt with the turn text", prompt?.payload.params.sessionId === thread && prompt.payload.params.prompt[0].text.includes("hello codex"), JSON.stringify(prompt?.payload)?.slice(0, 200));
      const updates = all.filter((frame) => frame.kind === "acp_read" && frame.payload.method === "session/update").map((frame) => frame.payload.params.update);
      const think = updates.find((item) => item.sessionUpdate === "tool_call" && item.name === "Thinking");
      const read = updates.find((item) => item.sessionUpdate === "tool_call" && item.name === "Read");
      const send = updates.find((item) => item.sessionUpdate === "tool_call" && item.name === "send");
      check(
        "codex: Codex items become steps with ACP kinds and the codex tool name",
        think?.kind === "think" && read?.kind === "read" && read.title === "Read README.md" && read._meta?.codex?.toolName === "Read" && Boolean(send),
        JSON.stringify([think, read, send]),
      );
      check("codex: text after the final message is not in the ended turn", !updates.some((item) => item.sessionUpdate === "agent_message_chunk"), JSON.stringify(updates.map((item) => item.sessionUpdate)));
      const answer = all.find((frame) => frame.kind === "acp_read" && frame.payload.result?.stopReason);
      check("codex: the prompt is answered with stopReason end_turn", answer?.payload.result.stopReason === "end_turn" && answer.payload.id === prompt?.payload.id, JSON.stringify(answer?.payload));
      check("codex: no tool arguments or approval reach the feed", !all.some((frame) => /requestApproval|item\/tool\/call|dynamicTools/.test(JSON.stringify(frame.payload))));
    });

    await step("codex: follow-up, steer and refused approvals in one thread", async () => {
      const hosts = starts().length;
      const follow = mention("codex follow-up", first.id);
      await waitFor(() => replyTo(follow), "codex follow-up reply");
      const resumed = codex().find((line) => line.type === "resume" && line.thread === turnOf(first)?.thread);
      check("codex: a thread follow-up resumes the same Codex thread", turnOf(follow)?.thread === turnOf(first)?.thread && Boolean(resumed), JSON.stringify([turnOf(first)?.thread, turnOf(follow)?.thread]));
      // Codex keeps a thread's dynamic tools; a new tool set files threads anew.
      check("codex: the resumed thread keeps its tools (none sent again) and its settings", resumed?.tools.length === 0 && resumed.approvalPolicy === "never" && resumed.model === CODEX_PICK.model, JSON.stringify(resumed));
      check("codex: the follow-up reuses the live app-server", starts().length === hosts);
      const slow = mention("SLOW codex base", first.id);
      await waitFor(() => turnOf(slow), "codex slow turn");
      mention("codex steer in", first.id);
      const steer = await waitFor(() => codex().find((line) => line.type === "steer"), "codex steer");
      check("codex: a message during a working turn is steered into it (expectedTurnId matches)", steer.ok && steer.text, JSON.stringify(steer));
      const reply = await waitFor(() => replies().find((item) => item.event.content.includes(slow.id.slice(0, REQUEST_CHARS)) && item.event.content.endsWith(CODEX_STEERED)), "codex steered reply");
      check("codex: the working turn answered with the steer folded in", Boolean(reply));
      const turnId = await waitFor(() => ctx.turnOf(agent, slow.id), "codex slow telemetry turn", ctx.TELEMETRY_WAIT_MS);
      const steering = await waitFor(() => ctx.frames(agent).find((frame) => frame.turnId === turnId && frame.payload?.method === "_session/steering"), "codex steer frame", ctx.TELEMETRY_WAIT_MS);
      check("codex: the steer shows as _session/steering", steering.payload.params.sessionId === turnOf(slow)?.thread);
      const ask = mention("ASK codex please", first.id);
      await waitFor(() => replyTo(ask), "codex reply after approval");
      const approval = codex().find((line) => line.type === "approval" && line.thread === turnOf(ask)?.thread);
      check("codex: an approval request is refused (method not found) and the turn goes on", approval?.code === METHOD_NOT_FOUND, JSON.stringify(approval));
      await sleep(500);
      check("codex: none of these messages reports a failure", !failureIn(first.id));
    });

    await step("codex: failures are reported in the thread", async () => {
      const fail = mention("FAIL codex please");
      const failed = await waitFor(() => failureIn(fail.id), "codex failure post");
      check("codex: a failed turn posts the generic failure, tagged to the owner", failed.event.tags.some((t) => t[0] === "p" && t[1] === owner), JSON.stringify(failed.event.tags));
      check("codex: the failure detail is in the runner log", runnerLines().some((line) => line.msg === "turn failed" && line.error === "model said no"), JSON.stringify(runnerLines().filter((line) => line.msg === "turn failed")));
      const quiet = mention("QUIET codex please");
      await waitFor(() => codex().some((line) => line.type === "unsubscribe" && line.thread === turnOf(quiet)?.thread), "codex quiet turn ends");
      await sleep(500);
      check("codex: a turn that ends without a message reports no failure", !failureIn(quiet.id) && !replyTo(quiet));
    });

    await step("codex: owner Stop interrupts a Codex turn and ends its shells", async () => {
      const hang = mention("HANG codex please");
      await waitFor(() => turnOf(hang), "codex hang turn");
      const stop = await extra.api("POST", `/v1/agents/${agent}/interrupt`, { channelId: channel, threadRootId: hang.id });
      check("codex: interrupt gives {interrupted:true}", stop.status === 200 && stop.json?.interrupted === true, stop.text);
      const thread = turnOf(hang)?.thread;
      await waitFor(() => codex().some((line) => line.type === "interrupted" && line.thread === thread), "codex interrupted");
      check("codex: app-server got turn/interrupt for that turn", codex().some((line) => line.type === "interrupt" && line.thread === thread && line.ok));
      await waitFor(() => codex().some((line) => line.type === "terminate" && line.thread === thread), "codex terminal ended");
      check("codex: the stopped turn's background terminal was cleaned and terminated", codex().some((line) => line.type === "clean" && line.thread === thread) && codex().some((line) => line.type === "terminate" && line.processId === "proc-1"));
      const turnId = await waitFor(() => ctx.turnOf(agent, hang.id), "codex hang telemetry turn", ctx.TELEMETRY_WAIT_MS);
      const cancelled = await waitFor(
        () => ctx.frames(agent).find((frame) => frame.turnId === turnId && frame.kind === "acp_read" && frame.payload.result?.stopReason),
        "codex cancelled frame",
        ctx.TELEMETRY_WAIT_MS,
      );
      check("codex: the interrupted prompt ends with stopReason cancelled", cancelled.payload.result.stopReason === "cancelled", JSON.stringify(cancelled.payload));
      await sleep(500);
      check("codex: an interrupted turn posts no failure", !failureIn(hang.id));
    });

    await step("codex: a crashed app-server fails its turn; the thread resumes in the next", async () => {
      const pidBefore = starts().filter((line) => line.agent === agent).at(-1)?.pid;
      const crash = mention("CRASH codex please");
      await waitFor(() => failureIn(crash.id), "codex crash failure post");
      check("codex: the turn of a process that crashed is reported", true);
      check("codex: the crashed process is gone", !alive(pidBefore));
      const after = mention("codex after crash", first.id);
      await waitFor(() => replyTo(after), "codex reply after crash");
      const turn = turnOf(after);
      check("codex: the next message starts a new app-server", turn && turn.pid !== pidBefore && hostOf(turn.pid)?.agent === agent, JSON.stringify(turn));
      check(
        "codex: the new process resumes the conversation's saved thread",
        turn?.thread === turnOf(first)?.thread && codex().some((line) => line.type === "resume" && line.pid === turn.pid && line.thread === turn.thread),
        JSON.stringify([turn?.thread, turnOf(first)?.thread]),
      );
    });

    await step("codex: a lost rollout starts a new thread that is shown the conversation", async () => {
      const lost = turnOf(first)?.thread;
      writeFileSync(threadsFile, "[]");
      const next = mention("codex after a lost rollout", first.id);
      await waitFor(() => replyTo(next), "codex reply after a lost rollout");
      const turn = turnOf(next);
      check("codex: a thread Codex no longer has is replaced, not reported", turn?.thread && turn.thread !== lost && !failureIn(first.id), JSON.stringify([lost, turn?.thread]));
      check("codex: the new thread's prompt carries the conversation again", turn?.fresh === true, JSON.stringify(turn));
      const again = mention("codex on the new thread", first.id);
      await waitFor(() => replyTo(again), "codex reply on the new thread");
      check("codex: later messages resume the new thread", turnOf(again)?.thread === turn?.thread, JSON.stringify([turn?.thread, turnOf(again)?.thread]));
    });

    await step("codex: an agent moves from Claude to Codex", async () => {
      const moved = await extra.api("POST", "/v1/agents", { name: "Codex mover", community: relayUrl });
      const pk = moved.json?.pubkey;
      const on = await extra.api("POST", `/v1/agents/${pk}/activate`, { name: "Codex mover", community: relayUrl, auth: authTag(ownerSecret, pk), config: { instructions: "" } });
      await waitFor(() => relay.auths.find((item) => item.ok && item.event.pubkey === pk), "codex mover AUTH");
      const put = await extra.api("PUT", `/v1/agents/${pk}/config`, { instructions: "", harness: CODEX_HARNESS });
      check("codex: activate on Claude, then PUT harness codex (no model) gives 204", on.status === 204 && put.status === 204, put.text);
      const event = sign(ownerSecret, 9, [["h", channel], ["p", pk]], "mover on codex", now() + 1);
      relay.inject(event);
      const reply = await waitFor(
        () => relay.published.find((item) => item.event.kind === 9 && item.event.pubkey === pk && item.event.content.startsWith(`${CODEX_REPLY_PREFIX}${event.id.slice(0, REQUEST_CHARS)}`)),
        "mover reply from codex",
      );
      const turn = codex().find((line) => line.type === "turn" && line.request === event.id);
      check("codex: the moved agent runs on Codex's recommended model and its default effort", Boolean(reply) && turn?.model === CODEX_CURRENT && turn.effort === CODEX_RESTING, JSON.stringify(turn));
      check("codex: each agent has its own app-server", hostOf(turn?.pid)?.agent === pk, JSON.stringify(hostOf(turn?.pid)));
    });
  } finally {
    await ctx.stopHarnessRunner("codex", "app-server", extra, starts);
  }
  for (const [label, path] of [
    ["fake-codex log", codexLog],
    ["Codex sudo log", sudoLog],
    ["Codex runner log", runnerLog],
  ]) {
    const text = readFileSync(path, "utf8");
    if (secret) check(`codex: agent key absent from the ${label}`, !text.includes(secret));
  }
  if (secret) check("codex: agent key absent from every telemetry frame", !JSON.stringify(ctx.frames(agent)).includes(secret));
  // #lizard forgives: one scenario list that must read in run order
}
