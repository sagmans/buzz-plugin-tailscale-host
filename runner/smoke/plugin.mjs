// Dogfood of the Buzz plugin against a live runner: the module is built from
// ../../plugin/plugin.js for a smoke hosts.json (scripts/build-plugin.mjs, as
// a user builds it), then loaded with a stand-in for Desktop's plugin
// context (React, `agents.register`, `host.spawn`, `effect`), and its React
// views are rendered in jsdom. `host.spawn` starts the real hosts helper from
// the built manifest, as Desktop does, and the helper reaches each test host
// over HTTPS (https-front.mjs), which forwards to the runner's API socket as
// `tailscale serve` does. It checks what the owner sees in the New agent
// dialog and in Settings, without Buzz Desktop.
//
// React, react-dom and jsdom are the runner's own pinned dev dependencies
// (runner/package.json), at the versions Desktop uses.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PluginBuildError, RUNNER_PORT, buildPlugin, validateHosts } from "../../scripts/build-plugin.mjs";
import { SETUP_STEPS } from "../../scripts/host-setup.mjs";
import { runnerUrl } from "../../scripts/hosts-helper.mjs";
import { makeCertificate, startFront } from "./https-front.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The source manifest: it grants nothing until a build adds the helper. */
const SOURCE_MANIFEST = resolve(HERE, "../../plugin/manifest.json");
/** The test hosts; each gets the origin of its HTTPS front at the start.
 * The smoke host forwards to the runner. The rogue host, answered by the
 * smoke itself, claims agents it does not hold, under ROGUE_PUBKEY. The lab
 * host is a second front on the same runner, added on the Settings page. */
const SMOKE_HOST_BASE = Object.freeze({ id: "smoke-host", label: "smoke/host" });
const ROGUE_HOST_BASE = Object.freeze({ id: "rogue-host", label: "rogue/host" });
const LAB_HOST_BASE = Object.freeze({ id: "lab-one", label: "lab/one" });
const ROGUE_PUBKEY = "cd".repeat(32);
/** Desktop's sources, to check the plugin draws only Desktop's classes; the
 * runner build reads the same clone (the runner/buzz-app link). */
const DESKTOP_SRC = resolve(HERE, "../buzz-app/src");
/** What Desktop's AgentsService.register accepts as a type id. */
const TYPE_ID = /^[a-z0-9][a-z0-9._-]*$/;
/** The one hosted type: the id existing agents carry, and its title. */
const TYPE_ID_VALUE = "tailscale-host";
const TYPE_TITLE = "Tailscale host";
/** Desktop's harness order (claude-code, codex, goose, pi), by the runner's titles. */
const HARNESS_TITLES = ["Claude", "Codex", "Goose", "Pi"];
/** The store key of builds that registered a type per harness, under an
 * earlier plugin id namespace. */
const LEGACY_HARNESS_CACHE_KEY = "example.tailscale-host.harnesses.v1";
/** The agent-to-host map of a build under an earlier plugin id namespace,
 * and the key this build keeps it under (plugin.js STORE_PREFIX). */
const EARLIER_HOST_KEY = `example.tailscale-host.agent-host.v1:${"ab".repeat(32)}`;
const MIGRATED_HOST_KEY = `sagmans.tailscale-host.agent-host.v1:${"ab".repeat(32)}`;
/** The helper the build grants as the plugin's one host process. */
const HOSTS_HELPER = resolve(HERE, "../../scripts/hosts-helper.mjs");
const POLL_MS = 25;
const WAIT_MS = 15_000;
const DOM_URL = "https://buzz.invalid/";
/** Globals jsdom provides that React DOM and the plugin read. */
const DOM_GLOBALS = ["window", "document", "localStorage", "navigator", "HTMLElement", "Event", "Node", "MouseEvent", "KeyboardEvent"];

/** Desktop's design-system styles, relative to its src/, and the file types
 * the class check reads. */
const DESKTOP_STYLES_DIR = "shared/design-system/styles";
const CSS_FILE_RE = /\.css$/;
const TSX_FILE_RE = /\.tsx$/;
/** A JSX className in Desktop's markup: a plain string, or a template
 * literal in braces (\x60 is the backtick). */
const CLASS_NAME_RE = /className=(?:"([^"]*)"|\{\x60([^\x60]*)\x60\})/g;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * @param {object} deps
 * @param {(method: string, path: string, body?: string) => Promise<{status: number, text: string}>} deps.request
 *   One call to the runner API, as `tailscale serve` forwards it (login header added).
 * @param {(name: string, ok: unknown, detail?: string) => void} deps.check
 * @param {(pubkey: string) => unknown} deps.authTag  The owner's NIP-OA tag for an agent.
 * @param {string} deps.community
 * @param {string} deps.workspaceRoot
 */
export async function pluginSmoke({ request, check, authTag, community, workspaceRoot }) {
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><body></body>", { url: DOM_URL });
  const saved = Object.fromEntries(DOM_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of DOM_GLOBALS)
    Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true });
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const cleanups = [];
  const buildDir = mkdtempSync(join(tmpdir(), "buzz-plugin-smoke-"));
  const fronts = [];
  // Every helper process the stand-in started, so none outlives the run, and
  // every line the plugin wrote to one, so a scenario can tell what it asked.
  const helpers = { children: new Set(), spawns: 0, failSpawn: false, lines: [] };
  try {
    const tls = await makeCertificate(buildDir);
    let hostDown = false;
    let rogueDown = false;
    const calls = [];
    const labCalls = [];
    // Both fronts share one runner, but a real lab host would be another
    // runner: agents made through the lab front are hidden from the smoke
    // front, or the plugin would rightly refuse them as another host's.
    const labAgents = new Set();
    /** A front that forwards to the runner, as `tailscale serve` does. */
    const forward = (log, down, own) => async ({ method, path, body }) => {
      log.push(`${method} ${path}`);
      if (down()) return "drop";
      const pubkey = /^\/v1\/agents\/([0-9a-f]{64})/.exec(path)?.[1];
      if (pubkey && labAgents.has(pubkey) !== own) return { status: 404, body: JSON.stringify({ error: "not_found", message: "no such agent" }) };
      const reply = await request(method, path, body);
      if (own && method === "POST" && path === "/v1/agents" && reply.status === 200) labAgents.add(JSON.parse(reply.text).pubkey);
      return { status: reply.status, body: reply.text };
    };
    const smokeFront = await startFront(tls, forward(calls, () => hostDown, false));
    const labFront = await startFront(tls, forward(labCalls, () => false, true));
    fronts.push(smokeFront, labFront);
    const SMOKE_HOST = Object.freeze({ ...SMOKE_HOST_BASE, origin: smokeFront.origin });
    const LAB_HOST = Object.freeze({ ...LAB_HOST_BASE, origin: labFront.origin });
    const hostsPath = join(buildDir, "hosts.json");
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST] }));
    const { outDir } = buildPlugin({ hostsPath, outDir: join(buildDir, "dist") });
    const PLUGIN = join(outDir, "plugin.js");
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    /** `host.spawn` as Desktop runs a declared process: program and leading
     * arguments from the installed manifest, the caller's after them, no
     * shell. NODE_EXTRA_CA_CERTS stands for the user's trust store, which
     * trusts the certificate of `tailscale serve`. */
    const desktopSpawn = (manifestPath) => async (id, { args = [], onStdout, onStderr } = {}) => {
      helpers.spawns += 1;
      if (helpers.failSpawn) throw new Error("spawn node ENOENT");
      const entry = JSON.parse(readFileSync(manifestPath, "utf8")).host?.processes?.find((item) => item.id === id);
      if (!entry || entry.program !== "node") throw new Error(`no declared process ${id}`);
      const child = spawn(process.execPath, [...entry.args, ...args], { env: { ...process.env, NODE_EXTRA_CA_CERTS: tls.cert }, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => onStdout?.(chunk));
      child.stderr.on("data", (chunk) => onStderr?.(chunk));
      const exited = new Promise((done) => child.once("exit", (code) => done(code)));
      helpers.children.add(child);
      void exited.then(() => helpers.children.delete(child));
      return {
        write: (data) => {
          helpers.lines.push(String(data));
          return new Promise((done, fail) => child.stdin.write(data, (error) => (error ? fail(error) : done())));
        },
        end: (data = "") => child.stdin.end(data),
        kill: () => child.kill("SIGTERM"),
        exited,
      };
    };
    const types = [];
    const ctx = {
      react: React,
      agents: {
        register(type) {
          if (!TYPE_ID.test(type.id ?? "") || !type.title || typeof type.defaults !== "function")
            throw new Error("Agent types need an id, a title and defaults");
          if (types.some((item) => item.id === type.id)) throw new Error(`Contribution already registered: ${type.id}`);
          types.push(type);
        },
      },
      host: { spawn: desktopSpawn(join(outDir, "manifest.json")) },
      effect(run) {
        cleanups.push(run());
      },
    };
    // Left by builds with a type per harness; the plugin must clear it.
    localStorage.setItem(LEGACY_HARNESS_CACHE_KEY, JSON.stringify([{ id: "codex", title: "Codex" }]));
    // An agent an earlier build placed on this host.
    localStorage.setItem(EARLIER_HOST_KEY, SMOKE_HOST.id);
    check("plugin: the source manifest grants no host access", JSON.parse(readFileSync(SOURCE_MANIFEST, "utf8")).host === undefined);
    // The owner's ask: the address names the machine, and the runner port is
    // the helper's to add. A port that the user wrote stays.
    const callTo = (origin) => runnerUrl([{ id: "a", label: "a", origin }], { host: "a", method: "GET", path: "/health", timeoutMs: 1000 }).href;
    check(
      "plugin: the helper calls the runner port when the address has none, and keeps a written port",
      callTo("https://machine.example.invalid") === `https://machine.example.invalid:${RUNNER_PORT}/v1/health` &&
        callTo(`https://machine.example.invalid:${RUNNER_PORT}`) === `https://machine.example.invalid:${RUNNER_PORT}/v1/health` &&
        callTo("https://machine.example.invalid:8443") === "https://machine.example.invalid:8443/v1/health",
      callTo("https://machine.example.invalid"),
    );
    let samePort;
    try {
      validateHosts({ hosts: [{ id: "a", label: "a", origin: "https://machine.example.invalid" }, { id: "b", label: "b", origin: `https://machine.example.invalid:${RUNNER_PORT}` }] });
    } catch (error) {
      samePort = error;
    }
    check("plugin: hosts.json refuses one machine twice, with and without the runner port", samePort instanceof PluginBuildError && /duplicate origin/.test(samePort.message), String(samePort));
    const grant = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")).host;
    check(
      "plugin: the build grants one host process, node on the helper with this hosts.json, and no network origin",
      JSON.stringify(Object.keys(grant)) === JSON.stringify(["processes"]) &&
        grant.processes.length === 1 &&
        grant.processes[0].id === "hosts" &&
        grant.processes[0].program === "node" &&
        JSON.stringify(grant.processes[0].args) === JSON.stringify([HOSTS_HELPER, "--hosts", hostsPath]),
      JSON.stringify(grant),
    );
    check("plugin: the build holds no host list", readFileSync(PLUGIN, "utf8") === readFileSync(resolve(HERE, "../../plugin/plugin.js"), "utf8"));
    const plugin = await import(`${pathToFileURL(PLUGIN).href}?smoke=${Date.now()}`);
    check("plugin: injects react, agents and host", JSON.stringify(plugin.inject) === JSON.stringify(["react", "agents", "host"]));
    await plugin.apply(ctx);
    check(
      "plugin: one hosted type, registered at once, with the legacy id; New agent's picker names its one host",
      types.length === 1 && types[0].id === TYPE_ID_VALUE && types[0].title === `${TYPE_TITLE} · ${SMOKE_HOST.label}`,
      JSON.stringify(types.map((item) => [item.id, item.title])),
    );
    const [hosted] = types;
    check("plugin: the type has its own icon and no harness suffix in its title", typeof hosted.icon === "function" && !/\(remote\)/.test(hosted.title));
    check("plugin: the type is hosted, with no run, models or timeoutMs", hosted.remote && !hosted.run && !hosted.models && hosted.timeoutMs === undefined);
    check("plugin: the old per-harness cache is removed", localStorage.getItem(LEGACY_HARNESS_CACHE_KEY) === null);
    check(
      "plugin: an earlier build's agent-to-host entry moves to this build's key",
      localStorage.getItem(MIGRATED_HOST_KEY) === SMOKE_HOST.id && localStorage.getItem(EARLIER_HOST_KEY) === null,
    );

    const until = async (predicate, label) => {
      const end = Date.now() + WAIT_MS;
      while (Date.now() < end) {
        const value = await act(async () => predicate());
        if (value) return value;
        await act(async () => sleep(POLL_MS));
      }
      throw new Error(`timed out waiting for ${label}`);
    };
    await until(() => hosted.provider.snapshot().readiness === "ready", "provider ready");
    check("plugin: provider is ready while one harness is ready", hosted.provider.snapshot().readiness === "ready", JSON.stringify(hosted.provider.snapshot()));
    check("plugin: provider snapshots are stable objects", hosted.provider.snapshot() === hosted.provider.snapshot());

    // ---- Desktop markup helpers ------------------------------------------
    // The plugin draws Desktop's own Select and Menu markup, so the smoke
    // drives it the way the owner does: open the pill, press an option.
    const mount = () => {
      const node = document.createElement("div");
      document.body.append(node);
      const root = createRoot(node);
      return { node, root, render: (element) => act(async () => root.render(element)), unmount: () => act(async () => root.unmount()) };
    };
    const press = (element) =>
      act(async () => {
        element.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
        element.click();
      });
    const key = (element, name) =>
      act(async () => {
        element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
      });
    const typeText = (control, value) =>
      act(async () => {
        const proto = control instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement : dom.window.HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(control, value);
        control.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      });
    const combobox = (node, label) => node.querySelector(`[role=combobox][aria-label="${label}"]`);
    const shownValue = (trigger) => trigger?.querySelector(".buzz-select-value")?.textContent;
    const shownSuffix = (trigger) => trigger?.querySelector(".buzz-select-value-suffix")?.textContent ?? "";
    /** Opens a pill and returns its popup. */
    const open = async (trigger) => {
      await press(trigger);
      return document.getElementById(trigger.getAttribute("aria-controls"));
    };
    const optionsOf = (popup) => [...popup.querySelectorAll("[role=option],[role=menuitemradio]")];
    const nameOf = (option) => option.getAttribute("aria-label") ?? option.querySelector(".buzz-choice-row-label")?.textContent;
    const labels = (popup) => optionsOf(popup).map(nameOf);
    /** Picks an option by its label in the pill named `label`. */
    const choose = async (node, label, option) => {
      const trigger = await until(() => combobox(node, label), `${label} pill`);
      const popup = await open(trigger);
      const target = optionsOf(popup).find((item) => nameOf(item) === option);
      if (!target) throw new Error(`${label} has no option ${option}: ${JSON.stringify(labels(popup))}`);
      await press(target);
    };
    const fieldControl = (node, label) => {
      const caption = [...node.querySelectorAll("label.buzz-field-label")].find((item) => item.textContent.startsWith(label));
      return caption ? document.getElementById(caption.htmlFor) : null;
    };
    const rowTitles = (node) => [...node.querySelectorAll(".buzz-preference-row-label")].map((item) => item.textContent);
    // Every class the plugin draws, checked against Desktop's at the end.
    const drawn = new Set();
    const collect = (node) => {
      for (const element of [node, ...node.querySelectorAll("[class]")])
        for (const name of (element.getAttribute("class") ?? "").split(/\s+/)) if (name) drawn.add(name);
    };

    // ---- New agent dialog -------------------------------------------------
    let config = hosted.defaults().config;
    check("plugin: defaults name Claude, thread sessions and the first host", config.harness === "claude-code" && config.scope === "thread" && config.host === SMOKE_HOST.id, JSON.stringify(config));
    const dialog = mount();
    // Holds the draft as Desktop's dialog does: CreateModel in the Model row
    // of the AI configuration group, Create under it.
    function Dialog({ start }) {
      const [draft, setDraft] = React.useState(start);
      config = draft;
      return React.createElement(
        "div",
        null,
        React.createElement(
          "div",
          { className: "buzz-preference-row", "data-row": "model" },
          React.createElement("div", { className: "buzz-preference-row-trailing" }, React.createElement(hosted.CreateModel, { config: draft, disabled: false, onChange: setDraft })),
        ),
        React.createElement(hosted.Create, { config: draft, disabled: false, onChange: setDraft }),
      );
    }
    await dialog.render(React.createElement(Dialog, { start: config }));
    const harnessPill = await until(() => combobox(dialog.node, "Harness"), "harness pill");
    const modelPill = await until(() => combobox(dialog.node, "Model"), "model pill");
    check(
      "plugin: dialog Model row holds the harness pill and the model pill, laid out as Desktop's CreateModelChoices",
      harnessPill.closest("div.flex.max-w-full.flex-wrap.items-center.justify-end.gap-2") === modelPill.closest("div.flex.max-w-full.flex-wrap.items-center.justify-end.gap-2") &&
        harnessPill.closest(".flex") !== null,
    );
    check(
      "plugin: both pills are Desktop's compact Select (outline, sm, capsule, chevron)",
      [harnessPill, modelPill].every(
        (pill) =>
          pill.matches("button.buzz-button[data-variant=outline][data-size=sm][data-button-shape=capsule]") &&
          pill.closest(".buzz-select[data-variant=compact][data-appearance=outlined]") &&
          pill.querySelector(".buzz-button-label > .buzz-select-value-content") &&
          pill.querySelector("svg.buzz-dropdown-chevron.tabler-icon-chevron-down"),
      ),
    );
    check("plugin: the harness pill shows Claude with its mark", shownValue(harnessPill) === "Claude" && harnessPill.querySelector(".buzz-select-leading svg") !== null, shownValue(harnessPill));
    const harnessList = await open(harnessPill);
    collect(dialog.node);
    check(
      "plugin: the harness list is Desktop's Select popup, every runner harness in Desktop's order, each with its mark",
      harnessList?.matches(".buzz-select-popup.text-body[data-variant=compact][role=listbox]") &&
        harnessList.parentElement.matches(".buzz-select-positioner") &&
        JSON.stringify(labels(harnessList)) === JSON.stringify(HARNESS_TITLES) &&
        optionsOf(harnessList).every((option) => option.matches(".buzz-select-option") && option.querySelector(".buzz-select-leading svg")),
      JSON.stringify(labels(harnessList ?? document.body)),
    );
    const harnessOptions = optionsOf(harnessList);
    check(
      "plugin: Claude is chosen; the others are listed, disabled, with the runner's reason",
      harnessOptions[0].hasAttribute("data-selected") &&
        !harnessOptions[0].hasAttribute("data-disabled") &&
        harnessOptions.slice(1).every((option) => option.hasAttribute("data-disabled") && option.querySelector(".buzz-select-option-description")?.textContent.length > 0),
      JSON.stringify(harnessOptions.map((option) => option.textContent)),
    );
    await press(harnessOptions[1]);
    check("plugin: a disabled harness cannot be picked", config.harness === "claude-code" && document.getElementById(harnessPill.getAttribute("aria-controls")) !== null);
    await press(document.body);
    check("plugin: an outside press closes the list", harnessPill.getAttribute("aria-expanded") === "false" && !dialog.node.querySelector("[role=listbox]"));

    check("plugin: the model pill starts on the host's default, marked Default", shownValue(modelPill) === "Sonnet 4.5" && shownSuffix(modelPill) === " · Default", `${shownValue(modelPill)}|${shownSuffix(modelPill)}`);
    const modelList = await open(modelPill);
    check(
      "plugin: dialog models are Desktop's: the default first, the rest, no Custom model in the compact pill",
      JSON.stringify(labels(modelList)) === JSON.stringify(["Sonnet 4.5 · Default", "Opus 4.1", "Haiku 4.5"]),
      JSON.stringify(labels(modelList)),
    );
    check("plugin: every Claude model shows Desktop's Claude logo", optionsOf(modelList).every((option) => option.querySelector(".buzz-select-leading svg")));
    // Keyboard, as Base UI: the list has focus, arrows move, Enter picks.
    let escaped = false;
    const onEscape = (event) => {
      if (event.key === "Escape") escaped = true;
    };
    document.addEventListener("keydown", onEscape);
    await key(modelList, "ArrowDown");
    check("plugin: ArrowDown highlights the next model", optionsOf(modelList)[1].hasAttribute("data-highlighted"));
    await key(modelList, "Escape");
    document.removeEventListener("keydown", onEscape);
    check("plugin: Escape closes the list and stays inside it (the dialog keeps open)", !escaped && modelPill.getAttribute("aria-expanded") === "false" && document.activeElement === modelPill);
    const again = await open(modelPill);
    await key(again, "ArrowDown");
    await key(again, "Enter");
    check("plugin: Enter picks the highlighted model", config.model === "opus" && shownValue(combobox(dialog.node, "Model")) === "Opus 4.1" && shownSuffix(combobox(dialog.node, "Model")) === "", JSON.stringify(config));
    await choose(dialog.node, "Model", "Sonnet 4.5 · Default");
    check("plugin: the Default row goes back to the host's default", config.model === undefined && shownSuffix(combobox(dialog.node, "Model")) === " · Default", JSON.stringify(config));
    await choose(dialog.node, "Model", "Opus 4.1");
    check("plugin: no Thinking and no Sessions in the dialog, as Desktop's", !combobox(dialog.node, "Thinking") && !combobox(dialog.node, "Sessions"));
    const instructions = fieldControl(dialog.node, "Instructions");
    check(
      "plugin: Instructions is Desktop's: optional, outlined, 4 rows, Desktop's example",
      instructions?.matches("textarea.buzz-textarea[data-appearance=outlined]") &&
        instructions.rows === 4 &&
        instructions.placeholder === "Help me plan my week and prioritize tasks." &&
        dialog.node.querySelector(".buzz-field-optional")?.textContent === "Optional",
    );
    await typeText(instructions, "Be brief.");
    check("plugin: where it runs is info under the rows, not a harness", new RegExp(`^Runs on ${SMOKE_HOST.label}\\.`).test(dialog.node.querySelector("p.text-secondary")?.textContent ?? ""));
    check("plugin: dialog picks reach the config", config.model === "opus" && config.instructions === "Be brief." && config.scope === "thread" && !config.effort, JSON.stringify(config));
    collect(dialog.node);
    const created = config;
    await dialog.unmount();

    // An old draft on a harness that is not ready: the reason shows, the
    // model pill does not, and moving back starts on Claude's defaults.
    const stale = mount();
    await stale.render(React.createElement(Dialog, { start: { ...created, harness: "codex", model: "gpt-x", effort: "high" } }));
    const codexAlert = await until(() => stale.node.querySelector("[role=alert]"), "codex readiness notice");
    check(
      "plugin: a not-ready harness shows the runner's reason and no model pill",
      /did not report its path|Not installed|Not found|not ready/i.test(codexAlert.textContent) && !combobox(stale.node, "Model"),
      codexAlert.textContent,
    );
    // Desktop's Model row column takes the widest content; a long reason
    // that counts there squeezes the "Model" title to one letter per line.
    const reasonBlock = codexAlert.parentElement;
    check(
      "plugin: the reason adds no width to the Model row and wraps under the pills",
      reasonBlock.style.width === "0px" && reasonBlock.style.minWidth === "100%" && reasonBlock.parentElement.matches(".buzz-preference-row-trailing"),
      reasonBlock.outerHTML.slice(0, 200),
    );
    await choose(stale.node, "Harness", "Claude");
    await until(() => combobox(stale.node, "Model"), "model pill after harness change");
    check("plugin: a harness change resets model and thinking to that harness's defaults", config.harness === "claude-code" && !config.model && !config.effort && config.instructions === "Be brief.", JSON.stringify(config));
    await stale.unmount();

    // ---- Create through the remote steps, as Desktop runs them -----------
    const signal = new AbortController().signal;
    const refused = await hosted.remote.provision({ name: "Never", community, config: { ...created, harness: "codex" }, signal }).then(() => undefined, (error) => error);
    check("plugin: provision refuses a harness that is not ready, before a key is made", refused && refused?.message.includes(`Codex is not ready on ${SMOKE_HOST.label}`), String(refused?.message));
    config = created;
    const made = await hosted.remote.provision({ name: "Plugin Made", community, config, signal });
    check("plugin: provision returns the runner's pubkey", /^[0-9a-f]{64}$/.test(made.pubkey), JSON.stringify(made));
    await hosted.remote.activate({ pubkey: made.pubkey, name: "Plugin Made", community, auth: authTag(made.pubkey), config, signal });
    const record = JSON.parse((await request("GET", `/v1/agents/${made.pubkey}`)).text);
    check(
      "plugin: activate sends harness, scope, model and instructions; never the host",
      record.config.harness === "claude-code" && record.config.scope === "thread" && record.config.model === "opus" && record.config.instructions === "Be brief." && !("host" in record.config),
      JSON.stringify(record.config),
    );
    const summary = hosted.summary({ pubkey: made.pubkey, config });
    check("plugin: summary is Tailscale host · harness · model · host", summary === `Tailscale host · Claude · opus · ${SMOKE_HOST.label}`, summary);

    // ---- Settings, split as Desktop's -------------------------------------
    const tab = hosted.tabs.find((item) => item.role === "settings");
    check("plugin: Settings tab declares splitSettings", tab?.splitSettings === true);
    // Desktop's type row: for a hosted agent it would add a second Harness
    // row naming the type, so the plugin must leave it out.
    const settingsHost = { typeControl: () => React.createElement("span", { "data-type-control": "" }, "Type") };
    const agent = { pubkey: made.pubkey, config };
    const identity = mount();
    await identity.render(React.createElement(tab.component, { agent, save: () => Promise.reject(new Error("hosted")), settingsHost, settingsSection: "identity" }));
    await until(() => identity.node.querySelector("textarea"), "identity instructions");
    const thinkingPill = await until(() => combobox(identity.node, "Thinking"), "identity thinking");
    check(
      "plugin: identity is Desktop's: one group of Runs on, Harness, Model, Thinking rows, then Instructions; no type row",
      JSON.stringify(rowTitles(identity.node)) === JSON.stringify(["Runs on", "Harness", "Model", "Thinking"]) &&
        identity.node.querySelectorAll(".buzz-settings-group").length === 1 &&
        !identity.node.querySelector("[data-type-control]") &&
        !fieldControl(identity.node, "Workspace") &&
        !combobox(identity.node, "Sessions") &&
        identity.node.querySelector("form.grid.gap-4"),
      JSON.stringify(rowTitles(identity.node)),
    );
    check(
      "plugin: Runs on shows the type and host as info, with the host mark",
      identity.node.querySelector(".buzz-preference-row-trailing")?.textContent === `Tailscale host · ${SMOKE_HOST.label}` &&
        identity.node.querySelector(".buzz-preference-row-trailing svg") !== null,
      identity.node.querySelector(".buzz-preference-row-trailing")?.textContent,
    );
    const menuButton = identity.node.querySelector('button[aria-label="Change harness from Claude"]');
    check(
      "plugin: the Harness row is Desktop's harness menu pill (outline, sm, control) with the Claude mark",
      menuButton?.matches(".buzz-button[data-variant=outline][data-size=sm][data-button-shape=control][aria-haspopup=menu]") &&
        menuButton.closest(".buzz-select[data-variant=compact]") &&
        menuButton.querySelector(".flex.min-w-0.items-center.gap-2 svg") !== null,
    );
    const menu = await open(menuButton);
    collect(identity.node);
    check(
      "plugin: the harness menu is Desktop's menu popup with ChoiceRow items and marks, in Desktop's order",
      menu?.matches(".buzz-menu-popup.text-body-sm[data-size=default][role=menu]") &&
        menu.parentElement.matches(".buzz-menu-positioner") &&
        JSON.stringify(labels(menu)) === JSON.stringify(HARNESS_TITLES) &&
        optionsOf(menu).every((item) => item.matches(".buzz-menu-item[data-selection=highlight]") && item.querySelector(".buzz-menu-choice-label .buzz-choice-row .buzz-choice-row-leading svg")),
      JSON.stringify(labels(menu ?? document.body)),
    );
    check(
      "plugin: Claude is checked; not-ready harnesses are disabled with the reason",
      optionsOf(menu)[0].hasAttribute("data-checked") && optionsOf(menu).slice(1).every((item) => item.hasAttribute("data-disabled") && item.querySelector(".buzz-choice-row-description")),
    );
    await key(menu, "Escape");
    const modelRow = combobox(identity.node, "Model");
    check(
      "plugin: Model and Thinking are Desktop's preference rows (outline, sm, control)",
      [modelRow, thinkingPill].every((pill) => pill.matches("button.buzz-button[data-variant=outline][data-size=sm][data-button-shape=control]") && pill.closest(".buzz-preference-row-trailing")) &&
        shownValue(modelRow) === "Opus 4.1" &&
        shownValue(thinkingPill) === "Automatic" &&
        shownSuffix(thinkingPill) === " · Default",
      `${shownValue(modelRow)}|${shownValue(thinkingPill)}${shownSuffix(thinkingPill)}`,
    );
    const thinkingList = await open(thinkingPill);
    check(
      "plugin: Thinking lists Automatic and the model's levels with Desktop labels, no Max",
      JSON.stringify(labels(thinkingList)) === JSON.stringify(["Automatic · Default", "Low", "Medium", "High", "Extra high"]),
      JSON.stringify(labels(thinkingList)),
    );
    await press(optionsOf(thinkingList).find((option) => nameOf(option) === "Extra high"));
    const settingsModels = await open(combobox(identity.node, "Model"));
    check(
      "plugin: Settings models end with Desktop's Custom model choice",
      JSON.stringify(labels(settingsModels)) === JSON.stringify(["Sonnet 4.5 · Default", "Opus 4.1", "Haiku 4.5", "Custom model"]),
      JSON.stringify(labels(settingsModels)),
    );
    await press(optionsOf(settingsModels).at(-1));
    const modelId = await until(() => fieldControl(identity.node, "Model ID"), "model id field");
    await typeText(modelId, "claude-opus-4-1[1m]");
    await press([...identity.node.querySelectorAll("button")].find((button) => button.textContent === "Use model"));
    check(
      "plugin: Custom model takes a typed id and lists it as Custom model; a level some model lists is kept",
      shownValue(combobox(identity.node, "Model")) === "claude-opus-4-1[1m]" && shownValue(combobox(identity.node, "Thinking")) === "Extra high",
      `${shownValue(combobox(identity.node, "Model"))}|${shownValue(combobox(identity.node, "Thinking"))}`,
    );
    await choose(identity.node, "Model", "Haiku 4.5");
    check("plugin: a model without that level puts Thinking back to Automatic", shownValue(combobox(identity.node, "Thinking")) === "Automatic");
    await choose(identity.node, "Model", "Opus 4.1");
    await choose(identity.node, "Thinking", "Extra high");
    const identitySave = () => [...identity.node.querySelectorAll("button[type=submit]")][0];
    check(
      "plugin: Save is Desktop's prominent button and shows only with a change",
      identitySave()?.matches(".buzz-button[data-variant=prominent]") && identitySave().textContent === "Save",
    );
    collect(identity.node);
    await act(async () => identitySave().closest("form").requestSubmit());
    await until(() => identity.node.textContent.includes("Saved."), "identity saved");
    const afterIdentity = JSON.parse((await request("GET", `/v1/agents/${made.pubkey}`)).text);
    check("plugin: identity Save puts the whole config to the runner", afterIdentity.config.effort === "xhigh" && afterIdentity.config.model === "opus" && afterIdentity.config.harness === "claude-code", JSON.stringify(afterIdentity.config));
    check("plugin: Save hides again once saved", !identitySave());
    await identity.unmount();

    const runtime = mount();
    await runtime.render(
      React.createElement(tab.component, {
        agent,
        save: () => Promise.reject(new Error("hosted")),
        settingsHost,
        settingsSection: "runtime",
        settingsContent: React.createElement("p", { "data-host-rows": "" }, "rows"),
      }),
    );
    const workspace = await until(() => fieldControl(runtime.node, "Workspace"), "runtime workspace");
    check("plugin: runtime shows the host's workspace in Desktop's Field, read-only", workspace.matches("input.buzz-input") && workspace.readOnly && workspace.value === `${workspaceRoot}/${made.pubkey}`, workspace.value);
    const sessions = combobox(runtime.node, "Sessions");
    check(
      "plugin: runtime shows Sessions as Desktop's row, no AI rows, host rows last",
      shownValue(sessions) === "One session per thread" &&
        JSON.stringify(rowTitles(runtime.node)) === JSON.stringify(["Sessions"]) &&
        runtime.node.querySelector("form")?.lastElementChild?.hasAttribute("data-host-rows"),
      JSON.stringify(rowTitles(runtime.node)),
    );
    const sessionList = await open(sessions);
    check("plugin: Sessions offers Desktop's two choices", JSON.stringify(labels(sessionList)) === JSON.stringify(["One session per thread", "One session per channel"]), JSON.stringify(labels(sessionList)));
    await press(optionsOf(sessionList)[1]);
    collect(runtime.node);
    await act(async () => runtime.node.querySelector("button[type=submit]").closest("form").requestSubmit());
    await until(() => runtime.node.textContent.includes("Saved."), "runtime saved");
    const after = JSON.parse((await request("GET", `/v1/agents/${made.pubkey}`)).text);
    check("plugin: runtime Save keeps harness, model and thinking", after.config.scope === "channel" && after.config.harness === "claude-code" && after.config.model === "opus" && after.config.effort === "xhigh", JSON.stringify(after.config));
    await runtime.unmount();

    // ---- Provider dialog ----------------------------------------------------
    const provider = mount();
    let closed = false;
    await provider.render(React.createElement(hosted.provider.DialogBody, { onClose: () => (closed = true) }));
    check(
      "plugin: provider dialog lists each harness as a Desktop row with its mark and readiness",
      JSON.stringify(rowTitles(provider.node)) === JSON.stringify(HARNESS_TITLES) &&
        provider.node.querySelectorAll(".buzz-preference-row .buzz-preference-row-label svg").length === HARNESS_TITLES.length &&
        /^Ready/.test(provider.node.querySelector(".buzz-preference-row-description")?.textContent ?? ""),
      JSON.stringify(rowTitles(provider.node)),
    );
    await press([...provider.node.querySelectorAll("button.buzz-button")].find((button) => button.textContent === "Close"));
    check("plugin: provider dialog Close calls Desktop's onClose", closed);
    collect(provider.node);
    await provider.unmount();

    // ---- Host unreachable --------------------------------------------------
    const footer = mount();
    await footer.render(React.createElement(hosted.PanelFooter));
    check("plugin: no panel notice while the host answers", footer.node.textContent === "");
    hostDown = true;
    await act(async () => hosted.provider.check());
    check("plugin: panel notice when the host is unreachable", footer.node.textContent.includes(`Can't reach ${SMOKE_HOST.label}`), footer.node.textContent);
    check("plugin: provider says Host unreachable", hosted.provider.snapshot().attentionLabel === "Host unreachable", JSON.stringify(hosted.provider.snapshot()));
    hostDown = false;
    await act(async () => hosted.provider.check());
    check("plugin: notice clears when the host answers again", footer.node.textContent === "" && hosted.provider.snapshot().readiness === "ready");
    await footer.unmount();

    await hosted.remote.remove({ pubkey: made.pubkey, community, signal });
    const gone = await request("GET", `/v1/agents/${made.pubkey}`);
    check("plugin: remove deletes the agent on the host", gone.status === 404, gone.text);
    check("plugin: every call used the runner's v1 routes", calls.length > 0 && calls.every((item) => / \/v1\//.test(item)), JSON.stringify([...new Set(calls)]));

    // ---- A second host that claims agents it does not hold ----------------
    // A build with two hosts, the rogue one first. It answers every agent
    // lookup and returns a pubkey of the real host's agent as its "new" one;
    // the plugin must keep that agent routed to the real host.
    const owned = await hosted.remote.provision({ name: "Plugin Owned", community, config, signal });
    const ownedKey = `${MIGRATED_HOST_KEY.split(":")[0]}:${owned.pubkey}`;
    const rogueFront = await startFront(tls, async ({ method, path }) => {
      if (rogueDown) return "drop";
      if (path === "/v1/harnesses") return { status: 200, body: (await request("GET", path)).text };
      if (method === "POST" && path === "/v1/agents") return { status: 200, body: JSON.stringify({ pubkey: owned.pubkey }) };
      // Claims every agent, under a pubkey that is not the one asked for.
      if (method === "GET" && path.startsWith("/v1/agents/")) return { status: 200, body: JSON.stringify({ pubkey: ROGUE_PUBKEY, config: {} }) };
      return { status: 204 };
    });
    fronts.push(rogueFront);
    const ROGUE_HOST = Object.freeze({ ...ROGUE_HOST_BASE, origin: rogueFront.origin });
    const twoHostsPath = join(buildDir, "hosts-two.json");
    writeFileSync(twoHostsPath, JSON.stringify({ hosts: [ROGUE_HOST, SMOKE_HOST] }));
    const { outDir: twoDir } = buildPlugin({ hostsPath: twoHostsPath, outDir: join(buildDir, "dist-two") });
    const rogueTypes = [];
    const rogueCtx = { ...ctx, agents: { register: (type) => rogueTypes.push(type) }, host: { spawn: desktopSpawn(join(twoDir, "manifest.json")) } };
    const twoHosts = await import(`${pathToFileURL(join(twoDir, "plugin.js")).href}?smoke=${Date.now()}`);
    await twoHosts.apply(rogueCtx);
    const [rogueHosted] = rogueTypes;
    check("plugin: with several hosts, New agent's picker gives the host count", rogueHosted.title === `${TYPE_TITLE} · 2 hosts`, rogueHosted.title);
    const rogueConfig = { ...config, host: ROGUE_HOST.id };
    const claimed = await rogueHosted.remote.provision({ name: "Rogue", community, config: rogueConfig, signal }).then(() => undefined, (error) => error);
    check(
      "plugin: a host that returns another host's agent as new is refused",
      claimed?.message.includes(`${ROGUE_HOST.label} returned an agent that ${SMOKE_HOST.label} holds`),
      String(claimed?.message),
    );
    check("plugin: the refused claim keeps the agent routed to its host", localStorage.getItem(ownedKey) === SMOKE_HOST.id, localStorage.getItem(ownedKey));
    localStorage.removeItem(ownedKey);
    const unsaved = await rogueHosted.remote.provision({ name: "Rogue", community, config: rogueConfig, signal }).then(() => undefined, (error) => error);
    check(
      "plugin: without a saved route, the host that holds the agent is asked and the claim refused",
      unsaved?.message.includes(`${ROGUE_HOST.label} returned an agent that ${SMOKE_HOST.label} holds`) && localStorage.getItem(ownedKey) === null,
      String(unsaved?.message),
    );
    await rogueHosted.remote.interrupt({ pubkey: owned.pubkey, channelId: "00000000-0000-4000-8000-000000000000", threadRootId: null });
    check("plugin: a lookup answer for another pubkey does not count; the real host is found", localStorage.getItem(ownedKey) === SMOKE_HOST.id, localStorage.getItem(ownedKey));
    rogueDown = true;
    const unchecked = await rogueHosted.remote.provision({ name: "Plugin Unchecked", community, config, signal }).then(() => undefined, (error) => error);
    rogueDown = false;
    check(
      "plugin: a new agent is refused while another host cannot be asked (fail closed)",
      unchecked?.message.includes(`Could not check the new agent with ${ROGUE_HOST.label}`),
      String(unchecked?.message),
    );
    // The refused create left an unactivated record on the runner.
    const orphan = JSON.parse((await request("POST", "/v1/agents", JSON.stringify({ name: "Plugin Unchecked", community }))).text);
    await request("DELETE", `/v1/agents/${orphan.pubkey}`);
    await request("DELETE", `/v1/agents/${owned.pubkey}`);
    localStorage.removeItem(ownedKey);

    // ---- The plugin's Settings page: hosts.json through the hosts helper --
    // A fresh load of the one-host build, with Desktop's optional
    // settingsCards service injected as Desktop does it (ctx.inject). Its
    // saves change this smoke's hosts.json, as they change the user's; the
    // build must stay as it is, because no change needs Update any more.
    const cards = [];
    const settingsTypes = [];
    const settingsCtx = {
      ...ctx,
      agents: { register: (type) => settingsTypes.push(type) },
      inject(names, run) {
        // communityReader stays out here, as on a Desktop without it: Add
        // host's owner and relay fields then start empty.
        if (JSON.stringify(names) === JSON.stringify(["communityReader"])) return;
        if (JSON.stringify(names) !== JSON.stringify(["settingsCards"])) throw new Error(`unexpected inject ${names}`);
        run({ settingsCards: { register: (card) => cards.push(card) } });
      },
    };
    const settingsModule = await import(`${pathToFileURL(PLUGIN).href}?smoke=${Date.now()}-settings`);
    await settingsModule.apply(settingsCtx);
    const [card] = cards;
    const [settingsHosted] = settingsTypes;
    const fileList = () => JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
    const builtFiles = () => ["manifest.json", "plugin.js"].map((name) => readFileSync(join(outDir, name), "utf8")).join("\n");
    const buildBefore = builtFiles();
    check(
      "plugin: registers its own Settings page, Tailscale hosts, under Plugins",
      cards.length === 1 && card.id === "hosts" && card.title === "Tailscale hosts" && card.group === "Plugins" && typeof card.component === "function",
      JSON.stringify(cards.map((item) => [item.id, item.title, item.group])),
    );
    let page = mount();
    await page.render(React.createElement(card.component, { active: () => true }));
    const rowFor = (label) => [...page.node.querySelectorAll(".buzz-preference-row")].find((row) => row.querySelector(".buzz-preference-row-label")?.textContent === label);
    const buttonFor = (label, name) => page.node.querySelector(`button[aria-label="${name} ${label}"]`);
    const addForm = () => page.node.querySelector('form[aria-label="Add a host"]');
    const submit = (form) => act(async () => form.requestSubmit());
    const settled = () => until(() => addForm() && !page.node.querySelector("button[disabled]") && !page.node.querySelector("[data-loading]"), "helper call");
    const addHost = async (label, origin) => {
      await typeText(fieldControl(addForm(), "Name"), label);
      await typeText(fieldControl(addForm(), "Address"), origin);
      await submit(addForm());
      await settled();
      return addForm().querySelector("[role=alert]")?.textContent ?? "";
    };
    const statusText = () => [...page.node.querySelectorAll("[role=status]")].map((item) => item.textContent).join(" | ");
    const checkAgain = () => press([...page.node.querySelectorAll("button")].find((item) => item.textContent === "Check again"));
    await until(() => buttonFor(SMOKE_HOST.label, "Edit"), "hosts.json read");
    await until(() => rowFor(SMOKE_HOST.label)?.textContent.includes("Reachable"), "host status");
    check(
      "plugin: Settings shows hosts.json, with Edit and Remove on every host, and the host's status",
      JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label]) && buttonFor(SMOKE_HOST.label, "Remove") && rowFor(SMOKE_HOST.label).textContent.includes(SMOKE_HOST.origin),
      rowFor(SMOKE_HOST.label)?.textContent,
    );
    check("plugin: the page names no Build or Update step", !/\bUpdate\b|\bBuild\b/.test(page.node.textContent), page.node.textContent);
    await press(buttonFor(SMOKE_HOST.label, "Remove"));
    await settled();
    check(
      "plugin: Remove keeps the last host, and says why",
      statusText().includes("must keep at least one host") && JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST]),
      statusText(),
    );
    const noHttps = await addHost(LAB_HOST.label, "http://lab-one.example.invalid");
    const withPath = await addHost(LAB_HOST.label, `https://lab-one.example.invalid:${RUNNER_PORT}/v1`);
    const sameName = await addHost(SMOKE_HOST.label.toUpperCase(), "https://lab-one.example.invalid");
    // Without Desktop's community reader the owner key starts empty.
    const noOwner = await addHost(LAB_HOST.label, "https://lab-one.example.invalid");
    check(
      "plugin: Add host refuses http, a path, a used name and a missing owner key before any setup, and says why, with the address to write and no runner port",
      /https:\/\//.test(noHttps) &&
        withPath.endsWith("Write it as https://lab-one.example.invalid") &&
        sameName.includes("already named") &&
        noOwner.includes("owner key") &&
        !helpers.lines.some((line) => line.includes('"op":"setup"')),
      JSON.stringify([noHttps, withPath, sameName, noOwner]),
    );
    check("plugin: a refused add leaves hosts.json as it was", JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST]), JSON.stringify(fileList()));

    // A host that a setup (or the owner by hand) puts in hosts.json works at
    // once, with no build and no Update. The setup itself is the fake-helper
    // scenario below and setup.mjs.
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST, LAB_HOST] }));
    await checkAgain();
    await until(() => rowFor(LAB_HOST.label), "listed host read");
    await until(() => rowFor(LAB_HOST.label)?.textContent.includes("Reachable"), "new host status");
    check("plugin: the new host answers at once on the page", rowFor(LAB_HOST.label).textContent.includes(`${LAB_HOST.origin} · Reachable`), rowFor(LAB_HOST.label)?.textContent);
    // A field Select names its trigger with aria-labelledby, as Desktop's.
    const labelledBy = (node, label) =>
      [...node.querySelectorAll("[role=combobox][aria-labelledby]")].find((item) => document.getElementById(item.getAttribute("aria-labelledby"))?.textContent === label);
    const pickHost = mount();
    let picked = settingsHosted.defaults().config;
    function HostDialog() {
      const [draft, setDraft] = React.useState(picked);
      picked = draft;
      return React.createElement(settingsHosted.Create, { config: draft, disabled: false, onChange: setDraft });
    }
    await pickHost.render(React.createElement(HostDialog));
    const hostPill = await until(() => labelledBy(pickHost.node, "Host"), "host pill");
    const hostList = await open(hostPill);
    check(
      "plugin: New agent offers the new host at once, in file order, the first as default",
      JSON.stringify(labels(hostList)) === JSON.stringify([SMOKE_HOST.label, LAB_HOST.label]) && picked.host === SMOKE_HOST.id,
      JSON.stringify(labels(hostList)),
    );
    await press(optionsOf(hostList).find((option) => nameOf(option) === LAB_HOST.label));
    check("plugin: the new host can be picked", picked.host === LAB_HOST.id, JSON.stringify(picked));
    collect(pickHost.node);
    await pickHost.unmount();
    const labAgent = await settingsHosted.remote.provision({ name: "Plugin Lab", community, config: picked, signal });
    check(
      "plugin: an agent is made on the new host at once, through its own front",
      /^[0-9a-f]{64}$/.test(labAgent.pubkey) && labCalls.includes("POST /v1/agents") && localStorage.getItem(`${MIGRATED_HOST_KEY.split(":")[0]}:${labAgent.pubkey}`) === LAB_HOST.id,
      JSON.stringify(labCalls),
    );
    await settingsHosted.remote.remove({ pubkey: labAgent.pubkey, community, signal });
    check("plugin: the agent on the new host is removed through its front", labCalls.includes(`DELETE /v1/agents/${labAgent.pubkey}`), JSON.stringify(labCalls));

    // Edit keeps the id that agents carry.
    await press(buttonFor(LAB_HOST.label, "Edit"));
    const editForm = page.node.querySelector(`form[aria-label="Edit ${LAB_HOST.label}"]`);
    await typeText(fieldControl(editForm, "Name"), "lab/renamed");
    await submit(editForm);
    await settled();
    const renamedHost = { ...LAB_HOST, label: "lab/renamed" };
    check("plugin: Edit renames the host in hosts.json and keeps its id", JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST, renamedHost]) && rowFor(renamedHost.label), JSON.stringify(fileList()));
    check("plugin: a save leaves the build as it is: no rebuild, nothing for Update", builtFiles() === buildBefore);

    // The owner edits hosts.json by hand: Check again shows it, and it is in use.
    // An address from before the runner port was internal: it has the port.
    const handHost = { id: "lab-hand", label: "lab/hand", origin: `https://lab-hand.example.invalid:${RUNNER_PORT}` };
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST, renamedHost, handHost] }));
    await checkAgain();
    await until(() => rowFor(handHost.label)?.textContent.includes("Could not reach"), "hand edit read");
    check(
      "plugin: a hand edit is in use after Check again: its host is asked, and here it does not answer",
      JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label, renamedHost.label, handHost.label]) && rowFor(handHost.label).textContent.includes("Could not reach lab/hand"),
      rowFor(handHost.label)?.textContent,
    );
    check(
      "plugin: an address with the runner port shows without it",
      rowFor(handHost.label).textContent.includes("https://lab-hand.example.invalid · ") && !rowFor(handHost.label).textContent.includes(`:${RUNNER_PORT}`),
      rowFor(handHost.label)?.textContent,
    );
    // Add with a listed machine aligns it (setup.mjs), so Edit is where a
    // second entry for one machine can be typed.
    await press(buttonFor(renamedHost.label, "Edit"));
    const moveForm = page.node.querySelector(`form[aria-label="Edit ${renamedHost.label}"]`);
    await typeText(fieldControl(moveForm, "Address"), "https://lab-hand.example.invalid");
    await submit(moveForm);
    await settled();
    const handAgain = moveForm.querySelector("[role=alert]")?.textContent ?? "";
    check(
      "plugin: Edit refuses the machine of a host saved with the runner port",
      handAgain.includes(`${handHost.label} already uses this address`) && fileList().length === 3,
      handAgain,
    );
    await press([...moveForm.querySelectorAll("button")].find((item) => item.textContent === "Cancel"));

    // Remove waits for its agents.
    const placedKey = `${MIGRATED_HOST_KEY.split(":")[0]}:${"ef".repeat(32)}`;
    localStorage.setItem(placedKey, renamedHost.id);
    await press(buttonFor(renamedHost.label, "Remove"));
    await settled();
    check(
      "plugin: Remove refuses while an agent runs on the host",
      statusText().includes(`1 agent runs on ${renamedHost.label}. Delete them first.`) && fileList().some((host) => host.id === renamedHost.id),
      statusText(),
    );
    localStorage.removeItem(placedKey);
    await press(buttonFor(handHost.label, "Remove"));
    await settled();
    check(
      "plugin: Remove deletes a host without agents from hosts.json, and the build stays as it is",
      JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST, renamedHost]) && !rowFor(handHost.label) && builtFiles() === buildBefore,
      JSON.stringify(fileList()),
    );
    await page.unmount();

    // A broken file: the page says so, and the hosts read last stay in use.
    writeFileSync(hostsPath, "{ broken");
    page = mount();
    await page.render(React.createElement(card.component, { active: () => true }));
    await checkAgain();
    const brokenAlert = await until(() => page.node.querySelector("[role=alert]"), "broken file alert");
    check(
      "plugin: a broken hosts.json shows the helper's reason; no Edit, Remove or Add; the last good hosts stay",
      brokenAlert.textContent.includes("not valid JSON") && !buttonFor(SMOKE_HOST.label, "Edit") && !addForm() && JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label, renamedHost.label]),
      brokenAlert.textContent,
    );
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST] }));
    // A helper that stops, and cannot start again: every call says why.
    helpers.failSpawn = true;
    for (const child of helpers.children) child.kill("SIGTERM");
    await until(() => helpers.children.size === 0, "helpers stopped");
    await checkAgain();
    const silentAlert = await until(() => page.node.querySelector("[role=alert]")?.textContent.includes("login shell's PATH") && page.node.querySelector("[role=alert]"), "silent helper alert");
    check("plugin: a helper that cannot start names node on the login shell's PATH", Boolean(silentAlert), silentAlert?.textContent);
    helpers.failSpawn = false;
    const spawnsBefore = helpers.spawns;
    await checkAgain();
    await until(() => buttonFor(SMOKE_HOST.label, "Edit") && !page.node.querySelector("[role=alert]"), "helper back");
    check("plugin: the next call starts the helper again, and the page recovers", helpers.spawns > spawnsBefore && JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label]), String(helpers.spawns));
    collect(page.node);
    await page.unmount();

    // ---- Add host: the page side of a host setup ----------------------------
    // The helper's setup itself is setup.mjs; here an in-process stand-in
    // answers as the helper does, so the page's steps, link, result and
    // password handling are checked without a machine.
    const LAB_DNS = "lab-box.example.ts.net";
    const setupLines = [];
    let signinAsk;
    // The setup waits at its check link until the scenario has looked.
    let releaseSetup;
    const setupHeld = new Promise((done) => (releaseSetup = done));
    const fakeHelper = async (id, { onStdout }) => {
      const answer = (value) => onStdout(`${JSON.stringify(value)}\n`);
      return {
        write: async (line) => {
          const ask = JSON.parse(line);
          setupLines.push(ask);
          if (ask.op === "read") return answer({ id: ask.id, ok: true, hosts: [SMOKE_HOST] });
          if (ask.op === "request") return answer({ id: ask.id, ok: false, error: "no runner here" });
          // A sign-in: its terminal waits at a prompt until the page answers.
          if (ask.op === "signin") {
            signinAsk = ask;
            answer({ id: ask.id, progress: { state: "running", output: "sudo password: \nPaste the key: ", link: "https://login.tailscale.com/a/signin-check" } });
            return answer({ id: ask.id, progress: { state: "running", output: "sudo password: \nPaste the key: ", link: "javascript:alert(1)" } });
          }
          if (ask.op === "signin-input") {
            answer({ id: ask.id, ok: true });
            return answer({ id: signinAsk.id, ok: true, code: 0, output: `sudo password: \nPaste the key: \nSaved a key of ${ask.text.length} characters.` });
          }
          const steps = SETUP_STEPS;
          answer({ id: ask.id, progress: { step: "connect", state: "waiting", link: "https://login.tailscale.com/a/page-check" } });
          answer({ id: ask.id, progress: { step: "copy", state: "waiting", link: "javascript:alert(1)" } });
          await setupHeld;
          for (const step of steps) answer({ id: ask.id, progress: { step, state: "done", detail: step === "health" ? "buzz-runner 0.0.0-page" : undefined } });
          answer({ id: ask.id, ok: true, added: true, version: "0.0.0-page", host: { id: "lab-box", label: "Lab Box", origin: "https://lab-box.example.ts.net:10000" },
            manual: [{ id: "sign-in", text: "Sign each harness in.", command: `ssh -t owner@${LAB_DNS} sudo -u buzz-agent /usr/local/bin/buzz-login` }] });
        },
        end: () => {},
        kill: () => {},
        exited: new Promise(() => {}),
      };
    };
    const VIEWER = "ab".repeat(32);
    const setupCards = [];
    const setupCtx = {
      ...ctx,
      agents: { register: () => {} },
      host: { spawn: fakeHelper },
      inject(names, run) {
        if (names[0] === "communityReader") run({ communityReader: { snapshot: () => ({ viewer: VIEWER, selected: "https://relay.example.ts.net" }), subscribe: () => () => {} } });
        else run({ settingsCards: { register: (card) => setupCards.push(card) } });
      },
    };
    const setupModule = await import(`${pathToFileURL(PLUGIN).href}?smoke=${Date.now()}-setup`);
    await setupModule.apply(setupCtx);
    const setupPage = mount();
    await setupPage.render(React.createElement(setupCards[0].component, { active: () => true }));
    const setupForm = () => setupPage.node.querySelector('form[aria-label="Add a host"]');
    await until(setupForm, "add form");
    check("plugin: the page has no separate setup step: Add host is the setup", !/Install runner|Set up a machine|Find machines/.test(setupPage.node.textContent), setupPage.node.textContent.slice(0, 300));
    check(
      "plugin: Add host's owner key and relay start as Desktop's identity and community",
      fieldControl(setupForm(), "Owner key")?.value === VIEWER && fieldControl(setupForm(), "Relay")?.value === "wss://relay.example.ts.net",
    );
    await typeText(fieldControl(setupForm(), "Name"), "Lab Box");
    await typeText(fieldControl(setupForm(), "Address"), `https://${LAB_DNS}/`);
    await typeText(fieldControl(setupForm(), "SSH login"), "owner");
    await typeText(fieldControl(setupForm(), "sudo password"), "page pass");
    await act(async () => setupForm().requestSubmit());
    await until(() => setupPage.node.querySelector('li[data-step="connect"][data-state="waiting"]'), "waiting step");
    const links = [...setupPage.node.querySelectorAll("li[data-step] a")].map((item) => item.getAttribute("href"));
    check("plugin: a waiting step shows its Tailscale check link, and no other URL", JSON.stringify(links) === JSON.stringify(["https://login.tailscale.com/a/page-check"]), JSON.stringify(links));
    releaseSetup();
    await until(() => setupPage.node.textContent.includes("Still to do:"), "setup result");
    const sent = setupLines.find((ask) => ask.op === "setup");
    check(
      "plugin: Add host sends the address, name, login, password, owner, relay and reserved ids as one setup",
      sent?.setup.address === `https://${LAB_DNS}` && sent.setup.label === "Lab Box" && sent.setup.sshUser === "owner" && sent.setup.sudoPassword === "page pass" && sent.setup.ownerPubkey === VIEWER && sent.setup.relay === "wss://relay.example.ts.net" && Array.isArray(sent.setup.reservedIds),
      JSON.stringify({ ...sent?.setup, sudoPassword: sent?.setup.sudoPassword ? "<set>" : "" }),
    );
    check("plugin: the password field is empty once the setup starts", fieldControl(setupForm(), "sudo password")?.value === "" && !setupPage.node.innerHTML.includes("page pass"));
    const stepStates = [...setupPage.node.querySelectorAll("li[data-step]")].map((item) => `${item.dataset.step}:${item.dataset.state}`);
    check("plugin: the page shows every setup step, in order, as done", JSON.stringify(stepStates) === JSON.stringify(SETUP_STEPS.map((step) => `${step}:done`)), JSON.stringify(stepStates));
    check(
      "plugin: a finished setup names the host and the sign-in command to copy",
      setupPage.node.textContent.includes("Added Lab Box (buzz-runner 0.0.0-page)") && setupPage.node.querySelector("code")?.textContent === `ssh -t owner@${LAB_DNS} sudo -u buzz-agent /usr/local/bin/buzz-login`,
    );

    // ---- Sign in: the page side of a harness sign-in -------------------------
    // The helper's sign-in itself is signin.mjs; here the stand-in streams a
    // terminal that waits at a prompt, and ends when the page answers it.
    const signInButton = () => setupPage.node.querySelector(`button[aria-label="Sign in on ${SMOKE_HOST.label}"]`);
    await until(signInButton, "Sign in button");
    await act(async () => signInButton().click());
    const startForm = () => setupPage.node.querySelector('form[aria-label="Start a sign-in"]');
    await until(startForm, "sign-in form");
    await typeText(fieldControl(startForm(), "SSH login"), "owner");
    await typeText(fieldControl(startForm(), "sudo password"), "sign pass");
    await act(async () => startForm().requestSubmit());
    const answerForm = () => setupPage.node.querySelector('form[aria-label="Answer the terminal"]');
    await until(() => answerForm() && setupPage.node.querySelector('pre[role="log"]')?.textContent.includes("Paste the key"), "sign-in terminal");
    const signinSent = setupLines.find((ask) => ask.op === "signin");
    check(
      "plugin: Start sends the host id, login, password and the chosen command as one sign-in",
      signinSent?.signin.host === SMOKE_HOST.id && signinSent.signin.sshUser === "owner" && signinSent.signin.sudoPassword === "sign pass" && signinSent.signin.command === "status",
      JSON.stringify({ ...signinSent?.signin, sudoPassword: signinSent?.signin.sudoPassword ? "<set>" : "" }),
    );
    const signinLinks = [...setupPage.node.querySelectorAll('[aria-label^="Sign in on"] a')].map((item) => item.getAttribute("href"));
    check("plugin: a sign-in shows its Tailscale check link, and no other URL", JSON.stringify(signinLinks) === JSON.stringify(["https://login.tailscale.com/a/signin-check"]), JSON.stringify(signinLinks));
    check("plugin: the sign-in password field is empty once the sign-in starts", fieldControl(startForm(), "sudo password")?.value === "" && !setupPage.node.innerHTML.includes("sign pass"));
    await typeText(fieldControl(answerForm(), "Answer"), "sk-page-key");
    check("plugin: the answer field hides what is typed", fieldControl(answerForm(), "Answer")?.type === "password");
    await act(async () => answerForm().requestSubmit());
    await until(() => setupPage.node.textContent.includes("The sign-in ended."), "sign-in end");
    const typedLine = setupLines.find((ask) => ask.op === "signin-input");
    check(
      "plugin: Send gives the typed line to the sign-in, and the page keeps no copy",
      typedLine?.text === "sk-page-key" && !setupPage.node.innerHTML.includes("sk-page-key") && setupPage.node.querySelector('pre[role="log"]')?.textContent.endsWith("Saved a key of 11 characters."),
    );
    collect(setupPage.node);
    await setupPage.unmount();

    // ---- The helper's own refusals, as the plugin could send them --------
    let rawOut = "";
    const raw = await desktopSpawn(join(outDir, "manifest.json"))("hosts", { onStdout: (chunk) => (rawOut += chunk) });
    const asks = [
      { id: 1, op: "request", host: "nowhere", method: "GET", path: "/harnesses", timeoutMs: 5000 },
      { id: 2, op: "request", host: SMOKE_HOST.id, method: "GET", path: "/../health", timeoutMs: 5000 },
      { id: 3, op: "request", host: SMOKE_HOST.id, method: "PATCH", path: "/health", timeoutMs: 5000 },
      { id: 4, op: "request", host: SMOKE_HOST.id, method: "GET", path: "/health", url: "https://example.invalid/", timeoutMs: 5000 },
      { id: 5, op: "request", host: SMOKE_HOST.id, method: "GET", path: "/health", timeoutMs: 5000 },
    ];
    for (const ask of asks) await raw.write(`${JSON.stringify(ask)}\n`);
    raw.end();
    await raw.exited;
    const answers = Object.fromEntries(rawOut.trim().split("\n").map((line) => JSON.parse(line)).map((item) => [item.id, item]));
    check(
      "helper: refuses a host not in hosts.json, a path out of the API, another method and a caller URL",
      [1, 2, 3, 4].every((id) => answers[id]?.ok === false) &&
        answers[1].error.includes("no host") &&
        answers[2].error.includes("not a runner route") &&
        answers[3].error.includes("method must be") &&
        answers[4].error.includes("unknown request keys: url"),
      JSON.stringify(answers),
    );
    check("helper: a listed host's route answers", answers[5]?.ok === true && answers[5].status === 200 && JSON.parse(answers[5].body).ok === true, JSON.stringify(answers[5]));
    const extraArgs = await desktopSpawn(join(outDir, "manifest.json"))("hosts", { args: ["--hosts", "/dev/null"] });
    check("helper: refuses arguments the caller adds after the declared ones", (await extraArgs.exited) === 64);

    // ---- Same classes as Desktop -----------------------------------------
    // Every class the plugin drew must be one Desktop's own markup uses
    // (Tailwind utilities exist only when Desktop's sources use them), one
    // Desktop's CSS defines (buzz-*), or Tabler's icon class.
    const { readdir, readFile } = await import("node:fs/promises");
    const sources = async (dir, pattern) => {
      const found = [];
      for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }))
        if (entry.isFile() && pattern.test(entry.name)) found.push(await readFile(resolve(entry.parentPath ?? entry.path, entry.name), "utf8"));
      return found.join("\n");
    };
    const css = await sources(resolve(DESKTOP_SRC, DESKTOP_STYLES_DIR), CSS_FILE_RE);
    const markup = await sources(DESKTOP_SRC, TSX_FILE_RE);
    const used = new Set();
    for (const match of markup.matchAll(CLASS_NAME_RE))
      for (const name of (match[1] ?? match[2]).split(/\s+/)) if (name && !name.includes("$")) used.add(name);
    // Some Desktop classes (buzz-choice-row-label) name a part without a rule.
    const foreign = [...drawn].filter(
      (name) => !used.has(name) && !name.startsWith("tabler-icon") && !(name.startsWith("buzz-") && new RegExp(`\\.${name}(?![\\w-])`).test(css)),
    );
    check("plugin: every class drawn is Desktop's own (CSS or markup)", drawn.size > 20 && foreign.length === 0, `${drawn.size} classes; not Desktop's: ${JSON.stringify(foreign)}`);
  } finally {
    // The plugin's poll timer must not outlive the run.
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
    dom.window.close();
    for (const child of helpers.children) child.kill("SIGTERM");
    await Promise.all(fronts.map((front) => front.close()));
    rmSync(buildDir, { recursive: true, force: true });
  }
  // #lizard forgives: one end-to-end scenario through the plugin UI that must read in run order
}
