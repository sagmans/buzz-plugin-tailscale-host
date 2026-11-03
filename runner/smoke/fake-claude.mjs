// A stand-in for the `claude` CLI that speaks the minimal stream-json
// protocol Desktop's `ClaudeProcess` drives: it answers `initialize`, takes a
// user message, lists the in-process Buzz tools, calls `send` with
// `final: true` over `mcp_message`, asks the `final` hook, then goes idle.
// Every step is appended to FAKE_LOG so the smoke run can assert on it.
// Modes, by a word in the message text:
//   SLOW   waits before acting (steering)
//   HANG   waits until an `interrupt` control request (Stop)
//   MEDIA <url>  calls `media_get` first (media budget)
//   FLOOD  writes one stdout line over the runner's 8 MiB cap (output cap)
//   STUCK  hangs and ignores stdin EOF and SIGTERM (bounded stop sequence)
//   MEMORY calls `mem_set` then `mem_get` first (owner-encrypted memory
//          still works when published events carry no auth tag)
//   TOOLS  streams thinking, text and tool uses with results first (Read,
//          a failing Bash with an oversized output, TodoWrite, Edit), for
//          the telemetry mapping
// Readiness and model checks (harnesses.ts), as Desktop's provider menu runs
// them: `--version` and `auth status --json` answer and exit; a `signed-out`
// file next to FAKE_LOG makes the account signed out. `initialize` lists
// FAKE_MODELS and `get_settings` reports FAKE_SETTINGS.
import { appendFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

const LOG = process.env.FAKE_LOG;
/** Long enough for more than one 3 s typing pulse. */
const SLOW_MS = 4_000;
/** TOOLS mode: a tool output over the 64 KiB frame cap (elision), and a
 * marker that must never appear in plaintext outside the encrypted frames. */
const TOOLS_BIG_BYTES = 200_000;
const PLAINTEXT_MARKER = "TELEMETRY-PLAINTEXT-MARKER";
const TOOLS_MESSAGE_ID = "msg_fake_tools";
/** Just over the runner's STDOUT_LINE_MAX_BYTES (8 MiB). */
const FLOOD_BYTES = 9 * 1024 * 1024;
const FLOOD_CHUNK = 64 * 1024;
/** What MEMORY mode stores and reads back. */
const MEMORY_SLUG = "smoke";
const MEMORY_TEXT = "remembered by the smoke run";
/** Newer than buzz-app's MIN_VERSION (claude-code setup.ts), so checks pass. */
const FAKE_VERSION = "2.1.200 (Claude Code)";
const FAKE_ACCOUNT = "smoke@example.invalid";
/** Claude's own catalog shape: an alias with a resolved id and efforts up to
 * `max` (hidden by the runner), one without effort, and `default` (dropped). */
const FAKE_MODELS = [
  { value: "default", displayName: "Default" },
  { value: "opus", resolvedModel: "claude-opus-4-1", supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"] },
  { value: "sonnet", resolvedModel: "claude-sonnet-4-5-20250929", supportedEffortLevels: ["low", "medium", "high"] },
  { value: "haiku", resolvedModel: "claude-haiku-4-5", supportsEffort: false },
];
const FAKE_SETTINGS = { model: "sonnet", effort: "medium" };
let stuck = false;
// The runner closes stdout on a runaway line; the next write fails (EPIPE).
process.stdout.on("error", (error) => {
  log({ type: "stdout-error", code: error.code });
  process.exit(1);
});
const argv = process.argv.slice(2);
const flag = (name) => {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
};
const sessionId = flag("--resume") ?? flag("--session-id") ?? "none";
const log = (entry) => appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, session: sessionId, ...entry })}\n`);
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

if (argv[0] === "--version" || (argv[0] === "auth" && argv[1] === "status")) {
  const signedOut = existsSync(join(dirname(LOG), "signed-out"));
  log({ type: "probe", argv, signedOut, env: process.env });
  process.stdout.write(
    argv[0] === "--version" ? `${FAKE_VERSION}\n` : `${JSON.stringify(signedOut ? { loggedIn: false } : { loggedIn: true, email: FAKE_ACCOUNT })}\n`,
  );
  process.exit(0);
}

log({
  type: "start",
  argv,
  resume: flag("--resume"),
  sessionIdFlag: flag("--session-id"),
  mcpConfig: flag("--mcp-config"),
  env: process.env,
});

let requests = 0;
const pending = new Map();
let interrupted;
const ask = (request) =>
  new Promise((resolve) => {
    const id = `fake-${++requests}`;
    pending.set(id, resolve);
    write({ type: "control_request", request_id: id, request });
  });

let queue = Promise.resolve();
let busy = false;

async function turn(message) {
  busy = true;
  const content = String(message.message?.content ?? "");
  log({
    type: "turn",
    uuid: message.uuid,
    hasBuzzEvent: content.includes("<buzz-event"),
    hasThreadContext: content.includes("<thread-context") || content.includes("<conversation-context"),
    scopeLine: content.match(/^Scope: .*$/m)?.[0],
    steer: content.includes("<new-message-arrived-while-you-were-working>"),
  });
  write({ type: "system", subtype: "init", session_id: sessionId, model: "fake-model" });
  write({ type: "user", isReplay: true, uuid: message.uuid, message: message.message, session_id: sessionId });
  write({ type: "system", subtype: "session_state_changed", state: "running", session_id: sessionId });
  if (content.includes("FLOOD")) {
    log({ type: "flooding" });
    const chunk = "x".repeat(FLOOD_CHUNK);
    for (let sent = 0; sent < FLOOD_BYTES; sent += FLOOD_CHUNK) {
      if (!process.stdout.write(chunk)) await new Promise((resolve) => process.stdout.once("drain", resolve));
    }
    await new Promise(() => undefined);
  }
  if (content.includes("STUCK")) {
    stuck = true;
    // A timer keeps the process alive after stdin closes, like a real
    // child that keeps working and ignores EOF.
    setInterval(() => undefined, 1_000);
    log({ type: "stuck" });
    await new Promise(() => undefined);
  }
  if (content.includes("HANG")) {
    log({ type: "hanging" });
    await new Promise((resolve) => (interrupted = resolve));
    log({ type: "aborted" });
    write({ type: "result", subtype: "error_during_execution", is_error: true, terminal_reason: "aborted_streaming", session_id: sessionId });
    write({ type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId });
    busy = false;
    return;
  }
  if (content.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  if (content.includes("TOOLS")) streamTools();
  const list = await ask({ subtype: "mcp_message", server_name: "buzz", message: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const tools = list.response?.mcp_response?.result?.tools ?? [];
  log({
    type: "tools/list",
    count: tools.length,
    names: tools.map((tool) => tool.name),
    alwaysLoad: tools.every((tool) => tool._meta?.["anthropic/alwaysLoad"] === true),
  });
  const callTool = async (id, name, args) => {
    const got = await ask({ subtype: "mcp_message", server_name: "buzz", message: { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } } });
    const result = got.response?.mcp_response?.result;
    return { isError: result?.isError === true, reply: result?.content?.[0]?.text };
  };
  if (content.includes("MEMORY")) {
    const set = await callTool(4, "mem_set", { slug: MEMORY_SLUG, text: MEMORY_TEXT });
    const get = await callTool(5, "mem_get", { slug: MEMORY_SLUG });
    log({ type: "memory", set, get, expected: MEMORY_TEXT });
  }
  const media = content.match(/MEDIA (https?:\/\/[^\s<"&]+)/)?.[1];
  if (media) {
    const got = await ask({
      subtype: "mcp_message",
      server_name: "buzz",
      message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "media_get", arguments: { url: media } } },
    });
    const result = got.response?.mcp_response?.result;
    log({ type: "media", isError: result?.isError === true, reply: result?.content?.[0]?.text });
  }
  const call = await ask({
    subtype: "mcp_message",
    server_name: "buzz",
    message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "send", arguments: { text: "pong from fake claude", audience: "everyone", final: true } } },
  });
  const result = call.response?.mcp_response?.result;
  log({ type: "tools/call", isError: result?.isError === true, reply: result?.content?.[0]?.text });
  const hook = await ask({
    subtype: "hook_callback",
    callback_id: "final",
    input: { tool_name: "mcp__buzz__send", tool_input: { text: "pong from fake claude", final: true } },
  });
  log({ type: "hook", response: hook.response });
  write({ type: "result", subtype: "success", is_error: false, result: "done", session_id: sessionId });
  write({ type: "system", subtype: "session_state_changed", state: "idle", session_id: sessionId });
  busy = false;
  // #lizard forgives: mirrors one upstream protocol handler branch for branch
}

/** What claude prints for a turn that thinks, talks and uses tools. */
function streamTools() {
  const assistant = (block) =>
    write({ type: "assistant", message: { id: TOOLS_MESSAGE_ID, role: "assistant", content: [block] }, parent_tool_use_id: null, session_id: sessionId });
  const result = (block) =>
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", ...block }] }, parent_tool_use_id: null, session_id: sessionId });
  assistant({ type: "thinking", thinking: `Planning the work. ${PLAINTEXT_MARKER}` });
  assistant({ type: "text", text: "Reading the file. " });
  assistant({ type: "text", text: "Then running a command." });
  assistant({ type: "tool_use", id: "toolu_read", name: "Read", input: { file_path: "/etc/hosts", offset: 2, limit: 3 } });
  result({ tool_use_id: "toolu_read", content: `line two\nline three ${PLAINTEXT_MARKER}` });
  assistant({ type: "tool_use", id: "toolu_bash", name: "Bash", input: { command: "ls -la", description: "List files" } });
  result({ tool_use_id: "toolu_bash", is_error: true, content: [{ type: "text", text: `${PLAINTEXT_MARKER} ${"x".repeat(TOOLS_BIG_BYTES)}` }] });
  assistant({ type: "tool_use", id: "toolu_todo", name: "TodoWrite", input: { todos: [{ content: "Check hosts", status: "in_progress", activeForm: "Checking" }] } });
  result({ tool_use_id: "toolu_todo", content: "Todos updated" });
  assistant({ type: "tool_use", id: "toolu_edit", name: "Edit", input: { file_path: "/tmp/fake.txt", old_string: "old", new_string: "new" } });
  result({ tool_use_id: "toolu_edit", content: "The file was updated" });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_response") {
    const id = message.response?.request_id;
    pending.get(id)?.(message.response);
    pending.delete(id);
    return;
  }
  if (message.type === "control_request") {
    const request = message.request ?? {};
    if (request.subtype === "initialize") {
      const prompt = String(request.appendSystemPrompt ?? "");
      log({
        type: "initialize",
        identity: prompt.match(/You are (.*) \(pubkey ([0-9a-f]{64})\)\./)?.slice(1),
        hasBase: prompt.includes("<base>"),
        hasInstructions: prompt.includes("<agent-instructions>"),
        hasSessionModel: prompt.includes("## Session Model"),
        workspace: prompt.match(/Current working directory: (.*)/)?.[1],
        sdkMcpServers: request.sdkMcpServers,
        finalHook: request.hooks?.PostToolUse?.some((entry) => entry.hookCallbackIds?.includes("final")),
      });
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { models: FAKE_MODELS } } });
      return;
    }
    if (request.subtype === "get_settings") {
      log({ type: "get_settings" });
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: { applied: FAKE_SETTINGS } } });
      return;
    }
    if (request.subtype === "interrupt") {
      log({ type: "interrupt" });
      write({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      interrupted?.();
      return;
    }
    write({ type: "control_response", response: { subtype: "error", request_id: message.request_id, error: "unsupported" } });
    return;
  }
  if (message.type === "user") {
    // A message during a busy turn is folded into it, as claude does.
    if (busy) {
      const content = String(message.message?.content ?? "");
      log({ type: "steer", steer: content.includes("<new-message-arrived-while-you-were-working>") });
      write({ type: "user", isReplay: true, uuid: message.uuid, message: message.message, session_id: sessionId });
      return;
    }
    queue = queue.then(() => turn(message));
  }
});
lines.on("close", () => {
  if (stuck) return log({ type: "eof-ignored" });
  log({ type: "exit" });
  process.exit(0);
});
process.on("SIGTERM", () => {
  if (stuck) return log({ type: "sigterm-ignored" });
  log({ type: "sigterm" });
  process.exit(0);
});
