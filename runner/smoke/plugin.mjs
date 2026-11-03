// Dogfood of the Buzz plugin against a live runner: the module is built from
// ../../plugin/plugin.js for a smoke host list (scripts/build-plugin.mjs, as
// a user builds it from hosts.json), then loaded with a stand-in for
// Desktop's plugin context (React, `agents.register`, `host.request`,
// `host.runCommand`, `effect`), its React views are rendered in jsdom, and
// its `remote` calls go to the runner's API socket the way Desktop sends
// them through Tailscale. It checks what the owner sees in the New agent
// dialog and in Settings, without Buzz Desktop.
//
// React, react-dom and jsdom are the runner's own pinned dev dependencies
// (runner/package.json), at the versions Desktop uses.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildPlugin } from "../../scripts/build-plugin.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The unbuilt source: it holds no hosts, so it must refuse to start. */
const SOURCE_PLUGIN = resolve(HERE, "../../plugin/plugin.js");
/** The host the smoke build is made for. Its origin is never contacted:
 * `host.request` below sends every call to the local runner socket. */
const SMOKE_HOST = Object.freeze({ id: "smoke-host", label: "smoke/host", origin: "https://runner.example.invalid:10000" });
/** A second host, answered by the smoke itself, that claims agents it does
 * not hold; and the pubkey it names in those answers. */
const ROGUE_HOST = Object.freeze({ id: "rogue-host", label: "rogue/host", origin: "https://rogue.example.invalid:10000" });
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
/** The helper the build grants the Settings page, and Desktop's deadline for
 * one host command (src-tauri host_command.rs DEADLINE). */
const HOSTS_HELPER = resolve(HERE, "../../scripts/hosts-helper.mjs");
const DESKTOP_COMMAND_DEADLINE_MS = 5000;
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
  try {
    const hostsPath = join(buildDir, "hosts.json");
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST] }));
    const { outDir } = buildPlugin({ hostsPath, outDir: join(buildDir, "dist") });
    const PLUGIN = join(outDir, "plugin.js");
    const React = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { act } = React;
    let hostDown = false;
    const types = [];
    const calls = [];
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
      host: {
        async request({ url, method, body }) {
          const { pathname } = new URL(url);
          calls.push(`${method} ${pathname}`);
          if (hostDown) throw new Error("connect ECONNREFUSED");
          const reply = await request(method, pathname, body);
          return { status: reply.status, body: reply.text };
        },
      },
      effect(run) {
        cleanups.push(run());
      },
    };
    // Left by builds with a type per harness; the plugin must clear it.
    localStorage.setItem(LEGACY_HARNESS_CACHE_KEY, JSON.stringify([{ id: "codex", title: "Codex" }]));
    // An agent an earlier build placed on this host.
    localStorage.setItem(EARLIER_HOST_KEY, SMOKE_HOST.id);
    const unbuilt = await import(`${pathToFileURL(SOURCE_PLUGIN).href}?smoke=${Date.now()}`);
    let unbuiltError;
    try {
      unbuilt.apply({ ...ctx, agents: { register() {} } });
    } catch (error) {
      unbuiltError = error;
    }
    check("plugin: the unbuilt source (no hosts) refuses to start", /No Tailscale hosts in this build/.test(String(unbuiltError?.message)), String(unbuiltError));
    const plugin = await import(`${pathToFileURL(PLUGIN).href}?smoke=${Date.now()}`);
    check("plugin: injects react, agents and host", JSON.stringify(plugin.inject) === JSON.stringify(["react", "agents", "host"]));
    plugin.apply(ctx);
    check(
      "plugin: one hosted type, registered at once, with the legacy id and title Tailscale host",
      types.length === 1 && types[0].id === TYPE_ID_VALUE && types[0].title === TYPE_TITLE,
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
    check("plugin: every call used the runner's v1 routes", calls.every((item) => / \/v1\//.test(item)), JSON.stringify([...new Set(calls)]));

    // ---- A second host that claims agents it does not hold ----------------
    // A build with two hosts, the rogue one first. It answers every agent
    // lookup and returns a pubkey of the real host's agent as its "new" one;
    // the plugin must keep that agent routed to the real host.
    const owned = await hosted.remote.provision({ name: "Plugin Owned", community, config, signal });
    const ownedKey = `${MIGRATED_HOST_KEY.split(":")[0]}:${owned.pubkey}`;
    const twoHostsPath = join(buildDir, "hosts-two.json");
    writeFileSync(twoHostsPath, JSON.stringify({ hosts: [ROGUE_HOST, SMOKE_HOST] }));
    const { outDir: twoDir } = buildPlugin({ hostsPath: twoHostsPath, outDir: join(buildDir, "dist-two") });
    let rogueDown = false;
    const rogueTypes = [];
    const rogueCtx = {
      ...ctx,
      agents: { register: (type) => rogueTypes.push(type) },
      host: {
        async request({ url, method, body }) {
          const { origin, pathname } = new URL(url);
          if (origin !== ROGUE_HOST.origin) {
            const reply = await request(method, pathname, body);
            return { status: reply.status, body: reply.text };
          }
          if (rogueDown) throw new Error("connect ECONNREFUSED");
          if (pathname === "/v1/harnesses") return { status: 200, body: (await request("GET", pathname)).text };
          if (method === "POST" && pathname === "/v1/agents") return { status: 200, body: JSON.stringify({ pubkey: owned.pubkey }) };
          // Claims every agent, under a pubkey that is not the one asked for.
          if (method === "GET" && pathname.startsWith("/v1/agents/")) return { status: 200, body: JSON.stringify({ pubkey: ROGUE_PUBKEY, config: {} }) };
          return { status: 204, body: "" };
        },
      },
    };
    const twoHosts = await import(`${pathToFileURL(join(twoDir, "plugin.js")).href}?smoke=${Date.now()}`);
    twoHosts.apply(rogueCtx);
    const [rogueHosted] = rogueTypes;
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
    // settingsCards service injected as Desktop does it (ctx.inject), and
    // `host.runCommand` run as Desktop runs a declared command: the real
    // helper, with the manifest's fixed arguments, stdin, a deadline and
    // output only on exit 0. Its saves change this smoke's hosts.json and
    // dist, as they change the user's.
    const cards = [];
    const settingsTypes = [];
    let helperSilent = false;
    const helperRuns = [];
    const runCommand = async (id, input) => {
      helperRuns.push(JSON.parse(input ?? "{}").op);
      if (helperSilent) return null;
      const { host } = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
      const command = host.commands?.find((item) => item.id === id);
      if (!command || (input !== undefined && Buffer.byteLength(input) > command.maxInputBytes)) return null;
      return new Promise((done) => {
        execFile(process.execPath, command.args, { timeout: DESKTOP_COMMAND_DEADLINE_MS, maxBuffer: command.maxOutputBytes }, (error, stdout) => done(error ? null : stdout)).stdin.end(
          input ?? "",
        );
      });
    };
    const settingsCtx = {
      ...ctx,
      host: { ...ctx.host, runCommand },
      agents: { register: (type) => settingsTypes.push(type) },
      inject(names, run) {
        if (JSON.stringify(names) !== JSON.stringify(["settingsCards"])) throw new Error(`unexpected inject ${names}`);
        run({ settingsCards: { register: (card) => cards.push(card) } });
      },
    };
    /** Loads dist/plugin.js as it is now, as Desktop does after Update. */
    const loadSettingsBuild = async () => {
      cards.length = 0;
      settingsTypes.length = 0;
      const module = await import(`${pathToFileURL(PLUGIN).href}?smoke=${Date.now()}-${Math.random()}`);
      module.apply(settingsCtx);
      return { card: cards[0], type: settingsTypes[0] };
    };
    const fileList = () => JSON.parse(readFileSync(hostsPath, "utf8")).hosts;
    const grantOf = () => JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8")).host;
    const { card, type: settingsHosted } = await loadSettingsBuild();
    check(
      "plugin: registers its own Settings page, Tailscale hosts, under Plugins",
      cards.length === 1 && card.id === "hosts" && card.title === "Tailscale hosts" && card.group === "Plugins" && typeof card.component === "function",
      JSON.stringify(cards.map((item) => [item.id, item.title, item.group])),
    );
    const grant = grantOf();
    check(
      "plugin: the build grants one host command: node on the helper with this hosts.json and dist, bounded",
      grant.commands?.length === 1 &&
        grant.commands[0].id === "hosts" &&
        grant.commands[0].program === "node" &&
        JSON.stringify(grant.commands[0].args) === JSON.stringify([HOSTS_HELPER, "--hosts", hostsPath, "--out", outDir]) &&
        grant.commands[0].maxInputBytes > 0 &&
        grant.commands[0].maxOutputBytes > 0,
      JSON.stringify(grant.commands),
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
    await until(() => buttonFor(SMOKE_HOST.label, "Edit"), "hosts.json read");
    await until(() => rowFor(SMOKE_HOST.label)?.textContent.includes("Reachable"), "host status");
    check(
      "plugin: Settings shows hosts.json, with Edit and Remove on every host, and the host's status",
      JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label]) && buttonFor(SMOKE_HOST.label, "Remove") && rowFor(SMOKE_HOST.label).textContent.includes(SMOKE_HOST.origin),
      rowFor(SMOKE_HOST.label)?.textContent,
    );
    await press(buttonFor(SMOKE_HOST.label, "Remove"));
    await settled();
    check(
      "plugin: Remove keeps the last host, and says why",
      statusText().includes("must keep at least one host") && JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST]),
      statusText(),
    );
    const noHttps = await addHost("lab/one", "http://lab-one.example.invalid:10000");
    const withPath = await addHost("lab/one", "https://lab-one.example.invalid:10000/v1");
    const sameAddress = await addHost("lab/one", SMOKE_HOST.origin);
    const sameName = await addHost(SMOKE_HOST.label.toUpperCase(), "https://lab-one.example.invalid:10000");
    check(
      "plugin: Add refuses http, a path, a used address and a used name, and says why",
      /https:\/\//.test(noHttps) && withPath.includes("Write it as https://lab-one.example.invalid:10000") && sameAddress.includes("already uses this address") && sameName.includes("already named"),
      JSON.stringify([noHttps, withPath, sameAddress, sameName]),
    );
    check("plugin: a refused add leaves hosts.json as it was", JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST]), JSON.stringify(fileList()));
    const labHost = { id: "lab-one", label: "lab/one", origin: "https://lab-one.example.invalid:10000" };
    const added = await addHost(labHost.label, `${labHost.origin}/`);
    check(
      "plugin: Add writes hosts.json with a fixed id from the name and the address without the slash",
      added === "" && JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST, labHost]),
      `${added} ${JSON.stringify(fileList())}`,
    );
    check(
      "plugin: the save builds again: the manifest grants both origins and keeps the command",
      JSON.stringify(grantOf().networkOrigins) === JSON.stringify([SMOKE_HOST.origin, labHost.origin]) && grantOf().commands?.length === 1,
      JSON.stringify(grantOf()),
    );
    check(
      "plugin: the new host waits for Update, and the page says where Update is",
      rowFor(labHost.label)?.textContent.includes("Not in use until Update") && statusText().includes("Manage plugins, select Tailscale host agents, then select Update"),
      `${rowFor(labHost.label)?.textContent} | ${statusText()}`,
    );
    check("plugin: before Update, New agent keeps the build's one host", settingsHosted.defaults().config.host === SMOKE_HOST.id);

    // Edit keeps the id that agents carry.
    await press(buttonFor(labHost.label, "Edit"));
    const editForm = page.node.querySelector(`form[aria-label="Edit ${labHost.label}"]`);
    await typeText(fieldControl(editForm, "Name"), "lab/renamed");
    await submit(editForm);
    await settled();
    const renamedHost = { ...labHost, label: "lab/renamed" };
    check("plugin: Edit renames the host in hosts.json and keeps its id", JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST, renamedHost]) && rowFor(renamedHost.label), JSON.stringify(fileList()));

    // The owner edits hosts.json by hand: the page shows it and builds it.
    const handHost = { id: "lab-hand", label: "lab/hand", origin: "https://lab-hand.example.invalid:10000" };
    writeFileSync(hostsPath, JSON.stringify({ hosts: [SMOKE_HOST, renamedHost, handHost] }));
    await press([...page.node.querySelectorAll("button")].find((item) => item.textContent === "Check again"));
    await until(() => rowFor(handHost.label), "hand edit read");
    const buildButton = await until(() => [...page.node.querySelectorAll("button")].find((item) => item.textContent === "Build"), "Build button");
    check("plugin: a hand edit shows on the page, which offers Build", page.node.textContent.includes("hosts.json differs from the hosts in use"), page.node.textContent);
    await press(buildButton);
    await until(() => statusText().includes("then select Update"), "build done");
    check(
      "plugin: Build makes the hand-edited list the manifest's grant",
      JSON.stringify(grantOf().networkOrigins) === JSON.stringify([SMOKE_HOST.origin, renamedHost.origin, handHost.origin]),
      JSON.stringify(grantOf().networkOrigins),
    );
    collect(page.node);
    await page.unmount();

    // Update: Desktop loads the new build. Its hosts are the file's, in use.
    const updated = await loadSettingsBuild();
    page = mount();
    await page.render(React.createElement(updated.card.component, { active: () => true }));
    await until(() => buttonFor(handHost.label, "Edit") && rowFor(handHost.label)?.textContent.includes("Reachable"), "updated hosts");
    check(
      "plugin: after Update, every host in hosts.json is in use and nothing waits",
      JSON.stringify(rowTitles(page.node)) === JSON.stringify([SMOKE_HOST.label, renamedHost.label, handHost.label]) && !page.node.textContent.includes("Not in use") && !page.node.textContent.includes("differs"),
      page.node.textContent,
    );
    const pickHost = mount();
    let picked = updated.type.defaults().config;
    function HostDialog() {
      const [draft, setDraft] = React.useState(picked);
      picked = draft;
      return React.createElement(updated.type.Create, { config: draft, disabled: false, onChange: setDraft });
    }
    await pickHost.render(React.createElement(HostDialog));
    // A field Select names its trigger with aria-labelledby, as Desktop's.
    const labelledBy = (node, label) =>
      [...node.querySelectorAll("[role=combobox][aria-labelledby]")].find((item) => document.getElementById(item.getAttribute("aria-labelledby"))?.textContent === label);
    const hostPill = await until(() => labelledBy(pickHost.node, "Host"), "host pill");
    const hostList = await open(hostPill);
    check(
      "plugin: after Update, New agent offers the hosts in file order, the first as default",
      JSON.stringify(labels(hostList)) === JSON.stringify([SMOKE_HOST.label, renamedHost.label, handHost.label]) && picked.host === SMOKE_HOST.id,
      JSON.stringify(labels(hostList)),
    );
    await press(document.body);
    collect(pickHost.node);
    await pickHost.unmount();

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
      "plugin: Remove deletes a host without agents from hosts.json and builds",
      JSON.stringify(fileList()) === JSON.stringify([SMOKE_HOST, renamedHost]) && JSON.stringify(grantOf().networkOrigins) === JSON.stringify([SMOKE_HOST.origin, renamedHost.origin]),
      JSON.stringify(fileList()),
    );
    await page.unmount();

    // A broken file and a helper that does not answer: the page says so and
    // shows the hosts in use, with nothing it could save over.
    writeFileSync(hostsPath, "{ broken");
    page = mount();
    await page.render(React.createElement(updated.card.component, { active: () => true }));
    const brokenAlert = await until(() => page.node.querySelector("[role=alert]"), "broken file alert");
    check(
      "plugin: a broken hosts.json shows the helper's reason; no Edit, Remove or Add",
      brokenAlert.textContent.includes("not valid JSON") && !buttonFor(SMOKE_HOST.label, "Edit") && !addForm() && rowTitles(page.node).length === 3,
      brokenAlert.textContent,
    );
    await page.unmount();
    helperSilent = true;
    page = mount();
    await page.render(React.createElement(updated.card.component, { active: () => true }));
    const silentAlert = await until(() => page.node.querySelector("[role=alert]"), "silent helper alert");
    check("plugin: a helper that does not answer names node on the login shell's PATH", silentAlert.textContent.includes("login shell's PATH"), silentAlert.textContent);
    collect(page.node);
    await page.unmount();
    helperSilent = false;
    check("plugin: the page sent only read, save and build requests", helperRuns.length > 0 && helperRuns.every((op) => ["read", "save", "build"].includes(op)), JSON.stringify(helperRuns));

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
    rmSync(buildDir, { recursive: true, force: true });
  }
  // #lizard forgives: one end-to-end scenario through the plugin UI that must read in run order
}
