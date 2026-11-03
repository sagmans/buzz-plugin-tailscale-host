// The harnesses this runner offers the owner (`GET /v1/harnesses`) and the
// models each lists (`GET /v1/harnesses/{id}/models`).
//
// Desktop's create dialog lists every local harness, and each harness lists
// its own models and effort levels. The plugin makes one hosted type per
// entry here, so the hosted choices are the same list, driven by the runner's
// `harnesses` config. A harness this runner cannot run yet is still listed,
// as not ready, so the owner sees it and knows why it cannot be picked.
//
// Claude's readiness and model list come from buzz-app's own code, imported
// unchanged: `checkClaude` (version and `claude auth status`, as Desktop's
// provider menu) and `ClaudeProcess` in discovery mode (as Desktop's model
// picker). Each check starts a short `claude` through the same sudo wrapper
// as agent turns, admitted under the live-session cap so a probe never pushes
// the host past `maxLiveSessions`.
//
// Every other harness is ready once it is installed: its configured path is
// there and is the path the root-owned `harness-wrapper` runs for it. Its
// provider sign-in is not a gate: a turn without one fails, and the failure
// is posted in the thread. Pi lists the models of the providers it has
// credentials for, through buzz-app's `Pi` client and `PiSetup`, from a
// short Pi host in the discovery workspace. Goose lists the models of the
// providers its config sets up, through buzz-app's `GooseSetup`, from short
// `goose-acp` processes in the discovery workspace. Codex lists its models
// through buzz-app's `AppServer` and `listModels`, from a short
// `codex app-server` in the discovery workspace.
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { ClaudeProcess, type ClaudeModel, type Spawn } from "@buzz/bundled/claude-code/claude";
import { checkClaude, type ClaudeStatus } from "@buzz/bundled/claude-code/setup";
import { effortName, type Model as CodexModel, resolveModel } from "@buzz/bundled/codex/config";
import { AppServer, listModels as listCodexModels } from "@buzz/bundled/codex/rpc";
import { GooseSetup, type Provider as GooseProvider } from "@buzz/bundled/goose/setup";
import { Pi } from "@buzz/bundled/pi/pi";
import { DEFAULT_THINKING, type PiModel, PiSetup, type Provider, runsAt } from "@buzz/bundled/pi/setup";
import type { RunnerConfig } from "./config";
import {
  CLAUDE_HARNESS,
  CLAUDE_HIDDEN_EFFORT,
  CODEX_DISCOVERY_TIMEOUT_MS,
  CODEX_HARNESS,
  CODEX_MODELS_MAX,
  DISCOVERY_AGENT,
  GOOSE_DISCOVERY_TIMEOUT_MS,
  GOOSE_HARNESS,
  GOOSE_MODEL_SEPARATOR,
  GOOSE_MODELS_MAX,
  HARNESS_CATALOG,
  HARNESS_DISCOVERY_TIMEOUT_MS,
  HARNESS_MODELS_TTL_MS,
  HOSTED_MODELS_TTL_MS,
  HARNESS_PATH_CHECK_TIMEOUT_MS,
  HARNESS_STATUS_TTL_MS,
  PI_DISCOVERY_TIMEOUT_MS,
  PI_HARNESS,
  PI_MODEL_SEPARATOR,
  PI_MODELS_MAX,
  PROBE_ADMIT_TIMEOUT_MS,
  type HarnessId,
} from "./constants";
import { BusyError, errorMessage, HarnessUnavailableError, NotFoundError, ProcessError } from "./errors";
import type { Logger } from "./log";
import { withTimeout } from "./net";
import type { PoolMember, SessionPool } from "./pool";
import { wrapperPath, type WrapperTarget } from "./wrapper";

/** Readiness as Desktop's provider menu words it (claude-code `setup.ts`
 * ClaudeStatus). A harness this runner cannot run yet is never `ready`;
 * `supported: false` says why. */
export type HarnessState = ClaudeStatus["state"];

export type HarnessView = Readonly<{
  id: HarnessId;
  title: string;
  /** This runner has code to run it. */
  supported: boolean;
  /** Its program is on the host (false when unknown or unsupported). */
  installed: boolean;
  /** An agent on it can take turns now. */
  ready: boolean;
  state: HarnessState;
  version?: string;
  /** The signed-in account, shown to the owner as Desktop does; never logged. */
  account?: string;
  /** Why it is not ready, in words for the owner. */
  message?: string;
}>;

/** Desktop's `Model` (features/agents/service.ts): efforts lowest first. */
export type ModelView = Readonly<{
  id: string;
  label: string;
  efforts: readonly Readonly<{ id: string; label: string }>[];
  /** The effort a turn without a pick runs at, when the harness reports it. */
  effort?: string;
}>;
export type ModelsView = Readonly<{ current: string; models: readonly ModelView[] }>;

type Cached<T> = { at: number; value: Promise<T> };

/** Words for each state, for the owner (Desktop's provider menu copy). */
const STATE_MESSAGES: Readonly<Record<HarnessState, string | undefined>> = {
  ready: undefined,
  missing: "Claude is not installed on the host",
  outdated: "Claude on the host is older than Buzz needs",
  "signed-out": "Claude is not signed in on the host (run `claude auth login` as the agent user)",
  error: "Claude did not start on the host",
};
/** Words for a harness this runner cannot run yet. Its install is only
 * looked at, never started: it has no sudo wrapper, and its provider sign-in
 * is the owner's to set up. */
const NOT_RUNNABLE_MESSAGES = Object.freeze({
  installed: "Installed, not signed in or configured. This host cannot run it yet.",
  missing: "Not installed on this host",
  notFound: "Not found at its configured path",
});
/** Words for a harness this runner can run that is not installed. */
const RUNNABLE_MESSAGES = Object.freeze({
  wrapperDiffers: "Its configured path is not the one the host wrapper runs",
  wrapperFailed: "The host wrapper did not report its path",
});

export class Harnesses {
  private status: Cached<ClaudeStatus> | undefined;
  private readonly models = new Map<HarnessId, Cached<ModelsView>>();
  /** What the wrapper says it runs, per harness. */
  private readonly wrapped = new Map<HarnessId, Cached<string>>();
  /** Probe processes running now, so the cap counts them. */
  private readonly probes = new Set<string>();
  private probeCount = 0;
  private disposed = false;
  private readonly member: PoolMember;

  constructor(
    private readonly deps: Readonly<{
      config: RunnerConfig;
      /** Starts `claude` through the wrapper, in the discovery workspace. */
      spawn: Spawn;
      /** Starts another harness through `harness-wrapper`, in the
       * discovery workspace. */
      spawnHarness(harness: HarnessId): Spawn;
      /** Runs `harness-wrapper <id> --path`. */
      wrapper: WrapperTarget;
      pool: SessionPool;
      log: Logger;
    }>,
  ) {
    // Probes are never evicted and never hold a conversation: they only take
    // a slot while they run.
    this.member = {
      id: "harness-probe",
      live: () => [...this.probes].map((key) => ({ key, at: Date.now(), evictable: false })),
      holds: () => false,
      evict: () => false,
      stopped: () => this.disposed,
    };
    deps.pool.register(this.member);
  }

  /** Every offered harness, in config order, with its readiness. */
  async list(): Promise<HarnessView[]> {
    return Promise.all(this.deps.config.harnesses.map((id) => this.view(id)));
  }

  /** The models a harness lists. Only a ready harness can list them. */
  async listModels(id: string): Promise<ModelsView> {
    const harness = this.offered(id);
    if (!HARNESS_CATALOG[harness].supported)
      throw new HarnessUnavailableError(`${HARNESS_CATALOG[harness].title} cannot run on this host yet`);
    if (harness === CLAUDE_HARNESS) {
      const status = await this.claudeStatus();
      if (status.state !== "ready")
        throw new HarnessUnavailableError(STATE_MESSAGES[status.state] ?? "Claude is not ready on the host");
    } else {
      const view = await this.view(harness);
      if (!view.ready) throw new HarnessUnavailableError(`${view.title} is not ready on this host: ${view.message ?? ""}`);
    }
    const ttl = harness === CLAUDE_HARNESS ? HARNESS_MODELS_TTL_MS : HOSTED_MODELS_TTL_MS;
    // An empty list is what a harness without a sign-in lists: it is never
    // kept, so the first sign-in shows at once.
    return cached(this.models, harness, ttl, (view) => view.models.length > 0, () =>
      harness === PI_HARNESS
        ? this.discoverPi()
        : harness === GOOSE_HARNESS
          ? this.discoverGoose()
          : harness === CODEX_HARNESS
            ? this.discoverCodex()
            : this.discover(),
    );
  }

  /** Throws unless agents can be made on `id` here: offered and supported.
   * Readiness is not required, so an agent can be made while claude signs
   * in; its turns fail with a clear error until then. */
  requireUsable(id: string): HarnessId {
    // Not 404 as for the models route: the agent exists, its harness is what
    // the host refuses.
    if (!this.deps.config.harnesses.includes(id as HarnessId))
      throw new HarnessUnavailableError("This host does not offer that harness");
    const harness = id as HarnessId;
    if (!HARNESS_CATALOG[harness].supported)
      throw new HarnessUnavailableError(`${HARNESS_CATALOG[harness].title} cannot run on this host yet`);
    return harness;
  }

  /** Throws unless `id` can take a turn now: an agent moved onto it has its
   * sessions stopped, so a harness still signing in would leave it mute. */
  async requireReady(id: string): Promise<HarnessId> {
    if (!this.deps.config.harnesses.includes(id as HarnessId))
      throw new HarnessUnavailableError("This host does not offer that harness");
    // The view's message first, so the owner reads why (not installed, not
    // signed in) and not only that the harness is unsupported.
    const view = await this.view(id as HarnessId);
    if (!view.ready)
      throw new HarnessUnavailableError(`${view.title} is not ready on this host${view.message ? `: ${view.message}` : ""}`);
    return this.requireUsable(id);
  }

  /** Whether `id` is offered and supported, for agents loaded at startup. */
  usable(id: string) {
    return this.deps.config.harnesses.includes(id as HarnessId) && HARNESS_CATALOG[id as HarnessId]?.supported === true;
  }

  dispose() {
    this.disposed = true;
    this.deps.pool.unregister(this.member);
  }

  private offered(id: string): HarnessId {
    if (!this.deps.config.harnesses.includes(id as HarnessId))
      throw new NotFoundError("This host does not offer that harness");
    return id as HarnessId;
  }

  private async view(id: HarnessId): Promise<HarnessView> {
    const { title, supported } = HARNESS_CATALOG[id];
    if (!supported) return this.installView(id);
    if (id !== CLAUDE_HARNESS) return this.runnableView(id);
    const status = await this.claudeStatus().catch(
      (error): ClaudeStatus => ({ state: "error", message: errorMessage(error) }),
    );
    const message = STATE_MESSAGES[status.state];
    return {
      id,
      title,
      supported,
      installed: status.state !== "missing" && status.state !== "error",
      ready: status.state === "ready",
      state: status.state,
      ...("version" in status && status.version ? { version: status.version } : {}),
      ...("account" in status && status.account ? { account: status.account } : {}),
      ...(message ? { message } : {}),
    };
  }

  /** A harness this runner cannot run: installed when its configured path
   * is there and the runner may enter or run it. It is never started. */
  private async installView(id: HarnessId): Promise<HarnessView> {
    const { title } = HARNESS_CATALOG[id];
    const base = { id, title, supported: false, ready: false } as const;
    const path = this.deps.config.harnessPaths[id];
    if (!path) return { ...base, installed: false, state: "missing", message: NOT_RUNNABLE_MESSAGES.missing };
    if (!(await this.present(id, path)))
      return { ...base, installed: false, state: "missing", message: NOT_RUNNABLE_MESSAGES.notFound };
    return { ...base, installed: true, state: "signed-out", message: NOT_RUNNABLE_MESSAGES.installed };
  }

  /** A harness this runner can run, other than Claude: ready once it is
   * installed and the wrapper runs the configured path. Nothing is started
   * but the wrapper's path report. */
  private async runnableView(id: HarnessId): Promise<HarnessView> {
    const { title } = HARNESS_CATALOG[id];
    const missing = (message: string) =>
      ({ id, title, supported: true, installed: false, ready: false, state: "missing", message }) as const;
    const path = this.deps.config.harnessPaths[id];
    if (!path) return missing(NOT_RUNNABLE_MESSAGES.missing);
    if (!(await this.present(id, path))) return missing(NOT_RUNNABLE_MESSAGES.notFound);
    let wrapped: string;
    try {
      wrapped = await cached(this.wrapped, id, HARNESS_STATUS_TTL_MS, () => true, () => wrapperPath(this.deps.wrapper, id));
    } catch (error) {
      this.deps.log.warn("harness wrapper path check failed", { harness: id, error });
      return missing(RUNNABLE_MESSAGES.wrapperFailed);
    }
    if (wrapped !== path) {
      this.deps.log.error("harness path differs from the one its wrapper runs", { harness: id, path, wrapped });
      return missing(RUNNABLE_MESSAGES.wrapperDiffers);
    }
    return { id, title, supported: true, installed: true, ready: true, state: "ready" };
  }

  /** Whether the configured path is there and the runner may run or enter it. */
  private async present(id: HarnessId, path: string) {
    try {
      await withTimeout(
        (async () => {
          const found = await stat(path);
          if (!found.isFile() && !found.isDirectory()) throw new Error("not a file or directory");
          // Execute on a file, search on a directory: what running it needs.
          await access(path, fsConstants.X_OK);
        })(),
        HARNESS_PATH_CHECK_TIMEOUT_MS,
        `${id} install check`,
      );
      return true;
    } catch (error) {
      this.deps.log.warn("harness not found at its configured path", { harness: id, path, error });
      return false;
    }
  }

  /** `checkClaude`, reused for a minute, one check at a time. */
  private claudeStatus(): Promise<ClaudeStatus> {
    if (this.status && Date.now() - this.status.at < HARNESS_STATUS_TTL_MS) return this.status.value;
    const value = checkClaude(this.probeSpawn()).then((status) => {
      if (status.state !== "ready")
        this.deps.log.warn("claude not ready on this host", {
          state: status.state,
          ...("version" in status ? { version: status.version } : {}),
          ...(status.state === "error" ? { error: status.message } : {}),
        });
      return status;
    });
    this.status = { at: Date.now(), value };
    value.catch(() => {
      if (this.status?.value === value) this.status = undefined;
    });
    return value;
  }

  /** Desktop's model discovery (claude-code `setup.ts` queryModels and
   * `runtime.ts` catalog): a `claude` in discovery mode lists its models
   * without a turn, then stops. */
  private async discover(): Promise<ModelsView> {
    let process: ClaudeProcess | undefined;
    const started = Date.now();
    try {
      const work = (async () => {
        process = await ClaudeProcess.start(this.probeSpawn(), { cwd: "~", systemPrompt: "", discovery: true });
        const running = process;
        // A model or effort Claude does not report is just not shown as the default.
        const [listed, reported, effort] = await Promise.all([
          running.models(),
          running.readModel().catch(() => undefined),
          running.readEffort().catch(() => undefined),
        ]);
        return catalog(listed, this.deps.config.model || reported || "", this.deps.config.effort ?? effort);
      })();
      const view = await withTimeout(work, HARNESS_DISCOVERY_TIMEOUT_MS, "claude model discovery");
      this.deps.log.info("claude models listed", { models: view.models.length, elapsedMs: Date.now() - started });
      return view;
    } catch (error) {
      this.deps.log.warn("claude model discovery failed", { elapsedMs: Date.now() - started, error });
      throw new HarnessUnavailableError("Claude did not list its models on the host", { cause: error });
    } finally {
      // Cast: TS narrows the closure-assigned variable to undefined here.
      await (process as ClaudeProcess | undefined)?.kill().catch(() => undefined);
    }
  }

  /** Desktop's Pi model list (pi `runtime.ts` models, `setup.ts`), across
   * every provider Pi has credentials for, from a Pi host that then stops.
   * Ids are `<provider>/<model>`: a hosted agent has one model field. */
  private async discoverPi(): Promise<ModelsView> {
    const started = Date.now();
    const pi = new Pi(() => this.probeSpawn(this.deps.spawnHarness(PI_HARNESS)), {
      tool: () => Promise.reject(new ProcessError("Model discovery runs no tools")),
      event: () => undefined,
    });
    const setup = new PiSetup(pi);
    try {
      const work = (async () => {
        const { providers, defaults } = await setup.providers();
        const signedIn = providers.filter((provider) => provider.configured);
        const lists = await Promise.all(
          signedIn.map(async (provider) => ({ provider, models: await setup.models(provider.id) })),
        );
        return piCatalog(lists, defaults);
      })();
      const view = await withTimeout(work, PI_DISCOVERY_TIMEOUT_MS, "pi model discovery");
      this.deps.log.info("pi models listed", { models: view.models.length, elapsedMs: Date.now() - started });
      return view;
    } catch (error) {
      this.deps.log.warn("pi model discovery failed", { elapsedMs: Date.now() - started, error });
      throw new HarnessUnavailableError("Pi did not list its models on the host", { cause: error });
    } finally {
      await pi.dispose().catch(() => undefined);
    }
  }

  /** Desktop's Goose model list (goose `setup.ts` picks), across every
   * provider Goose's config sets up, each read by short `goose-acp`
   * processes one provider at a time, so a discovery holds one live-session
   * slot. Ids are `<provider>/<model>`: a hosted agent has one model field. */
  private async discoverGoose(): Promise<ModelsView> {
    const started = Date.now();
    const setup = new GooseSetup({
      spawn: this.probeSpawn(this.deps.spawnHarness(GOOSE_HARNESS)),
      // The wrapper starts Goose in the discovery workspace; the throwaway
      // sessions that read model levels name it as their cwd.
      resolveDirectory: async () => `${this.deps.config.workspaceRoot}/${DISCOVERY_AGENT}`,
    });
    try {
      const work = (async () => {
        const { providers, defaults } = await setup.providers();
        const lists: { provider: GooseProvider; models: ModelsView["models"] }[] = [];
        for (const provider of providers.filter((item) => item.configured && !item.needs)) {
          // goose calls a local server (LM Studio, Atomic Chat) configured on
          // its built-in host alone; one that does not answer is left out,
          // not every provider's models with it.
          try {
            const picks = await setup.picks({ provider: provider.id, model: "" });
            lists.push({ provider, models: picks.models });
          } catch (error) {
            this.deps.log.warn("goose provider models skipped", { provider: provider.id, error });
          }
        }
        return gooseCatalog(lists, defaults);
      })();
      const view = await withTimeout(work, GOOSE_DISCOVERY_TIMEOUT_MS, "goose model discovery");
      this.deps.log.info("goose models listed", { models: view.models.length, elapsedMs: Date.now() - started });
      return view;
    } catch (error) {
      this.deps.log.warn("goose model discovery failed", { elapsedMs: Date.now() - started, error });
      throw new HarnessUnavailableError("Goose did not list its models on the host", { cause: error });
    }
  }

  /** Desktop's Codex model list (codex `runtime.ts` preview): Codex's own
   * catalog, from an `app-server` that then stops. It needs no sign-in. */
  private async discoverCodex(): Promise<ModelsView> {
    const started = Date.now();
    const rpc = new AppServer();
    try {
      const work = (async () => {
        await rpc.open(this.probeSpawn(this.deps.spawnHarness(CODEX_HARNESS)));
        return codexCatalog(await listCodexModels(rpc));
      })();
      const view = await withTimeout(work, CODEX_DISCOVERY_TIMEOUT_MS, "codex model discovery");
      this.deps.log.info("codex models listed", { models: view.models.length, elapsedMs: Date.now() - started });
      return view;
    } catch (error) {
      this.deps.log.warn("codex model discovery failed", { elapsedMs: Date.now() - started, error });
      throw new HarnessUnavailableError("Codex did not list its models on the host", { cause: error });
    } finally {
      await rpc.close().catch(() => undefined);
    }
  }

  /** The discovery workspace's spawn, each process admitted under the
   * live-session cap and counted until it exits. */
  private probeSpawn(spawn: Spawn = this.deps.spawn): Spawn {
    return async (id, options) => {
      if (this.disposed) throw new ProcessError("The runner is stopping");
      const key = `probe-${++this.probeCount}`;
      const admitted = this.deps.pool.admit(this.member, key);
      let release: () => void;
      try {
        release = await withTimeout(admitted, PROBE_ADMIT_TIMEOUT_MS, "live-session slot for a probe");
      } catch (error) {
        // A slot that frees later is handed straight back.
        void admitted.then((late) => late(), () => undefined);
        throw new BusyError("Every live session on the host is busy; try again shortly", { cause: error });
      }
      this.probes.add(key);
      const done = () => {
        this.probes.delete(key);
        release();
      };
      try {
        const child = await spawn(id, options);
        void child.exited.then(done, done);
        return child;
      } catch (error) {
        done();
        throw error;
      }
    };
  }
}

/** Desktop's catalog (adapted from buzz-app src/bundled/claude-code/runtime.ts
 * 258-300; see NOTICE): `default` is not a choice, labels are Desktop's model
 * names, and `max` is not offered. A current model Claude does not list is
 * shown first, at any listed effort. */
function catalog(listed: readonly ClaudeModel[], own: string, effort: string | undefined): ModelsView {
  const resting = (efforts: readonly { id: string }[]) =>
    effort && efforts.some((level) => level.id === effort) ? { effort } : {};
  const offered = listed.filter((model) => model.value !== "default");
  const models = offered.map((model) => {
    const efforts = effortChoices(effortLevels(model));
    return { id: model.value, label: modelName(model.resolvedModel ?? model.value), efforts, ...resting(efforts) };
  });
  const current = offered.find((model) => own === model.value || own === model.resolvedModel)?.value ?? own;
  if (!current || models.some((model) => model.id === current)) return { current, models };
  const efforts = effortChoices(offered.flatMap(effortLevels));
  return { current, models: [{ id: current, label: modelName(current), efforts, ...resting(efforts) }, ...models] };
}

/** A value reused for `ttlMs`, one computation at a time; a failed one, or
 * one `keep` refuses, is not kept, so the next ask computes it again. */
function cached<K, T>(
  cache: Map<K, Cached<T>>,
  key: K,
  ttlMs: number,
  keep: (value: T) => boolean,
  compute: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = compute();
  cache.set(key, { at: Date.now(), value });
  const forget = () => {
    if (cache.get(key)?.value === value) cache.delete(key);
  };
  value.then((done) => {
    if (!keep(done)) forget();
  }, forget);
  return value;
}

/** Pi's models as one list: each signed-in provider's, in Pi's order, ids
 * `<provider>/<model>`, labels naming the provider when there are several.
 * Efforts are the model's thinking levels; its default is the level Pi's
 * settings pick, clamped as Pi clamps it. */
function piCatalog(
  lists: readonly Readonly<{ provider: Provider; models: readonly PiModel[] }>[],
  defaults: Readonly<{ provider?: string; model?: string; thinking?: string }>,
): ModelsView {
  const level = defaults.thinking || DEFAULT_THINKING;
  const models = lists
    .flatMap(({ provider, models: listed }) =>
      listed.map((model) => {
        const efforts = model.thinking.map((id) => ({ id, label: effortLabel(id) }));
        return {
          id: `${provider.id}${PI_MODEL_SEPARATOR}${model.id}`,
          label: lists.length > 1 ? `${model.label} · ${provider.name}` : model.label,
          efforts,
          ...(efforts.length ? { effort: runsAt(model.thinking, level) } : {}),
        };
      }),
    )
    .slice(0, PI_MODELS_MAX);
  const current =
    defaults.provider && defaults.model ? `${defaults.provider}${PI_MODEL_SEPARATOR}${defaults.model}` : "";
  return { current, models };
}

/** Goose's models as one list: each configured provider's, in Goose's
 * order, ids `<provider>/<model>`, labels naming the provider when there are
 * several. Efforts are the levels Goose lists for the model, resting where
 * Goose runs it. */
function gooseCatalog(
  lists: readonly Readonly<{ provider: GooseProvider; models: ModelsView["models"] }>[],
  defaults: Readonly<{ provider?: string; model?: string }>,
): ModelsView {
  const models = lists
    .flatMap(({ provider, models: listed }) =>
      listed.map((model) => ({
        ...model,
        id: `${provider.id}${GOOSE_MODEL_SEPARATOR}${model.id}`,
        label: lists.length > 1 ? `${model.label} · ${provider.name}` : model.label,
      })),
    )
    .slice(0, GOOSE_MODELS_MAX);
  const current =
    defaults.provider && defaults.model ? `${defaults.provider}${GOOSE_MODEL_SEPARATOR}${defaults.model}` : "";
  return { current, models };
}

/** Codex's models as Desktop's picker shows them (codex `runtime.ts`
 * preview): Codex's labels and effort names, each resting at the model's
 * default effort; the current model is Codex's recommended one. */
function codexCatalog(listed: readonly CodexModel[]): ModelsView {
  const models = listed.slice(0, CODEX_MODELS_MAX).map((row) => ({
    id: row.model,
    label: row.displayName || row.model,
    efforts: row.supportedReasoningEfforts.map(({ reasoningEffort: id }) => ({ id, label: effortName(id) })),
    ...(row.defaultReasoningEffort ? { effort: row.defaultReasoningEffort } : {}),
  }));
  return { current: resolveModel("", listed) ?? "", models };
}

// Desktop's label rules, copied from buzz-app src/bundled/claude-code/runtime.ts
// (70-82, 986-993; Apache-2.0, Copyright 2026 Block, Inc.; see NOTICE)
// because that module also loads Desktop's agent store and cannot be imported
// here. Keep them in step with it.
const effortLabel = (id: string) => (id === "xhigh" ? "Extra high" : `${id.charAt(0).toUpperCase()}${id.slice(1)}`);
const effortChoices = (levels: readonly string[]) =>
  [...new Set(levels)].filter((id) => id !== CLAUDE_HIDDEN_EFFORT).map((id) => ({ id, label: effortLabel(id) }));
const effortLevels = (model: ClaudeModel) =>
  model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? []);
const MODEL_ID_PATTERN = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[.*\])?$/;
function modelName(model: string) {
  const id = MODEL_ID_PATTERN.exec(model);
  const family = id?.[1] ?? (/^[a-z]+$/.test(model) ? model : undefined);
  if (!family) return model;
  const name = family[0]?.toUpperCase() + family.slice(1);
  return id ? `${name} ${id[2]}${id[3] ? `.${id[3]}` : ""}` : name;
}
