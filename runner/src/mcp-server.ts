// Loopback MCP servers for harnesses that reach the Buzz tools over HTTP MCP
// (Goose): the runner-side port of Desktop's host MCP servers
// (buzz-app src-tauri/src/host_mcp.rs; Apache-2.0, Copyright 2026 Block,
// Inc.; see NOTICE) and their page side (`answerMcp` in
// features/host/service.ts, not imported because that module loads Tauri).
// buzz-app's `AcpProcess` gets a session's server from `serve` and hands the
// harness only its address and token; every tool call is answered in this
// process, which holds the agent key. The harness, run as the harness user,
// never gets a key.
//
// The same rules as Desktop, so an agent cannot tell the two hosts apart and
// a stolen token buys nothing:
// - Binds only 127.0.0.1 on a port the OS picks. A random 256-bit token per
//   server authorizes each request as `Authorization: Bearer <token>`. `Host`
//   must name the bound address and a request with `Origin` (a web page) is
//   refused.
// - The token admits one MCP session: `initialize` claims a random
//   `Mcp-Session-Id` that every later request must send. Goose saves its
//   token to disk, so a token read from there is useless once Goose has
//   connected. Before the claim only `initialize`, `server/discover` and
//   `ping` are answered; a second `initialize` means two clients hold the
//   token, so the server stops and the session using it fails.
// - A refused request gets 404, never 401 or 403, which MCP clients answer by
//   starting an OAuth sign-in.
// - JSON replies only, never SSE; a notification or response gets 202; GET
//   and DELETE get 405. One request per connection.
// - Nothing about a request is logged: no token, session id, body or path.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import type { HostMcpServer, McpHandler } from "@buzz/features/host/service";
import {
  MCP_BODY_LIMIT_BYTES,
  MCP_BODY_TIMEOUT_MS,
  MCP_CONNECTIONS,
  MCP_ENDPOINT,
  MCP_HEAD_LIMIT_BYTES,
  MCP_HEAD_TIMEOUT_MS,
  MCP_HOST,
  MCP_MAX_SERVERS,
  MCP_REPLY_LIMIT_BYTES,
  MCP_SECRET_BYTES,
} from "./constants";
import { errorMessage, ProcessError } from "./errors";
import type { Logger } from "./log";

const BEARER = "Bearer ";
const SESSION_HEADER = "mcp-session-id";
const JSON_TYPE = "application/json";
const POST = "POST";
const STATUS = Object.freeze({
  ok: 200,
  accepted: 202,
  badRequest: 400,
  notFound: 404,
  notAllowed: 405,
  tooLarge: 413,
  unsupported: 415,
  unavailable: 503,
});
/** JSON-RPC errors as Desktop's page answers them. */
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;
/** Methods answered before the session is claimed, besides `initialize`. */
const OUTSIDE_METHODS = new Set(["server/discover", "ping"]);
const INITIALIZE = "initialize";

/** Where one server's session stands (host_mcp.rs UNCLAIMED/CLAIMING/CLAIMED). */
type Claim = "unclaimed" | "claiming" | "claimed";
/** Where a request stands to the session (host_mcp.rs `Join`). */
/** `conflict`: a second `initialize`; it is refused and the server stops. */
type Join = "outside" | "claiming" | "inside" | "conflict";

/** Every loopback MCP server of the runner, under one cap for the host. */
export class McpServers {
  private readonly live = new Set<LoopbackServer>();
  private disposed = false;

  constructor(private readonly log: Logger) {}

  /** buzz-app's `ServeMcp`: starts a server whose messages `handler`
   * answers. Throws "Too many MCP servers" at the cap, which buzz-app's
   * sessions answer by closing an idle session and trying once more. */
  readonly serve = async (handler: McpHandler): Promise<HostMcpServer> => {
    if (this.disposed) throw new ProcessError("The runner is stopping");
    if (this.live.size >= MCP_MAX_SERVERS) throw new ProcessError("Too many MCP servers are running");
    const server = new LoopbackServer(handler, this.log);
    this.live.add(server);
    void server.closed.then(() => this.live.delete(server));
    try {
      await server.listen();
    } catch (error) {
      server.close();
      throw new ProcessError("Could not start the MCP server", { cause: error });
    }
    return server.view();
  };

  get size() {
    return this.live.size;
  }

  /** Stops every server: their sessions end with the runner. */
  dispose() {
    this.disposed = true;
    for (const server of this.live) server.close();
  }
}

/** One server: one session's Buzz tools. */
class LoopbackServer {
  private readonly token = secret();
  private readonly session = secret();
  private claim: Claim = "unclaimed";
  private authority = "";
  private stopped = false;
  private readonly sockets = new Set<Socket>();
  private readonly server: Server;
  private release!: () => void;
  readonly closed = new Promise<void>((resolve) => (this.release = resolve));

  constructor(
    private readonly handler: McpHandler,
    private readonly log: Logger,
  ) {
    this.server = createServer({ maxHeaderSize: MCP_HEAD_LIMIT_BYTES }, (request, response) => {
      void this.answer(request, response).catch((error) => {
        // Only the failure's class: the request may hold the token.
        this.log.warn("mcp request failed", { error: errorMessage(error) });
        if (!response.headersSent) this.respond(response, STATUS.badRequest, undefined, false);
      });
    });
    this.server.headersTimeout = MCP_HEAD_TIMEOUT_MS;
    this.server.requestTimeout = MCP_HEAD_TIMEOUT_MS + MCP_BODY_TIMEOUT_MS;
    this.server.maxConnections = MCP_CONNECTIONS;
    this.server.on("connection", (socket: Socket) => {
      if (this.stopped) return socket.destroy();
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.once("close", () => this.release());
  }

  listen() {
    return new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, MCP_HOST, () => {
        this.server.off("error", reject);
        const address = this.server.address();
        if (!address || typeof address === "string") return reject(new Error("no TCP address"));
        this.authority = `${MCP_HOST}:${address.port}`;
        // A server error after start stops it; its session then fails.
        this.server.on("error", (error) => {
          this.log.warn("mcp server failed", { error: errorMessage(error) });
          this.close();
        });
        resolve();
      });
    });
  }

  view(): HostMcpServer {
    return Object.freeze({
      url: `http://${this.authority}${MCP_ENDPOINT}`,
      headers: Object.freeze([Object.freeze({ name: "Authorization", value: `${BEARER}${this.token}` })]),
      close: async () => this.close(),
      closed: this.closed,
    });
  }

  /** Stops listening and drops every connection, answered or not, except
   * `answering`, whose refusal is still written; it ends after that reply. */
  close(answering?: Socket) {
    if (this.stopped) return;
    this.stopped = true;
    this.server.close();
    for (const socket of this.sockets) if (socket !== answering) socket.destroy();
  }

  private async answer(request: IncomingMessage, response: ServerResponse) {
    const refused = this.refuse(request);
    if (typeof refused === "number") return this.respond(response, refused, undefined, false);
    const body = await readBody(request);
    if (body === undefined) return this.respond(response, STATUS.badRequest, undefined, false);
    const join = this.join(refused, body);
    if (typeof join === "number") return this.respond(response, join, undefined, false);
    if (join === "conflict") {
      // The client is answered before the server goes: a dropped connection
      // would read as a crash, not as a refusal.
      this.close(request.socket);
      response.once("close", () => request.socket.destroy());
      return this.respond(response, STATUS.notFound, undefined, false);
    }
    if (join === "claiming") this.claim = "claiming";
    let reply: string | undefined;
    try {
      reply = await this.forward(body);
    } finally {
      // A client that hung up before its answer does not hold the session.
      const answered = !request.socket.destroyed && !this.stopped;
      if (join === "claiming")
        this.claim = answered && reply !== undefined && claims(reply) ? "claimed" : "unclaimed";
    }
    if (this.stopped || request.socket.destroyed) return;
    const joined = join === "inside" || (join === "claiming" && this.claim === "claimed");
    this.respond(response, reply === undefined ? STATUS.accepted : STATUS.ok, reply, joined);
    // #lizard forgives: one branch per MCP request rule, as host_mcp.rs
  }

  /** Whether an authorized `POST /mcp` names the session, or the status that
   * refuses it (host_mcp.rs `refuse`). */
  private refuse(request: IncomingMessage): boolean | number {
    const authorization = header(request, "authorization") ?? "";
    const token = authorization.startsWith(BEARER) ? authorization.slice(BEARER.length) : "";
    const path = (request.url ?? "").split("?")[0];
    if (
      header(request, "host") !== this.authority ||
      // An agent never sends one; a web page always does.
      request.headers.origin !== undefined ||
      path !== MCP_ENDPOINT ||
      !same(token, this.token)
    )
      return STATUS.notFound;
    // No server stream for GET and no session for DELETE to end.
    if (request.method !== POST) return STATUS.notAllowed;
    const type = (header(request, "content-type") ?? "").split(";")[0]?.trim().toLowerCase();
    if (type !== JSON_TYPE) return STATUS.unsupported;
    const length = Number(header(request, "content-length"));
    if (Number.isFinite(length) && length > MCP_BODY_LIMIT_BYTES) return STATUS.tooLarge;
    const named = header(request, SESSION_HEADER);
    if (named === undefined) return false;
    return same(named, this.session) ? true : STATUS.notFound;
    // #lizard forgives: one branch per MCP request rule, as host_mcp.rs
  }

  /** Where `body` stands to the session, or the status that refuses it
   * (host_mcp.rs `join`). */
  private join(named: boolean, body: string): Join | number {
    if (named) return this.claim === "claimed" ? "inside" : STATUS.notFound;
    let method: unknown;
    try {
      method = (JSON.parse(body) as { method?: unknown } | null)?.method;
    } catch {
      method = undefined;
    }
    if (method === INITIALIZE) {
      if (this.claim === "unclaimed") return "claiming";
      // Another client has the token too, and may hold the session.
      return "conflict";
    }
    if (typeof method === "string" && OUTSIDE_METHODS.has(method) && this.claim !== "claimed") return "outside";
    return STATUS.notFound;
  }

  /** The handler's JSON-RPC reply to one message, serialized; undefined for
   * a notification (Desktop `answerMcp` and its reply limit). */
  private async forward(body: string): Promise<string | undefined> {
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } });
    }
    const id = (message as { id?: unknown } | null)?.id;
    let reply: unknown;
    try {
      reply = await this.handler(message);
    } catch (error) {
      reply = id === undefined || id === null ? undefined : rpcError(id, error);
    }
    if (reply === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(reply);
    } catch (error) {
      return JSON.stringify(rpcError(id ?? null, error));
    }
    if (Buffer.byteLength(text, "utf8") > MCP_REPLY_LIMIT_BYTES)
      return JSON.stringify(rpcError(id ?? null, new Error("Reply is too large")));
    return text;
  }

  private respond(response: ServerResponse, status: number, body: string | undefined, joined: boolean) {
    const headers: Record<string, string> = { "Cache-Control": "no-store", Connection: "close" };
    if (joined && (status === STATUS.ok || status === STATUS.accepted)) headers["Mcp-Session-Id"] = this.session;
    if (status === STATUS.ok) headers["Content-Type"] = JSON_TYPE;
    if (status === STATUS.notAllowed) headers.Allow = POST;
    response.writeHead(status, headers);
    response.end(body ?? "");
  }
}

/** The body as UTF-8 text, or undefined when it is over the cap, slower
 * than MCP_BODY_TIMEOUT_MS, or not UTF-8 (each a 400 in Desktop). */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (text: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (text === undefined) request.resume();
      resolve(text);
    };
    const timer = setTimeout(() => finish(undefined), MCP_BODY_TIMEOUT_MS);
    request.on("data", (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MCP_BODY_LIMIT_BYTES) return finish(undefined);
      chunks.push(chunk);
    });
    request.once("end", () => {
      try {
        finish(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        finish(undefined);
      }
    });
    request.once("error", () => finish(undefined));
    request.once("aborted", () => finish(undefined));
  });
}

/** Whether an `initialize` reply succeeded, which claims the session. */
function claims(reply: string) {
  try {
    const parsed = JSON.parse(reply) as { result?: unknown } | null;
    return parsed !== null && typeof parsed === "object" && parsed.result !== undefined;
  } catch {
    return false;
  }
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Compares a secret without showing how much of it matched. */
function same(given: string, expected: string) {
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function secret() {
  return randomBytes(MCP_SECRET_BYTES).toString("base64url");
}

function rpcError(id: unknown, error: unknown) {
  return { jsonrpc: "2.0", id, error: { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) } };
}
