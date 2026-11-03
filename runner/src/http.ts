// The plugin-facing HTTP API (docs/RUNNER_CONTRACT.md). It is served only on a Unix
// socket (socket.ts); `tailscale serve` terminates TLS and adds the caller's
// tailnet login, which is checked against the allowlist before anything else
// is read. Every body
// is size-capped, must be JSON, and is validated field by field here, at the
// trust boundary, before it reaches the agent manager.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { parseAuthTag } from "./attest";
import { optionalEffort, optionalModel, type RunnerConfig } from "./config";
import {
  API_PREFIX,
  BODY_LIMIT_BYTES,
  CHANNEL_ID,
  FORBIDDEN_MESSAGE,
  HARNESS_CATALOG,
  HEADERS_TIMEOUT_MS,
  HEX64,
  INSTRUCTIONS_MAX,
  KEEP_ALIVE_TIMEOUT_MS,
  LOGIN_HEADER,
  MODEL_ID_ANY,
  NAME_MAX,
  PICTURE_MAX,
  REQUEST_TIMEOUT_MS,
  SCOPES,
  type HarnessId,
} from "./constants";
import type { AgentManager } from "./agents";
import {
  ConfigError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  RunnerError,
  UnsupportedMediaError,
  ValidationError,
} from "./errors";
import type { Logger } from "./log";
import type { AgentSettings, Scope } from "./store";

type Body = Record<string, unknown>;
type Reply = Readonly<{ status: number; body?: unknown }>;
type Route = Readonly<{
  method: string;
  pattern: RegExp;
  /** For logs: the path with ids elided. */
  name: string;
  handle(match: RegExpMatchArray, body: () => Promise<Body>): Promise<Reply>;
}>;

const NO_CONTENT: Reply = { status: 204 };
const PK = "([0-9a-f]{64})";
/** A harness id in a path; whether it is offered is checked after. */
const HARNESS_SEGMENT = "([a-z0-9-]{1,32})";
const CONTROL = /\p{Cc}/u;

export function createApi(config: RunnerConfig, agents: AgentManager, log: Logger): Server {
  const routes = buildRoutes(config, agents);
  const server = createServer(async (req, res) => {
    const started = Date.now();
    let route: Route | undefined;
    let reply: Reply;
    try {
      // Authorization first: an unauthorized caller learns nothing, not even
      // which paths exist.
      authorize(req, config);
      const url = new URL(req.url ?? "/", "http://runner.invalid");
      const matched = routes
        .map((candidate) => ({ candidate, match: url.pathname.match(candidate.pattern) }))
        .filter((item) => item.match);
      if (!matched.length) throw new NotFoundError();
      const hit = matched.find((item) => item.candidate.method === req.method);
      if (!hit?.match) throw new RunnerError("method_not_allowed", 405, "Method not allowed");
      route = hit.candidate;
      reply = await route.handle(hit.match, () => readJson(req));
    } catch (error) {
      reply = errorReply(error, log, route?.name);
    }
    send(res, reply);
    log.info("request", {
      method: req.method,
      route: route?.name ?? "unmatched",
      status: reply.status,
      durationMs: Date.now() - started,
    });
  });
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.maxHeadersCount = 64;
  return server;
}

function buildRoutes(config: RunnerConfig, agents: AgentManager): Route[] {
  const agentPath = (suffix = "") => new RegExp(`^${API_PREFIX}/agents/${PK}${suffix}$`);
  return [
    {
      method: "GET",
      pattern: new RegExp(`^${API_PREFIX}/health$`),
      name: "health",
      handle: async () => ({ status: 200, body: agents.health() }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${API_PREFIX}/harnesses$`),
      name: "harnesses",
      handle: async () => ({ status: 200, body: { harnesses: await agents.harnesses.list() } }),
    },
    {
      method: "GET",
      pattern: new RegExp(`^${API_PREFIX}/harnesses/${HARNESS_SEGMENT}/models$`),
      name: "harness models",
      handle: async (match) => ({ status: 200, body: await agents.harnesses.listModels(match[1] as string) }),
    },
    {
      method: "POST",
      pattern: new RegExp(`^${API_PREFIX}/agents$`),
      name: "provision",
      handle: async (_match, body) => {
        const input = only(await body(), ["name", "picture", "community"]);
        const picture = optionalPicture(input.picture);
        const created = await agents.provision({
          name: name(input.name),
          community: community(input.community, config),
          ...(picture ? { picture } : {}),
        });
        return { status: 200, body: created };
      },
    },
    {
      method: "GET",
      pattern: agentPath(),
      name: "agent",
      handle: async (match) => ({ status: 200, body: agents.view(pk(match)) }),
    },
    {
      method: "DELETE",
      pattern: agentPath(),
      name: "delete",
      handle: async (match) => {
        await agents.remove(pk(match));
        return NO_CONTENT;
      },
    },
    {
      method: "POST",
      pattern: agentPath("/activate"),
      name: "activate",
      handle: async (match, body) => {
        const input = only(await body(), ["name", "community", "auth", "config"]);
        await agents.activate(pk(match), {
          name: name(input.name),
          community: community(input.community, config),
          auth: parseAuthTag(input.auth),
          ...(input.config === undefined ? {} : { config: settings(input.config) }),
        });
        return NO_CONTENT;
      },
    },
    {
      method: "PUT",
      pattern: agentPath("/profile"),
      name: "profile",
      handle: async (match, body) => {
        const input = only(await body(), ["name", "picture"]);
        const picture = optionalPicture(input.picture);
        await agents.profile(pk(match), { name: name(input.name), ...(picture ? { picture } : {}) });
        return NO_CONTENT;
      },
    },
    {
      method: "PUT",
      pattern: agentPath("/config"),
      name: "config",
      handle: async (match, body) => {
        await agents.setConfig(pk(match), settings(await body()));
        return NO_CONTENT;
      },
    },
    {
      method: "POST",
      pattern: agentPath("/interrupt"),
      name: "interrupt",
      handle: async (match, body) => {
        const input = only(await body(), ["channelId", "threadRootId"]);
        if (typeof input.channelId !== "string" || !CHANNEL_ID.test(input.channelId))
          throw new ValidationError("channelId must be a channel id");
        const root = input.threadRootId;
        if (root !== undefined && root !== null && (typeof root !== "string" || !HEX64.test(root)))
          throw new ValidationError("threadRootId must be an event id");
        return {
          status: 200,
          body: await agents.interrupt(pk(match), input.channelId.toLowerCase(), root ?? undefined),
        };
      },
    },
  ];
}

/** Fails closed: no header, a repeated header, or a login not on the list is
 * the same 403, so a caller learns nothing about which check failed. The
 * value is never logged (it is personal data). */
function authorize(req: IncomingMessage, config: RunnerConfig) {
  const login = req.headers[LOGIN_HEADER];
  if (typeof login !== "string" || !config.allowedLogins.includes(login)) throw new ForbiddenError(FORBIDDEN_MESSAGE);
}

function readJson(req: IncomingMessage): Promise<Body> {
  const type = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return Promise.reject(new UnsupportedMediaError());
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > BODY_LIMIT_BYTES) return Promise.reject(new PayloadTooLargeError(BODY_LIMIT_BYTES));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES) {
        // Stop reading but keep the socket, so the 413 still reaches the
        // caller; `send` closes the connection after it.
        reject(new PayloadTooLargeError(BODY_LIMIT_BYTES));
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (cause) => reject(new ValidationError(`Body unreadable: ${cause.message}`)));
    req.on("end", () => {
      try {
        const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value))
          return reject(new ValidationError("Body must be a JSON object"));
        resolve(value as Body);
      } catch {
        reject(new ValidationError("Body is not valid JSON"));
      }
    });
  });
}

/** Rejects fields the contract does not name, so a typo or a newer client
 * cannot slip unvalidated data past this boundary. */
function only(body: Body, allowed: readonly string[]) {
  const extra = Object.keys(body).filter((key) => !allowed.includes(key));
  if (extra.length) throw new ValidationError(`Unknown fields: ${extra.join(", ")}`);
  return body;
}

const pk = (match: RegExpMatchArray) => match[1] as string;

/** Desktop's rule (agent-controller `valid_name`): one line, 1..256 bytes. */
function name(value: unknown) {
  if (typeof value !== "string") throw new ValidationError("name is required");
  const trimmed = value.trim();
  if (!trimmed || Buffer.byteLength(trimmed) > NAME_MAX || CONTROL.test(trimmed))
    throw new ValidationError("name must be one line of 1 to 256 bytes");
  return trimmed;
}

/** Desktop's rule: an HTTPS image URL without credentials. */
function optionalPicture(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > PICTURE_MAX) throw new ValidationError("picture must be a URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ValidationError("picture must be a URL");
  }
  if (url.protocol !== "https:" || url.username || url.password)
    throw new ValidationError("picture must be an HTTPS URL without credentials");
  return value;
}

function community(value: unknown, config: RunnerConfig) {
  if (typeof value !== "string" || !config.relays.includes(value))
    throw new ValidationError("community is not one this runner serves", "community_not_allowed");
  return value;
}

/** `{instructions?, model?, effort?, harness?, scope?}`; a PUT replaces the
 * whole config. Whether the harness is offered here is the agent manager's
 * check; this one is shape only. A custom model id is allowed, as Desktop's
 * model field allows one. */
function settings(value: unknown): AgentSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("config must be an object");
  const input = only(value as Body, ["instructions", "model", "effort", "harness", "scope"]);
  const harness = optionalHarness(input.harness);
  const scope = optionalScope(input.scope);
  const instructions = input.instructions ?? "";
  if (typeof instructions !== "string" || instructions.length > INSTRUCTIONS_MAX)
    throw new ValidationError(`instructions must be a string of at most ${INSTRUCTIONS_MAX} characters`);
  try {
    const model = optionalModel(input.model, MODEL_ID_ANY);
    const effort = optionalEffort(input.effort);
    // Which levels the harness takes is checked once the harness is known
    // (an absent one keeps the agent's): AgentManager `settle`.
    return {
      instructions,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(harness ? { harness } : {}),
      ...(scope ? { scope } : {}),
    };
  } catch (error) {
    if (error instanceof ConfigError) throw new ValidationError(error.message);
    throw error;
  }
}

function optionalHarness(value: unknown): HarnessId | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !Object.hasOwn(HARNESS_CATALOG, value))
    throw new ValidationError(`harness must be one of ${Object.keys(HARNESS_CATALOG).join(", ")}`);
  return value as HarnessId;
}

function optionalScope(value: unknown): Scope | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || !SCOPES.includes(value as Scope))
    throw new ValidationError(`scope must be one of ${SCOPES.join(", ")}`);
  return value as Scope;
}

/** Domain errors keep their code and message; anything else is a 500 whose
 * details stay in the log. */
function errorReply(error: unknown, log: Logger, route: string | undefined): Reply {
  if (error instanceof RunnerError && error.status < 500)
    return { status: error.status, body: { error: error.code, message: error.message } };
  log.error("request failed", { route, error });
  if (error instanceof RunnerError)
    return { status: error.status, body: { error: error.code, message: error.message } };
  return { status: 500, body: { error: "internal", message: "Internal error" } };
}

function send(res: ServerResponse, reply: Reply) {
  if (res.headersSent) return;
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // An unread oversized body must not be parsed as the next request.
    ...(reply.status === 413 ? { connection: "close" } : {}),
  };
  if (reply.body === undefined) {
    res.writeHead(reply.status, headers).end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  res
    .writeHead(reply.status, { ...headers, "content-type": "application/json", "content-length": Buffer.byteLength(payload) })
    .end(payload);
}
