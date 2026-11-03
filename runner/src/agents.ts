// The hosted agents this runner keeps: their keys, their live feeds and their
// turn runtimes, and the five lifecycle calls Desktop's hosted agent type
// makes through the plugin (docs/RUNNER_CONTRACT.md, section 2). Each call is safe to repeat.
//
// Key custody: the secret key is generated here, written only to the agent's
// 0600 record, and used only inside this process (nodeClient's closure and
// the AUTH signer). It is never returned, logged, put in a child's argv or
// environment, or written anywhere the claude user can read.
import { nodeClient } from "@buzz/buzz-mcp/node";
import type { BuzzClient, Template } from "@buzz/buzz-mcp/client";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { verifyOwnerProof, type AuthTag } from "./attest";
import type { RunnerConfig } from "./config";
import {
  ACTIVATE_DEADLINE_MS,
  AGENT_RECORDS_MAX,
  CHILD_STOP_BUDGET_MS,
  CLAUDE_HARNESS,
  DEFAULT_SCOPE,
  DISCOVERY_AGENT,
  GOOSE_HARNESS,
  HARNESS_CATALOG,
  HARNESS_EFFORTS,
  HARNESS_MODEL_IDS,
  HARNESS_PROGRAMS,
  KIND_PROFILE,
  MODEL_ID,
  MEDIA_TOTAL_MAX_BYTES,
  PROVISION_RATE_MAX,
  PROVISION_RATE_WINDOW_MS,
  TURN_QUEUE_LIMIT,
  VERSION,
} from "./constants";
import { ConflictError, NotFoundError, RelayError, RunnerError, ValidationError } from "./errors";
import { ServerPool } from "@buzz/bundled/goose/sessions";
import { Harnesses } from "./harnesses";
import type { HarnessId } from "./constants";
import { Limiter } from "./limiter";
import { LiveListener } from "./live";
import { McpServers } from "./mcp-server";
import { short, type Logger } from "./log";
import { retry, sleep } from "./net";
import { CommunityReads, relaySelf } from "./reads";
import { AgentRuntime } from "./runtime";
import { SessionPool } from "./pool";
import { withoutAttestation } from "./publish";
import { ChildTracker, harnessSpawn, wrapperSpawn, type ChildStop } from "./spawn";
import { type StreamTap, Telemetry } from "./telemetry";
import { trimMedia, type AgentRecord, type AgentSettings, type AgentState, type StateStore } from "./store";

export type ProvisionInput = Readonly<{ name: string; picture?: string; community: string }>;
export type ActivateInput = Readonly<{ name: string; community: string; auth: AuthTag; config?: AgentSettings }>;
export type ProfileInput = Readonly<{ name: string; picture?: string }>;

/** What a running agent holds besides its record. */
type Running = {
  client: BuzzClient;
  state: AgentState;
  listener: LiveListener;
  runtime: AgentRuntime;
  telemetry?: Telemetry | undefined;
  /** Its claude processes, so a stop can wait until each one exited. */
  children: ChildTracker;
};

const MS_PER_S = 1000;
const now = () => Math.floor(Date.now() / MS_PER_S);

export class AgentManager {
  private readonly records = new Map<string, AgentRecord>();
  private readonly running = new Map<string, Running>();
  /** One lifecycle call per agent at a time, so activate and delete never race. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly limiter: Limiter;
  /** One live-process cap for every agent: memory is the host's, not the agent's. */
  private readonly pool: SessionPool;
  /** The offered harnesses and their readiness; also checks each agent's
   * harness, so http and activate share one rule. */
  readonly harnesses: Harnesses;
  /** The loopback MCP servers of every Goose session, under one cap. */
  private readonly mcp: McpServers;
  /** The servers Goose sessions hold, least recently used first: an idle
   * session closes to make room for a new one (buzz-app `ServerPool`). */
  private readonly mcpPool = new ServerPool();
  /** Claude processes the runner starts for itself (readiness and model
   * checks), stopped with the agents' own at shutdown. */
  private readonly hostChildren = new ChildTracker();
  /** When recent agents were created, for the provision rate limit. */
  private provisioned: number[] = [];
  private stopping = false;

  constructor(
    private readonly config: RunnerConfig,
    private readonly store: StateStore,
    private readonly log: Logger,
  ) {
    this.limiter = new Limiter(config.maxParallelTurns, TURN_QUEUE_LIMIT);
    this.pool = new SessionPool(config.maxLiveSessions, log.child({ component: "pool" }));
    this.mcp = new McpServers(log.child({ component: "mcp" }));
    const harnessLog = log.child({ component: "harnesses" });
    this.harnesses = new Harnesses({
      config,
      // Checks run as the claude user in a workspace no agent owns, with no
      // telemetry tap: they hold no conversation.
      spawn: wrapperSpawn(
        {
          sudo: config.sudo,
          runAsUser: config.runAsUser,
          wrapper: config.wrapper,
          agent: DISCOVERY_AGENT,
          children: this.hostChildren,
        },
        harnessLog,
      ),
      spawnHarness: (harness) => this.spawnHarness(harness, DISCOVERY_AGENT, this.hostChildren, harnessLog),
      wrapper: { sudo: config.sudo, runAsUser: config.runAsUser, wrapper: config.harnessWrapper },
      pool: this.pool,
      log: harnessLog,
    });
  }

  /** Starts `harness` for `agent` through `harness-wrapper`, with only the
   * programs its buzz-app module asks for. */
  private spawnHarness(
    harness: HarnessId,
    agent: string,
    children: ChildTracker,
    log: Logger,
    tap?: () => StreamTap | undefined,
  ) {
    const { programs, passArgs } = HARNESS_PROGRAMS[harness] ?? { programs: [], passArgs: false };
    return harnessSpawn(
      {
        sudo: this.config.sudo,
        runAsUser: this.config.runAsUser,
        wrapper: this.config.harnessWrapper,
        harness,
        agent,
        programs,
        passArgs,
        tap,
        children,
      },
      log,
    );
  }

  /** Loads every record and starts the activated agents. */
  async start() {
    for (const record of this.store.listAgents()) {
      if (!this.config.relays.includes(record.community)) {
        this.log.warn("agent community no longer allowed; not started", { agent: short(record.pubkey) });
        this.records.set(record.pubkey, record);
        continue;
      }
      this.records.set(record.pubkey, record);
      if (record.activated && record.auth) await this.launch(record);
    }
    this.log.info("agents loaded", { total: this.records.size, running: this.running.size });
  }

  health() {
    return { ok: true, version: VERSION, agents: this.records.size };
  }

  /** A new key, or the same not-yet-activated agent for a repeated call
   * with the same name and community. New keys are capped in number and in
   * rate, since each one is stored and can run claude processes; a repeat
   * call is never limited. */
  provision(input: ProvisionInput) {
    return this.locked("provision", async () => {
      for (const record of this.records.values())
        if (!record.activated && record.name === input.name && record.community === input.community)
          return { pubkey: record.pubkey, ...(record.picture ? { picture: record.picture } : {}) };
      if (this.records.size >= AGENT_RECORDS_MAX)
        throw new RunnerError("agent_limit", 409, `This runner keeps at most ${AGENT_RECORDS_MAX} agents`);
      const started = Date.now();
      this.provisioned = this.provisioned.filter((at) => started - at < PROVISION_RATE_WINDOW_MS);
      if (this.provisioned.length >= PROVISION_RATE_MAX) {
        this.log.warn("provision rate limited", { windowMs: PROVISION_RATE_WINDOW_MS, max: PROVISION_RATE_MAX });
        throw new RunnerError("rate_limited", 429, "Too many new agents; try again later");
      }
      this.provisioned.push(started);
      const secret = generateSecretKey();
      const record: AgentRecord = {
        pubkey: getPublicKey(secret),
        secretKey: bytesToHex(secret),
        name: input.name,
        ...(input.picture ? { picture: input.picture } : {}),
        community: input.community,
        activated: false,
        config: { instructions: "" },
        createdAt: now(),
      };
      secret.fill(0);
      await this.store.saveAgent(record);
      this.records.set(record.pubkey, record);
      this.log.info("agent provisioned", { agent: short(record.pubkey) });
      return { pubkey: record.pubkey, ...(record.picture ? { picture: record.picture } : {}) };
    });
  }

  view(pubkey: string) {
    const record = this.require(pubkey);
    return {
      pubkey: record.pubkey,
      name: record.name,
      ...(record.picture ? { picture: record.picture } : {}),
      community: record.community,
      activated: record.activated,
      config: { ...record.config, harness: harnessOf(record.config), scope: record.config.scope ?? DEFAULT_SCOPE },
      // Shown read-only, as Desktop shows a local agent's folder.
      workspace: `${this.config.workspaceRoot}/${record.pubkey}`,
    };
  }

  /** The settings to keep, and whether a live agent moves to another
   * harness. A move stops the agent's sessions, so it is allowed only onto a
   * harness that can take the next turn. A new agent on Claude only needs a
   * Claude this runner can run (its sign-in may follow, and checking it
   * starts a probe); on another harness it needs the harness installed, the
   * gate Desktop's picker shows. An edit that keeps the harness is never
   * blocked by it. */
  private async settle(record: AgentRecord, settings: AgentSettings) {
    const wanted = settings.harness ?? harnessOf(record.config);
    const moved = record.activated && wanted !== harnessOf(record.config);
    const gated = moved || (!record.activated && wanted !== CLAUDE_HARNESS);
    const harness = gated ? await this.harnesses.requireReady(wanted) : this.harnesses.requireUsable(wanted);
    const efforts = HARNESS_EFFORTS[harness] ?? [];
    // Desktop never offers `max` for Claude (claude-code `effortChoices`);
    // each harness takes only the levels its own picker shows.
    if (settings.effort && !efforts.includes(settings.effort))
      throw new ValidationError(`effort ${settings.effort} is not offered for ${HARNESS_CATALOG[harness].title}`);
    // Request validation took any harness's model shape; this one's may be narrower.
    if (settings.model && !(HARNESS_MODEL_IDS[harness] ?? MODEL_ID).test(settings.model))
      throw new ValidationError(`model ${settings.model} is not a ${HARNESS_CATALOG[harness].title} model id`);
    return { config: { ...settings, harness }, moved };
  }

  /** Stops the agent's sessions gracefully, drops them (they belong to the
   * old harness) and starts it again on the new one. */
  private async move(record: AgentRecord, from: string) {
    const state = this.running.get(record.pubkey)?.state;
    this.report(await this.halt(record.pubkey), short(record.pubkey));
    const sessions = state ?? this.store.agentState(record.pubkey);
    await sessions.forgetSessions();
    // The next launch reads the file afresh; this copy must not write again.
    sessions.close();
    await this.launch(record);
    this.log.info("agent harness changed", { agent: short(record.pubkey), from, to: harnessOf(record.config) });
  }

  /** Verifies the owner's proof, publishes the profile with it, then starts
   * listening. A repeat re-verifies and republishes, which is harmless. */
  activate(pubkey: string, input: ActivateInput) {
    return this.locked(pubkey, () =>
      deadline(
        (async () => {
          const record = this.require(pubkey);
          if (record.community !== input.community)
            throw new ConflictError("community differs from the one this agent was created in");
          await verifyOwnerProof(input.auth, pubkey, this.config.ownerPubkey);
          const { config, moved } = await this.settle(record, input.config ?? record.config);
          let next: AgentRecord = { ...record, name: input.name, auth: [...input.auth], config };
          await this.save(next);
          const profileAt = await this.publishProfile(next);
          next = { ...next, activated: true, profileAt };
          await this.save(next);
          const live = this.running.get(pubkey);
          // A new owner proof must reach the AUTH signer and the client, which
          // captured the old one; otherwise only the prompt may have changed.
          if (moved) await this.move(next, harnessOf(record.config));
          else if (live && JSON.stringify(record.auth) === JSON.stringify(next.auth)) live.runtime.reconfigure();
          else {
            this.report(await this.halt(pubkey), short(pubkey));
            await this.launch(next);
          }
          this.log.info("agent activated", { agent: short(pubkey) });
        })(),
        ACTIVATE_DEADLINE_MS,
        "activate",
      ),
    );
  }

  profile(pubkey: string, input: ProfileInput) {
    return this.locked(pubkey, async () => {
      const record = this.require(pubkey);
      const { picture: _old, ...rest } = record;
      let next: AgentRecord = { ...rest, name: input.name, ...(input.picture ? { picture: input.picture } : {}) };
      await this.save(next);
      if (next.activated) {
        next = { ...next, profileAt: await this.publishProfile(next) };
        await this.save(next);
      }
      this.running.get(pubkey)?.runtime.reconfigure();
    });
  }

  setConfig(pubkey: string, settings: AgentSettings) {
    return this.locked(pubkey, async () => {
      const record = this.require(pubkey);
      const { config, moved } = await this.settle(record, settings);
      const next = { ...record, config };
      await this.save(next);
      if (moved) await this.move(next, harnessOf(record.config));
      else this.running.get(pubkey)?.runtime.reconfigure();
    });
  }

  async interrupt(pubkey: string, channel: string, root: string | undefined) {
    this.require(pubkey);
    const live = this.running.get(pubkey);
    return { interrupted: live ? await live.runtime.interrupt(channel, root) : false };
  }

  /** Stops everything for the agent and deletes its key. Its workspace on
   * the claude user's side is kept. Absent is already done. */
  remove(pubkey: string) {
    return this.locked(pubkey, async () => {
      this.report(await this.halt(pubkey, true), short(pubkey));
      await this.store.deleteAgent(pubkey);
      const existed = this.records.delete(pubkey);
      if (existed) this.log.info("agent deleted", { agent: short(pubkey) });
    });
  }

  /** Stops every agent in parallel, each on its own budget, and waits for
   * their claude processes: systemd SIGKILLs what is left when the runner
   * exits, and a killed claude can lose the end of its session file. */
  async shutdown() {
    this.stopping = true;
    this.limiter.close();
    this.harnesses.dispose();
    const started = Date.now();
    const results = await Promise.allSettled([
      ...[...this.running.keys()].map((pubkey) => this.halt(pubkey)),
      this.hostChildren.stopAll(CHILD_STOP_BUDGET_MS, this.hostChildren.pids()),
    ]);
    // Sessions closed with their agents; any server left has no one to serve.
    this.mcp.dispose();
    const stops = results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
    for (const result of results)
      if (result.status === "rejected") this.log.error("agent stop failed", { error: result.reason });
    this.report(
      {
        children: stops.reduce((sum, stop) => sum + stop.children, 0),
        exited: stops.reduce((sum, stop) => sum + stop.exited, 0),
        alive: stops.flatMap((stop) => stop.alive),
        elapsedMs: Date.now() - started,
      },
      undefined,
    );
  }

  /** One line per stop: how many claude processes exited and how long it
   * took, and an error naming any still running at the deadline. */
  private report(stop: ChildStop | undefined, agent: string | undefined) {
    if (!stop) return;
    const where = agent ? { agent } : {};
    this.log.info("claude children stopped", {
      ...where,
      children: stop.children,
      exited: stop.exited,
      alive: stop.alive.length,
      elapsedMs: stop.elapsedMs,
    });
    if (stop.alive.length)
      this.log.error("claude children still running at the stop deadline", { ...where, pids: stop.alive });
  }

  /** Stops the agent and waits for its claude processes, within the agent's
   * own budget, so one slow agent never holds up another's stop. Events are
   * refused at once; busy turns are interrupted (see `AgentRuntime.shutdown`).
   * `deleting` also stops its state writes, so a late write cannot recreate
   * a deleted file. */
  private async halt(pubkey: string, deleting = false): Promise<ChildStop | undefined> {
    const live = this.running.get(pubkey);
    if (!live) return undefined;
    this.running.delete(pubkey);
    const started = Date.now();
    const among = live.children.pids();
    const stopping = live.runtime.shutdown();
    await Promise.all([stopping, live.listener.stop()]);
    live.telemetry?.dispose();
    if (deleting) live.state.close();
    // A process that was still starting when the stop began counts too.
    const stop = await live.children.stopAll(CHILD_STOP_BUDGET_MS, [...new Set([...among, ...live.children.pids()])]);
    return { ...stop, elapsedMs: Date.now() - started };
  }

  private require(pubkey: string) {
    const record = this.records.get(pubkey);
    if (!record) throw new NotFoundError("No such agent");
    return record;
  }

  private async save(record: AgentRecord) {
    await this.store.saveAgent(record);
    this.records.set(record.pubkey, record);
  }

  /** A Buzz client acting as the agent. Its `path`/`files` reads are bounded
   * to an empty runner-owned directory: the runner can read its own key
   * files, so a broader root would let a prompt post them. The owner's tag
   * is given to nodeClient for the membership header and memory encryption.
   * With `attestEvents` off it is kept off published events except the
   * profile (publish.ts says why). */
  private client(record: AgentRecord): BuzzClient {
    const auth = record.auth ? JSON.stringify(record.auth) : undefined;
    const client = nodeClient({
      relay: record.community,
      key: record.secretKey,
      ...(auth ? { auth } : {}),
      root: this.store.filesRoot(record.pubkey),
      media: this.store.mediaDir(record.pubkey),
    });
    if (this.config.attestEvents) return client;
    return withoutAttestation(client, { relay: record.community, key: record.secretKey, ...(auth ? { auth } : {}) });
  }

  /** Kind 0 as Desktop's native agents publish it (agent-controller
   * `profile_event`): name, `bot: true`, picture, with the owner's tag. The
   * write is idempotent, so transient failures are retried. */
  private async publishProfile(record: AgentRecord) {
    // A replaceable event replaces only an older one: wait out the second.
    while (record.profileAt !== undefined && now() <= record.profileAt) await sleep(MS_PER_S / 4);
    const client = this.client(record);
    const content = JSON.stringify({ name: record.name, bot: true, ...(record.picture ? { picture: record.picture } : {}) });
    try {
      const event = await retry(
        "publish profile",
        () => client.publish({ kind: KIND_PROFILE, content, tags: [] }),
        this.log.child({ agent: short(record.pubkey) }),
      );
      return event.created_at;
    } catch (cause) {
      throw new RelayError("The community did not accept the profile", { cause });
    }
  }

  private async launch(record: AgentRecord) {
    if (this.stopping || this.running.has(record.pubkey) || !record.auth) return;
    const log = this.log.child({ agent: short(record.pubkey) });
    // A harness removed from config, or one this build cannot run, must not
    // run as Claude by mistake: the agent stays stopped until it is offered.
    const harness = harnessOf(record.config);
    if (!this.harnesses.usable(harness)) {
      log.error("agent harness not offered on this runner; not started", { harness });
      return;
    }
    const client = this.client(record);
    const state = this.store.agentState(record.pubkey);
    let relayAuthor: string | undefined;
    try {
      relayAuthor = await retry("read relay identity", () => relaySelf(record.community), log);
      if (!relayAuthor) log.warn("relay names no signing key; DM wake disabled");
    } catch (error) {
      log.warn("relay identity unreadable; DM wake disabled until restart", { error });
    }
    const reads = new CommunityReads(client, () => relayAuthor);
    const mediaDir = this.store.mediaDir(record.pubkey);
    // A budget lowered across releases applies from the start.
    void trimMedia(mediaDir, MEDIA_TOTAL_MAX_BYTES).catch((error) => log.warn("media trim failed", { error }));
    const secret = hexToBytes(record.secretKey);
    let runtime!: AgentRuntime;
    const listener = new LiveListener({
      community: record.community,
      agent: record.pubkey,
      authTag: record.auth,
      sign: (template: Template) =>
        finalizeEvent({ ...template, tags: template.tags.map((tag) => [...tag]), created_at: now() }, secret),
      state,
      replyAuthor: this.config.replyWake ? this.config.ownerPubkey : undefined,
      relayAuthor: () => relayAuthor,
      channel: (id) => reads.channel(id),
      onEvent: (event) => runtime.handle(event),
      log,
    });
    // Frames go over the agent's own authenticated socket: the relay takes
    // kind 24200 only there, and checks the owner from that AUTH.
    const telemetry = this.config.publishTelemetry
      ? new Telemetry({
          agent: record.pubkey,
          owner: this.config.ownerPubkey,
          secret,
          publish: (event, timeoutMs) => listener.publish(event, timeoutMs),
          sessionOf: (key) => state.sessions.get(key)?.id,
          log: log.child({ component: "telemetry" }),
        })
      : undefined;
    const children = new ChildTracker();
    runtime = new AgentRuntime({
      record: () => this.records.get(record.pubkey) ?? record,
      client,
      reads,
      isDm: (channel) => listener.isDm(channel),
      isHosted: (pubkey) => this.records.has(pubkey),
      mediaDir,
      harness,
      spawn:
        harness === CLAUDE_HARNESS
          ? wrapperSpawn(
              {
                sudo: this.config.sudo,
                runAsUser: this.config.runAsUser,
                wrapper: this.config.wrapper,
                agent: record.pubkey,
                tap: telemetry && ((session, fresh, cwd) => telemetry.tap(session, fresh, cwd)),
                children,
              },
              log,
            )
          : this.spawnHarness(
              harness,
              record.pubkey,
              children,
              log,
              // Goose's raw ACP; Pi reports through its engine's feed.
              telemetry && harness === GOOSE_HARNESS
                ? () => telemetry.acpTap((session) => runtime.keyOfSession(session))
                : undefined,
            ),
      state,
      config: this.config,
      limiter: this.limiter,
      pool: this.pool,
      serveMcp: this.mcp.serve,
      mcpPool: this.mcpPool,
      log,
      telemetry,
    });
    this.running.set(record.pubkey, { client, state, listener, runtime, telemetry, children });
    listener.start();
    log.info("agent started");
  }

  /** Serializes calls per key; a failure does not block the next call. */
  private locked<T>(key: string, run: () => Promise<T>): Promise<T> {
    if (this.stopping) return Promise.reject(new RunnerError("shutting_down", 503, "The runner is stopping"));
    const prior = this.locks.get(key) ?? Promise.resolve();
    const next = prior.then(run, run);
    const settled = next.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) this.locks.delete(key);
    });
    return next;
  }
}

/** Absent is Claude: records made before harnesses existed ran on it. */
const harnessOf = (config: AgentSettings) => config.harness ?? CLAUDE_HARNESS;

function deadline<T>(work: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayError(`${operation} did not finish within ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
