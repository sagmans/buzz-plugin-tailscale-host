// A stand-in for `goose-acp` (Goose 1.57) for the smoke run: line-delimited
// JSON-RPC ACP on stdin and stdout, with the Goose extensions buzz-app's
// goose module and `GooseSetup` call (providers, defaults, system prompt,
// steer, per-session config options). Like Goose, it reaches the Buzz tools
// over the HTTP MCP server named in `session/new`, with the Bearer token
// given there, and calls `send` itself.
//
// Turn modes, by a word in the prompt's event content:
//   SLOW   answers after SLOW_MS (a steer can join it)
//   HANG   never answers until `session/cancel`
//   CRASH  starts the turn, then exits 1
//   FAIL   answers the prompt with a JSON-RPC error
// The reply text names the event id, so the smoke matches replies to events.
// For the smoke's refusal checks, each session's MCP address, token and
// session id are written to a file of their own in FAKE_GOOSE_STATE, never
// to the log, so the log can be checked for the token.
import { appendFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";

const SLOW_MS = 1_500;
const REPLY_PREFIX = "goose reply: to ";
const STEERED = " (steered)";
const REQUEST_CHARS = 12;
const MCP_TIMEOUT_MS = 10_000;
const agentArg = process.argv[2] ?? "";
const log = (entry) => {
  if (process.env.FAKE_GOOSE_LOG) appendFileSync(process.env.FAKE_GOOSE_LOG, `${JSON.stringify({ pid: process.pid, agent: agentArg, ...entry })}\n`);
};
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

log({ type: "start", argv: process.argv.slice(2), env: Object.keys(process.env).filter((key) => !key.startsWith("__")).sort(), cwd: process.cwd() });

/** Goose's provider catalog: one configured, one not, one that is another
 * agent, and a local server goose calls configured on its built-in host
 * though nothing listens there (Atomic Chat on localhost:1337 on the host). */
const PROVIDERS = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    defaultModel: "claude-x",
    configured: true,
    visibleInSetup: true,
    models: [{ id: "tiny" }, { id: "claude-x", recommended: true }],
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    defaultModel: "gpt-x",
    configured: false,
    visibleInSetup: true,
    configKeys: [{ name: "OPENAI_API_KEY", required: true, secret: true }],
    models: [{ id: "gpt-x" }],
  },
  { providerId: "claude-acp", providerName: "Claude Code", configured: true, visibleInSetup: true, acp: true, models: [{ id: "default" }] },
  { providerId: "atomic_chat", providerName: "Atomic Chat", configured: true, visibleInSetup: true, models: [] },
];
const DEFAULTS = { providerId: "anthropic", modelId: "claude-x" };
/** Thinking levels per model, and where Goose rests each. */
const LEVELS = { "claude-x": { current: "medium", levels: ["low", "medium", "high"] }, tiny: { current: "", levels: [] }, "gpt-x": { current: "low", levels: ["low"] } };

/** Open sessions: provider, model, level, MCP client and the running turn. */
const sessions = new Map();
let nextSession = 0;
let nextRun = 0;
let nextCall = 0;
const waiting = new Map();

const options = (session) => {
  const level = LEVELS[session.model];
  if (!level?.levels.length) return { configOptions: [] };
  return {
    configOptions: [
      { id: "thinking_effort", category: "thought_level", currentValue: session.effort || level.current, options: level.levels.map((value) => ({ value, name: value })) },
    ],
  };
};

/** One request to a session's MCP server, as Goose's MCP client sends it. */
function mcp(session, message, withSession = true) {
  const url = new URL(session.mcp.url);
  const body = JSON.stringify(message);
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "Content-Length": Buffer.byteLength(body) };
  for (const { name, value } of session.mcp.headers) headers[name] = value;
  if (withSession && session.mcp.session) headers["Mcp-Session-Id"] = session.mcp.session;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, path: url.pathname, method: "POST", headers, agent: false, timeout: MCP_TIMEOUT_MS }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let json;
        try {
          json = text ? JSON.parse(text) : undefined;
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, session: res.headers["mcp-session-id"], json });
      });
    });
    req.on("timeout", () => req.destroy(new Error("mcp timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Connects to the session's Buzz tools, as Goose does while it opens it. */
async function connect(session) {
  const init = await mcp(session, { jsonrpc: "2.0", id: ++nextCall, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-goose", version: "1" } } }, false);
  session.mcp.session = init.session;
  const ready = await mcp(session, { jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await mcp(session, { jsonrpc: "2.0", id: ++nextCall, method: "tools/list" });
  const names = (list.json?.result?.tools ?? []).map((tool) => tool.name);
  log({ type: "mcp", session: session.id, initStatus: init.status, claimed: Boolean(init.session), notifyStatus: ready.status, listStatus: list.status, tools: names });
  if (process.env.FAKE_GOOSE_STATE)
    writeFileSync(join(process.env.FAKE_GOOSE_STATE, `mcp-${session.id}.json`), JSON.stringify({ url: session.mcp.url, headers: session.mcp.headers, session: init.session }), { mode: 0o600 });
}

const update = (session, body) => write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session.id, update: body } });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Asks the client a question and waits for its answer. */
function ask(method, params) {
  const id = `g${++nextCall}`;
  write({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function prompt(id, params) {
  const session = sessions.get(params.sessionId);
  if (!session) return write({ jsonrpc: "2.0", id, error: { code: -32602, message: "no such session" } });
  const text = (params.prompt ?? []).map((block) => block.text ?? "").join("\n");
  const events = [...text.matchAll(/Event ID: ([0-9a-f]{64})/g)].map((match) => match[1]);
  const request = events.at(-1) ?? "";
  const content = text.match(/^Content: (.*)$/gm)?.at(-1) ?? "";
  const run = { id: `run-${++nextRun}`, steered: false, cancel: undefined };
  session.run = run;
  log({ type: "prompt", session: session.id, request, provider: session.provider, model: session.model, effort: session.effort, identity: text.includes("Event ID:"), length: text.length });
  update(session, { sessionUpdate: "session_info_update", _meta: { goose: { activeRunId: run.id } } });
  const end = (result) => {
    if (session.run === run) session.run = undefined;
    update(session, { sessionUpdate: "session_info_update", _meta: { goose: { activeRunId: null } } });
    write({ jsonrpc: "2.0", id, ...result });
  };
  if (content.includes("CRASH")) {
    log({ type: "crash", session: session.id });
    process.exit(1);
  }
  if (content.includes("FAIL")) return end({ error: { code: -32603, message: "provider said no" } });
  if (content.includes("HANG")) {
    await new Promise((resolve) => (run.cancel = resolve));
    log({ type: "cancelled", session: session.id });
    return end({ result: { stopReason: "cancelled" } });
  }
  update(session, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking it over" } });
  const allowed = await ask("session/request_permission", {
    sessionId: session.id,
    toolCall: { toolCallId: `tc-${run.id}`, title: "shell" },
    options: [
      { optionId: "once", kind: "allow_once", name: "Allow" },
      { optionId: "always", kind: "allow_always", name: "Always" },
      { optionId: "no", kind: "reject_once", name: "Reject" },
    ],
  });
  log({ type: "permission", session: session.id, outcome: allowed?.result?.outcome ?? null });
  update(session, { sessionUpdate: "tool_call", toolCallId: `tc-${run.id}`, title: "shell ls -la", kind: "execute", status: "pending", rawInput: { command: "ls -la" } });
  update(session, { sessionUpdate: "tool_call_update", toolCallId: `tc-${run.id}`, status: "completed", content: [{ type: "content", content: { type: "text", text: "total 0" } }] });
  if (content.includes("SLOW")) await sleep(SLOW_MS);
  const words = `${REPLY_PREFIX}${request.slice(0, REQUEST_CHARS)}${run.steered ? STEERED : ""}`;
  let result;
  try {
    const got = await mcp(session, { jsonrpc: "2.0", id: ++nextCall, method: "tools/call", params: { name: "send", arguments: { text: words, audience: "everyone", final: true } } });
    result = { status: got.status, isError: got.json?.result?.isError === true || Boolean(got.json?.error), said: String(got.json?.result?.content?.[0]?.text ?? got.json?.error?.message ?? "").slice(0, 300) };
  } catch (error) {
    result = { status: 0, isError: true, said: String(error) };
  }
  log({ type: "tool", session: session.id, name: "send", ...result });
  update(session, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "sent" } });
  end({ result: { stopReason: "end_turn" } });
  // #lizard forgives: mirrors one upstream protocol handler branch for branch
}

const methods = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } } }),
  "_goose/unstable/providers/list": ({ providerIds = [] }) => ({ entries: providerIds.length ? PROVIDERS.filter((entry) => providerIds.includes(entry.providerId)) : PROVIDERS }),
  "_goose/unstable/defaults/read": () => DEFAULTS,
  "_goose/unstable/config/read": () => ({ value: null }),
  // Only the local server lists live, and nothing answers it.
  "_goose/unstable/providers/supported-models/list": ({ providerId }) => {
    throw new Error(`Failed to fetch provider supported models for ${providerId}: Could not connect to localhost:1337`);
  },
  "session/new": async ({ cwd, mcpServers = [], _meta = {} }) => {
    const provider = _meta.provider || DEFAULTS.providerId;
    const entry = PROVIDERS.find((item) => item.providerId === provider);
    const session = { id: `gs-${process.pid}-${++nextSession}`, cwd, provider, model: entry?.defaultModel ?? "", effort: "" };
    const buzz = mcpServers.find((server) => server.name === "buzz");
    const auth = buzz?.headers?.find((header) => header.name === "Authorization")?.value ?? "";
    log({
      type: "session",
      session: session.id,
      cwd,
      servers: mcpServers.map((server) => ({ type: server.type, name: server.name, local: String(server.url ?? "").startsWith("http://127.0.0.1:") })),
      bearer: auth.startsWith("Bearer ") && auth.length > "Bearer ".length + 40,
      extensions: (_meta.enabledExtensions ?? []).map((item) => item.name ?? item.server?.name ?? item.type),
      title: _meta.sessionTitle,
      provider: _meta.provider,
    });
    sessions.set(session.id, session);
    if (buzz) {
      session.mcp = { url: buzz.url, headers: buzz.headers };
      await connect(session);
    }
    return { sessionId: session.id, ...options(session) };
  },
  "_goose/unstable/session/system-prompt/set": ({ sessionId, mode, key, text }) => {
    log({ type: "system", session: sessionId, mode, key, identity: /pubkey|npub/i.test(text ?? ""), brief: (text ?? "").includes("Be brief.") });
    return {};
  },
  "session/set_config_option": ({ sessionId, configId, value }) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error("no such session");
    log({ type: "config", session: sessionId, configId, value });
    if (configId === "provider") {
      const entry = PROVIDERS.find((item) => item.providerId === value);
      if (!entry) throw new Error(`unknown provider ${value}`);
      session.provider = value;
      session.model = entry.defaultModel;
    } else if (configId === "model") {
      if (!LEVELS[value]) throw new Error(`unknown model ${value}`);
      session.model = value;
    } else if (configId === "thinking_effort") {
      if (!LEVELS[session.model]?.levels.includes(value)) throw new Error(`${session.model} has no level ${value}`);
      session.effort = value;
    }
    return options(session);
  },
  "_goose/unstable/session/steer": ({ sessionId, expectedRunId, prompt: steer }) => {
    const session = sessions.get(sessionId);
    const ok = session?.run && session.run.id === expectedRunId;
    log({ type: "steer", session: sessionId, ok: Boolean(ok), text: (steer ?? []).map((block) => block.text ?? "").join("").includes("new-message") });
    if (!ok) throw new Error("no such run");
    session.run.steered = true;
    return {};
  },
  "session/close": ({ sessionId }) => {
    log({ type: "close", session: sessionId });
    sessions.delete(sessionId);
    return {};
  },
  "session/delete": ({ sessionId }) => {
    log({ type: "delete", session: sessionId });
    sessions.delete(sessionId);
    return {};
  },
};

createInterface({ input: process.stdin }).on("line", (line) => {
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
  if (message.method === "session/cancel") {
    log({ type: "cancel", session: message.params?.sessionId });
    sessions.get(message.params?.sessionId)?.run?.cancel?.();
    return;
  }
  log({ type: "request", method: message.method });
  if (message.method === "session/prompt") return void prompt(message.id, message.params ?? {});
  const handler = methods[message.method];
  if (!handler) return write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `no ${message.method}` } });
  Promise.resolve()
    .then(() => handler(message.params ?? {}))
    .then(
      (result) => write({ jsonrpc: "2.0", id: message.id, result }),
      (error) => write({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(error?.message ?? error) } }),
    );
}).on("close", () => {
  log({ type: "exit" });
  process.exit(0);
});
