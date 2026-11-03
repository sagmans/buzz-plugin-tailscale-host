// A stand-in for `codex app-server` (Codex 0.164) for the smoke run: the
// JSONL app-server protocol on stdin and stdout, with the calls buzz-app's
// `AppServer` and the runner's Codex engine make (config, paged model list,
// thread start, resume and naming, turns, steer, interrupt, background
// terminals). Like Codex, it calls the Buzz tools as dynamic tools in the
// `buzz` namespace (`item/tool/call`) and sends the reply with `send` itself.
//
// Turn modes, by a word in the prompt's event content:
//   SLOW    answers after SLOW_MS (a steer can join it)
//   HANG    never ends until `turn/interrupt`; leaves a background terminal
//   CRASH   starts the turn, then exits 1
//   FAIL    ends the turn as failed
//   QUIET   ends the turn without a Buzz message
//   ASK     asks an approval first, which the runner must refuse
// The reply text names the event id, so the smoke matches replies to events.
// Threads are kept in FAKE_CODEX_STATE per agent, so a later process resumes
// them, as Codex's rollouts do.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SLOW_MS = 1_500;
const REPLY_PREFIX = "codex reply: to ";
const STEERED = " (steered)";
const REQUEST_CHARS = 12;
const PAGE_CURSOR = "page-2";
const agentArg = process.argv[2] ?? "";
const log = (entry) => {
  if (process.env.FAKE_CODEX_LOG) appendFileSync(process.env.FAKE_CODEX_LOG, `${JSON.stringify({ pid: process.pid, agent: agentArg, ...entry })}\n`);
};
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => write({ method, params });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

log({ type: "start", argv: process.argv.slice(2), env: Object.keys(process.env).filter((key) => !key.startsWith("__")).sort(), cwd: process.cwd() });

/** Codex's catalog: two pages, the first model recommended. */
const MODELS = [
  {
    model: "gpt-x",
    displayName: "GPT X",
    description: "",
    isDefault: true,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
  },
  { model: "gpt-mini", displayName: "", description: "", isDefault: false, defaultReasoningEffort: "", supportedReasoningEfforts: [] },
];

const threadsFile = process.env.FAKE_CODEX_STATE ? join(process.env.FAKE_CODEX_STATE, `threads-${agentArg}.json`) : "";
const known = () => (threadsFile && existsSync(threadsFile) ? JSON.parse(readFileSync(threadsFile, "utf8")) : []);
const keep = (id) => threadsFile && writeFileSync(threadsFile, JSON.stringify([...known(), id]));

/** Loaded threads: their settings and running turn. */
const threads = new Map();
let nextThread = 0;
let nextTurn = 0;
let nextCall = 0;
const waiting = new Map();
/** Background terminals per thread, as a stopped command leaves them. */
const terminals = new Map();

/** Asks the client and waits for its answer. */
function ask(method, params) {
  const id = `c${++nextCall}`;
  write({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

function load(id, params, resumed) {
  const thread = { id, cwd: params.cwd, turn: undefined };
  threads.set(id, thread);
  const namespace = (params.dynamicTools ?? []).find((entry) => entry.type === "namespace");
  log({
    type: resumed ? "resume" : "thread",
    thread: id,
    cwd: params.cwd,
    model: params.model,
    approvalPolicy: params.approvalPolicy,
    sandbox: params.sandbox,
    identity: (params.developerInstructions ?? "").includes(agentArg),
    namespace: namespace?.name,
    tools: (namespace?.tools ?? []).map((tool) => tool.name),
    functions: (namespace?.tools ?? []).every((tool) => tool.type === "function" && tool.inputSchema),
    deferred: (namespace?.tools ?? []).some((tool) => tool.deferLoading),
    webSearch: params.config?.web_search,
    inherited: params.config?.mcp_servers?.inherited ?? null,
    plugins: params.config?.["features.plugins"],
    apps: params.config?.["features.apps"],
  });
  return { thread: { id, cwd: params.cwd } };
}

async function turn(id, params) {
  const thread = threads.get(params.threadId);
  if (!thread) return write({ id, error: { code: -32602, message: "thread not loaded" } });
  if (thread.turn) return write({ id, error: { code: -32602, message: "turn already running" } });
  const text = (params.input ?? []).map((block) => block.text ?? "").join("\n");
  const events = [...text.matchAll(/Event ID: ([0-9a-f]{64})/g)].map((match) => match[1]);
  const request = events.at(-1) ?? "";
  const content = text.match(/^Content: (.*)$/gm)?.at(-1) ?? "";
  const context = Object.values(params.additionalContext ?? {}).map((value) => value.value ?? "").join("");
  const run = { id: `turn-${process.pid}-${++nextTurn}`, steered: false, interrupt: undefined };
  thread.turn = run;
  log({
    type: "turn",
    thread: thread.id,
    turn: run.id,
    request,
    model: params.model,
    effort: params.effort,
    summary: params.summary,
    identity: text.includes("Event ID:"),
    fresh: text.includes("hello codex"),
    contextKeys: Object.keys(params.additionalContext ?? {}),
    brief: context.includes("Be brief."),
    named: context.includes(`pubkey ${agentArg}`),
  });
  write({ id, result: { turn: { id: run.id, status: "inProgress" } } });
  notify("turn/started", { threadId: thread.id, turn: { id: run.id, status: "inProgress" } });
  const end = (status, error) => {
    if (thread.turn === run) thread.turn = undefined;
    notify("turn/completed", { threadId: thread.id, turn: { id: run.id, status, ...(error ? { error: { message: error } } : {}) } });
  };
  if (content.includes("CRASH")) {
    log({ type: "crash", thread: thread.id });
    process.exit(1);
  }
  if (content.includes("FAIL")) return end("failed", "model said no");
  if (content.includes("ASK")) {
    const answer = await ask("item/commandExecution/requestApproval", { threadId: thread.id, turnId: run.id, itemId: "a1" });
    log({ type: "approval", thread: thread.id, code: answer?.error?.code ?? null });
  }
  notify("item/started", { threadId: thread.id, turnId: run.id, item: { type: "reasoning", id: "r1" } });
  notify("item/started", {
    threadId: thread.id,
    turnId: run.id,
    item: { type: "commandExecution", id: "x1", command: "/bin/bash -lc 'cat README.md'", commandActions: [{ type: "read", name: "README.md", path: "README.md" }] },
  });
  notify("item/completed", { threadId: thread.id, turnId: run.id, item: { type: "commandExecution", id: "x1", command: "cat README.md", aggregatedOutput: "readme" } });
  if (content.includes("HANG")) {
    terminals.set(thread.id, ["proc-1"]);
    await new Promise((resolve) => (run.interrupt = resolve));
    log({ type: "interrupted", thread: thread.id });
    return end("interrupted");
  }
  if (content.includes("SLOW")) await sleep(SLOW_MS);
  if (!content.includes("QUIET")) {
    const words = `${REPLY_PREFIX}${request.slice(0, REQUEST_CHARS)}${run.steered ? STEERED : ""}`;
    notify("item/started", { threadId: thread.id, turnId: run.id, item: { type: "dynamicToolCall", id: "t1", tool: "send" } });
    const answer = await ask("item/tool/call", {
      threadId: thread.id,
      turnId: run.id,
      callId: "call-1",
      namespace: "buzz",
      tool: "send",
      arguments: { text: words, audience: "everyone", final: true },
    });
    log({ type: "tool", thread: thread.id, name: "send", success: answer?.result?.success === true, said: String(answer?.result?.contentItems?.[0]?.text ?? answer?.error?.message ?? "").slice(0, 300) });
    // A call from a turn that is not running is refused.
    const stray = await ask("item/tool/call", { threadId: thread.id, turnId: "turn-none", callId: "call-2", namespace: "buzz", tool: "send", arguments: { text: "stray", final: true } });
    log({ type: "stray", thread: thread.id, success: stray?.result?.success === true, said: String(stray?.result?.contentItems?.[0]?.text ?? "").slice(0, 200) });
  }
  notify("item/completed", { threadId: thread.id, turnId: run.id, item: { type: "agentMessage", id: "m1", text: "codex says done" } });
  end("completed");
  // #lizard forgives: mirrors one upstream protocol handler branch for branch
}

const methods = {
  initialize: (params) => {
    log({ type: "initialize", experimental: params.capabilities?.experimentalApi === true, client: params.clientInfo?.name });
    return { userAgent: "fake-codex/0.164.0" };
  },
  "config/read": ({ cwd }) => {
    log({ type: "config", cwd });
    return { config: { mcp_servers: { inherited: { command: "/bin/true" } }, model_reasoning_summary: null } };
  },
  "model/list": ({ cursor }) => (cursor === PAGE_CURSOR ? { data: [MODELS[1]], nextCursor: null } : { data: [MODELS[0]], nextCursor: PAGE_CURSOR }),
  "thread/start": (params) => {
    const id = `th-${process.pid}-${++nextThread}`;
    keep(id);
    return load(id, params, false);
  },
  "thread/resume": (params) => {
    if (!known().includes(params.threadId)) throw new Error(`no rollout found for thread id ${params.threadId}`);
    return load(params.threadId, params, true);
  },
  "thread/name/set": ({ threadId, name }) => {
    log({ type: "name", thread: threadId, name });
    return {};
  },
  "thread/unsubscribe": ({ threadId }) => {
    log({ type: "unsubscribe", thread: threadId });
    threads.delete(threadId);
    return {};
  },
  "turn/steer": ({ threadId, expectedTurnId, input }) => {
    const run = threads.get(threadId)?.turn;
    log({ type: "steer", thread: threadId, ok: Boolean(run && run.id === expectedTurnId), text: (input ?? []).map((block) => block.text ?? "").join("").includes("new-message") });
    if (!run) throw new Error("no active turn to steer");
    if (run.id !== expectedTurnId) throw new Error("expected turn mismatch");
    run.steered = true;
    return {};
  },
  "turn/interrupt": ({ threadId, turnId }) => {
    const run = threads.get(threadId)?.turn;
    log({ type: "interrupt", thread: threadId, ok: run?.id === turnId });
    run?.interrupt?.();
    return {};
  },
  "thread/backgroundTerminals/clean": ({ threadId }) => {
    log({ type: "clean", thread: threadId });
    return {};
  },
  "thread/backgroundTerminals/list": ({ threadId }) => ({ data: (terminals.get(threadId) ?? []).map((processId) => ({ processId })), nextCursor: null }),
  "thread/backgroundTerminals/terminate": ({ threadId, processId }) => {
    log({ type: "terminate", thread: threadId, processId });
    terminals.set(threadId, (terminals.get(threadId) ?? []).filter((id) => id !== processId));
    return {};
  },
};

createInterface({ input: process.stdin })
  .on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.method === undefined) {
      const resolve = waiting.get(message.id);
      waiting.delete(message.id);
      resolve?.(message);
      return;
    }
    if (message.id === undefined) {
      log({ type: "notification", method: message.method });
      return;
    }
    log({ type: "request", method: message.method });
    if (message.method === "turn/start") return void turn(message.id, message.params ?? {});
    const handler = methods[message.method];
    if (!handler) return write({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
    Promise.resolve()
      .then(() => handler(message.params ?? {}))
      .then(
        (result) => write({ id: message.id, result }),
        (error) => write({ id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }),
      );
  })
  .on("close", () => {
    log({ type: "exit" });
    process.exit(0);
  });
