// A stand-in for buzz-app's Pi host (bundled/pi/host.mjs) for the smoke run:
// the same line protocol (`ready`, requests both ways, `event` notifies) and
// the methods buzz-runner's Pi engine and model discovery call. It keeps a
// small state file per agent, so a host started later finds the runs and
// places an earlier one left, as Pi durable's SQLite storage does.
//
// Turn modes, by a word in the delivered text:
//   SLOW   answers after SLOW_MS (a steer can join it)
//   HANG   never answers until interrupted or aborted
//   CRASH  takes the turn, then exits 1 (the run stays unfinished)
//   FAIL   leaves the request unanswered with a detail
//   NOMODEL  rejects as the host does for an agent with no model
// Every tool call names a context that is NOT the delivered one, so the
// smoke can check the runner posts where its own context says. The reply
// text names the request id, so the smoke matches replies to events.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SLOW_MS = 1_500;
const PREFIX_REPLY = "pi reply: ";
const REQUEST_PREFIX = "to ";
const REQUEST_CHARS = 12;
const BOGUS_CONTEXT = { channel: "00000000-0000-4000-8000-000000000000" };
const agentArg = process.argv[2] ?? "";
const log = (entry) => {
  if (process.env.FAKE_PI_LOG) appendFileSync(process.env.FAKE_PI_LOG, `${JSON.stringify({ pid: process.pid, agent: agentArg, ...entry })}\n`);
};
const statePath = (agent) => join(process.env.FAKE_PI_STATE ?? ".", `${agent}.json`);
const load = (agent) => (existsSync(statePath(agent)) ? JSON.parse(readFileSync(statePath(agent), "utf8")) : { places: {}, unfinished: [], next: 1 });
const save = (agent, state) => writeFileSync(statePath(agent), JSON.stringify(state));
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

log({
  type: "start",
  argv: process.argv.slice(2),
  env: Object.keys(process.env).filter((key) => !key.startsWith("__")).sort(),
  piDir: process.env.PI_CODING_AGENT_DIR,
});

const opened = new Set();
/** Runs working now, by conversation key. */
const runs = new Map();
/** Submissions and how each settles. */
const waiting = new Map();
let calls = 0;
const pending = new Map();
const call = (method, params) =>
  new Promise((resolve, reject) => {
    const id = `h${++calls}`;
    pending.set(id, { resolve, reject });
    write({ id, method, params });
  });

const DEFAULTS = { provider: "anthropic", model: "claude-x", thinking: "high" };
const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", key: true, signsIn: true, configured: "auth.json" },
  { id: "openai", name: "OpenAI", key: true, signsIn: true },
];
const MODELS = {
  anthropic: [
    { id: "claude-x", name: "Claude X", thinking: ["off", "low", "medium", "high"] },
    { id: "tiny", name: "Tiny", thinking: [] },
  ],
  openai: [{ id: "gpt-x", name: "GPT X", thinking: ["low"] }],
};

function settle(submission, result) {
  const entry = waiting.get(submission);
  if (!entry || entry.result) return;
  entry.result = result;
  for (const resolve of entry.waiters) resolve(result);
  const state = load(entry.agent);
  state.unfinished = state.unfinished.filter((item) => item.submission !== submission);
  save(entry.agent, state);
}

function finish(key, result) {
  const run = runs.get(key);
  if (!run) return;
  runs.delete(key);
  for (const submission of run.submissions) settle(submission, result);
}

async function run(agent, key, conversation, text, request) {
  log({ type: "run", key });
  write({ method: "event", params: { agent, conversation, type: "step", tool: "Thinking" } });
  const mode = /\b(SLOW|HANG|CRASH|FAIL)\b/.exec(text)?.[1];
  if (mode === "CRASH") {
    log({ type: "crash", key });
    process.exit(1);
  }
  if (mode === "HANG") return;
  if (mode === "SLOW") await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  if (!runs.has(key)) return;
  if (mode === "FAIL") return finish(key, { status: "unanswered", reason: "error", detail: "provider said no" });
  write({ method: "event", params: { agent, conversation, type: "step", tool: "bash", target: "ls -la" } });
  // The reply names the request, so the smoke can match it to its event.
  const words = `${REQUEST_PREFIX}${String(request).slice(0, REQUEST_CHARS)}`;
  const steered = runs.get(key)?.submissions.length > 1;
  const result = await call("tool", {
    agent,
    conversation,
    context: BOGUS_CONTEXT,
    name: "send",
    arguments: { text: `${PREFIX_REPLY}${words}${steered ? " (steered)" : ""}`, audience: "everyone", final: true },
  }).catch((error) => ({ error: String(error) }));
  log({ type: "tool", key, name: "send", isError: Boolean(result?.isError || result?.error), final: result?.final === true, contextSent: BOGUS_CONTEXT, said: String(result?.content?.[0]?.text ?? result?.error ?? "").slice(0, 300) });
  finish(key, { status: "done", text: `${PREFIX_REPLY}${words}` });
}

const methods = {
  // A `signed-out` file in FAKE_PI_STATE stands for an auth.json without
  // credentials: no provider is configured and Pi's settings pick nothing.
  providers: () =>
    existsSync(join(process.env.FAKE_PI_STATE ?? ".", "signed-out"))
      ? { providers: PROVIDERS.map(({ configured: _configured, ...provider }) => provider), defaults: {} }
      : { providers: PROVIDERS, defaults: DEFAULTS },
  defaults: () => DEFAULTS,
  models: ({ provider }) => MODELS[provider] ?? [],
  open({ agent, tools, hint }) {
    opened.add(agent);
    log({ type: "open", tools: tools.map((tool) => tool.name), loads: [...new Set(tools.map((tool) => tool.load))], hint });
    return {};
  },
  unfinished({ agent }) {
    if (!opened.has(agent)) throw new Error("The agent is not open");
    return { submissions: load(agent).unfinished };
  },
  drop({ agent, submissions }) {
    const state = load(agent);
    const ids = new Set(submissions.map((item) => item.submission));
    state.unfinished = state.unfinished.filter((item) => !ids.has(item.submission));
    save(agent, state);
    log({ type: "drop", submissions: [...ids] });
    return {};
  },
  place({ agent, key }) {
    if (!opened.has(agent)) throw new Error("The agent is not open");
    return { seen: load(agent).places[key]?.seen ?? 0 };
  },
  deliver(params) {
    const { agent, key, at, context, request, text, steer, provider, model, thinking, instructions, cwd, core, pick } = params;
    if (!opened.has(agent)) throw new Error("The agent is not open");
    if (/\bNOMODEL\b/.test(text)) throw new Error("This agent has no model. Choose a provider and model in its Identity tab.");
    const state = load(agent);
    const place = (state.places[key] ??= { conversation: state.next++, seen: 0 });
    const conversation = place.conversation;
    const submission = state.next++;
    const busy = runs.has(key);
    log({
      type: "deliver",
      key,
      conversation,
      request,
      busy,
      provider,
      model,
      thinking,
      cwd,
      pick,
      hasCore: Boolean(core?.text !== undefined && core?.placeholder),
      identity: /You are .+ \(pubkey [0-9a-f]{64}\)/.test(instructions ?? ""),
      context,
      text: text.slice(0, 4000),
      steerDiffers: steer !== text,
      at,
    });
    place.seen = Math.max(place.seen, at);
    state.unfinished.push({ submission, conversation, request });
    save(agent, state);
    waiting.set(submission, { agent, waiters: [], result: undefined });
    write({ method: "event", params: { agent, conversation, type: "placed", request, entry: submission } });
    if (busy) runs.get(key).submissions.push(submission);
    else {
      runs.set(key, { submissions: [submission] });
      void run(agent, key, conversation, text, request);
    }
    return { submission, conversation };
  },
  wait({ submission }) {
    const entry = waiting.get(submission);
    if (!entry) throw new Error("Pi has no record of this request");
    if (entry.result) return entry.result;
    return new Promise((resolve) => entry.waiters.push(resolve));
  },
  abort({ agent, conversation }) {
    for (const [key, place] of Object.entries(load(agent).places))
      if (place.conversation === conversation) finish(key, { status: "unanswered", reason: "aborted" });
    return {};
  },
  session({ key, action }) {
    log({ type: "session", key, action });
    if (action === "interrupt") finish(key, { status: "unanswered", reason: "aborted" });
    return {};
  },
  close: () => ({}),
};

const lines = createInterface({ input: process.stdin });
let launched = false;
lines.on("line", async (line) => {
  if (!launched) {
    launched = true;
    let first;
    try {
      first = JSON.parse(line);
    } catch {
      first = {};
    }
    log({
      type: "launch",
      ok: typeof first.host === "string" && first.host.includes("BUZZ_PI_HOST") && typeof first.package === "string" && typeof first.lock === "string",
      hostBytes: first.host?.length ?? 0,
    });
    write({ method: "ready", params: {} });
    return;
  }
  const message = JSON.parse(line);
  if (!message.method) {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
    return;
  }
  log({ type: "request", method: message.method });
  try {
    const result = await methods[message.method]?.(message.params ?? {});
    if (result === undefined) throw new Error(`Unknown method ${message.method}`);
    write({ id: message.id, result });
  } catch (error) {
    write({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
});
// The runner stops the host with stdin EOF; storage closes first in the real one.
lines.on("close", () => {
  log({ type: "exit" });
  process.exit(0);
});
