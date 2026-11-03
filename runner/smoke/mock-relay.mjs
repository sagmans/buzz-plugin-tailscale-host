// A tiny in-memory Buzz relay for the smoke run: NIP-11 `self`, the HTTP
// bridge (`POST /query`, `POST /events`, NIP-98 checked), and a NIP-42
// WebSocket with REQ/EVENT/EOSE/CLOSE. Node has no WebSocket server, and no
// new packages may be added, so the RFC 6455 framing is done by hand (text,
// ping and close frames only, which is all the runner sends).
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_TEXT = 0x1;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;
/** buzz-relay `handle_agent_observer_event` rules the mock applies to WS
 * EVENTs: observer kind, ±300 s freshness, exact routing tags. */
const KIND_AGENT_OBSERVER = 24200;
const OBSERVER_FRESHNESS_S = 300;
/** Channel discovery kinds (metadata, roster). buzz-relay keeps them in
 * their channel's scope, so a REQ without `#h` gets them only as stored
 * events, never live; the mock does the same so the runner cannot rely on it. */
const CHANNEL_SCOPED_KINDS = [39000, 39002];
const KIND_MEMBER_ADDED = 44100;
/** NIP-01 addressable (parameterized replaceable) kind range. */
const ADDRESSABLE_MIN = 30000;
const ADDRESSABLE_END = 40000;

/** NIP-01 filter matching, enough for the runner's filters. */
export function matches(filter, event) {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter))
    if (key.startsWith("#") && !event.tags.some((tag) => tag[0] === key.slice(1) && values.includes(tag[1]))) return false;
  return true;
}

function frame(opcode, payload) {
  const data = Buffer.from(payload);
  const header =
    data.length < 126
      ? Buffer.from([0x80 | opcode, data.length])
      : data.length < 65536
        ? Buffer.from([0x80 | opcode, 126, data.length >> 8, data.length & 0xff])
        : (() => {
            const h = Buffer.alloc(10);
            h[0] = 0x80 | opcode;
            h[1] = 127;
            h.writeBigUInt64BE(BigInt(data.length), 2);
            return h;
          })();
  return Buffer.concat([header, data]);
}

export class MockRelay {
  constructor() {
    this.secret = generateSecretKey();
    this.pubkey = getPublicKey(this.secret);
    this.events = [];
    this.published = []; // events received over POST /events
    this.queries = []; // { author, authTag, filters }
    this.auths = []; // { event, ok, reason }
    this.observed = []; // WS EVENTs: { event, ok, reason, at }
    this.reqs = []; // { connection, subId, filters }
    this.connections = new Set();
    this.blobs = new Map(); // media name -> Buffer, served at GET /media/<name>
    // Authors whose profile (kind 0) writes get no answer until released, so
    // a scenario can keep an activate busy past the runner's deadline.
    this.holding = new Set();
    this.held = []; // { author, answer }
    // "<agent>:<subId>" pairs whose next REQ gets its events but no EOSE,
    // so a scenario can make the runner wait out a load deadline.
    this.unfinished = new Set();
    this.server = createServer((req, res) => this.http(req, res));
    this.server.on("upgrade", (req, socket) => this.upgrade(req, socket));
  }

  async start() {
    await new Promise((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.url = `ws://127.0.0.1:${this.server.address().port}`;
    return this.url;
  }

  async stop() {
    for (const connection of this.connections) connection.socket.destroy();
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Relay-authored event (channel metadata, rosters). */
  relaySigned(kind, tags, content = "") {
    return finalizeEvent({ kind, tags, content, created_at: Math.floor(Date.now() / 1000) }, this.secret);
  }

  /** Stores an event and pushes it to live subscriptions, as an accepted write. */
  inject(event) {
    // NIP-01 addressable kinds: a newer event replaces the stored one, so a
    // roster without the agent hides the old roster that named it.
    if (event.kind >= ADDRESSABLE_MIN && event.kind < ADDRESSABLE_END) {
      const d = (item) => item.tags.find((tag) => tag[0] === "d")?.[1] ?? "";
      this.events = this.events.filter((item) => !(item.kind === event.kind && item.pubkey === event.pubkey && d(item) === d(event)));
    }
    this.events.push(event);
    const live = (filter) => !CHANNEL_SCOPED_KINDS.includes(event.kind) || "#h" in filter;
    for (const connection of this.connections)
      for (const [subId, filters] of connection.subs)
        if (filters.some((filter) => live(filter) && matches(filter, event))) this.send(connection, ["EVENT", subId, event]);
  }

  /** The relay's membership notice to `member` about `channel` (buzz-relay
   * `emit_membership_notification`): what a join or leave sends live. */
  notice(member, channel, kind = KIND_MEMBER_ADDED, type = "stream") {
    this.inject(this.relaySigned(kind, [["p", member], ["h", channel], ["t", type]]));
  }

  /** Pushes raw JSON (for example an event with a broken signature) to every subscription. */
  pushRaw(event) {
    for (const connection of this.connections)
      for (const subId of connection.subs.keys()) this.send(connection, ["EVENT", subId, event]);
  }

  /** Leaves `author`'s profile writes unanswered until `releaseProfiles`. */
  holdProfiles(author) {
    this.holding.add(author);
  }

  /** Accepts every held profile write of `author`, and the next ones at once. */
  releaseProfiles(author) {
    this.holding.delete(author);
    const mine = this.held.filter((item) => item.author === author);
    this.held = this.held.filter((item) => item.author !== author);
    for (const item of mine) item.answer();
  }

  dropAll() {
    for (const connection of this.connections) connection.socket.destroy();
  }

  /** Drops only `agent`'s sockets, so other runners on this relay go on. */
  drop(agent) {
    for (const connection of this.connections) if (connection.authed === agent) connection.socket.destroy();
  }

  /** The next `subId` REQ of `agent` gets no EOSE. */
  withholdEose(agent, subId) {
    this.unfinished.add(`${agent}:${subId}`);
  }

  query(filters) {
    const out = [];
    for (const filter of filters) {
      const hits = this.events
        .filter((event) => matches(filter, event))
        .sort((a, b) => b.created_at - a.created_at)
        .slice(0, filter.limit ?? 500);
      out.push(...hits);
    }
    return [...new Map(out.map((event) => [event.id, event])).values()];
  }

  nip98(req, body) {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Nostr ")) return undefined;
    try {
      const event = JSON.parse(Buffer.from(header.slice(6), "base64").toString("utf8"));
      if (!verifyEvent(event) || event.kind !== 27235) return undefined;
      const payload = event.tags.find((tag) => tag[0] === "payload")?.[1];
      if (payload !== createHash("sha256").update(body).digest("hex")) return undefined;
      return event.pubkey;
    } catch {
      return undefined;
    }
  }

  http(req, res) {
    const reply = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/") return reply(200, { name: "mock", self: this.pubkey });
    if (req.method === "GET" && req.url.startsWith("/media/")) {
      const blob = this.blobs.get(req.url.slice("/media/".length));
      if (!blob || !(req.headers.authorization ?? "").startsWith("Nostr ")) return reply(404, { error: "no blob" });
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": blob.length });
      return res.end(blob);
    }
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const author = this.nip98(req, body);
      if (!author) return reply(401, { error: "nip98" });
      const authTag = req.headers["x-auth-tag"];
      if (req.method === "POST" && req.url === "/query") {
        const filters = JSON.parse(body);
        this.queries.push({ author, authTag, filters });
        return reply(200, this.query(filters));
      }
      if (req.method === "POST" && req.url === "/events") {
        const event = JSON.parse(body);
        if (!verifyEvent(event)) return reply(200, { accepted: false, message: "invalid: bad signature" });
        const accept = () => {
          // A held write whose caller gave up has no one to answer.
          if (res.destroyed || res.writableEnded) return;
          this.published.push({ event, authTag, at: Date.now() });
          this.inject(event);
          reply(200, { accepted: true, message: "", event_id: event.id });
        };
        if (event.kind === 0 && this.holding.has(event.pubkey)) return void this.held.push({ author: event.pubkey, answer: accept });
        return accept();
      }
      if (req.method === "POST" && req.url === "/profiles/search") return reply(404, {});
      reply(404, { error: "not found" });
    });
  }

  upgrade(req, socket) {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const connection = { socket, buffer: Buffer.alloc(0), subs: new Map(), challenge: randomBytes(16).toString("hex"), authed: undefined };
    this.connections.add(connection);
    socket.on("data", (chunk) => this.read(connection, chunk));
    socket.on("close", () => this.connections.delete(connection));
    socket.on("error", () => this.connections.delete(connection));
    this.send(connection, ["AUTH", connection.challenge]);
  }

  send(connection, message) {
    if (!connection.socket.destroyed) connection.socket.write(frame(OP_TEXT, JSON.stringify(message)));
  }

  read(connection, chunk) {
    connection.buffer = Buffer.concat([connection.buffer, chunk]);
    for (;;) {
      const buf = connection.buffer;
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let length = buf[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buf.length < 4) return;
        length = buf.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buf.length < 10) return;
        length = Number(buf.readBigUInt64BE(2));
        offset = 10;
      }
      const maskEnd = offset + (masked ? 4 : 0);
      if (buf.length < maskEnd + length) return;
      const payload = Buffer.from(buf.subarray(maskEnd, maskEnd + length));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= buf[offset + (i % 4)];
      connection.buffer = buf.subarray(maskEnd + length);
      if (opcode === OP_CLOSE) {
        connection.socket.end(frame(OP_CLOSE, Buffer.alloc(0)));
        return;
      }
      if (opcode === OP_PING) {
        connection.socket.write(frame(OP_PONG, payload));
        continue;
      }
      if (opcode === OP_TEXT) this.message(connection, payload.toString("utf8"));
    }
  }

  message(connection, text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return;
    }
    const [type, ...rest] = data;
    if (type === "AUTH") {
      const event = rest[0];
      const tag = (name) => event?.tags?.find((item) => item[0] === name);
      let reason = "";
      if (!verifyEvent(event)) reason = "bad signature";
      else if (event.kind !== 22242) reason = "bad kind";
      else if (tag("challenge")?.[1] !== connection.challenge) reason = "bad challenge";
      else if (tag("relay")?.[1] !== this.url) reason = "bad relay";
      else if (!tag("auth")) reason = "no auth tag";
      const ok = !reason;
      this.auths.push({ event, ok, reason });
      if (ok) connection.authed = event.pubkey;
      this.send(connection, ["OK", event?.id, ok, reason]);
      return;
    }
    if (type === "REQ") {
      const [subId, ...filters] = rest;
      if (!connection.authed) return this.send(connection, ["CLOSED", subId, "auth-required:"]);
      this.reqs.push({ subId, filters, agent: connection.authed });
      connection.subs.set(subId, filters);
      for (const event of this.query(filters)) this.send(connection, ["EVENT", subId, event]);
      if (this.unfinished.delete(`${connection.authed}:${subId}`)) return;
      this.send(connection, ["EOSE", subId]);
      return;
    }
    if (type === "EVENT") {
      const event = rest[0];
      const tags = JSON.stringify(event?.tags ?? []);
      let reason = "";
      if (!connection.authed) reason = "auth-required:";
      else if (!verifyEvent(event)) reason = "invalid: bad signature";
      else if (event.pubkey !== connection.authed) reason = "restricted: not the authenticated agent";
      else if (event.kind !== KIND_AGENT_OBSERVER) reason = "restricted: kind not accepted over WebSocket";
      else if (Math.abs(event.created_at - Math.floor(Date.now() / 1000)) > OBSERVER_FRESHNESS_S) reason = "invalid: stale";
      else if (tags !== JSON.stringify([["p", this.owner], ["agent", event.pubkey], ["frame", "telemetry"]])) reason = "invalid: route tags";
      const ok = !reason;
      this.observed.push({ event, ok, reason, at: Date.now() });
      this.send(connection, ["OK", event?.id, ok, reason]);
      return;
    }
    if (type === "CLOSE") connection.subs.delete(rest[0]);
  }
}
