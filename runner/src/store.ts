// State on disk. Agent records hold each agent's secret key, so every file is
// 0600 in a 0700 tree owned by the runner user, and every write is atomic
// (temp file, fsync, rename) so a crash never leaves a half-written key.
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { open, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { SavedSession, SessionStore } from "@buzz/bundled/claude-code/sessions";
import {
  AGENTS_DIR,
  FILES_DIR,
  HEX64,
  MEDIA_DIR,
  RECENT_IDS_PERSISTED,
  SAVED_SESSIONS_LIMIT,
  SESSIONS_DIR,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
} from "./constants";
import type { Effort } from "./config";
import type { HarnessId, SCOPES } from "./constants";
import { StateError } from "./errors";
import { log } from "./log";

export type Scope = (typeof SCOPES)[number];

export type AgentSettings = Readonly<{
  instructions: string;
  model?: string;
  effort?: Effort;
  /** Fixed once the agent is activated: a session belongs to one harness.
   * Absent is Claude, which every agent made before harness choice runs. */
  harness?: HarnessId;
  /** Desktop's session scope; absent is one session per thread. */
  scope?: Scope;
}>;

/** One agent as the runner keeps it. `secretKey` never leaves this process. */
export type AgentRecord = Readonly<{
  pubkey: string;
  secretKey: string;
  name: string;
  picture?: string;
  community: string;
  activated: boolean;
  /** The owner's NIP-OA tag as given at activation. */
  auth?: readonly string[];
  config: AgentSettings;
  createdAt: number;
  /** created_at of the last accepted profile, so a rename within the same
   * second still replaces it (Rust `sign_event_after`). */
  profileAt?: number;
}>;

/** Per-agent live state: the relay cursor and Desktop-shaped saved sessions. */
type SessionsFile = {
  cursor?: number;
  recent?: string[];
  sessions?: Record<string, SavedSession>;
};

/** One write at a time per file, so a slow write never lands after a newer one. */
const queues = new Map<string, Promise<void>>();

async function writeAtomic(path: string, data: string) {
  const prior = queues.get(path) ?? Promise.resolve();
  const next = prior.then(async () => {
    const tmp = `${path}.${randomUUID()}.tmp`;
    const handle = await open(tmp, "wx", STATE_FILE_MODE);
    try {
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(tmp, path);
    } catch (error) {
      await rm(tmp, { force: true });
      throw error;
    }
  });
  const settled = next.catch(() => undefined);
  queues.set(path, settled);
  void settled.then(() => {
    if (queues.get(path) === settled) queues.delete(path);
  });
  return next;
}

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true, mode: STATE_DIR_MODE });
  // mkdir's mode is masked by umask and ignored for an existing directory.
  chmodSync(path, STATE_DIR_MODE);
}

export class StateStore {
  readonly agentsDir: string;
  readonly sessionsDir: string;

  constructor(readonly root: string) {
    this.agentsDir = join(root, AGENTS_DIR);
    this.sessionsDir = join(root, SESSIONS_DIR);
  }

  /** Creates the tree with owner-only modes, and refuses one another user
   * could read: keys would be exposed. */
  init() {
    try {
      for (const dir of [this.root, this.agentsDir, this.sessionsDir, join(this.root, FILES_DIR), join(this.root, MEDIA_DIR)])
        ensureDir(dir);
      const mode = statSync(this.root).mode & 0o777;
      if (mode !== STATE_DIR_MODE) throw new StateError(`State dir ${this.root} has mode ${mode.toString(8)}`);
    } catch (cause) {
      if (cause instanceof StateError) throw cause;
      throw new StateError(`Cannot prepare state dir ${this.root}`, { cause });
    }
  }

  /** An empty directory only the runner can write, which bounds what the
   * Buzz tools' `path` and `files` arguments may read. */
  filesRoot(pubkey: string) {
    const dir = join(this.root, FILES_DIR, pubkey);
    ensureDir(dir);
    return dir;
  }
  mediaDir(pubkey: string) {
    const dir = join(this.root, MEDIA_DIR, pubkey);
    ensureDir(dir);
    return dir;
  }

  listAgents(): AgentRecord[] {
    const records: AgentRecord[] = [];
    for (const name of readdirSync(this.agentsDir)) {
      const pubkey = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !HEX64.test(pubkey)) continue;
      try {
        records.push(this.readAgentFile(pubkey));
      } catch (error) {
        // One unreadable record must not stop the others from running.
        log.error("agent record unreadable", { agent: pubkey.slice(0, 12), error });
      }
    }
    return records;
  }

  private readAgentFile(pubkey: string): AgentRecord {
    const path = this.agentPath(pubkey);
    const mode = statSync(path).mode & 0o777;
    if (mode !== STATE_FILE_MODE) chmodSync(path, STATE_FILE_MODE);
    const record = JSON.parse(readFileSync(path, "utf8")) as AgentRecord;
    if (record.pubkey !== pubkey || typeof record.secretKey !== "string" || !HEX64.test(record.secretKey))
      throw new StateError(`Agent record ${pubkey.slice(0, 12)} is malformed`);
    return record;
  }

  async saveAgent(record: AgentRecord) {
    try {
      await writeAtomic(this.agentPath(record.pubkey), `${JSON.stringify(record, null, 2)}\n`);
    } catch (cause) {
      throw new StateError(`Cannot save agent ${record.pubkey.slice(0, 12)}`, { cause });
    }
  }

  async deleteAgent(pubkey: string) {
    try {
      await (queues.get(this.agentPath(pubkey)) ?? Promise.resolve());
      await rm(this.agentPath(pubkey), { force: true });
      await (queues.get(this.sessionsPath(pubkey)) ?? Promise.resolve());
      await rm(this.sessionsPath(pubkey), { force: true });
    } catch (cause) {
      throw new StateError(`Cannot delete agent ${pubkey.slice(0, 12)}`, { cause });
    }
  }

  /** The agent's relay cursor and saved sessions, read once and written
   * through on each change. */
  agentState(pubkey: string) {
    return new AgentState(this.sessionsPath(pubkey));
  }

  private agentPath(pubkey: string) {
    if (!HEX64.test(pubkey)) throw new StateError("Bad agent id");
    return join(this.agentsDir, `${pubkey}.json`);
  }
  private sessionsPath(pubkey: string) {
    if (!HEX64.test(pubkey)) throw new StateError("Bad agent id");
    return join(this.sessionsDir, `${pubkey}.json`);
  }
}

/** Cursor, recent ids and the Desktop `SessionStore` for one agent. Reads are
 * from memory, as Desktop's `AgentStore` reads are synchronous; writes go to
 * disk in the background and failures are logged, as Desktop logs "Claude
 * sessions were not saved". */
export class AgentState {
  private data: SessionsFile;
  private closed = false;

  constructor(private readonly path: string) {
    try {
      this.data = JSON.parse(readFileSync(path, "utf8")) as SessionsFile;
    } catch {
      this.data = {};
    }
  }

  get cursor() {
    return this.data.cursor;
  }
  get recent(): readonly string[] {
    return this.data.recent ?? [];
  }
  /** Records the newest event handled, for catch-up after a restart. */
  advance(createdAt: number, id: string) {
    this.data.cursor = Math.max(this.data.cursor ?? 0, createdAt);
    this.data.recent = [...(this.data.recent ?? []), id].slice(-RECENT_IDS_PERSISTED);
    this.flush();
  }
  initCursor(createdAt: number) {
    if (this.data.cursor === undefined) {
      this.data.cursor = createdAt;
      this.flush();
    }
  }

  readonly sessions: SessionStore = {
    get: (key) => {
      const saved = this.data.sessions?.[key];
      return saved && typeof saved.id === "string" ? saved : undefined;
    },
    set: (key, session) => {
      this.data.sessions = prune({ ...this.data.sessions, [key]: session });
      this.flush();
    },
    delete: async (key) => {
      const { [key]: _gone, ...rest } = this.data.sessions ?? {};
      this.data.sessions = rest;
      await this.write();
    },
  };

  /** Drops every saved session, keeping the relay cursor: after a harness
   * change the old sessions belong to another program and cannot resume. */
  async forgetSessions() {
    this.data.sessions = {};
    await this.write();
  }

  /** Stops writing: the agent was deleted, and its file with it. */
  close() {
    this.closed = true;
  }

  private flush() {
    void this.write().catch((error) =>
      log.warn("agent state not saved", { file: this.path.split("/").at(-1), error }),
    );
  }
  private async write() {
    if (this.closed) return;
    await writeAtomic(this.path, JSON.stringify(this.data));
  }
}

/** Keeps the most recently used sessions, as Desktop's `localSessions` does. */
function prune(sessions: Record<string, SavedSession>) {
  return Object.fromEntries(
    Object.entries(sessions)
      .sort(([, a], [, b]) => b.at - a.at)
      .slice(0, SAVED_SESSIONS_LIMIT),
  );
}

/** Keeps an agent's saved media under `maxBytes` by deleting the oldest
 * files first, since nodeClient's `media_get` caps one file (500 MiB) but
 * not their sum. Partial downloads (dot files) belong to a running call and
 * are left alone. Returns the removed paths. */
export async function trimMedia(dir: string, maxBytes: number): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files = (
    await Promise.all(
      names
        .filter((name) => !name.startsWith("."))
        .map(async (name) => {
          const path = join(dir, name);
          const info = await stat(path).catch(() => undefined);
          return info?.isFile() ? { path, size: info.size, at: info.mtimeMs } : undefined;
        }),
    )
  )
    .filter((file) => file !== undefined)
    .sort((a, b) => a.at - b.at);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  const removed: string[] = [];
  for (const file of files) {
    if (total <= maxBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
    removed.push(file.path);
  }
  return removed;
}
