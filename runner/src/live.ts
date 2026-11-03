// One agent's live feed from its community. buzz-app's `nodeClient` is
// HTTP-only, so this is the runner's own NIP-42 WebSocket, shaped after
// buzz-acp's relay loop: wait for the relay's AUTH challenge, answer with a
// kind-22242 event that carries the owner's NIP-OA tag, then subscribe.
// It hears what can wake the agent (chat events that p-tag it, messages in
// its one-to-one DMs, and, for the reply-wake rule, the owner's chat messages
// in its channels), verifies each signature, drops duplicates, and
// hands the rest to the agent's gate. The relay's membership notices keep
// that channel scope current while the socket stays open. The cursor
// survives restarts so a reconnect catches up from the last event it saw.
import { CHAT_KINDS } from "@buzz/features/agents/attention";
import { eventDto, type RelayEvent } from "@buzz/features/relay/events";
import type { BuzzEvent, Template } from "@buzz/buzz-mcp/client";
import {
  CATCHUP_MAX_S,
  CHANNEL_ID,
  DEDUPE_LIMIT,
  FUTURE_SKEW_S,
  KIND_AUTH,
  KIND_CHANNEL_MEMBERS,
  KIND_CHAT,
  KIND_MEMBER_ADDED,
  KIND_MEMBER_REMOVED,
  KIND_PROBE,
  NOTICE_SYSTEM_TYPE,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
  RESUBSCRIBE_SKEW_S,
  ROSTER_LOAD_TIMEOUT_MS,
  ROSTER_SETTLE_MS,
  SUB_DMS,
  SUB_MEMBERSHIP,
  SUB_MENTIONS,
  SUB_NOTICES,
  SUB_PROBE,
  SUB_REPLIES,
  WS_AUTH_TIMEOUT_MS,
  WS_CONNECT_TIMEOUT_MS,
  WS_FRAME_LIMIT,
  WS_PROBE_INTERVAL_MS,
  WS_PROBE_TIMEOUT_MS,
} from "./constants";
import { errorMessage, RelayError } from "./errors";
import type { Logger } from "./log";
import { backoff, sleep } from "./net";
import { rosterMembers, type ChannelSummary } from "./reads";
import type { AgentState } from "./store";

export type LiveOptions = Readonly<{
  community: string;
  agent: string;
  authTag: readonly string[];
  /** Signs as the agent; the key stays in the caller's closure. */
  sign(template: Template): BuzzEvent;
  state: AgentState;
  /** The owner, whose untagged thread replies may wake the agent (config
   * `replyWake`); undefined subscribes to no such messages. */
  replyAuthor?: string | undefined;
  relayAuthor(): string | undefined;
  /** Desktop's channel summary, to tell a one-to-one DM from a group. */
  channel(id: string): Promise<ChannelSummary>;
  /** The agent's gate; true when the event was admitted. */
  onEvent(event: RelayEvent): Promise<boolean>;
  log: Logger;
}>;

export type LiveStatus = "connecting" | "connected" | "stopped";
/** A published event awaiting the relay's `OK`. */
type Waiting = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
/** The relay treats a re-sent event as success. */
const DUPLICATE = "duplicate";
const now = () => Math.floor(Date.now() / 1000);

export class LiveListener {
  status: LiveStatus = "connecting";
  private readonly abort = new AbortController();
  private readonly seen: Set<string>;
  /** Channel → roster, from relay-signed kind-39002 events naming the agent. */
  private rosters = new Map<string, readonly string[]>();
  /** Rosters of the membership REQ in flight; they replace `rosters` at its
   * EOSE, so a channel the agent left drops out instead of staying stale. */
  private loading: Map<string, readonly string[]> | undefined;
  /** A notice came while a load was in flight: load once more after it. */
  private reloadQueued = false;
  /** Channels a relay-signed add notice named that no roster load has shown
   * yet. They are in the scope at once: the relay stores the roster after
   * the notice and serves a cached channel list for a while (see
   * `ROSTER_SETTLE_MS`), so a load right after the notice misses the join.
   * Desktop (`relay/live.ts` `grant`) and buzz-acp also act on the notice's
   * channel. Kept across reconnects; a remove notice takes one out. */
  private readonly granted = new Set<string>();
  /** The pending load deadline and the confirming load after a notice; both
   * belong to the open socket and end with it. */
  private loadDeadline: ReturnType<typeof setTimeout> | undefined;
  private settleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ends the open socket with a reason; unset while none is authenticated. */
  private failSession: ((error: Error) => void) | undefined;
  private readonly types = new Map<string, string | undefined>();
  /** One-to-one DMs the agent is in, which wake it without a mention. */
  private dms = new Set<string>();
  /** True once the relay has sent the current rosters on this connection. */
  private membershipLoaded = false;
  /** Channel list of the open mention REQ, to skip identical re-sends. */
  private mentionScope = "";
  /** The `since` each wake subscription was opened with; older events are
   * dropped even if a relay sends them. */
  private readonly sinces = new Map<string, number>();
  private socket: WebSocket | undefined;
  private running: Promise<void> | undefined;
  /** The authenticated socket's sender and the frames awaiting `OK`; unset
   * while no socket is authenticated. */
  private outbox: { send(message: unknown): void; waiting: Map<string, Waiting> } | undefined;

  constructor(private readonly options: LiveOptions) {
    this.seen = new Set(options.state.recent);
  }

  start() {
    this.options.state.initCursor(now());
    this.running ??= this.loop();
  }

  async stop() {
    this.status = "stopped";
    this.abort.abort(new RelayError("listener stopped"));
    this.socket?.close();
    await this.running;
  }

  /** Sends `event` on the authenticated socket and resolves on the relay's
   * `OK`. Kinds the relay takes only over WebSocket use this (observer
   * frames: the HTTP bridge accepts typing only). Never queued or retried:
   * with no authenticated socket it fails at once, and the caller drops it. */
  publish(event: BuzzEvent, timeoutMs: number): Promise<void> {
    const outbox = this.outbox;
    if (!outbox) return Promise.reject(new RelayError("relay not connected"));
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        outbox.waiting.delete(event.id);
        reject(new RelayError(`relay did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      outbox.waiting.set(event.id, { resolve, reject, timer });
      outbox.send(["EVENT", event]);
    });
  }

  /** Whether `channel` is a one-to-one DM of the agent, by the relay's roster. */
  isDm(channel: string) {
    return this.dms.has(channel);
  }

  /** Reconnects for as long as the agent is active. Attempts are unbounded on
   * purpose: a listener that gives up leaves the agent deaf with no one to
   * notice. The delay is capped and jittered, and every attempt is logged. */
  private async loop() {
    const { log } = this.options;
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      const started = Date.now();
      let authenticated = false;
      try {
        await this.session(() => {
          authenticated = true;
          attempt = 0;
        });
      } catch (error) {
        if (this.abort.signal.aborted) break;
        log.warn("relay session ended", { attempt: attempt + 1, elapsedMs: Date.now() - started, authenticated, error });
      }
      if (this.abort.signal.aborted) break;
      this.status = "connecting";
      const delay = backoff(attempt++, RECONNECT_BASE_MS, RECONNECT_MAX_MS);
      log.info("relay reconnect scheduled", { attempt, delayMs: delay });
      await sleep(delay, this.abort.signal).catch(() => undefined);
    }
    this.status = "stopped";
  }

  /** One socket from connect to close. Resolves or rejects when it closes. */
  private session(onAuthenticated: () => void) {
    const { community, agent, log } = this.options;
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(community);
      this.socket = ws;
      let authId: string | undefined;
      let authenticated = false;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      let probeDeadline: ReturnType<typeof setTimeout> | undefined;
      let failure: Error | undefined;
      let outbox: LiveListener["outbox"];
      const send = (message: unknown) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      const fail = (error: Error) => {
        failure ??= error;
        ws.close();
      };
      // Connect, then authenticate, each within its own deadline.
      let deadline = setTimeout(() => fail(new RelayError("relay connect timed out")), WS_CONNECT_TIMEOUT_MS);
      const stop = () => ws.close();
      this.abort.signal.addEventListener("abort", stop, { once: true });

      // Same probe as the Desktop live client (buzz-app `relay/live.ts`): an
      // empty `limit: 0` REQ needs no database read, and a fresh id per probe
      // keeps a late answer to an old probe from counting for a new one.
      let probeId = "";
      let probeSerial = 0;
      const probe = () => {
        probeTimer = setTimeout(() => {
          if (probeId) send(["CLOSE", probeId]);
          probeId = `${SUB_PROBE}-${++probeSerial}`;
          send(["REQ", probeId, { kinds: [KIND_PROBE], "#p": [agent], limit: 0 }]);
          probeDeadline = setTimeout(() => fail(new RelayError("relay probe unanswered")), WS_PROBE_TIMEOUT_MS);
          // The relay can silently prune multi-channel scopes, so the
          // Desktop client renews them every quiet minute; do the same.
          this.renewMentions(send);
        }, WS_PROBE_INTERVAL_MS);
      };

      ws.addEventListener("open", () => {
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(new RelayError("relay authentication timed out")), WS_AUTH_TIMEOUT_MS);
        log.debug("relay connected");
      });
      ws.addEventListener("error", () => fail(new RelayError("relay socket error")));
      ws.addEventListener("close", (event) => {
        clearTimeout(deadline);
        clearTimeout(probeTimer);
        clearTimeout(probeDeadline);
        clearTimeout(this.loadDeadline);
        clearTimeout(this.settleTimer);
        if (this.failSession === fail) this.failSession = undefined;
        this.abort.signal.removeEventListener("abort", stop);
        if (this.socket === ws) this.socket = undefined;
        if (outbox) {
          if (this.outbox === outbox) this.outbox = undefined;
          for (const waiting of outbox.waiting.values()) {
            clearTimeout(waiting.timer);
            waiting.reject(new RelayError("relay socket closed"));
          }
          outbox.waiting.clear();
        }
        if (this.abort.signal.aborted) return resolve();
        reject(failure ?? new RelayError(`relay closed the socket (${event.code})`));
      });
      ws.addEventListener("message", (message) => {
        // #lizard forgives: one branch per relay message type (NIP-01, NIP-42)
        if (typeof message.data !== "string" || message.data.length > WS_FRAME_LIMIT) return;
        let data: unknown;
        try {
          data = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!Array.isArray(data)) return;
        const [type, first, second] = data as [unknown, unknown, unknown];
        if (type === "AUTH" && typeof first === "string" && !authId) {
          const auth = this.options.sign({
            kind: KIND_AUTH,
            content: "",
            tags: [["relay", community], ["challenge", first], [...this.options.authTag]],
          });
          authId = auth.id;
          send(["AUTH", auth]);
          return;
        }
        if (type === "OK" && first === authId && !authenticated) {
          if (second !== true) return fail(new RelayError("relay rejected authentication"));
          clearTimeout(deadline);
          authenticated = true;
          this.status = "connected";
          onAuthenticated();
          outbox = { send, waiting: new Map() };
          this.outbox = outbox;
          this.failSession = fail;
          log.info("relay authenticated");
          this.subscribe(send);
          probe();
          return;
        }
        if (!authenticated) return;
        if (type === "OK" && typeof first === "string" && outbox?.waiting.has(first)) {
          const waiting = outbox.waiting.get(first)!;
          outbox.waiting.delete(first);
          clearTimeout(waiting.timer);
          const reason = String(data[3] ?? "");
          if (second === true || reason.startsWith(DUPLICATE)) waiting.resolve();
          else waiting.reject(new RelayError(`relay refused the event: ${reason.slice(0, 200)}`));
          return;
        }
        if (probeId && first === probeId && (type === "EOSE" || type === "CLOSED")) {
          clearTimeout(probeDeadline);
          if (type === "EOSE") send(["CLOSE", probeId]);
          probeId = "";
          probe();
          return;
        }
        if (type === "EVENT" && typeof first === "string") return this.receive(first, second, send);
        if (type === "EOSE" && first === SUB_MEMBERSHIP) return this.rostersLoaded(send);
        // Our own CLOSE of an answered probe comes back as CLOSED: not news.
        if (type === "CLOSED" && typeof first === "string" && first.startsWith(`${SUB_PROBE}-`)) return;
        if (type === "CLOSED" && typeof first === "string") {
          log.warn("relay closed a subscription", { subscription: first, reason: String(second ?? "").slice(0, 200) });
          // The wake subscriptions are the listener's purpose: start over.
          // The notices are the only way it hears a join, so they count too.
          if (first === SUB_MENTIONS || first === SUB_DMS || first === SUB_REPLIES || first === SUB_NOTICES) fail(new RelayError(`subscription ${first} closed`));
          return;
        }
        if (type === "NOTICE") log.info("relay notice", { notice: String(first ?? "").slice(0, 200) });
      });
      // #lizard forgives: the socket handlers share one connection's state
    });
  }

  /** Mentions from the cursor; the membership list in full (it is replaceable,
   * so the relay sends the current one). The notice REQ goes before the
   * roster load: the relay handles one socket's frames in order, so a join
   * after the load was read still sends a notice. */
  private subscribe(send: (message: unknown) => void) {
    const { agent } = this.options;
    this.membershipLoaded = false;
    this.mentionScope = "";
    this.loading = undefined;
    this.reloadQueued = false;
    this.subscribeMentions(send);
    this.subscribeNotices(send, agent);
    this.loadRosters(send);
    if (this.dms.size) this.subscribeDms(send);
  }

  /** The relay keeps a roster (kind 39002) in its channel's scope, so it never
   * sends one live to the membership REQ, which has no `#h` (see
   * `subscribeMentions`). Each grant or loss of access instead sends the agent
   * a global notice (buzz-relay `side_effects.rs`
   * `emit_membership_notification`), as Desktop and buzz-acp use. Live only
   * (`limit: 0`): the roster load at connect already covers the past. The
   * second filter asks for system channels, which a filter without `#t`
   * does not get (buzz-core `filter.rs` `notice_channel_types`). */
  private subscribeNotices(send: (message: unknown) => void, agent: string) {
    const filter = { kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED], "#p": [agent], limit: 0 };
    send(["REQ", SUB_NOTICES, filter, { ...filter, "#t": [NOTICE_SYSTEM_TYPE] }]);
  }

  /** Asks the relay for every current roster that names the agent. One load
   * at a time: a second REQ with the same id would replace the first, and
   * the first one's EOSE could then end the second's load early. */
  private loadRosters(send: (message: unknown) => void) {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = new Map();
    // A load without EOSE would hold every later notice in `reloadQueued`.
    this.loadDeadline = setTimeout(() => this.failSession?.(new RelayError("relay roster load timed out")), ROSTER_LOAD_TIMEOUT_MS);
    send(["REQ", SUB_MEMBERSHIP, { kinds: [KIND_CHANNEL_MEMBERS], "#p": [this.options.agent] }]);
  }

  /** The roster load is complete: scope the wake subscriptions to it. */
  private rostersLoaded(send: (message: unknown) => void) {
    clearTimeout(this.loadDeadline);
    if (this.loading) this.rosters = this.loading;
    this.loading = undefined;
    const { agent } = this.options;
    for (const channel of this.granted) if (this.rosters.get(channel)?.includes(agent)) this.granted.delete(channel);
    this.membershipLoaded = true;
    this.subscribeMentions(send);
    void this.refreshDms(send);
    if (!this.reloadQueued) return;
    this.reloadQueued = false;
    this.loadRosters(send);
  }

  /** The relay gives a REQ without `#h` a community-global live scope, which
   * never matches channel events (buzz-relay `handlers/req.rs`,
   * `subscription.rs` `matches_channel`); such a REQ only returns stored
   * events. So once the rosters are known, the mention REQ names every
   * channel the agent belongs to. Reusing the subscription id makes the relay
   * replace the old REQ; the dedupe set drops events the new one replays. */
  private subscribeMentions(send: (message: unknown) => void) {
    const { agent } = this.options;
    const joined = [...this.rosters].filter(([, members]) => members.includes(agent)).map(([channel]) => channel);
    const channels = [...new Set([...joined, ...this.granted])].sort();
    const scope = channels.join(",");
    if (this.mentionScope && scope === this.mentionScope) return;
    this.mentionScope = scope || "global";
    const since = this.since();
    this.sinces.set(SUB_MENTIONS, since);
    const filter = { kinds: [...CHAT_KINDS], "#p": [agent], since };
    send(["REQ", SUB_MENTIONS, channels.length ? { ...filter, "#h": channels } : filter]);
    if (channels.length) this.options.log.info("mention subscription scoped", { channels: channels.length });
    this.subscribeReplies(send, channels, since);
  }

  /** The owner's chat messages in the agent's channels, for the reply-wake
   * rule. Only once channels are known: a REQ without `#h` gets no live
   * channel events (see `subscribeMentions`) and would only replay the
   * owner's stored messages from every channel. DM channels stay in: the
   * DM subscription hears the same messages, and the dedupe set keeps one.
   * The gate decides which of these, if any, are for this agent. With no
   * channel left the old REQ is kept, not closed: the relay answers a CLOSE
   * with CLOSED, which reads as a lost subscription and reconnects. The next
   * reconnect drops the stale scope, and until then the gate still checks
   * every event it brings. */
  private subscribeReplies(send: (message: unknown) => void, channels: readonly string[], since: number) {
    const owner = this.options.replyAuthor;
    if (!owner || !channels.length) return;
    this.sinces.set(SUB_REPLIES, since);
    send(["REQ", SUB_REPLIES, { kinds: [KIND_CHAT], authors: [owner], "#h": channels, since }]);
  }

  /** Re-sends a multi-channel mention REQ in place (see `probe`). */
  private renewMentions(send: (message: unknown) => void) {
    if (!this.membershipLoaded || !this.mentionScope.includes(",")) return;
    this.mentionScope = "";
    this.subscribeMentions(send);
  }

  /** Where catch-up starts. The cursor may sit up to FUTURE_SKEW_S past the
   * clock (see `receive`), so that is subtracted too: events from just
   * before a future-dated one are still fetched. */
  private since() {
    const cursor = this.options.state.cursor ?? now();
    return Math.max(cursor - RESUBSCRIBE_SKEW_S - FUTURE_SKEW_S, now() - CATCHUP_MAX_S);
  }

  private subscribeDms(send: (message: unknown) => void) {
    if (!this.dms.size) return send(["CLOSE", SUB_DMS]);
    const since = this.since();
    this.sinces.set(SUB_DMS, since);
    send(["REQ", SUB_DMS, { kinds: [KIND_CHAT], "#h": [...this.dms].sort(), since }]);
  }

  private receive(subscription: string, raw: unknown, send: (message: unknown) => void) {
    const { log } = this.options;
    let event: RelayEvent;
    try {
      event = eventDto(raw);
    } catch {
      log.warn("event dropped", { reason: "bad-signature", subscription });
      return;
    }
    if (subscription === SUB_MEMBERSHIP) {
      if (event.kind !== KIND_CHANNEL_MEMBERS || event.pubkey !== this.options.relayAuthor()) return;
      const channel = event.tags.find((item) => item[0] === "d")?.[1];
      if (!channel) return;
      if (this.loading) return void this.loading.set(channel, rosterMembers(event));
      this.rosters.set(channel, rosterMembers(event));
      // A join or leave after the initial rosters changes the live scope.
      if (this.membershipLoaded) this.subscribeMentions(send);
      void this.refreshDms(send);
      return;
    }
    if (subscription === SUB_NOTICES) return this.notice(event, send);
    if (subscription !== SUB_MENTIONS && subscription !== SUB_DMS && subscription !== SUB_REPLIES) return;
    // The relay applies the filter; this check keeps a stray frame from
    // reaching the gate as if it were the owner's.
    if (subscription === SUB_REPLIES && event.pubkey !== this.options.replyAuthor) return;
    if (event.created_at < (this.sinces.get(subscription) ?? 0)) {
      log.debug("event dropped", { reason: "before-since", subscription, event: event.id.slice(0, 12) });
      return;
    }
    if (this.seen.has(event.id)) return;
    this.seen.add(event.id);
    if (this.seen.size > DEDUPE_LIMIT) this.seen.delete(this.seen.values().next().value as string);
    // Only admitted events move the cursor, and never past the clock plus a
    // small skew: anyone who can mention the agent could otherwise date an
    // event in the future and make the next catch-up skip real ones. The
    // cursor only grows, so admissions that settle out of order are safe.
    void this.options
      .onEvent(event)
      .then((admitted) => {
        if (admitted) this.options.state.advance(Math.min(event.created_at, now() + FUTURE_SKEW_S), event.id);
      })
      .catch((error) => log.error("event handler failed", { event: event.id.slice(0, 12), error }));
  }

  /** A relay-signed notice that the agent gained or lost a channel. The
   * relay is already trusted for rosters, so its notice changes the scope at
   * once; a roster load after `ROSTER_SETTLE_MS` then brings the full
   * roster (one-to-one DMs need it). A notice signed by anyone else, or
   * without one valid channel id, is dropped. */
  private notice(event: RelayEvent, send: (message: unknown) => void) {
    const { agent, log } = this.options;
    const kinds: readonly number[] = [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED];
    const forAgent = event.tags.some(([name, value]) => name === "p" && value === agent);
    const channel = event.tags.find((item) => item[0] === "h")?.[1] ?? "";
    if (!kinds.includes(event.kind) || event.pubkey !== this.options.relayAuthor() || !forAgent || !CHANNEL_ID.test(channel)) {
      log.warn("event dropped", { reason: "bad-notice", subscription: SUB_NOTICES, event: event.id.slice(0, 12) });
      return;
    }
    log.info("membership notice", { kind: event.kind, channel });
    if (event.kind === KIND_MEMBER_ADDED) this.granted.add(channel);
    else {
      this.granted.delete(channel);
      this.rosters.delete(channel);
    }
    if (this.membershipLoaded) this.subscribeMentions(send);
    void this.refreshDms(send);
    // One confirming load after the last notice of a burst.
    clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.loadRosters(send), ROSTER_SETTLE_MS);
  }

  /** Recomputes the one-to-one DMs from the rosters and resubscribes when
   * they change. A channel's kind is read once; a failed read is retried on
   * the next roster change rather than guessed. */
  private async refreshDms(send: (message: unknown) => void) {
    const { agent, log } = this.options;
    if (!this.options.relayAuthor()) return;
    const next = new Set<string>();
    for (const [channel, members] of this.rosters) {
      if (members.length !== 2 || !members.includes(agent)) continue;
      if (!this.types.has(channel))
        try {
          this.types.set(channel, (await this.options.channel(channel)).channelType);
        } catch (error) {
          log.warn("channel kind unreadable", { channel, error: errorMessage(error) });
          continue;
        }
      if (this.types.get(channel) === "dm") next.add(channel);
    }
    const changed = next.size !== this.dms.size || [...next].some((channel) => !this.dms.has(channel));
    if (!changed) return;
    this.dms = next;
    log.info("dm channels updated", { count: next.size });
    this.subscribeDms(send);
  }
}
