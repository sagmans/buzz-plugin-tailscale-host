// Tailscale host agents: prebuilt Buzz plugin API v1 module.
// Purpose: let the owner create Buzz agents that run on the owner's own
// Tailscale hosts instead of this device. It registers one hosted agent type
// (`RemoteAgentType`), so Buzz Desktop keeps the owner's agent list and signs
// only the NIP-OA owner proof, while `buzz-runner` on the host makes and keeps
// the agent key and runs the agent's turns even while this device sleeps.
//
// One type, many harnesses: Desktop locks the type of a hosted agent
// (AgentSettingsHost), so a type per harness would fix the harness for good.
// The type is "Tailscale host"; the harness is a setting inside it, listed
// from the runner (`GET /v1/harnesses`) in Desktop's order with Desktop's
// icons, and the runner restarts the agent on a new one. A harness the host
// cannot run yet is listed but cannot be picked. Adding a harness later is
// runner config plus runner support, never a change here.
// Contract with the runner: "Runner contract v1" in docs/RUNNER_CONTRACT.md,
// harness routes in docs/HARNESSES.md. Change both together.
//
// hosts.json is the one host list, and it is not in this file. The build
// (scripts/build-plugin.mjs) grants one host process, scripts/hosts-helper.mjs
// on the user's hosts.json. The plugin reads and saves the list through it,
// and sends every runner call through it by host id: the helper takes the
// origin from the file at each call. So a host added on the plugin's Settings
// page, or by hand in the file, works at once, with no new build and no
// Update; Buzz would let the plugin reach only the origins of its installed
// manifest itself.

// Cordis starts apply() only after these host services exist.
export const inject = ["react", "agents", "host"];

// The manifest id; storage keys are named after it, so two builds under
// different ids never read each other's data.
const PLUGIN_ID = "sagmans.tailscale-host";
// The hosts in hosts.json as the helper last read or saved them, in the
// user's order; the first is the default for new agents. Replaced, never
// changed in place, so views that read it see each change (setHostList).
let HOSTS = Object.freeze([]);
const defaultHostId = () => (HOSTS.length ? HOSTS[0].id : undefined);

// The type id the plugin always had, so existing agents (whose saved config
// names it) keep working.
const TYPE_ID = "tailscale-host";
const TYPE_TITLE = "Tailscale host";
// Desktop's New agent Harness picker shows only the type title, so the title
// names where the agent runs: the host itself when there is one, else the
// host count, and the Host field below the picker names each host. Desktop
// keeps the title it got at registration, so it names the hosts as the
// plugin found them at start; the Host field always shows the list as it is.
const pickerTitle = (list) =>
  list.length === 1 ? `${TYPE_TITLE} · ${list[0].label}` : list.length ? `${TYPE_TITLE} · ${list.length} hosts` : TYPE_TITLE;
// The harness an agent gets when its config names none: every agent made
// before harnesses existed runs Claude.
const CLAUDE_HARNESS = "claude-code";
// Desktop draws type and harness icons at this size.
const HARNESS_ICON_SIZE = 20;
// Desktop sizes icons in rem from a 16px root (createDecorativeIcon), so
// icons scale with the app's text size as Desktop's do.
const REM_PX = 16;
// Desktop's chevron and check sizes in its Select and Menu triggers.
const CHEVRON_SIZE = 14;
const FIELD_CHEVRON_SIZE = 16;
const CHECK_SIZE = 14;
// Desktop's popup geometry (Base UI Positioner sideOffset and
// collisionPadding in Select.tsx and Menu.tsx).
const POPUP_OFFSET_PX = 4;
const POPUP_PADDING_PX = 8;
// Desktop's Model row (PreferenceRow) sizes its trailing column to the
// widest content, so a long host message would squeeze the "Model" title to
// one letter per line. A zero width adds nothing to that size; the full
// minimum width then lets the message wrap under the pills. Desktop's CSS
// has no utility class for this pair, so it is an inline style.
const MESSAGE_BLOCK_STYLE = Object.freeze({ width: 0, minWidth: "100%" });
// Desktop's Instructions box heights (AgentInstructions.tsx).
const INSTRUCTIONS_ROWS_CREATE = 4;
const INSTRUCTIONS_ROWS = 8;
const INSTRUCTIONS_EXAMPLE = "Help me plan my week and prioritize tasks.";
// Desktop's model-vendor matchers (features/agents/ModelPicker.tsx
// `modelLogo`), limited to the marks this plugin carries.
const CLAUDE_MODEL = /claude|anthropic|opus|sonnet|haiku/;
const OPENAI_MODEL = /(?:^|[\s/._-])(?:gpt|codex|o[134](?:[\s/._-]|$))|openai/;
const API_PREFIX = "/v1";
// Activation publishes a profile and opens a relay connection on the host, and
// a harness check may start claude twice, so these get more time than plain
// record calls.
const REQUEST_TIMEOUT_MS = 30000;
const ACTIVATE_TIMEOUT_MS = 90000;
const HARNESS_TIMEOUT_MS = 45000;
// Readiness can change on the host (sign-in, install) without this app
// knowing; a minute matches the runner's own status cache.
const STATUS_POLL_MS = 60000;
// A sign-in on the host (buzz-login) changes a harness's models; a list is
// fetched again when a picker opens after this long, as the runner keeps it.
const MODELS_TTL_MS = 60000;
const INSTRUCTIONS_MAX = 20000;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
// Bounds for what a runner reports, which is shown in the UI: a broken or
// hostile runner must not flood it.
const HARNESS_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const HARNESSES_MAX = 16;
const TITLE_MAX = 40;
const TEXT_MAX = 200;
const MODELS_MAX = 64;
const EFFORTS_MAX = 16;
const MODEL_MAX = 128;
const EFFORT_ID = /^[a-z]{1,16}$/;
// Desktop never offers `max` for Claude (claude-code `effortChoices`); the
// runner refuses it too.
const CLAUDE_HIDDEN_EFFORT = "max";
// Desktop's Sessions choices (claude-code tabs.tsx SCOPES).
const SCOPES = Object.freeze([
  ["thread", "One session per thread"],
  ["channel", "One session per channel"],
]);
const DEFAULT_SCOPE = "thread";
// Desktop's words for these rows (claude-code tabs.tsx, ModelPicker.tsx,
// Field.tsx, AgentSaveButton.tsx), so hosted agents read as Desktop's own.
const CUSTOM_MODEL = "\u0000custom-model";
const LABELS = Object.freeze({
  model: "Model",
  modelId: "Model ID",
  custom: "Custom model",
  customDescription: "Enter a model ID",
  customListed: "Custom model",
  useModel: "Use model",
  cancel: "Cancel",
  defaultDescription: "Following the provider's model default",
  defaultSuffix: " · Default",
  modelUnavailable: "Model unavailable",
  loadingModels: "Loading models…",
  tryAgain: "Try again",
  thinking: "Thinking",
  automatic: "Automatic",
  unavailable: " (unavailable)",
  sessions: "Sessions",
  workspace: "Workspace",
  host: "Host",
  runsOn: "Runs on",
  harness: "Harness",
  instructions: "Instructions",
  optional: "Optional",
  save: "Save",
  saving: "Saving…",
  // The plugin's Settings page.
  summaryIntro: "New agent can run on each of these hosts. Add hosts and sign their harnesses in on the Tailscale hosts page.",
  hostsFileNote: "New agent offers these hosts; the first is the default. You can also edit hosts.json by hand, then select Check again.",
  addIntro: "This installs buzz-runner on the machine over Tailscale SSH, or aligns the runner already there. It also installs the runner's own Node and each harness that the machine does not have yet.",
  addNeeds: "The machine needs Linux, an ACL tag, Tailscale SSH, and curl or wget.",
  sshLoginHelp: "The Linux user that Tailscale SSH signs you in as. Empty: your user name here.",
  sudoHelp: "Only for a login that sudo asks a password of. It goes to sudo on the machine, and is not saved.",
  signInTitle: "Harnesses",
  harnessesIntro: "An agent can work only when its harness on this host is signed in.",
  signInIntro: "This runs on the host's own terminal, as the harness user.",
  signInSteps: "Follow the terminal: open the link that it shows, type the code or key in Answer, and select Send.",
  noHosts: "No Tailscale hosts. Add one in Settings > Plugins > Tailscale hosts.",
  helperMissing: "This version of Buzz Desktop cannot run the hosts helper, which this plugin needs to reach its hosts.",
  helperSilent:
    "The hosts helper did not answer. Buzz runs node from your login shell's PATH: check that node is there, then select Check again.",
});
// Remembers which host holds each agent, because remove/profile/interrupt
// calls name only the pubkey. Holds no secret: pubkey and host id only.
const STORE_PREFIX = `${PLUGIN_ID}.agent-host.v1:`;
// The same map as kept by earlier builds that were published under another
// plugin id namespace (`<namespace>.tailscale-host`). Plugins share the app
// WebView's localStorage, so those entries are still readable: they move to
// STORE_PREFIX once, and existing agents keep their host after the id change.
const EARLIER_STORE_KEY = /^[a-z][a-z0-9-]*\.tailscale-host\.agent-host\.v1:([0-9a-f]{64})$/;
// Written by builds that registered a type per harness, under any namespace;
// removed at start so the WebView store keeps nothing stale.
const LEGACY_HARNESS_CACHE_KEY = /^[a-z][a-z0-9-]*\.tailscale-host\.harnesses\.v1$/;
const HEX64 = /^[0-9a-f]{64}$/;
// A host's status before its first answer.
const CHECKING = Object.freeze({ state: "checking" });
// The host process the build declares (scripts/build-plugin.mjs
// HOSTS_PROCESS), and its bounds (scripts/hosts-helper.mjs): one request line
// at most LINE_MAX, a reply carries at most a 1 MiB runner body, which JSON
// escaping can about double.
const HOSTS_PROCESS = "hosts";
const HELPER_LINE_MAX = 262144;
const HELPER_REPLY_MAX = 4 * 1048576;
// A hosts.json read or save is local; it gets the time a command would.
const HELPER_FILE_TIMEOUT_MS = 10000;
// The helper ends each runner call at its own timeout; the plugin waits this
// much longer, so the helper's reason, not a bare timeout, reaches the owner.
const HELPER_GRACE_MS = 5000;
// Helper log lines kept per line, so a runaway process cannot flood the log.
const HELPER_LOG_MAX = 1000;
// The status poll asks each host every minute (scripts/build-plugin.mjs HOSTS_MAX).
const HOSTS_MAX = 16;
// The host rules of scripts/build-plugin.mjs, repeated here because the
// plugin is one file with no imports: an id is saved in each agent's config;
// a label is cut as runner titles are. The helper checks them again.
const HOST_ID = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const HOST_ID_MAX = 32;
const HOST_ID_FALLBACK = "host";
const LABEL_MAX = 40;
// A DNS name is at most 253 characters; with scheme and port this bounds an
// origin well before it could matter as stored data.
const ORIGIN_MAX = 300;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
// The plugin's own page under Settings, beside the other plugins' cards.
const SETTINGS_CARD_ID = "hosts";
const SETTINGS_TITLE = "Tailscale hosts";
const SETTINGS_GROUP = "Plugins";
// The Hosts page in the left panel, as Usage has one. Its icon is an image
// because Desktop takes only a data: image for a page. The stroke is a mid
// gray: an image cannot use the theme's currentColor.
const HOSTS_PAGE_ID = "hosts";
const HOSTS_PAGE_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='1.75' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect x='3' y='4' width='18' height='7' rx='2'/%3E%3Crect x='3' y='13' width='18' height='7' rx='2'/%3E%3Cpath d='M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6'/%3E%3C/svg%3E";
const PAGE_ICON_SIZE = 16;
const STEP_MARK_SIZE = 16;
// The page's view that shows Add a host instead of one host. A host id starts
// with a letter or a digit (HOST_ID), so it can never equal this.
const ADD_VIEW = "+add";
// What a state's dot looks like: Desktop's status tokens, so that the dots
// follow the theme. The words beside a dot carry the meaning.
const TONE_COLORS = Object.freeze({ good: "var(--status-online)", wait: "var(--status-away)", bad: "var(--color-danger)", off: "var(--status-offline)" });
// The page's layout. Desktop's Tailwind build holds only the classes that
// Desktop itself uses, so a size that it lacks is an inline style here.
const DOT_STYLE = Object.freeze({ display: "inline-block", flex: "none", width: "0.5rem", height: "0.5rem", borderRadius: "50%" });
const COLUMNS_STYLE = Object.freeze({ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "1.5rem" });
const LIST_STYLE = Object.freeze({ flex: "1 1 15rem", maxWidth: "20rem", minWidth: 0 });
const DETAIL_STYLE = Object.freeze({ flex: "3 1 24rem", minWidth: 0 });
const CARD_STYLE = Object.freeze({ padding: "1.25rem", borderRadius: "0.75rem", border: "1px solid var(--border-standard)" });
const FIELDSET_STYLE = Object.freeze({ border: 0, margin: 0, padding: 0, minWidth: 0 });
const LEGEND_STYLE = Object.freeze({ padding: 0, marginBottom: "0.5rem" });
const DISCLOSED_STYLE = Object.freeze({ marginTop: "0.75rem" });
const STEP_ROW_STYLE = Object.freeze({ display: "flex", alignItems: "flex-start", gap: "0.75rem" });
const STEP_MARK_STYLE = Object.freeze({ display: "flex", flex: "none", alignItems: "center", justifyContent: "center", width: "1rem", height: "1.25rem" });
const GROW_STYLE = Object.freeze({ flex: "1 1 auto", minWidth: 0 });
const TERMINAL_STYLE = Object.freeze({ padding: "0.75rem", borderRadius: "0.5rem", border: "1px solid var(--border-standard)", fontFamily: "ui-monospace, monospace" });
const PAGE_SCROLL_STYLE = Object.freeze({ flex: "1 1 0", minHeight: 0, overflowY: "auto" });
const PAGE_BODY_STYLE = Object.freeze({ padding: "var(--space-panel-inset, 1.25rem)", maxWidth: "64rem" });
const ORIGIN_EXAMPLE = "https://runner-host.example.ts.net";
// The port of the runner's tailscale serve (scripts/build-plugin.mjs
// RUNNER_PORT). The owner knows the machine, not where the runner listens,
// so an address is kept without it and the hosts helper adds it.
const RUNNER_PORT = "10000";
// The host setup that Add host runs (scripts/host-setup.mjs). The steps in
// order, with the words the page shows; the helper names each by its key.
const SETUP_STEPS = Object.freeze([
  ["machine", "Check the machine"],
  ["bundle", "Build the runner"],
  ["connect", "Connect over Tailscale SSH"],
  ["node", "Install the runner's Node"],
  ["copy", "Copy the runner"],
  ["harnesses", "Install the harnesses"],
  ["install", "Install buzz-runner"],
  ["serve", "Turn on tailscale serve"],
  ["hosts", "Add to hosts.json"],
  ["health", "Check the runner"],
]);
const SETUP_STATES = Object.freeze(["running", "waiting", "done", "failed"]);
// The longest a setup step may run without a progress line: the helper's
// own longest silent stretch (the Node download, or one harness download,
// 16 min each; each harness shows a line when it ends), with a margin.
const SETUP_IDLE_MS = 1020000;
// The only links a setup shows: a Tailscale SSH check, which the user opens
// to approve the connection (scripts/host-setup.mjs CHECK_LINK_RE).
const CHECK_LINK = /^https:\/\/login\.tailscale\.com\/[A-Za-z0-9/_?=&.-]{1,200}$/;
// The sign-ins that the Hosts page offers, by harness, with the words the page
// shows: the helper takes only these keys (scripts/host-signin.mjs
// SIGNIN_COMMANDS). The first method of a harness is its usual one.
const SIGNIN_HARNESSES = Object.freeze([
  {
    id: "claude-code",
    title: "Claude",
    methods: [
      ["claude", "claude.ai account", "Sign in with a browser and a Claude subscription."],
      ["claude-console", "Anthropic Console", "Sign in with a browser and API billing."],
    ],
  },
  {
    id: "codex",
    title: "Codex",
    methods: [
      ["codex-device", "Device code", "Sign in with a browser and a one-time code."],
      ["codex-api-key", "API key", "Type a key in Answer."],
    ],
  },
  {
    id: "goose",
    title: "Goose",
    methods: [
      ["goose-key", "Provider key", "Type a provider key in Answer."],
      ["goose-oauth", "Device code", "Sign in with a browser and a one-time code."],
      ["goose-default", "Default model", "Choose the model that new agents start with."],
    ],
  },
  {
    id: "pi",
    title: "Pi",
    methods: [
      ["pi-key", "Provider key", "Type a provider key in Answer."],
      ["pi-oauth", "Browser", "Sign in with a browser."],
      ["pi-default", "Default model", "Choose the model that new agents start with."],
    ],
  },
]);
// The sign-in command that only shows what is signed in; it has no harness.
const SIGNIN_STATUS = "status";
// The longest a sign-in may stay without new output: the owner signs in
// in a browser meanwhile, and the helper ends a sign-in after 20 min.
const SIGNIN_IDLE_MS = 1260000;
// The helper sends at most 300 lines of 2000 characters.
const SIGNIN_OUTPUT_MAX = 700000;
// buzz-login's own bound for a key or a pasted code.
const SIGNIN_INPUT_MAX = 8192;
// Bounds for what the helper reports about a setup.
const DETAIL_MAX = 500;
const MANUAL_MAX = 8;
const COMMAND_MAX = 300;
// The SSH login and sudo password fields (scripts/host-setup.mjs rules).
const SSH_USER_MAX = 32;
const PASSWORD_MAX = 256;
// Add host gives its login a sudo rule for buzz-login only (install.sh
// --login-user), so a sign-in asks no password. Hosts set up before that
// rule, or by another login, still need one.
const SIGNIN_PASSWORD_HELP = "Leave it empty for the login that ran Add host: sudo asks it no password for a sign-in. Only a host that an older Add host or another login set up needs it. Not saved.";
const RELAY_MAX = 300;
// The relay the runner's agents connect to: the community the owner has
// open, as Desktop names it (an https:// or wss:// origin), as wss://.
const RELAY_EXAMPLE = "wss://relay.example.ts.net";

/** A failed runner call, carrying what is needed to diagnose it in one pass. */
class RunnerError extends Error {
  constructor(message, details) {
    super(message, details && details.cause ? { cause: details.cause } : undefined);
    this.name = "RunnerError";
    this.details = details;
  }
}

/** A host entry the owner typed that breaks a host rule, or a save that the
 * hosts helper refused; the message names what to fix. */
class HostConfigError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "HostConfigError";
    this.details = details;
  }
}

/** A label as the build accepts it, from what the owner typed. */
function checkHostLabel(value) {
  const label = typeof value === "string" ? value.trim() : "";
  if (!label || label.length > LABEL_MAX || CONTROL_CHARS.test(label))
    throw new HostConfigError(`Name must be 1-${LABEL_MAX} printable characters.`, { field: "label" });
  return label;
}

/** An origin exactly as Buzz and the build compare it (HTTPS, no
 * credentials, path, query or fragment). One trailing slash is accepted,
 * because a pasted address often has it. RUNNER_PORT is dropped, so an
 * address from an older hosts.json and a typed one are the same host and
 * read the same on the page. */
function checkHostOrigin(value) {
  const typed = typeof value === "string" ? value.trim() : "";
  if (!typed || typed.length > ORIGIN_MAX) throw new HostConfigError("Enter the host's https:// address.", { field: "origin" });
  let url;
  try {
    url = new URL(typed);
  } catch {
    throw new HostConfigError(`Address is not a URL. Example: ${ORIGIN_EXAMPLE}`, { field: "origin" });
  }
  if (url.protocol !== "https:") throw new HostConfigError("Address must start with https://.", { field: "origin" });
  if (url.username || url.password) throw new HostConfigError("Address must not hold a user name or password.", { field: "origin" });
  const typedOrigin = url.origin;
  if (url.port === RUNNER_PORT) url.port = "";
  if (typed !== typedOrigin && typed !== `${typedOrigin}/`)
    throw new HostConfigError(`Address must have no path. Write it as ${url.origin}`, { field: "origin" });
  return url.origin;
}

/** A new host's id, made from its label: the owner never sees it, but it is
 * saved in each agent's config, so it stays fixed when the label changes. */
function hostIdFor(label, taken) {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, HOST_ID_MAX)
      .replace(/-+$/g, "") || HOST_ID_FALLBACK;
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const id = `${base.slice(0, HOST_ID_MAX - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (HOST_ID.test(id) && !taken.has(id)) return id;
  }
}

/** Checks one host against the others in the list: the same id, origin or
 * name (case-insensitive) twice would route agents to the wrong runner. */
function checkUnique(host, others) {
  for (const other of others) {
    if (other.id === host.id) throw new HostConfigError(`Duplicate host id ${host.id}.`, { field: "id" });
    if (other.origin === host.origin) throw new HostConfigError(`${other.label} already uses this address.`, { field: "origin" });
    if (other.label.toLowerCase() === host.label.toLowerCase())
      throw new HostConfigError(`A host is already named ${other.label}.`, { field: "label" });
  }
}

function hostById(id) {
  if (!HOSTS.length) throw new RunnerError(LABELS.noHosts, { op: "host", id });
  const host = HOSTS.find((entry) => entry.id === id);
  if (!host) throw new RunnerError(`Unknown Tailscale host: ${id}`, { op: "host", id });
  return host;
}

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);
const errorText = (error) => String((error && error.message) || error);

/** Keeps only fields the runner accepts, so a stale or edited config can not
 * send unexpected data across the trust boundary. The runner checks the
 * harness again: this only keeps the id well formed. */
function cleanConfig(config) {
  const value = config && typeof config === "object" ? config : {};
  const harness = typeof value.harness === "string" && HARNESS_ID.test(value.harness) ? value.harness : CLAUDE_HARNESS;
  const out = {
    host: typeof value.host === "string" && HOSTS.some((entry) => entry.id === value.host) ? value.host : defaultHostId(),
    harness,
    scope: SCOPES.some(([id]) => id === value.scope) ? value.scope : DEFAULT_SCOPE,
    instructions: typeof value.instructions === "string" ? value.instructions.slice(0, INSTRUCTIONS_MAX) : "",
  };
  if (typeof value.model === "string" && value.model.trim()) out.model = value.model.trim().slice(0, MODEL_MAX);
  if (
    typeof value.effort === "string" &&
    EFFORT_ID.test(value.effort) &&
    !(harness === CLAUDE_HARNESS && value.effort === CLAUDE_HIDDEN_EFFORT)
  )
    out.effort = value.effort;
  return out;
}

/** The config the runner stores: the host is where it runs, not a setting. */
function runtimeConfig(config) {
  const { host: _host, ...rest } = cleanConfig(config);
  return rest;
}

/** A runner's harness list, bounded and shape-checked; bad entries dropped. */
function parseHarnesses(reply) {
  const list = reply && Array.isArray(reply.harnesses) ? reply.harnesses.slice(0, HARNESSES_MAX) : [];
  return list
    .filter((item) => item && typeof item.id === "string" && HARNESS_ID.test(item.id))
    .map((item) => ({
      id: item.id,
      title: text(item.title, TITLE_MAX) || item.id,
      supported: item.supported === true,
      installed: item.installed === true,
      ready: item.ready === true,
      state: text(item.state, TITLE_MAX) || "",
      version: text(item.version, TITLE_MAX),
      account: text(item.account, TEXT_MAX),
      message: text(item.message, TEXT_MAX),
    }));
}

/** A runner's model list (Desktop's `Models`), bounded and shape-checked. */
function parseModels(reply) {
  const efforts = (list) =>
    (Array.isArray(list) ? list.slice(0, EFFORTS_MAX) : [])
      .filter((item) => item && typeof item.id === "string" && EFFORT_ID.test(item.id))
      .map((item) => ({ id: item.id, label: text(item.label, TITLE_MAX) || item.id }));
  const models = (reply && Array.isArray(reply.models) ? reply.models.slice(0, MODELS_MAX) : [])
    .filter((item) => item && typeof item.id === "string" && item.id && item.id.length <= MODEL_MAX)
    .map((item) => ({
      id: item.id,
      label: text(item.label, TITLE_MAX) || item.id,
      efforts: efforts(item.efforts),
      effort: typeof item.effort === "string" && EFFORT_ID.test(item.effort) ? item.effort : undefined,
    }));
  return { current: text(reply && reply.current, MODEL_MAX) || "", models };
}

// ---- Icons ----------------------------------------------------------------
// Copies of Desktop's harness marks (buzz-app shared/design-system/icons/
// HarnessLogos.tsx), because a plugin cannot import Desktop's design system.
// Sources and licenses are listed in this repository's NOTICE, as buzz-app's
// NOTICE.md states them. A harness without a mark here shows no icon in the
// Harness field.

/** Claude's bundled brand mark, as Desktop ships it (claude.png). Claude is a
 * trademark of Anthropic; see NOTICE. */
const CLAUDE_PNG = "data:image/png;base64,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";

function makeIcons(h) {
  const svg = (viewBox, extra, children) =>
    function HarnessIcon({ size = "1em", ...props }) {
      const length = typeof size === "number" ? `${size / REM_PX}rem` : size;
      return h("svg", { width: length, height: length, viewBox, xmlns: "http://www.w3.org/2000/svg", ...extra, ...props }, ...children);
    };
  return {
    // The type's own mark: a plain server rack, because the type stands for
    // the host, not for one harness. Original drawing for this plugin; no
    // third-party license.
    host: svg(
      "0 0 24 24",
      { fill: "none", stroke: "currentColor", strokeWidth: "1.75", strokeLinecap: "round", strokeLinejoin: "round" },
      [
        h("rect", { key: "t", x: "3", y: "4", width: "18", height: "7", rx: "2" }),
        h("rect", { key: "b", x: "3", y: "13", width: "18", height: "7", rx: "2" }),
        h("path", { key: "d", d: "M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" }),
      ],
    ),
    "claude-code": svg("0 0 32 32", {}, [h("image", { key: "i", href: CLAUDE_PNG, width: "32", height: "32" })]),
    // OpenAI's Blossom mark for Codex, from OpenAI's brand kit. OpenAI and the
    // Blossom logo are trademarks of OpenAI.
    codex: svg("176 176 364 364", { fill: "currentColor" }, [
      h("path", {
        key: "p",
        d: "M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z",
      }),
    ]),
    // Goose's official mark. Apache-2.0 © Block, Inc.
    goose: svg("0 0 45 45", { fill: "currentColor" }, [
      h("path", {
        key: "p",
        d: "M43.2098 39.2492L39.8118 36.4522C37.9646 34.9318 36.3923 33.1051 35.1631 31.0529C33.4647 28.2172 31.1178 25.8243 28.3164 24.071L26.9482 23.2744C26.4794 22.9485 26.1525 22.4405 26.106 21.8675C26.0762 21.4981 26.1647 21.1678 26.3712 20.8771C27.0837 19.873 30.9617 15.6995 31.6365 15.1411C32.5056 14.4228 33.4739 13.8253 34.3724 13.1412C34.5001 13.0438 34.6283 12.9469 34.7545 12.8481C34.7589 12.8437 34.7653 12.8403 34.7692 12.8363C35.0574 12.6088 35.3295 12.3671 35.5458 12.0803C36.5993 10.8604 36.5783 9.82938 36.5783 9.82938C36.5783 9.82938 36.5793 9.8284 36.5798 9.82791C36.4677 9.5534 36.0645 8.69902 35.2449 8.29825C35.9696 8.28406 36.7872 8.55564 37.1582 8.91873C37.6039 8.21947 37.8922 7.76585 38.3404 7.00347C38.4471 6.82241 38.5038 6.48771 38.2998 6.30029C38.2998 6.30029 38.2988 6.30029 38.2978 6.30029C38.2978 6.30029 38.2978 6.29931 38.2978 6.29833C38.2939 6.29442 38.289 6.29148 38.2851 6.28757C38.2812 6.28365 38.2787 6.27925 38.2743 6.27485C38.2743 6.27485 38.2734 6.27485 38.2724 6.27485C38.2724 6.27485 38.2724 6.27387 38.2724 6.27289C38.2641 6.26457 38.2548 6.25821 38.246 6.25038C38.2406 6.245 38.2362 6.23864 38.2313 6.23276C38.2254 6.22787 38.219 6.22347 38.2137 6.21808C38.2053 6.20977 38.2 6.19949 38.1911 6.19166C38.1911 6.19166 38.1897 6.19117 38.1892 6.19166C38.1892 6.19166 38.1892 6.19068 38.1892 6.1897C38.1853 6.18579 38.1804 6.18285 38.1765 6.17894C38.1726 6.17502 38.1696 6.17013 38.1657 6.16621C38.1657 6.16621 38.1642 6.16572 38.1637 6.16621C38.1637 6.16621 38.1637 6.16524 38.1637 6.16426C37.9763 5.9602 37.6416 6.01697 37.4606 6.12364C36.4692 6.70693 35.5047 7.33475 34.6351 7.88525C34.6351 7.88525 33.6046 7.86372 32.3842 8.91775C32.097 9.13452 31.8552 9.4066 31.6282 9.69433C31.6238 9.69873 31.6199 9.7046 31.6164 9.70901C31.5171 9.83476 31.4202 9.96297 31.3233 10.0912C30.6387 10.9901 30.0417 11.958 29.3234 12.8271C28.7656 13.5023 24.5915 17.3798 23.5874 18.0923C23.2967 18.2988 22.9669 18.3879 22.597 18.3575C22.0245 18.3115 21.5161 17.9842 21.1902 17.5154L20.3935 16.1472C18.6402 13.3448 16.2474 10.9989 13.4117 9.30041C11.3594 8.0712 9.5332 6.49847 8.01234 4.65172L5.2153 1.25377C5.0773 1.08642 4.81306 1.11382 4.71422 1.30662C4.39615 1.92612 3.78888 3.23411 3.32353 4.99327C3.31227 5.03487 3.32206 5.07891 3.34946 5.11218C3.92786 5.81095 5.26717 7.35089 6.8624 8.65351C6.97348 8.74403 6.88246 8.92313 6.74447 8.88496C5.36846 8.51013 4.03062 7.90825 3.02944 7.39542C2.94772 7.35383 2.84887 7.4057 2.83713 7.49672C2.68152 8.74354 2.64139 10.1127 2.80581 11.5562C2.8107 11.6032 2.84055 11.6438 2.8841 11.6629C4.02572 12.1596 5.85143 12.8804 7.76816 13.3389C7.90713 13.3722 7.90273 13.5723 7.76229 13.5992C6.26982 13.8801 4.70688 13.9427 3.43656 13.9261C3.3475 13.9251 3.28193 14.0093 3.30591 14.0949C3.56085 14.9958 3.90632 15.9118 4.3619 16.8342C4.55029 17.2487 4.75532 17.6553 4.97504 18.0532C5.01271 18.1212 5.08562 18.1618 5.16343 18.1584C6.21207 18.107 7.47946 17.9964 8.75369 17.7713C8.97095 17.7331 9.08741 18.0189 8.90391 18.1417C8.03877 18.7201 7.11588 19.2183 6.25758 19.6283C6.14259 19.6836 6.1054 19.8304 6.18125 19.9327C6.69114 20.6236 7.25191 21.2774 7.86114 21.8866C7.86114 21.8866 10.8608 24.9763 10.9425 25.2185C12.6928 23.4261 15.5701 21.4394 18.7474 19.7047C14.4921 23.1672 12.1198 25.7235 10.9258 27.1758L10.0935 28.3439C9.66091 28.9507 9.2856 29.5951 8.97193 30.2709C7.92231 32.5292 6.19201 37.0966 6.19201 37.0966C6.0594 37.4543 6.16755 37.8072 6.39753 38.0371C6.40292 38.0425 6.4083 38.0479 6.41417 38.0528C6.41955 38.0582 6.42445 38.0641 6.42983 38.0694C6.66031 38.2999 7.01263 38.4076 7.37033 38.275C7.37033 38.275 11.9368 36.5447 14.1961 35.495C14.8719 35.1814 15.5168 34.8056 16.1231 34.3735L17.4095 33.457C18.0907 32.9715 19.0234 33.0489 19.615 33.6405L22.5804 36.6058C23.1896 37.2151 23.8433 37.7758 24.5343 38.2857C24.637 38.3611 24.7833 38.3244 24.8386 38.2094C25.2492 37.3516 25.7473 36.4277 26.3252 35.5631C26.4481 35.3796 26.7343 35.4965 26.6957 35.7133C26.4701 36.988 26.3605 38.2554 26.3086 39.3035C26.3047 39.3809 26.3458 39.4543 26.4138 39.4919C26.8112 39.7121 27.2178 39.9172 27.6327 40.1051C28.5551 40.5606 29.4717 40.9066 30.3721 41.1611C30.4577 41.185 30.5419 41.1195 30.5409 41.0304C30.5237 39.7596 30.5864 38.1967 30.8677 36.7047C30.8942 36.5638 31.0943 36.5593 31.1281 36.6988C31.5861 38.616 32.3069 40.4417 32.8041 41.5829C32.8231 41.6264 32.8633 41.6558 32.9107 41.6612C34.3543 41.8256 35.7234 41.7855 36.9703 41.6298C37.0618 41.6186 37.1136 41.5197 37.0715 41.4375C36.5587 40.4364 35.9568 39.0975 35.582 37.7225C35.5443 37.584 35.7229 37.4935 35.8135 37.6046C37.1161 39.1998 38.656 40.5391 39.3548 41.1175C39.3881 41.1449 39.4326 41.1542 39.4737 41.1434C41.2333 40.6786 42.5413 40.0713 43.1604 39.7528C43.3532 39.6539 43.3806 39.3897 43.2132 39.2517L43.2098 39.2492Z",
      }),
    ]),
    // Pi's official favicon. MIT © 2026 Earendil Inc. and contributors.
    pi: svg("0 0 800 800", {}, [
      h("rect", { key: "r", width: "800", height: "800", rx: "120", fill: "#09090b" }),
      h("path", {
        key: "a",
        fill: "#fff",
        fillRule: "evenodd",
        d: "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z",
      }),
      h("path", { key: "b", fill: "#fff", d: "M517.36 400 H634.72 V634.72 H517.36 Z" }),
    ]),
  };
}

/** Desktop's Tabler outline icons (chevron-down, check, x, loader-2), kept apart from
 * the harness marks so a harness id can never pick one. */
function makeGlyphs(h) {
  // Desktop's Tabler outline icons, drawn as Tabler
  // draws them so global `.tabler-icon` rules apply alike. MIT © Tabler.
  const tabler = (name, d) =>
    function TablerIcon({ size = 24, className, ...props }) {
      const length = `${size / REM_PX}rem`;
      return h(
        "svg",
        {
          xmlns: "http://www.w3.org/2000/svg",
          width: length,
          height: length,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          className: ["tabler-icon", `tabler-icon-${name}`, className].filter(Boolean).join(" "),
          ...props,
        },
        h("path", { d }),
      );
    };
  return {
    caret: tabler("chevron-down", "M6 9l6 6l6 -6"),
    check: tabler("check", "M5 12l5 5l10 -10"),
    cross: tabler("x", "M18 6l-12 12M6 6l12 12"),
    spinner: tabler("loader-2", "M12 3a9 9 0 1 0 9 9"),
  };
}

/** Moves the agent-to-host map of earlier builds to this build's keys and
 * drops their stale harness cache. An entry is moved only when this build
 * has no entry for that agent yet, so a newer choice is never replaced.
 * Keys are collected first: removing while indexing would skip entries. */
function migrateStore() {
  const keys = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (typeof key === "string") keys.push(key);
  }
  for (const key of keys) {
    if (LEGACY_HARNESS_CACHE_KEY.test(key)) {
      localStorage.removeItem(key);
      continue;
    }
    const match = EARLIER_STORE_KEY.exec(key);
    if (!match || key.startsWith(STORE_PREFIX)) continue;
    const value = localStorage.getItem(key);
    const target = STORE_PREFIX + match[1];
    if (value && localStorage.getItem(target) === null) localStorage.setItem(target, value);
    localStorage.removeItem(key);
  }
}

// ---- The hosts helper -------------------------------------------------------
/**
 * The client for the plugin's one long-lived host process
 * (scripts/hosts-helper.mjs): it reads and saves hosts.json and carries each
 * runner call. Kept outside apply() so the process, its line buffer and its
 * waiting requests have one owner. The process is started on first use and
 * again after it exits; requests and replies are JSON lines matched by id,
 * because runner calls end in any order.
 */
class HelperClient {
  /** @param {object} host Desktop's `ctx.host`, for `spawn`. */
  constructor(host) {
    this.host = host;
    this.process = undefined;
    this.starting = undefined;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.stopped = false;
  }

  /** Fails every request still waiting, as when the helper exits. */
  failPending(reason) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new HostConfigError(reason, { op: entry.op, id }));
    }
    this.pending.clear();
  }

  /** Settles the waiting request that one reply line answers. */
  onReplyLine(line) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      console.warn("tailscale-host: hosts helper wrote a line that is not JSON", { line: line.slice(0, HELPER_LOG_MAX) });
      return;
    }
    const entry = reply && this.pending.get(reply.id);
    // A progress line comes before its request's reply (a host setup); it
    // restarts the wait, because a setup's steps can each take minutes.
    if (entry && reply.progress !== undefined) {
      entry.arm();
      entry.onProgress?.(reply.progress);
      return;
    }
    if (!entry) {
      // A late reply after its wait ended, or a refusal of a line that
      // could not be read (id null): the request already failed.
      if (reply && reply.ok === false) console.warn("tailscale-host: hosts helper refused a request", { id: reply.id, error: text(reply.error, TEXT_MAX * 3) });
      return;
    }
    this.pending.delete(reply.id);
    clearTimeout(entry.timer);
    if (reply.ok === true) entry.resolve(reply);
    // `refused`: the helper ran the request and it failed, as opposed to a
    // helper that is missing or does not answer.
    else entry.reject(new HostConfigError(text(reply.error, TEXT_MAX * 3) || "The hosts helper refused the request.", { op: entry.op, refused: true }));
  }

  /** Desktop hands stdout over in chunks, not lines. */
  onOutput(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.onReplyLine(line);
    }
    // A reply never gets this long; the helper is broken, so start it again.
    if (this.buffer.length > HELPER_REPLY_MAX) {
      this.buffer = "";
      this.process?.kill();
    }
  }

  /** Watches a started helper: when it exits, the next call starts a new one. */
  adopt(child) {
    this.process = child;
    this.buffer = "";
    const gone = (reason) => {
      if (this.process === child) this.process = undefined;
      this.failPending(reason);
    };
    Promise.resolve(child.exited).then(
      (code) => gone(`The hosts helper stopped (${JSON.stringify(code)}). ${LABELS.helperSilent}`),
      () => gone(LABELS.helperSilent),
    );
    if (this.stopped) child.kill();
    return child;
  }

  /** The running helper, started when there is none. */
  running() {
    if (this.process) return Promise.resolve(this.process);
    if (typeof this.host.spawn !== "function") return Promise.reject(new HostConfigError(LABELS.helperMissing, { op: "spawn" }));
    this.starting ??= this.host
      .spawn(HOSTS_PROCESS, {
        onStdout: (chunk) => this.onOutput(chunk),
        // The helper logs each failure as one JSON line, for the app's log.
        onStderr: (chunk) => console.warn("tailscale-host: hosts helper", String(chunk).slice(0, HELPER_LOG_MAX)),
      })
      .then(
        (child) => this.adopt(child),
        (cause) => {
          console.warn("tailscale-host: hosts helper did not start", { error: errorText(cause) });
          throw new HostConfigError(LABELS.helperSilent, { op: "spawn", cause });
        },
      )
      .finally(() => {
        this.starting = undefined;
      });
    return this.starting;
  }

  /** One request to the helper; resolves with its reply. Waits at most
   * `waitMs` for the reply, or between two progress lines when `onProgress`
   * takes them, so a helper that hangs fails the call instead of the view.
   * The request is never logged: a setup carries the sudo password. */
  async call(request, waitMs, onProgress) {
    const id = this.nextId++;
    const line = `${JSON.stringify({ id, ...request })}\n`;
    if (line.length > HELPER_LINE_MAX) throw new HostConfigError("The request is too large for the hosts helper.", { op: request.op });
    const child = await this.running();
    return new Promise((resolve, reject) => {
      const entry = { op: request.op, resolve, reject, timer: undefined, onProgress };
      entry.arm = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new HostConfigError(LABELS.helperSilent, { op: request.op, waitMs }));
        }, waitMs);
      };
      entry.arm();
      this.pending.set(id, entry);
      Promise.resolve(child.write(line)).catch((cause) => {
        this.pending.delete(id);
        clearTimeout(entry.timer);
        reject(new HostConfigError(LABELS.helperSilent, { op: request.op, cause }));
      });
    });
  }

  /** Ends the helper for good, as when the plugin is unloaded. */
  stop(reason) {
    this.stopped = true;
    this.failPending(reason);
    this.process?.kill();
  }
}

// Async: the type's picker title names the hosts, so the first read of
// hosts.json comes before the type is registered.
export async function apply(ctx) {
  const React = ctx.react;
  const h = React.createElement;
  const icons = makeIcons(h);
  const glyphs = makeGlyphs(h);
  let disposed = false;
  migrateStore();

  const helper = new HelperClient(ctx.host);

  /** One JSON call to a host's runner, through the helper; throws
   * RunnerError on any failure. */
  async function call(host, method, path, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    const started = Date.now();
    let response;
    try {
      response = await helper.call(
        { op: "request", host: host.id, method, path, ...(body === undefined ? {} : { body: JSON.stringify(body) }), timeoutMs },
        timeoutMs + HELPER_GRACE_MS,
      );
    } catch (cause) {
      // A helper that does not run is not a host problem; say which it is.
      const reason = cause?.details?.refused ? `Could not reach ${host.label}. Check Tailscale and buzz-runner.` : errorText(cause);
      throw new RunnerError(reason, {
        op: `${method} ${path}`,
        host: host.id,
        elapsedMs: Date.now() - started,
        cause,
      });
    }
    if (response.status === HTTP_NO_CONTENT) return undefined;
    if (!Number.isInteger(response.status) || typeof response.body !== "string")
      throw new RunnerError(`Invalid reply from ${host.label}.`, { op: `${method} ${path}`, host: host.id });
    let parsed;
    try {
      parsed = response.body ? JSON.parse(response.body) : undefined;
    } catch (cause) {
      throw new RunnerError(`Invalid reply from ${host.label}.`, {
        op: `${method} ${path}`,
        host: host.id,
        status: response.status,
        cause,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      const reason = parsed && typeof parsed.message === "string" ? parsed.message.slice(0, TEXT_MAX) : "";
      throw new RunnerError(
        `${host.label} refused the request (${response.status})${reason ? `: ${reason}` : ""}.`,
        { op: `${method} ${path}`, host: host.id, status: response.status, code: parsed?.error },
      );
    }
    return parsed;
  }

  function remember(pubkey, hostId) {
    localStorage.setItem(STORE_PREFIX + pubkey, hostId);
  }
  function forget(pubkey) {
    localStorage.removeItem(STORE_PREFIX + pubkey);
  }

  /** Whether `host`'s runner keeps the agent `pubkey`. Only a record that
   * names that same pubkey counts: a host that answered for any key would
   * otherwise claim every agent. A 404 is no; other failures are raised. */
  async function holds(host, pubkey) {
    try {
      const record = await call(host, "GET", `/agents/${pubkey}`);
      return Boolean(record) && record.pubkey === pubkey;
    } catch (error) {
      if (error?.details?.status === HTTP_NOT_FOUND) return false;
      throw error;
    }
  }

  /** The host that holds this agent: the saved one, else the first host whose
   * runner keeps it (covers a cleared WebView store or another device). */
  async function locate(pubkey) {
    if (!HEX64.test(pubkey)) throw new RunnerError("Invalid agent pubkey.", { op: "locate" });
    // Without a host list no host can be asked, and "no host knows it" would
    // let a delete drop an agent that still runs.
    if (!HOSTS.length) throw new RunnerError(hostsFile.error || LABELS.noHosts, { op: "locate" });
    const saved = localStorage.getItem(STORE_PREFIX + pubkey);
    if (saved && HOSTS.some((entry) => entry.id === saved)) return hostById(saved);
    for (const host of HOSTS) {
      if (!(await holds(host, pubkey))) continue;
      remember(pubkey, host.id);
      return host;
    }
    return undefined;
  }

  /** Refuses a new agent's pubkey that another host holds. The plugin routes
   * an agent to the host that made it, so a host that answered with another
   * host's agent would take that agent's settings, profile and delete calls.
   * A runner makes each key at random, so an honest one never collides. A
   * host that cannot be asked blocks the create: the check fails closed. */
  async function requireNewKey(host, pubkey) {
    const saved = localStorage.getItem(STORE_PREFIX + pubkey);
    const taken = (other) =>
      new RunnerError(`${host.label} returned an agent that ${other.label} holds.`, {
        op: "provision",
        host: host.id,
        holder: other.id,
      });
    const holder = saved && saved !== host.id ? HOSTS.find((entry) => entry.id === saved) : undefined;
    if (holder) throw taken(holder);
    for (const other of HOSTS) {
      if (other.id === host.id) continue;
      let held;
      try {
        held = await holds(other, pubkey);
      } catch (cause) {
        throw new RunnerError(`Could not check the new agent with ${other.label}. Try again when it answers.`, {
          op: "provision",
          host: host.id,
          other: other.id,
          cause,
        });
      }
      if (held) throw taken(other);
    }
  }

  // ---- Host status and model stores ---------------------------------------
  // Each host's harness list and the model lists asked for so far. Views read
  // them with useSyncExternalStore; snapshots are replaced, never mutated, so
  // React sees each change.

  const listeners = new Set();
  // A host has no entry until its first answer, which reads as checking.
  let hosts = Object.freeze({});
  const statusOf = (id) => hosts[id] || CHECKING;
  let models = Object.freeze({});
  // Keys with a fetch in flight: a stale list stays "ok" while it refreshes,
  // so its state alone cannot stop a second picker from asking again.
  const modelsInFlight = new Set();
  const emit = () => {
    for (const listener of [...listeners]) listener();
  };
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  const useStore = (read) => React.useSyncExternalStore(subscribe, read);

  let refreshing;
  let refreshAgain;
  /** Reads hosts.json again, then asks every host in it for its harnesses,
   * one round at a time. The read picks up an edit by hand. A call while a
   * round runs gets one more round after it: the running round may have read
   * hosts.json before the change that the caller (Check again, a save, a
   * setup) wants seen. */
  function refresh() {
    if (refreshing) {
      refreshAgain ??= refreshing.catch(() => undefined).then(() => {
        refreshAgain = undefined;
        return refresh();
      });
      return refreshAgain;
    }
    refreshing = readHostsFile().then(() =>
      Promise.all(
      HOSTS.map(async (host) => {
        try {
          const list = parseHarnesses(await call(host, "GET", "/harnesses", undefined, HARNESS_TIMEOUT_MS));
          return [host.id, Object.freeze({ state: "ok", harnesses: list })];
        } catch (error) {
          return [host.id, Object.freeze({ state: "down", error: errorText(error) })];
        }
      }),
    ))
      .then((entries) => {
        if (disposed) return;
        // Only hosts still in the list keep a status.
        hosts = Object.freeze(Object.fromEntries(HOSTS.map((host) => [host.id, hosts[host.id]]).filter(([, status]) => status).concat(entries)));
        emit();
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }

  const modelKey = (hostId, harness) => `${hostId}/${harness}`;
  /** Whether a fetched list still stands: an empty one never does (the
   * owner may sign in on the host at any time), a full one for the TTL. */
  const modelsFresh = (entry) => entry.models.length > 0 && Date.now() - entry.at < MODELS_TTL_MS;
  /** The runner's model list for a harness on a host, fetched again when a
   * picker mounts after a sign-in may have changed it, or when retried. */
  function loadModels(hostId, harness, force = false) {
    const key = modelKey(hostId, harness);
    const known = models[key];
    if (modelsInFlight.has(key) || (known && known.state === "ok" && !force && modelsFresh(known))) return;
    modelsInFlight.add(key);
    // A stale list stays shown while the new one loads, so a picker does not
    // flash to "loading" on every open.
    if (!known || known.state !== "ok") {
      models = Object.freeze({ ...models, [key]: Object.freeze({ state: "loading" }) });
      emit();
    }
    call(hostById(hostId), "GET", `/harnesses/${harness}/models`, undefined, HARNESS_TIMEOUT_MS).then(
      (reply) => {
        if (disposed) return;
        models = Object.freeze({ ...models, [key]: Object.freeze({ state: "ok", at: Date.now(), ...parseModels(reply) }) });
        emit();
      },
      (error) => {
        if (disposed) return;
        models = Object.freeze({ ...models, [key]: Object.freeze({ state: "error", error: errorText(error) }) });
        emit();
      },
    ).finally(() => modelsInFlight.delete(key));
  }
  /** `enabled` false skips the fetch: a harness that is not ready on the host
   * has no model list to show, and asking would only fail. */
  function useModels(hostId, harness, enabled = true) {
    const entry = useStore(() => models[modelKey(hostId, harness)]);
    React.useEffect(() => {
      if (enabled) loadModels(hostId, harness);
    }, [hostId, harness, enabled]);
    return entry || { state: "loading" };
  }

  /** One host's view of one harness. */
  function harnessOn(hostId, harness) {
    const status = hosts[hostId];
    return status && status.state === "ok" ? status.harnesses.find((item) => item.id === harness) : undefined;
  }
  /** A harness's title as the host names it, for summaries and notices. */
  function harnessTitle(hostId, harness) {
    return harnessOn(hostId, harness)?.title || harness;
  }

  // A stable snapshot object, as useSyncExternalStore requires.
  let snapshot;
  /** The type is ready when some host answers with a ready harness. */
  function providerSnapshot() {
    const statuses = HOSTS.map((host) => statusOf(host.id));
    let next;
    if (!statuses.length) next = { readiness: "attention", attentionLabel: "No Tailscale host" };
    else if (statuses.some((status) => status.state === "ok" && status.harnesses.some((item) => item.ready))) next = { readiness: "ready" };
    else if (statuses.some((status) => status.state === "checking")) next = { readiness: "checking" };
    else if (statuses.every((status) => status.state === "down")) next = { readiness: "attention", attentionLabel: "Host unreachable" };
    else next = { readiness: "attention", attentionLabel: "No harness ready on host" };
    if (snapshot && snapshot.readiness === next.readiness && snapshot.attentionLabel === next.attentionLabel) return snapshot;
    snapshot = Object.freeze(next);
    return snapshot;
  }

  // ---- hosts.json, through the hosts helper ---------------------------------
  // The Settings page shows and edits hosts.json, the one host list, through
  // the helper. A read or save also replaces HOSTS, which New agent and every
  // runner call use, so a change is in use at once.

  // The file as last read or saved. `busy`: one save at a time, so two saves
  // never race on the file.
  let hostsFile = Object.freeze({ state: "loading", error: undefined, busy: false });
  const setHostsFile = (change) => {
    hostsFile = Object.freeze({ ...hostsFile, ...change });
    emit();
  };

  /** A host list as the helper reports it. The helper is local, but its
   * answer is checked as any input, so a broken file cannot break the page. */
  function parseFileHosts(list) {
    if (!Array.isArray(list) || !list.length || list.length > HOSTS_MAX)
      throw new HostConfigError(`The hosts helper returned no valid list (1-${HOSTS_MAX} hosts).`, { field: "file" });
    return Object.freeze(
      list.map((entry) => {
        if (!entry || typeof entry.id !== "string" || !HOST_ID.test(entry.id)) throw new HostConfigError("The hosts helper returned an invalid host id.", { field: "file" });
        return Object.freeze({ id: entry.id, label: checkHostLabel(entry.label), origin: checkHostOrigin(entry.origin) });
      }),
    );
  }

  /** The new list for every view; a list equal to the one in use keeps its
   * object, so views do not draw again for nothing. */
  function setHostList(list) {
    if (!sameHosts(list, HOSTS)) HOSTS = list;
  }

  /** Runs one file request and keeps its result. A failed read keeps the
   * hosts in use and shows the reason on the page; a failed save is thrown
   * to the form or button that asked, and the list stays as it was. */
  async function fileCall(request) {
    if (request.op === "save") {
      if (hostsFile.busy) throw new HostConfigError("A save is still running. Try again in a moment.", { op: request.op });
      setHostsFile({ busy: true });
    }
    try {
      const reply = await helper.call(request, HELPER_FILE_TIMEOUT_MS);
      const list = parseFileHosts(reply.hosts);
      if (disposed) return list;
      setHostList(list);
      setHostsFile({ state: "ready", error: undefined });
      return list;
    } catch (error) {
      if (!disposed && request.op === "read") setHostsFile({ state: "error", error: errorText(error) });
      throw error;
    } finally {
      if (!disposed && request.op === "save") setHostsFile({ busy: false });
    }
  }

  const readHostsFile = () => fileCall({ op: "read" }).catch(() => undefined);
  const saveHostsFile = (list) => fileCall({ op: "save", hosts: list.map(({ id, label, origin }) => ({ id, label, origin })) });

  const sameHosts = (a, b) => JSON.stringify(a.map(({ id, label, origin }) => [id, label, origin])) === JSON.stringify(b.map(({ id, label, origin }) => [id, label, origin]));

  /** The file's list, for a change: only after a good read, so a save can
   * never write over hosts the page did not see. */
  function fileHosts() {
    if (hostsFile.state !== "ready") throw new HostConfigError("hosts.json is not loaded. Select Check again.", { field: "file" });
    return HOSTS;
  }

  /** The host id of each agent this device has placed. */
  function placedHostIds() {
    const ids = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (typeof key === "string" && key.startsWith(STORE_PREFIX)) ids.push(localStorage.getItem(key));
    }
    return ids;
  }
  /** How many agents this device has placed on a host. */
  const agentsOn = (hostId) => placedHostIds().filter((id) => id === hostId).length;

  // ---- Host setup -----------------------------------------------------------
  // Settings > Tailscale hosts > Add a host: the one setup that may run, which
  // installs or aligns buzz-runner on the machine and lists it. Kept here, not
  // in the view, so a setup's progress is still shown when the owner opens the
  // page again: the helper runs the setup on, whatever page is open.

  // Desktop's community reader, if any (injected at the end of apply): it
  // names the owner and the relay a new host's config gets.
  let communityReader;
  const SETUP_IDLE = Object.freeze({ state: "idle", label: "", steps: Object.freeze({}), result: undefined, error: undefined });
  let setupRun = SETUP_IDLE;
  // The add form's values while a setup runs or after it failed, so that the
  // owner corrects one field and not all. Never the password.
  let setupForm = null;
  // The SSH login last used on each host, so that the next sign-in there asks
  // only for the password. In memory only; a login name is not a secret.
  const sshLogins = new Map();
  const setSetupRun = (change) => {
    setupRun = Object.freeze({ ...setupRun, ...change });
    emit();
  };

  /** One progress event as the page keeps it, or undefined for one it does
   * not know. A link is kept only when it is a Tailscale SSH check. */
  function parseProgress(event) {
    if (!event || !SETUP_STEPS.some(([key]) => key === event.step) || !SETUP_STATES.includes(event.state)) return undefined;
    const link = typeof event.link === "string" && CHECK_LINK.test(event.link) ? event.link : undefined;
    return [event.step, Object.freeze({ state: event.state, detail: text(event.detail, DETAIL_MAX), link })];
  }

  /** What a finished setup reports: the host it added and the steps left
   * to the owner, each with a command to copy. The host id lets the result
   * open that host; an id that is not valid gives no button. */
  function parseSetupResult(reply) {
    const manual = Array.isArray(reply.manual) ? reply.manual.slice(0, MANUAL_MAX) : [];
    const hostId = typeof reply.host?.id === "string" && HOST_ID.test(reply.host.id) ? reply.host.id : undefined;
    return Object.freeze({
      hostId,
      label: text(reply.host?.label, LABEL_MAX) || "",
      added: reply.added === true,
      version: text(reply.version, TITLE_MAX),
      manual: Object.freeze(
        manual
          .filter((entry) => entry && typeof entry.text === "string")
          .map((entry) =>
            Object.freeze({ text: text(entry.text, DETAIL_MAX), command: text(entry.command, COMMAND_MAX) }),
          ),
      ),
    });
  }

  /** The owner key and relay the runner's config gets, from the identity and
   * community open in Desktop; the page shows them for the owner to check. */
  function communityDefaults() {
    let snapshot;
    try {
      snapshot = communityReader?.snapshot?.();
    } catch {
      snapshot = undefined;
    }
    const ownerPubkey = typeof snapshot?.viewer === "string" && HEX64.test(snapshot.viewer) ? snapshot.viewer : "";
    let relay = "";
    try {
      const url = new URL(String(snapshot?.selected ?? ""));
      if (url.protocol === "wss:" || url.protocol === "https:") relay = `wss://${url.host}`;
    } catch {
      relay = "";
    }
    return { ownerPubkey, relay };
  }

  /** Runs one setup through the helper. The password goes into the request
   * and nowhere else: not into the store, a log or an error. */
  async function startSetup({ address, sshUser, sudoPassword, ownerPubkey, relay, label }) {
    if (setupRun.state === "running") throw new HostConfigError("A setup is already running.", { op: "setup" });
    setSetupRun({ ...SETUP_IDLE, state: "running", label });
    // Ids that agents on this device still name stay taken, so a new host
    // never takes over the agents of a host removed by hand.
    const reservedIds = [...new Set(placedHostIds().filter((id) => typeof id === "string" && HOST_ID.test(id)))];
    const setup = { address, sshUser, sudoPassword, ownerPubkey, relay, reservedIds, label };
    try {
      const reply = await helper.call({ op: "setup", setup }, SETUP_IDLE_MS, (event) => {
        const entry = parseProgress(event);
        if (entry && !disposed) setSetupRun({ steps: Object.freeze({ ...setupRun.steps, [entry[0]]: entry[1] }) });
      });
      if (disposed) return;
      const result = parseSetupResult(reply);
      // The sign-in starts with the login that the setup used: the setup
      // gave that login the sign-in rule, so sudo asks it no password.
      if (result.hostId) sshLogins.set(result.hostId, sshUser);
      setupForm = null;
      setSetupRun({ state: "done", result });
      void refresh();
    } catch (error) {
      if (!disposed) setSetupRun({ state: "failed", error: errorText(error) });
    }
  }

  /** Back to the form, once a setup has ended. */
  function resetSetup() {
    if (setupRun.state !== "running") setSetupRun(SETUP_IDLE);
  }

  // ---- Harness sign-in -------------------------------------------------------
  // The Hosts page > a host > Sign in: the one sign-in that may run, a
  // terminal on the machine that runs buzz-login as the harness user
  // (scripts/host-signin.mjs). Kept here, as the setup is, so a sign-in that
  // waits for the owner's browser goes on when the page closes and opens.
  const SIGNIN_IDLE = Object.freeze({ state: "idle", hostId: "", harness: null, output: "", link: undefined, error: undefined, code: undefined });
  let signinRun = SIGNIN_IDLE;
  const setSigninRun = (change) => {
    signinRun = Object.freeze({ ...signinRun, ...change });
    emit();
  };

  /** Runs one sign-in through the helper. The password goes into the
   * request and nowhere else: not into the store, a log or an error. */
  async function startSignIn({ hostId, harness, sshUser, sudoPassword, command }) {
    if (signinRun.state === "running") throw new HostConfigError("A sign-in is already running.", { op: "signin" });
    setSigninRun({ ...SIGNIN_IDLE, state: "running", hostId, harness });
    try {
      const reply = await helper.call({ op: "signin", signin: { host: hostId, sshUser, sudoPassword, command } }, SIGNIN_IDLE_MS, (event) => {
        if (disposed || !event) return;
        const link = typeof event.link === "string" && CHECK_LINK.test(event.link) ? event.link : signinRun.link;
        setSigninRun({ output: text(event.output, SIGNIN_OUTPUT_MAX) ?? signinRun.output, link });
      });
      if (disposed) return;
      setSigninRun({ state: "done", code: Number.isInteger(reply.code) ? reply.code : undefined, output: text(reply.output, SIGNIN_OUTPUT_MAX) ?? signinRun.output });
      // A sign-in changes what each harness reports.
      void refresh();
    } catch (error) {
      if (!disposed) setSigninRun({ state: "failed", error: errorText(error) });
    }
  }

  /** One typed line, or the cancel, to the running sign-in. Neither is
   * kept: a line may be a key. */
  const sendSignInInput = (line) => helper.call({ op: "signin-input", text: line }, REQUEST_TIMEOUT_MS);
  const cancelSignIn = () => helper.call({ op: "signin-cancel" }, REQUEST_TIMEOUT_MS);

  /** Forgets a sign-in that has ended, so that the next one starts clean. */
  function resetSignIn() {
    if (signinRun.state !== "running") setSigninRun(SIGNIN_IDLE);
  }

  function fileHost(list, id) {
    const host = list.find((entry) => entry.id === id);
    if (!host) throw new HostConfigError("This host is no longer in hosts.json. Select Check again.", { field: "id", id });
    return host;
  }

  /** The add form's values as a setup takes them. A host already listed for
   * the same machine (with or without the runner's port) is the one the
   * setup aligns, so only its own name may repeat. */
  function checkNewHost({ label, origin, sshUser, ownerPubkey, relay }) {
    const list = fileHosts();
    const clean = { label: checkHostLabel(label), address: checkHostOrigin(origin) };
    const machine = new URL(clean.address).hostname;
    const same = list.find((entry) => new URL(entry.origin).hostname === machine);
    if (!same && list.length >= HOSTS_MAX) throw new HostConfigError(`hosts.json can hold at most ${HOSTS_MAX} hosts.`, { field: "label" });
    const named = list.find((entry) => entry !== same && entry.label.toLowerCase() === clean.label.toLowerCase());
    if (named) throw new HostConfigError(`A host is already named ${named.label}.`, { field: "label" });
    if (!HEX64.test(ownerPubkey.trim())) throw new HostConfigError("The owner key must be 64 lowercase hex characters.", { field: "ownerPubkey" });
    if (!relay.trim().startsWith("wss://")) throw new HostConfigError(`The relay must be a wss:// address, for example ${RELAY_EXAMPLE}.`, { field: "relay" });
    return { ...clean, sshUser: sshUser.trim(), ownerPubkey: ownerPubkey.trim(), relay: relay.trim() };
  }

  /** Keeps the id, which each agent's config names, so agents stay on the
   * host when its name or address changes. */
  async function updateHost(id, { label, origin }) {
    const list = fileHosts();
    fileHost(list, id);
    const host = Object.freeze({ id, label: checkHostLabel(label), origin: checkHostOrigin(origin) });
    checkUnique(host, list.filter((entry) => entry.id !== id));
    await saveHostsFile(list.map((entry) => (entry.id === id ? host : entry)));
    return host;
  }

  /** Refuses while an agent of this device runs on the host: its settings,
   * profile and delete calls would have nowhere to go. The last host stays,
   * because the helper refuses an empty hosts.json. */
  async function removeHost(id) {
    const list = fileHosts();
    const host = fileHost(list, id);
    if (list.length === 1) throw new HostConfigError("hosts.json must keep at least one host. Add another host first.", { field: "id", id });
    const count = agentsOn(id);
    if (count) throw new HostConfigError(`${count} agent${count === 1 ? " runs" : "s run"} on ${host.label}. Delete them first.`, { field: "id", id });
    await saveHostsFile(list.filter((entry) => entry.id !== id));
  }

  // ---- Desktop markup -------------------------------------------------------
  // A plugin cannot import Desktop's design system, but Desktop's CSS is
  // global in the WebView. These views render the elements, class names and
  // data attributes of Desktop's own components (shared/design-system/ui:
  // Button, Select, Menu, ChoiceRow, PreferenceRow, SettingsGroup, Field,
  // Input, Textarea; features/agents: ModelPicker, CreateModelChoices,
  // AgentInstructions, AgentSaveButton), so a hosted agent looks and acts as
  // Desktop's own agents. Keep them in step with those files.

  function Button({ variant = "subtle", size = "md", shape = "capsule", type = "button", loading = false, disabled, children, ...props }) {
    const off = Boolean(disabled || loading);
    return h(
      "button",
      {
        ...props,
        type,
        disabled: off,
        "aria-busy": loading || undefined,
        "data-buzz-ui": "",
        className: "buzz-button",
        "data-variant": variant === "primary" ? "prominent" : variant,
        "data-size": size,
        "data-button-shape": shape,
        "data-loading": loading || undefined,
        "data-disabled": off ? "" : undefined,
      },
      h("span", { className: "buzz-button-label" }, children),
    );
  }

  function PreferenceRow({ title, subtitle, trailing }) {
    const id = React.useId();
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-preference-row", "data-variant": "default" },
      h(
        "div",
        { className: "buzz-preference-row-content" },
        h("div", { id: `${id}-title`, className: "buzz-preference-row-label" }, title),
        subtitle ? h("span", { id: `${id}-subtitle`, className: "buzz-preference-row-description" }, subtitle) : null,
      ),
      trailing == null ? null : h("div", { className: "buzz-preference-row-trailing" }, trailing),
    );
  }

  function SettingsGroup({ children }) {
    return h("div", { "data-buzz-ui": "", className: "buzz-settings-group", "data-layout": "rows" }, children);
  }

  function ChoiceRow({ label, description, leading }) {
    return h(
      "span",
      { "data-buzz-ui": "", className: "buzz-choice-row" },
      leading ? h("span", { className: "buzz-choice-row-leading", "aria-hidden": "true" }, leading) : null,
      h(
        "span",
        { className: "buzz-choice-row-content" },
        h("span", { className: "buzz-choice-row-label" }, label),
        description ? " " : null,
        description ? h("span", { className: "buzz-choice-row-description text-body-sm" }, description) : null,
      ),
    );
  }

  /** `nativeLabel` false names a control that is not a form input (a select
   * trigger), as Desktop's Field does. */
  function Field({ label, description, optional, controlId, nativeLabel = true, children }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-field" },
      h(
        nativeLabel ? "label" : "span",
        { className: "buzz-field-label", ...(nativeLabel && controlId ? { htmlFor: controlId } : {}) },
        label,
        optional ? " " : null,
        optional ? h("span", { className: "buzz-field-optional" }, LABELS.optional) : null,
      ),
      children,
      description ? h("p", { className: "buzz-field-description" }, description) : null,
    );
  }

  function Input(props) {
    return h("input", { ...props, "data-buzz-ui": "", "data-size": "md", className: "buzz-input" });
  }

  function AgentInstructions({ value, disabled, onChange, creation = false }) {
    const id = React.useId();
    return h(
      Field,
      { label: LABELS.instructions, optional: creation, controlId: id },
      h("textarea", {
        id,
        rows: creation ? INSTRUCTIONS_ROWS_CREATE : INSTRUCTIONS_ROWS,
        maxLength: INSTRUCTIONS_MAX,
        value,
        disabled,
        placeholder: INSTRUCTIONS_EXAMPLE,
        onChange: (event) => onChange(event.target.value),
        "data-buzz-ui": "",
        className: "buzz-textarea",
        "data-variant": "text",
        "data-surface": "inset",
        "data-appearance": "outlined",
      }),
    );
  }

  /** Desktop's anchored popup (Base UI Positioner): fixed beside its trigger,
   * flipped above when there is more room there, and in the top layer when
   * the WebView has the Popover API, so a dialog's clipping cannot cut it.
   * It stays inside the caller's DOM, so the dialog's focus trap and outside
   * press checks treat it as part of the dialog. */
  function Floating({ anchor, align, positionerClass, popup, onDismiss, children }) {
    const positioner = React.useRef(null);
    const dismiss = React.useRef(onDismiss);
    dismiss.current = onDismiss;
    const [place, setPlace] = React.useState(null);
    const [starting, setStarting] = React.useState(true);
    React.useLayoutEffect(() => {
      const node = positioner.current;
      if (typeof node.showPopover === "function" && !node.matches(":popover-open")) node.showPopover();
      const update = () => {
        const box = anchor.current && anchor.current.getBoundingClientRect();
        if (!box) return;
        const height = node.firstElementChild ? node.firstElementChild.scrollHeight : 0;
        const below = window.innerHeight - box.bottom - POPUP_OFFSET_PX - POPUP_PADDING_PX;
        const above = box.top - POPUP_OFFSET_PX - POPUP_PADDING_PX;
        const side = height > below && above > below ? "top" : "bottom";
        setPlace({
          side,
          top: side === "bottom" ? box.bottom + POPUP_OFFSET_PX : undefined,
          bottom: side === "top" ? window.innerHeight - box.top + POPUP_OFFSET_PX : undefined,
          left: align === "end" ? undefined : box.left,
          right: align === "end" ? window.innerWidth - box.right : undefined,
          anchorWidth: box.width,
          availableHeight: Math.max(0, side === "top" ? above : below),
          availableWidth: Math.max(0, window.innerWidth - 2 * POPUP_PADDING_PX),
        });
      };
      update();
      const outside = (event) => {
        if (!node.contains(event.target) && !(anchor.current && anchor.current.contains(event.target))) dismiss.current();
      };
      window.addEventListener("resize", update);
      window.addEventListener("scroll", update, true);
      document.addEventListener("mousedown", outside, true);
      return () => {
        window.removeEventListener("resize", update);
        window.removeEventListener("scroll", update, true);
        document.removeEventListener("mousedown", outside, true);
        if (typeof node.hidePopover === "function" && node.matches(":popover-open")) node.hidePopover();
      };
    }, []);
    // Desktop's entry motion keys off data-starting-style for one frame.
    React.useEffect(() => {
      if (typeof window.requestAnimationFrame !== "function") {
        setStarting(false);
        return undefined;
      }
      const frame = window.requestAnimationFrame(() => setStarting(false));
      return () => window.cancelAnimationFrame(frame);
    }, []);
    const px = (value) => (value === undefined ? "auto" : `${value}px`);
    const style = place
      ? {
          position: "fixed",
          top: px(place.top),
          bottom: px(place.bottom),
          left: px(place.left),
          right: px(place.right),
          margin: 0,
          padding: 0,
          border: 0,
          background: "transparent",
          overflow: "visible",
          "--anchor-width": `${place.anchorWidth}px`,
          "--available-height": `${place.availableHeight}px`,
          "--available-width": `${place.availableWidth}px`,
          "--transform-origin": place.side === "top" ? "center bottom" : "center top",
        }
      : { position: "fixed", visibility: "hidden", margin: 0, padding: 0, border: 0, background: "transparent" };
    return h(
      "div",
      { ref: positioner, className: positionerClass, popover: "manual", style },
      h(
        "div",
        {
          ...popup,
          "data-side": place ? place.side : "bottom",
          "data-align": align,
          "data-open": "",
          "data-starting-style": starting ? "" : undefined,
        },
        children,
      ),
    );
  }

  /** Open state, highlight and keys of one Desktop list popup (Select or
   * Menu), as Base UI handles them: arrows, Home and End move, Enter and
   * Space choose, Escape closes back to the trigger, Tab closes. */
  function useListPopup({ count, isDisabled, selectedIndex, disabled, onChoose }) {
    const trigger = React.useRef(null);
    const popup = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    const [active, setActive] = React.useState(-1);
    const enabled = [];
    for (let index = 0; index < count; index += 1) if (!isDisabled(index)) enabled.push(index);
    const show = () => {
      if (disabled) return;
      setActive(enabled.includes(selectedIndex) ? selectedIndex : enabled[0] ?? -1);
      setOpen(true);
    };
    const close = (refocus) => {
      setOpen(false);
      if (refocus && trigger.current) trigger.current.focus();
    };
    const choose = (index) => {
      if (index < 0 || isDisabled(index)) return;
      close(true);
      onChoose(index);
    };
    React.useEffect(() => {
      if (open && popup.current) popup.current.focus();
    }, [open]);
    const step = (offset) => {
      const at = enabled.indexOf(active);
      const next = at < 0 ? 0 : Math.min(enabled.length - 1, Math.max(0, at + offset));
      if (enabled.length) setActive(enabled[next]);
    };
    const onPopupKeyDown = (event) => {
      const keys = {
        ArrowDown: () => step(1),
        ArrowUp: () => step(-1),
        Home: () => enabled.length && setActive(enabled[0]),
        End: () => enabled.length && setActive(enabled[enabled.length - 1]),
        Enter: () => choose(active),
        " ": () => choose(active),
        Escape: () => close(true),
      };
      if (event.key === "Tab") {
        close(false);
        return;
      }
      const run = keys[event.key];
      if (!run) return;
      // Escape must close only this popup, never the dialog around it.
      event.preventDefault();
      event.stopPropagation();
      run();
    };
    const onTriggerKeyDown = (event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      show();
    };
    return { trigger, popup, open, active, setActive, show, close, choose, onPopupKeyDown, onTriggerKeyDown };
  }

  /** Desktop's Select. Options are `{value, label, description?, leading?,
   * disabled?}`. `preference` is the settings row, `compact` the dialog
   * pill, `field` the labelled form field. */
  function Select({ label, value, options, onValueChange, variant = "compact", disabled = false, description, valueLabel, valueSuffix, valueTitle, leading, align = "start", placeholder }) {
    const base = variant === "preference" ? "compact" : variant;
    const id = React.useId();
    const selectedIndex = options.findIndex((option) => option.value === value);
    const selected = options[selectedIndex];
    const list = useListPopup({
      count: options.length,
      isDisabled: (index) => Boolean(options[index].disabled),
      selectedIndex,
      disabled,
      onChoose: (index) => {
        if (options[index].value !== value) onValueChange(options[index].value);
      },
    });
    const empty = !selected && valueLabel === undefined;
    const valueText = h(
      "span",
      {
        className: base === "inline" ? undefined : "buzz-select-value",
        title: base === "compact" ? valueTitle ?? (selected && selected.label) : undefined,
        "data-placeholder": empty ? "" : undefined,
      },
      valueLabel ?? (selected ? selected.label : placeholder ?? ""),
    );
    const valueContent = h(
      "span",
      { className: "buzz-select-value-content" },
      leading ? h("span", { className: "buzz-select-leading", "aria-hidden": "true" }, leading) : null,
      base === "field"
        ? valueText
        : h(
            "span",
            { className: "buzz-select-value-text" },
            valueText,
            base === "compact" && valueSuffix ? h("span", { className: "buzz-select-value-suffix" }, valueSuffix) : null,
          ),
    );
    const triggerProps = {
      ref: list.trigger,
      id: `${id}-trigger`,
      role: "combobox",
      "aria-haspopup": "listbox",
      "aria-expanded": list.open,
      "aria-controls": list.open ? `${id}-list` : undefined,
      "data-popup-open": list.open ? "" : undefined,
      disabled,
      onClick: () => (list.open ? list.close(false) : list.show()),
      onKeyDown: list.onTriggerKeyDown,
    };
    const trigger =
      base === "field"
        ? h(
            "button",
            { ...triggerProps, type: "button", "aria-labelledby": `${id}-label`, "data-buzz-ui": "", className: "buzz-input buzz-select-trigger" },
            valueContent,
            h("span", { "aria-hidden": "true" }, h(glyphs.caret, { size: FIELD_CHEVRON_SIZE, className: "buzz-dropdown-chevron", "aria-hidden": "true" })),
          )
        : h(
            Button,
            {
              ...triggerProps,
              "aria-label": label,
              shape: variant === "preference" ? "control" : "capsule",
              variant: base === "compact" ? "outline" : "ghost",
              size: base === "compact" ? "sm" : "md",
            },
            valueContent,
            h("span", { "aria-hidden": "true" }, h(glyphs.caret, { size: CHEVRON_SIZE, className: "buzz-dropdown-chevron", "aria-hidden": "true" })),
          );
    const popup = list.open
      ? h(
          Floating,
          {
            anchor: list.trigger,
            align,
            positionerClass: "buzz-select-positioner",
            onDismiss: () => list.close(false),
            popup: {
              ref: list.popup,
              id: `${id}-list`,
              role: "listbox",
              tabIndex: -1,
              "aria-label": label,
              "aria-activedescendant": list.active >= 0 ? `${id}-option-${list.active}` : undefined,
              "data-buzz-ui": "",
              className: "buzz-select-popup text-body",
              "data-variant": base,
              onKeyDown: list.onPopupKeyDown,
            },
          },
          h(
            "div",
            { role: "presentation" },
            h(
              "div",
              { role: "group" },
              options.map((option, index) => {
                const chosen = option.value === value;
                return h(
                  "div",
                  {
                    key: option.value,
                    id: `${id}-option-${index}`,
                    role: "option",
                    "aria-selected": chosen,
                    "aria-disabled": option.disabled || undefined,
                    "aria-label": option.label,
                    "aria-describedby": option.description ? `${id}-description-${index}` : undefined,
                    className: "buzz-select-option",
                    "data-selected": chosen ? "" : undefined,
                    "data-highlighted": index === list.active ? "" : undefined,
                    "data-disabled": option.disabled ? "" : undefined,
                    onMouseEnter: () => !option.disabled && list.setActive(index),
                    onClick: () => list.choose(index),
                  },
                  h(
                    "span",
                    { className: "buzz-select-option-main" },
                    option.leading ? h("span", { className: "buzz-select-leading", "aria-hidden": "true" }, option.leading) : null,
                    h(
                      "span",
                      { className: "buzz-select-option-content" },
                      h("div", null, option.label),
                      option.description
                        ? h("span", { id: `${id}-description-${index}`, className: "buzz-select-option-description text-body-sm text-subtle" }, option.description)
                        : null,
                    ),
                  ),
                  // Desktop keeps the check's space in compact lists so labels line up.
                  base === "compact" || chosen
                    ? h(
                        "span",
                        { className: "buzz-select-indicator", "data-selected": chosen ? "" : undefined, "aria-hidden": "true" },
                        h(glyphs.check, { size: CHECK_SIZE, "aria-hidden": "true" }),
                      )
                    : null,
                );
              }),
            ),
          ),
        )
      : null;
    const control = h(
      "div",
      { "data-buzz-ui": "", className: "buzz-select text-body", "data-variant": base, "data-appearance": "outlined" },
      base === "field" ? null : h("div", { id: `${id}-label`, className: base === "compact" ? "sr-only" : "text-primary" }, label),
      trigger,
      popup,
    );
    if (variant === "preference") return h(PreferenceRow, { title: label, subtitle: description, trailing: control });
    if (variant === "field")
      return h(Field, { label: h("span", { id: `${id}-label` }, label), description, nativeLabel: false }, control);
    return control;
  }

  // ---- Hosted rows ----------------------------------------------------------

  /** A harness mark for the host's harness id, at Desktop's size. */
  const harnessIcon = (id) => (icons[id] ? h(icons[id], { size: HARNESS_ICON_SIZE, "aria-hidden": "true" }) : null);

  /** Desktop's model-vendor logo for a model, when this plugin has the mark. */
  function modelLogo(text) {
    const name = text.toLowerCase();
    const Icon = CLAUDE_MODEL.test(name) ? icons["claude-code"] : OPENAI_MODEL.test(name) ? icons.codex : null;
    return Icon ? h(Icon, { size: HARNESS_ICON_SIZE, "aria-hidden": "true" }) : null;
  }

  /** The host's harnesses in its (Desktop's) order. One that is not ready
   * is listed but cannot be picked, with the host's reason; an agent on a
   * harness the host no longer lists keeps showing it. */
  function harnessChoices(hostId, value) {
    const status = hosts[hostId];
    const list = status.state === "ok" ? status.harnesses : [];
    const items = list.map((item) => ({
      id: item.id,
      title: item.title,
      disabled: !item.ready && item.id !== value,
      description: item.ready ? undefined : item.message || "Not ready on this host",
    }));
    if (!list.some((item) => item.id === value))
      items.unshift({ id: value, title: value, disabled: false, description: status.state === "ok" ? "Not offered on this host" : undefined });
    return items;
  }

  /** The New agent dialog's harness pill: Desktop's compact Select with the
   * harness marks, as its Harness row shows agent types. */
  function HarnessSelect({ hostId, value, disabled, onChange }) {
    const status = useStore(() => hosts[hostId]);
    if (status.state === "checking")
      return h("span", { role: "status", className: "text-body-sm text-secondary" }, "Checking harnesses…");
    const items = harnessChoices(hostId, value);
    return h(Select, {
      label: LABELS.harness,
      variant: "compact",
      align: "end",
      value,
      leading: harnessIcon(value),
      disabled: disabled || items.length < 2,
      options: items.map((item) => ({ value: item.id, label: item.title, description: item.description, disabled: item.disabled, leading: harnessIcon(item.id) })),
      onValueChange: onChange,
    });
  }

  /** The profile Settings harness row: Desktop's harness menu (the
   * AgentSettingsHost TypeField pill), listing the host's harnesses. */
  function HarnessMenu({ hostId, value, disabled, onChange }) {
    const status = useStore(() => hosts[hostId]);
    const items = harnessChoices(hostId, value);
    const selectedIndex = items.findIndex((item) => item.id === value);
    const title = (items[selectedIndex] && items[selectedIndex].title) || value;
    const id = React.useId();
    const list = useListPopup({
      count: items.length,
      isDisabled: (index) => items[index].disabled,
      selectedIndex,
      disabled,
      onChoose: (index) => {
        if (items[index].id !== value) onChange(items[index].id);
      },
    });
    const current = h("span", { className: "flex min-w-0 items-center gap-2" }, harnessIcon(value), title);
    const menu =
      status.state === "ok" && items.length > 1
        ? h(
            "div",
            { className: "buzz-select", "data-variant": "compact" },
            h(
              Button,
              {
                ref: list.trigger,
                variant: "outline",
                shape: "control",
                size: "sm",
                disabled,
                "aria-label": `Change harness from ${title}`,
                "aria-haspopup": "menu",
                "aria-expanded": list.open,
                "aria-controls": list.open ? `${id}-menu` : undefined,
                "data-popup-open": list.open ? "" : undefined,
                onClick: () => (list.open ? list.close(false) : list.show()),
                onKeyDown: list.onTriggerKeyDown,
              },
              current,
              h(glyphs.caret, { size: CHEVRON_SIZE, "aria-hidden": "true" }),
            ),
            list.open
              ? h(
                  Floating,
                  {
                    anchor: list.trigger,
                    align: "start",
                    positionerClass: "buzz-menu-positioner",
                    onDismiss: () => list.close(false),
                    popup: {
                      ref: list.popup,
                      id: `${id}-menu`,
                      role: "menu",
                      tabIndex: -1,
                      "aria-activedescendant": list.active >= 0 ? `${id}-item-${list.active}` : undefined,
                      "data-buzz-ui": "",
                      "data-size": "default",
                      className: "buzz-menu-popup text-body-sm",
                      onKeyDown: list.onPopupKeyDown,
                    },
                  },
                  h(
                    "div",
                    { role: "group" },
                    items.map((item, index) =>
                      h(
                        "div",
                        {
                          key: item.id,
                          id: `${id}-item-${index}`,
                          role: "menuitemradio",
                          tabIndex: -1,
                          "aria-checked": item.id === value,
                          "aria-disabled": item.disabled || undefined,
                          className: "buzz-menu-item",
                          "data-selection": "highlight",
                          "data-checked": item.id === value ? "" : undefined,
                          "data-highlighted": index === list.active ? "" : undefined,
                          "data-disabled": item.disabled ? "" : undefined,
                          onMouseEnter: () => !item.disabled && list.setActive(index),
                          onClick: () => list.choose(index),
                        },
                        h("span", { className: "buzz-menu-choice-label" }, h(ChoiceRow, { label: item.title, description: item.description, leading: harnessIcon(item.id) })),
                      ),
                    ),
                  ),
                )
              : null,
          )
        : current;
    return h(PreferenceRow, { title: LABELS.harness, trailing: menu });
  }

  /** Desktop's ModelPicker (list form): the host's default first, marked
   * Default, then the host's models with vendor logos; Settings adds Custom
   * model. `value` "" follows the host's default. */
  function ModelSelect({ hostId, harness, value, onChange, disabled, compact }) {
    const list = useModels(hostId, harness);
    const [custom, setCustom] = React.useState(null);
    const inputId = React.useId();
    const loading = list.state === "loading";
    const known = list.state === "ok" ? list.models : [];
    const defaultModel = list.state === "ok" ? list.current : "";
    const defaultChoice = known.find((model) => model.id === defaultModel);
    const fallback = {
      id: "",
      label: defaultChoice ? defaultChoice.label : defaultModel || LABELS.modelUnavailable,
      description: LABELS.defaultDescription,
    };
    const listed = known.filter((model) => model.id !== defaultModel || model.id === value);
    if (value && !listed.some((model) => model.id === value))
      listed.push({ id: value, label: value, description: LABELS.customListed });
    const shown = [fallback, ...listed];
    const selected = shown.find((model) => model.id === (value || defaultModel)) || fallback;
    const inherited = value === "";
    const choices = compact ? shown : [...shown, { id: CUSTOM_MODEL, label: LABELS.custom, description: LABELS.customDescription }];
    const logos = choices.map((model) => modelLogo(`${model.id} ${model.label}`));
    const anyLogo = logos.some(Boolean);
    const select = h(Select, {
      label: LABELS.model,
      variant: compact ? "compact" : "preference",
      align: compact ? "end" : "start",
      value: selected.id,
      valueLabel: loading ? LABELS.loadingModels : selected.label,
      valueSuffix: !loading && inherited ? LABELS.defaultSuffix : undefined,
      valueTitle: loading ? LABELS.loadingModels : inherited ? `${selected.label}${LABELS.defaultSuffix}` : selected.label,
      leading: modelLogo(`${selected.id} ${selected.label}`),
      disabled: disabled || loading,
      options: choices.map((model, index) => ({
        value: model.id,
        label: model.id === "" ? `${model.label}${LABELS.defaultSuffix}` : model.label,
        description: model.description,
        // An empty mark keeps the icon column in a list where only some models have one.
        leading: anyLogo ? logos[index] || h(React.Fragment) : undefined,
      })),
      onValueChange: (next) => {
        if (next === CUSTOM_MODEL) setCustom(known.some((model) => model.id === value) || !value ? "" : value);
        else onChange(next);
      },
    });
    if (custom === null) return select;
    // Desktop asks for a custom id in a small dialog; a plugin has no dialog
    // of Desktop's, so the same field opens under the row instead.
    const use = () => {
      if (!custom.trim()) return;
      onChange(custom.trim().slice(0, MODEL_MAX));
      setCustom(null);
    };
    return h(
      React.Fragment,
      null,
      select,
      h(
        Field,
        { label: LABELS.modelId, controlId: inputId },
        h(Input, {
          id: inputId,
          value: custom,
          placeholder: LABELS.customDescription,
          maxLength: MODEL_MAX,
          autoCorrect: "off",
          autoCapitalize: "none",
          spellCheck: false,
          onChange: (event) => setCustom(event.target.value),
          onKeyDown: (event) => {
            // Enter takes the id here; it must not submit the settings form.
            if (event.key !== "Enter") return;
            event.preventDefault();
            use();
          },
        }),
      ),
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(Button, { onClick: () => setCustom(null) }, LABELS.cancel),
        h(Button, { variant: "prominent", disabled: !custom.trim(), onClick: use }, LABELS.useModel),
      ),
    );
  }

  const dedupe = (efforts) => efforts.filter((level, index) => efforts.findIndex((item) => item.id === level.id) === index);
  /** The levels of the model a run uses; with no model match, any level some
   * listed model has. */
  function effortsFor(list, model) {
    const used = list.models.find((item) => item.id === (model || list.current));
    return used ? used.efforts : dedupe(list.models.flatMap((item) => item.efforts));
  }

  /** Desktop's Thinking row: Automatic (the default), then the levels of the
   * model the run uses; a saved level that model does not list is kept,
   * marked unavailable. */
  function EffortSelect({ hostId, harness, model, value, onChange, disabled }) {
    const list = useModels(hostId, harness);
    const efforts = list.state === "ok" ? effortsFor(list, model) : [];
    const options = [
      { value: "", label: `${LABELS.automatic}${LABELS.defaultSuffix}` },
      ...(value && !efforts.some((level) => level.id === value)
        ? [{ value, label: list.state === "ok" && list.models.length ? `${value}${LABELS.unavailable}` : value }]
        : []),
      ...efforts.map((level) => ({ value: level.id, label: level.label })),
    ];
    return h(Select, {
      label: LABELS.thinking,
      variant: "preference",
      value,
      valueLabel: value ? undefined : LABELS.automatic,
      valueSuffix: value ? undefined : LABELS.defaultSuffix,
      options,
      disabled,
      onValueChange: onChange,
    });
  }

  /** Desktop's rule on a model change: a level the new model does not list
   * goes back to Automatic; without the host's list, the level is kept. */
  function keptEffort(hostId, harness, model, effort) {
    const list = models[modelKey(hostId, harness)];
    if (!effort || !list || list.state !== "ok") return effort;
    return effortsFor(list, model).some((level) => level.id === effort) ? effort : "";
  }

  /** The draft after a pick. A new harness has its own models and levels,
   * so it starts on its defaults. */
  function pick(config, patch) {
    if (patch.harness !== undefined && patch.harness !== config.harness)
      return cleanConfig({ ...config, harness: patch.harness, model: "", effort: "" });
    if (patch.host !== undefined && patch.host !== config.host)
      return cleanConfig({ ...config, host: patch.host, model: "", effort: "" });
    if (patch.model !== undefined)
      return cleanConfig({ ...config, model: patch.model, effort: keptEffort(config.host, config.harness, patch.model, config.effort) });
    return cleanConfig({ ...config, ...patch });
  }

  /** Why the chosen harness cannot be used now, or "" when it can. */
  function harnessProblem(hostId, harness) {
    const status = hosts[hostId];
    if (status.state === "down") return status.error;
    if (status.state !== "ok") return "";
    const entry = harnessOn(hostId, harness);
    if (!entry) return `${harness} is not offered on this host.`;
    return entry.ready ? "" : entry.message || `${entry.title} is not ready on this host.`;
  }

  /** "Where it runs", shown apart from the harness: the type and the host. */
  function runsOn(host) {
    return h("span", { className: "flex min-w-0 items-center gap-2" }, h(icons.host, { size: HARNESS_ICON_SIZE, "aria-hidden": "true" }), `${TYPE_TITLE} · ${host.label}`);
  }

  /** A harness's readiness on one host, in the owner's words. */
  function readinessLine(host, harness) {
    const status = hosts[host.id];
    if (status.state === "checking") return "Checking…";
    if (status.state === "down") return status.error;
    const entry = harnessOn(host.id, harness.id);
    if (!entry) return "Not offered on this host.";
    if (entry.ready) return ["Ready", entry.version, entry.account].filter(Boolean).join(" · ");
    return entry.message || "Not ready.";
  }

  // ---- The hosted agent type ------------------------------------------------

  /** New agent dialog, Model row: the harness pill and the model pill, laid
   * out as Desktop's CreateModelChoices. Desktop's own Harness row above
   * shows the type ("Tailscale host (hosted)"), which is where it runs.
   * Messages go in a block that adds no width (MESSAGE_BLOCK_STYLE): a host
   * error is longer than Desktop's own messages in this row. */
  function CreateModel(props) {
    const config = cleanConfig(props.config);
    useStore(() => hosts);
    const set = (patch) => props.onChange(pick(config, patch));
    const problem = harnessProblem(config.host, config.harness);
    const ready = Boolean(harnessOn(config.host, config.harness)?.ready);
    const list = useModels(config.host, config.harness, ready);
    const failed = ready && list.state === "error";
    return h(
      React.Fragment,
      null,
      h(
        "div",
        { className: "flex max-w-full flex-wrap items-center justify-end gap-2" },
        h(HarnessSelect, { hostId: config.host, value: config.harness, disabled: props.disabled, onChange: (harness) => set({ harness }) }),
        ready
          ? h(ModelSelect, {
              key: config.harness,
              compact: true,
              hostId: config.host,
              harness: config.harness,
              value: config.model || "",
              disabled: props.disabled,
              onChange: (model) => set({ model }),
            })
          : null,
        failed ? h(Button, { size: "sm", disabled: props.disabled, onClick: () => loadModels(config.host, config.harness, true) }, LABELS.tryAgain) : null,
      ),
      problem || failed
        ? h(
            "div",
            { className: "grid gap-1", style: MESSAGE_BLOCK_STYLE },
            problem ? h("span", { role: "alert", className: "text-body-sm text-danger" }, problem) : null,
            failed ? h("span", { role: "alert", className: "text-body-sm text-danger" }, list.error) : null,
          )
        : null,
    );
  }

  /** The rest of the New agent dialog, as Desktop's: where it runs, then
   * the instructions. The host choice shows even with one host, so the owner
   * sees which host the agent goes to and finds where new hosts appear.
   * Sessions keep Desktop's default and change in Settings, as Desktop's do. */
  function Create(props) {
    const list = useStore(() => HOSTS);
    const file = useStore(() => hostsFile);
    const config = cleanConfig(props.config);
    const set = (patch) => props.onChange(pick(config, patch));
    if (!list.length) return h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, file.error || LABELS.noHosts);
    const host = hostById(config.host);
    return h(
      "div",
      { className: "grid gap-4" },
      h(Select, {
        label: LABELS.host,
        variant: "field",
        value: config.host,
        disabled: props.disabled,
        options: list.map((entry) => ({ value: entry.id, label: entry.label })),
        onValueChange: (id) => set({ host: id }),
      }),
      h("p", { className: "m-0 text-body-sm text-secondary" }, `Runs on ${host.label}. The host keeps its key and runs it, whether or not this app is open.`),
      h(AgentInstructions, { creation: true, value: config.instructions, disabled: props.disabled, onChange: (instructions) => set({ instructions }) }),
    );
  }

  /** Settings tab, split as Desktop's. Identity: where it runs, harness,
   * model, thinking and instructions. Runtime: workspace and sessions. It
   * saves to the runner, which restarts the agent on a new harness. */
  function Settings(props) {
    const { agent, settingsSection, settingsContent } = props;
    const form = React.useId();
    const workspaceId = React.useId();
    const [state, setState] = React.useState({ status: "loading" });
    const [draft, setDraft] = React.useState(null);
    const [saved, setSaved] = React.useState(null);
    useStore(() => hosts);
    React.useEffect(() => {
      let live = true;
      (async () => {
        try {
          const host = await locate(agent.pubkey);
          if (!host) throw new RunnerError("No host knows this agent.", { op: "settings" });
          const record = await call(host, "GET", `/agents/${agent.pubkey}`);
          if (!live) return;
          const loaded = cleanConfig({ ...(record && record.config), host: host.id });
          setState({ status: "ready", host, workspace: text(record && record.workspace, TEXT_MAX) || "" });
          setDraft(loaded);
          setSaved(loaded);
        } catch (error) {
          if (live) setState({ status: "error", message: errorText(error) });
        }
      })();
      return () => {
        live = false;
      };
    }, [agent.pubkey]);

    if (state.status === "loading") return h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, "Loading from host…");
    if (state.status === "error") return h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, state.message);

    const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
    const save = async () => {
      const moved = draft.harness !== saved.harness;
      setState({ ...state, saving: true, error: undefined, notice: undefined });
      try {
        await call(state.host, "PUT", `/agents/${agent.pubkey}/config`, runtimeConfig(draft));
        setSaved(draft);
        setState({ ...state, saving: false, notice: moved ? `Saved. The agent restarted on ${harnessTitle(state.host.id, draft.harness)}.` : "Saved. New sessions use it." });
      } catch (error) {
        setState({ ...state, saving: false, error: errorText(error) });
      }
    };
    const identity = settingsSection !== "runtime";
    const runtime = settingsSection !== "identity";
    const problem = harnessProblem(state.host.id, draft.harness);
    const ready = Boolean(harnessOn(state.host.id, draft.harness)?.ready);
    const set = (patch) => setDraft(pick(draft, patch));
    return h(
      "form",
      {
        id: form,
        className: "grid gap-4 [container-type:inline-size]",
        onSubmit: (event) => {
          event.preventDefault();
          void save();
        },
      },
      state.error ? h("p", { role: "alert", tabIndex: -1, className: "buzz-field-error" }, state.error) : null,
      identity
        ? h(
            SettingsGroup,
            null,
            h(PreferenceRow, { title: LABELS.runsOn, trailing: runsOn(state.host) }),
            h(HarnessMenu, { hostId: state.host.id, value: draft.harness, disabled: Boolean(state.saving), onChange: (harness) => set({ harness }) }),
            ready
              ? h(ModelSelect, { key: draft.harness, hostId: state.host.id, harness: draft.harness, value: draft.model || "", onChange: (model) => set({ model }) })
              : null,
            ready
              ? h(EffortSelect, { hostId: state.host.id, harness: draft.harness, model: draft.model, value: draft.effort || "", onChange: (effort) => set({ effort }) })
              : null,
          )
        : null,
      identity && problem ? h("p", { role: "alert", className: "m-0 mt-1 text-body-sm text-danger" }, problem) : null,
      identity ? h(AgentInstructions, { value: draft.instructions, disabled: false, onChange: (instructions) => set({ instructions }) }) : null,
      runtime
        ? h(
            Field,
            { label: LABELS.workspace, controlId: workspaceId, description: "The folder the agent works in on the host. The host sets it." },
            h(Input, { id: workspaceId, value: state.workspace, readOnly: true }),
          )
        : null,
      runtime
        ? h(Select, {
            label: LABELS.sessions,
            variant: "preference",
            value: draft.scope,
            options: SCOPES.map(([value, label]) => ({ value, label })),
            onValueChange: (scope) => set({ scope }),
          })
        : null,
      // Desktop shows Save only while there is something to save.
      dirty || state.saving
        ? h("div", null, h(Button, { type: "submit", form, variant: "prominent", loading: Boolean(state.saving), disabled: !dirty }, state.saving ? LABELS.saving : LABELS.save))
        : null,
      state.notice ? h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, state.notice) : null,
      runtime ? settingsContent || null : null,
    );
  }

  /** The provider dialog: each host and every harness on it, and a recheck. */
  function DialogBody({ onClose }) {
    useStore(() => hosts);
    const list = useStore(() => HOSTS);
    const [checking, setChecking] = React.useState(false);
    return h(
      "div",
      { className: "grid gap-4" },
      list.length ? null : h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, hostsFile.error || LABELS.noHosts),
      list.map((host) => {
        const status = statusOf(host.id);
        return h(
          "section",
          { key: host.id, "aria-label": host.label },
          h("h3", { className: "text-label-sm" }, host.label),
          status.state === "ok"
            ? h(
                SettingsGroup,
                null,
                status.harnesses.map((harness) =>
                  h(
                    "div",
                    { key: harness.id },
                    h(PreferenceRow, {
                      title: h("span", { className: "flex min-w-0 items-center gap-2" }, harnessIcon(harness.id), harness.title),
                      subtitle: readinessLine(host, harness),
                    }),
                  ),
                ),
              )
            : h(
                "p",
                { role: status.state === "down" ? "alert" : "status", className: `m-0 text-body-sm ${status.state === "down" ? "text-danger" : "text-secondary"}` },
                status.state === "down" ? status.error : "Checking…",
              ),
        );
      }),
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(
          Button,
          {
            loading: checking,
            onClick: () => {
              setChecking(true);
              refresh().finally(() => setChecking(false));
            },
          },
          "Check again",
        ),
        h(Button, { onClick: onClose }, "Close"),
      ),
    );
  }

  /** Pinned across the agent's tabs while no host answers: settings and
   * profile changes need the runner, so the host's access notice fits. */
  function PanelFooter() {
    useStore(() => hosts);
    const list = useStore(() => HOSTS);
    const down = list.filter((host) => statusOf(host.id).state === "down");
    if (!down.length || down.length < list.length) return null;
    return h(
      "div",
      { role: "status", className: "text-body-sm text-secondary" },
      `Can't reach ${down.map((host) => host.label).join(", ")}. Settings and profile changes wait until it answers.`,
    );
  }

  // ---- The Hosts page and the Settings card ---------------------------------

  /** Edit form for one listed host: a plain save of hosts.json, with no
   * setup. Errors stay beside the form until the owner types again. */
  function HostForm({ host, disabled, onDone, onCancel }) {
    const labelId = React.useId();
    const originId = React.useId();
    const [label, setLabel] = React.useState(host.label);
    const [origin, setOrigin] = React.useState(host.origin);
    const [error, setError] = React.useState("");
    const [saving, setSaving] = React.useState(false);
    const submit = async (event) => {
      event.preventDefault();
      if (saving) return;
      setSaving(true);
      try {
        const saved = await updateHost(host.id, { label, origin });
        setError("");
        onDone(saved);
      } catch (cause) {
        setError(errorText(cause));
      } finally {
        setSaving(false);
      }
    };
    const typed = (set) => (event) => {
      set(event.target.value);
      setError("");
    };
    return h(
      "form",
      { "aria-label": `Edit ${host.label}`, className: "grid gap-3", onSubmit: submit },
      h(
        Field,
        { label: "Name", controlId: labelId, description: "Shown in New agent and in each agent's settings." },
        h(Input, { id: labelId, value: label, maxLength: LABEL_MAX, autoComplete: "off", spellCheck: false, onChange: typed(setLabel) }),
      ),
      h(
        Field,
        { label: "Address", controlId: originId, description: `The machine's https:// address on your tailnet, with no path. Example: ${ORIGIN_EXAMPLE}` },
        h(Input, {
          id: originId,
          value: origin,
          maxLength: ORIGIN_MAX,
          inputMode: "url",
          autoComplete: "off",
          autoCapitalize: "none",
          spellCheck: false,
          placeholder: ORIGIN_EXAMPLE,
          onChange: typed(setOrigin),
        }),
      ),
      error ? h("p", { role: "alert", className: "buzz-field-error" }, error) : null,
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(Button, { type: "submit", variant: "prominent", loading: saving, disabled: disabled && !saving }, LABELS.save),
        h(Button, { onClick: onCancel, disabled: saving }, LABELS.cancel),
      ),
    );
  }

  // The state of one step, in the words and with the mark the page shows.
  const STEP_WORDS = Object.freeze({ running: "Running…", waiting: "Waiting for you", failed: "Failed" });

  /** Desktop's content header (shared/design-system/ui/Header.tsx): one
   * heading shape for every part of the page, so the parts read as sections. */
  function ContentHeader({ title, subtitle, actions, level = 2, inline = false }) {
    return h(
      "div",
      { "data-buzz-ui": "", className: "buzz-content-header", "data-inline": inline || undefined },
      h(
        "div",
        { className: "buzz-content-header-copy" },
        h(`h${level}`, { className: "buzz-content-header-title" }, title),
        subtitle ? h("p", { className: "buzz-content-header-subtitle" }, subtitle) : null,
      ),
      actions ? h("div", { className: "buzz-content-header-actions" }, actions) : null,
    );
  }

  /** A state a reader takes in at a glance. The word beside it carries the
   * meaning, so the color is never the only signal. */
  function StateDot({ tone }) {
    return h("span", { "aria-hidden": "true", "data-tone": tone, style: { ...DOT_STYLE, background: TONE_COLORS[tone] } });
  }

  /** The mark of one setup step: pending, running, waiting, done or failed. */
  function StepMark({ state }) {
    if (state === "done") return h(glyphs.check, { size: STEP_MARK_SIZE, "aria-hidden": "true", style: { color: TONE_COLORS.good } });
    if (state === "failed") return h(glyphs.cross, { size: STEP_MARK_SIZE, "aria-hidden": "true", style: { color: TONE_COLORS.bad } });
    if (state === "running") return h(glyphs.spinner, { size: STEP_MARK_SIZE, "aria-hidden": "true", className: "motion-safe:animate-spin" });
    return h(StateDot, { tone: state === "waiting" ? "wait" : "off" });
  }

  /** A link the owner must open, set apart from the steps and the terminal
   * so that it is not lost among them. Only a checked Tailscale link comes
   * here (CHECK_LINK). */
  function ApproveLink({ link }) {
    return h(
      "p",
      { className: "m-0 text-body-sm" },
      "Open this link to approve the connection: ",
      h("a", { href: link, target: "_blank", rel: "noopener noreferrer" }, link),
    );
  }

  /** The setup's steps in order, each with its mark and what it found. */
  function SetupSteps({ run }) {
    return h(
      "ol",
      { "aria-label": "Setup steps", "aria-live": "polite", className: "m-0 grid gap-3 list-none p-0 text-body-sm" },
      SETUP_STEPS.map(([key, words]) => {
        const step = run.steps[key];
        const state = step ? step.state : "pending";
        return h(
          "li",
          { key, "data-step": key, "data-state": state, style: STEP_ROW_STYLE },
          h("span", { style: STEP_MARK_STYLE }, h(StepMark, { state })),
          h(
            "span",
            { className: state === "pending" ? "text-secondary" : undefined, style: GROW_STYLE },
            h("span", { className: state === "failed" ? "text-danger" : undefined }, words),
            STEP_WORDS[state] ? h("span", { className: "text-secondary" }, ` · ${STEP_WORDS[state]}`) : null,
            step?.detail ? h("span", { className: "block text-secondary whitespace-pre-wrap" }, step.detail) : null,
            step?.link ? h(ApproveLink, { link: step.link }) : null,
          ),
        );
      }),
    );
  }

  /** The steps a setup leaves to the owner, with a command to copy where a
   * step has one. Signing the harnesses in is the next thing to do and it
   * has its own place on the host's details, so the button goes there. It
   * shows only once the host is listed: a sign-in runs only on a listed
   * host. */
  function SetupResult({ result, onOpenHost, onAddAnother }) {
    const list = useStore(() => HOSTS);
    const listed = Boolean(result.hostId && list.some((host) => host.id === result.hostId));
    return h(
      "div",
      { "aria-label": "Still to do", role: "group", className: "grid gap-3 text-body-sm" },
      h("p", { role: "status", className: "m-0" }, `${result.added ? "Added" : "Already listed:"} ${result.label}${result.version ? ` (buzz-runner ${result.version})` : ""}. New agent can use it now.`),
      h("h3", { className: "text-label-sm" }, "Next"),
      h(
        "ol",
        { className: "m-0 grid gap-2 list-decimal pl-6" },
        result.manual.map((entry, index) =>
          h(
            "li",
            { key: index },
            entry.text,
            entry.command
              ? h(
                  "span",
                  { className: "flex items-center gap-2" },
                  h("code", { className: "select-all" }, entry.command),
                  h(Button, { size: "sm", onClick: () => void navigator.clipboard?.writeText(entry.command).catch(() => undefined) }, "Copy"),
                )
              : null,
          ),
        ),
      ),
      h(
        "div",
        { className: "flex items-center gap-2" },
        listed ? h(Button, { variant: "prominent", "aria-label": `Sign in on ${result.label}`, onClick: () => onOpenHost(result.hostId) }, "Sign in to the harnesses") : null,
        h(Button, { onClick: onAddAnother }, "Add another host"),
      ),
    );
  }

  /** The setup's heading: what it does now, or how it ended. */
  function setupTitle(run) {
    const name = run.label || "the host";
    if (run.state === "failed") return `Could not add ${name}`;
    return run.state === "done" ? `Added ${name}` : `Adding ${name}`;
  }

  /** How far the setup is, in words: the count a long setup is judged by. */
  function setupProgressLine(run) {
    if (run.state === "failed") return "The setup stopped.";
    if (run.state === "done") return "The setup is done.";
    const done = SETUP_STEPS.filter(([key]) => run.steps[key]?.state === "done").length;
    return `Step ${Math.min(done + 1, SETUP_STEPS.length)} of ${SETUP_STEPS.length}. You can leave this page: the setup goes on.`;
  }

  /** Add a host, once the setup started: the steps and their end. The form
   * goes away so that the page shows one thing to look at. */
  function SetupProgress({ run, onOpenHost }) {
    return h(
      "section",
      { "aria-label": "Setup", className: "grid gap-4", style: CARD_STYLE },
      h(ContentHeader, { title: setupTitle(run), subtitle: setupProgressLine(run) }),
      h(SetupSteps, { run }),
      run.state === "failed"
        ? h(
            "div",
            { className: "grid gap-3" },
            h("p", { role: "alert", className: "buzz-field-error" }, run.error),
            h("div", null, h(Button, { onClick: resetSetup }, "Back to the form")),
          )
        : null,
      run.state === "done" && run.result ? h(SetupResult, { result: run.result, onOpenHost, onAddAnother: resetSetup }) : null,
    );
  }

  /** Add a host, the form. The fields that most owners never change start
   * closed, and open when one of them is empty: a setup cannot run then. */
  function AddHostForm({ active, disabled }) {
    const defaults = React.useMemo(communityDefaults, []);
    const [values, setValues] = React.useState({ label: "", origin: "", sshUser: "", ...defaults, ...setupForm, password: "" });
    const [error, setError] = React.useState("");
    const ids = { label: React.useId(), origin: React.useId(), user: React.useId(), password: React.useId(), owner: React.useId(), relay: React.useId() };
    const typed = (key) => (event) => {
      const { value } = event.target;
      setValues((now) => ({ ...now, [key]: value }));
      setError("");
    };
    const submit = (event) => {
      event.preventDefault();
      if (!active() || setupRun.state === "running") return;
      let setup;
      try {
        setup = checkNewHost(values);
      } catch (cause) {
        return setError(errorText(cause));
      }
      // The password leaves the view with the request; the field is empty
      // again, so it is not kept while the setup runs.
      const sudoPassword = values.password;
      setValues((now) => ({ ...now, password: "" }));
      setError("");
      // A failed setup comes back to these values, with no password.
      setupForm = Object.freeze({ label: values.label, origin: values.origin, sshUser: values.sshUser, ownerPubkey: values.ownerPubkey, relay: values.relay });
      void startSetup({ ...setup, sudoPassword });
    };
    const field = (id, key, name, description, input = {}) =>
      h(
        Field,
        { label: name, controlId: id, description },
        h(Input, { id, value: values[key], autoComplete: "off", autoCapitalize: "none", spellCheck: false, onChange: typed(key), ...input }),
      );
    return h(
      "form",
      { "aria-label": "Add a host", className: "grid gap-5", style: CARD_STYLE, onSubmit: submit },
      h(ContentHeader, { title: "Add a host", subtitle: `${LABELS.addIntro} ${LABELS.addNeeds}` }),
      h(
        "fieldset",
        { className: "grid gap-3", style: FIELDSET_STYLE },
        h("legend", { className: "text-label-sm", style: LEGEND_STYLE }, "Machine"),
        field(ids.label, "label", "Name", "Shown in New agent and in each agent's settings.", { maxLength: LABEL_MAX }),
        field(ids.origin, "origin", "Address", "The machine's https:// MagicDNS name, with no port.", { maxLength: ORIGIN_MAX, inputMode: "url", placeholder: ORIGIN_EXAMPLE }),
      ),
      h(
        "fieldset",
        { className: "grid gap-3", style: FIELDSET_STYLE },
        h("legend", { className: "text-label-sm", style: LEGEND_STYLE }, "Access"),
        field(ids.user, "sshUser", "SSH login", LABELS.sshLoginHelp, { maxLength: SSH_USER_MAX }),
        field(ids.password, "password", "sudo password", LABELS.sudoHelp, { type: "password", maxLength: PASSWORD_MAX }),
      ),
      h(
        "details",
        { open: !defaults.ownerPubkey || !defaults.relay || undefined, className: "grid gap-3" },
        h("summary", { className: "text-label-sm" }, "Identity and relay"),
        h(
          "div",
          { className: "grid gap-3", style: DISCLOSED_STYLE },
          field(ids.owner, "ownerPubkey", "Owner key", "Your key in hex. Only you can make agents on this runner.", { maxLength: 64 }),
          field(ids.relay, "relay", "Relay", `The relay the agents connect to. Example: ${RELAY_EXAMPLE}`, { maxLength: RELAY_MAX, inputMode: "url" }),
        ),
      ),
      error ? h("p", { role: "alert", className: "buzz-field-error" }, error) : null,
      h("div", null, h(Button, { type: "submit", variant: "prominent", disabled }, "Add host")),
    );
  }

  /** Add a host: the form, or the setup once there is one. */
  function AddHostView({ active, disabled, onOpenHost }) {
    const run = useStore(() => setupRun);
    return run.state === "idle" ? h(AddHostForm, { active, disabled }) : h(SetupProgress, { run, onOpenHost });
  }

  /** One choice of a group, drawn as Desktop's Radio card. A native input
   * keeps the keyboard and the form's own behavior; the plugin cannot use
   * Desktop's Base UI component. */
  function RadioCard({ name, label, description, checked, disabled, onSelect }) {
    return h(
      "label",
      { className: "buzz-choice", "data-variant": "card", "data-size": "md" },
      h("input", { type: "radio", className: "sr-only", name, checked, disabled, onChange: onSelect }),
      h(
        "span",
        { "aria-hidden": "true", "data-buzz-ui": "", className: "buzz-radio", "data-variant": "card", "data-size": "md", "data-checked": checked ? "" : undefined, "data-unchecked": checked ? undefined : "" },
        checked ? h("span", { className: "buzz-radio-indicator" }) : null,
      ),
      h(
        "span",
        null,
        h("span", { className: "buzz-choice-label" }, label),
        description ? h("span", { className: "buzz-choice-description" }, description) : null,
      ),
    );
  }

  /** The sign-in form: how to sign in, and how to reach root on the host. */
  function SignInStart({ host, signing, active, blocked, onClose }) {
    const harness = SIGNIN_HARNESSES.find((entry) => entry.id === signing.harness);
    const [values, setValues] = React.useState({ sshUser: sshLogins.get(host.id) ?? "", password: "", command: harness ? harness.methods[0][0] : SIGNIN_STATUS });
    const ids = { user: React.useId(), password: React.useId(), methods: React.useId() };
    const typed = (key) => (event) => {
      const { value } = event.target;
      setValues((now) => ({ ...now, [key]: value }));
    };
    const start = (event) => {
      event.preventDefault();
      if (!active() || blocked) return;
      // The password leaves the view with the request, as in Add host.
      const sudoPassword = values.password;
      setValues((now) => ({ ...now, password: "" }));
      const sshUser = values.sshUser.trim();
      sshLogins.set(host.id, sshUser);
      void startSignIn({ hostId: host.id, harness: signing.harness, sshUser, sudoPassword, command: values.command });
    };
    return h(
      "form",
      { "aria-label": "Start a sign-in", className: "grid gap-4", onSubmit: start },
      harness
        ? h(
            "div",
            { role: "radiogroup", "aria-label": "How to sign in", "data-buzz-ui": "", className: "buzz-radio-group" },
            harness.methods.map(([value, label, description]) =>
              h(RadioCard, { key: value, name: ids.methods, label, description, checked: values.command === value, onSelect: () => setValues((now) => ({ ...now, command: value })) }),
            ),
          )
        : null,
      h(
        Field,
        { label: "SSH login", controlId: ids.user, description: LABELS.sshLoginHelp },
        h(Input, { id: ids.user, value: values.sshUser, maxLength: SSH_USER_MAX, autoComplete: "off", autoCapitalize: "none", spellCheck: false, onChange: typed("sshUser") }),
      ),
      h(
        Field,
        { label: "sudo password", controlId: ids.password, description: SIGNIN_PASSWORD_HELP },
        h(Input, { id: ids.password, type: "password", value: values.password, maxLength: PASSWORD_MAX, autoComplete: "off", onChange: typed("password") }),
      ),
      blocked ? h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, "A sign-in runs on another host. Finish it first.") : null,
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(Button, { type: "submit", variant: "prominent", disabled: blocked }, "Start"),
        h(Button, { onClick: onClose }, "Close"),
      ),
    );
  }

  /** One typed line to the running sign-in's terminal. */
  function SignInAnswer({ active, onError, onCancel }) {
    const [line, setLine] = React.useState("");
    const id = React.useId();
    const send = (event) => {
      event.preventDefault();
      if (!active()) return;
      // The line leaves the view with the request; it may be a key.
      const typed = line;
      setLine("");
      sendSignInInput(typed).catch((cause) => onError(errorText(cause)));
    };
    return h(
      "form",
      { "aria-label": "Answer the terminal", className: "grid gap-2", onSubmit: send },
      h(
        Field,
        { label: "Answer", controlId: id, description: "A key, a pasted code, or a menu number. It is hidden as you type, goes only to the terminal, and is not saved." },
        h(Input, { id, type: "password", value: line, maxLength: SIGNIN_INPUT_MAX, autoComplete: "off", autoCapitalize: "none", spellCheck: false, onChange: (event) => setLine(event.target.value) }),
      ),
      h(
        "div",
        { className: "flex items-center gap-2" },
        h(Button, { type: "submit", variant: "prominent" }, "Send"),
        h(Button, { onClick: onCancel }, "Cancel"),
      ),
    );
  }

  /** How the sign-in on this host ended, in the words the page shows. */
  function signInEnd(run) {
    if (run.state === "failed") return h("p", { role: "alert", className: "buzz-field-error" }, run.error);
    if (run.state !== "done") return null;
    return h("p", { role: "status", className: "m-0 text-body-sm" }, run.code === 0 ? "The sign-in ended." : `The sign-in ended with exit ${run.code}.`);
  }

  /** A running or ended sign-in: what to do now, then the machine's terminal,
   * so the owner signs in without a shell on the machine. */
  function SignInTerminal({ run, active, onClose }) {
    const [error, setError] = React.useState("");
    const running = run.state === "running";
    // A cancel that comes just after the end finds no sign-in; the end
    // already shows, so there is nothing more to say.
    const cancel = () => void cancelSignIn().catch(() => undefined);
    const again = () => {
      resetSignIn();
      setError("");
    };
    return h(
      "div",
      { className: "grid gap-3" },
      running ? h("p", { className: "m-0 text-body-sm text-secondary" }, LABELS.signInSteps) : signInEnd(run),
      run.link ? h(ApproveLink, { link: run.link }) : null,
      run.output ? h("pre", { role: "log", "aria-label": "Terminal on the host", className: "m-0 max-h-80 overflow-auto whitespace-pre-wrap break-all text-body-sm select-text", style: TERMINAL_STYLE }, run.output) : null,
      running ? h(SignInAnswer, { active, onError: setError, onCancel: cancel }) : null,
      error ? h("p", { role: "alert", className: "buzz-field-error" }, error) : null,
      running
        ? null
        : h(
            "div",
            { className: "flex items-center gap-2" },
            h(Button, { variant: "prominent", onClick: onClose }, "Done"),
            h(Button, { onClick: again }, "Try again"),
          ),
    );
  }

  /** One sign-in on one host: `buzz-login` on the machine, as the harness
   * user. It replaces the host's harness list while it is open, so that the
   * owner has one thing to look at. */
  function SignInPanel({ host, signing, active, onClose }) {
    const run = useStore(() => signinRun);
    const harness = SIGNIN_HARNESSES.find((entry) => entry.id === signing.harness);
    const mine = run.hostId === host.id && run.state !== "idle";
    const close = () => {
      if (run.state !== "running") resetSignIn();
      onClose();
    };
    return h(
      "section",
      { "aria-label": `Sign in on ${host.label}`, className: "grid gap-4", style: CARD_STYLE },
      h(ContentHeader, { level: 3, inline: true, title: harness ? `Sign in to ${harness.title} on ${host.label}` : `Show what is signed in on ${host.label}`, subtitle: mine ? undefined : LABELS.signInIntro }),
      mine ? h(SignInTerminal, { run, active, onClose: close }) : h(SignInStart, { host, signing, active, blocked: run.state === "running", onClose: close }),
    );
  }

  /** What one harness can do on this host, in words. */
  function harnessLine(host, harness) {
    const status = statusOf(host.id);
    if (status.state === "checking") return "Checking…";
    if (status.state === "down") return "The host does not answer. You can still try to sign in.";
    const entry = harnessOn(host.id, harness.id);
    if (!entry) return "Not offered on this host.";
    if (entry.ready) return ["Ready", entry.version, entry.account].filter(Boolean).join(" · ");
    return entry.message || "Not ready.";
  }

  /** How one host stands in the list: enough to see which one needs work. */
  function hostLine(host) {
    const status = statusOf(host.id);
    if (status.state === "checking") return "Checking…";
    if (status.state === "down") return "Not reachable";
    const ready = status.harnesses.filter((entry) => entry.ready).length;
    return `Reachable · ${ready} of ${status.harnesses.length} ready`;
  }

  /** The tone of a host's dot: reachable with every harness ready, reachable
   * with work left, or not reachable. */
  function hostTone(host) {
    const status = statusOf(host.id);
    if (status.state === "checking") return "off";
    if (status.state === "down") return "bad";
    return status.harnesses.some((entry) => entry.ready) ? "good" : "wait";
  }

  /** One harness's row: its state and its Sign in. A harness that is not
   * ready gets the prominent button, so the work left is what stands out. */
  function HarnessRow({ host, harness, blocked, onSignIn }) {
    const entry = harnessOn(host.id, harness.id);
    const offered = statusOf(host.id).state !== "ok" || Boolean(entry);
    return h(PreferenceRow, {
      title: h("span", { className: "flex min-w-0 items-center gap-2" }, harnessIcon(harness.id), harness.title),
      subtitle: harnessLine(host, harness),
      trailing: offered
        ? h(Button, { size: "sm", variant: entry?.ready ? "subtle" : "prominent", disabled: blocked, "aria-label": `Sign in to ${harness.title} on ${host.label}`, onClick: () => onSignIn(harness.id) }, entry?.ready ? "Sign in again" : "Sign in")
        : null,
    });
  }

  /** The host's harnesses, with what each needs. */
  function HarnessSection({ host, signinHost, onSignIn, onShowSignIn }) {
    const blocked = Boolean(signinHost);
    return h(
      "section",
      { "aria-label": LABELS.signInTitle, className: "grid gap-3" },
      h(ContentHeader, {
        level: 3,
        inline: true,
        title: LABELS.signInTitle,
        subtitle: LABELS.harnessesIntro,
        actions: h(Button, { size: "sm", disabled: blocked, onClick: () => onSignIn(null) }, "Show what is signed in"),
      }),
      blocked
        ? h(
            "div",
            { role: "status", className: "flex items-center gap-2 text-body-sm text-secondary" },
            `A sign-in runs on ${signinHost.label}.`,
            h(Button, { size: "sm", onClick: () => onShowSignIn(signinHost.id) }, "Show it"),
          )
        : null,
      h(
        SettingsGroup,
        null,
        SIGNIN_HARNESSES.map((harness) => h(HarnessRow, { key: harness.id, host, harness, blocked, onSignIn })),
      ),
    );
  }

  /** The right side of the page for one host: what it is, and what it needs. */
  function HostDetail({ host, ready, busy, active, signing, signinHost, onSignIn, onShowSignIn, onCloseSignIn, onSaved, onRemove }) {
    const [editing, setEditing] = React.useState(false);
    const status = statusOf(host.id);
    return h(
      "div",
      { className: "grid gap-5" },
      h(ContentHeader, {
        title: host.label,
        subtitle: hostSubtitle(host, status),
        actions: ready
          ? h(
              "div",
              { className: "flex items-center gap-2" },
              h(Button, { size: "sm", disabled: busy, "aria-label": `Edit ${host.label}`, onClick: () => setEditing(true) }, "Edit"),
              h(Button, { size: "sm", disabled: busy, "aria-label": `Remove ${host.label}`, onClick: () => onRemove(host) }, "Remove"),
            )
          : null,
      }),
      editing
        ? h(
            "div",
            { style: CARD_STYLE },
            h(HostForm, {
              host,
              disabled: busy,
              onDone: (saved) => {
                setEditing(false);
                onSaved(saved);
              },
              onCancel: () => setEditing(false),
            }),
          )
        : null,
      signing
        ? h(SignInPanel, { key: `${host.id}:${signing.harness}`, host, signing, active, onClose: onCloseSignIn })
        : h(HarnessSection, { host, signinHost, onSignIn, onShowSignIn }),
    );
  }

  /** One host's address and whether it answers. */
  function hostSubtitle(host, status) {
    const reach = status.state === "checking" ? "Checking…" : status.state === "down" ? status.error : "Reachable";
    return `${host.origin} · ${reach}`;
  }

  /** The left side of the page: every host, and the two page-wide actions. */
  function HostList({ list, selected, adding, ready, running, onSelect, onAdd }) {
    const [checking, setChecking] = React.useState(false);
    const check = () => {
      setChecking(true);
      refresh().finally(() => setChecking(false));
    };
    return h(
      "nav",
      { "aria-label": "Hosts", className: "grid gap-3", style: LIST_STYLE },
      h(ContentHeader, { level: 2, title: "Hosts" }),
      list.length
        ? h(
            "div",
            { className: "grid gap-1" },
            list.map((host) =>
              h(
                "button",
                {
                  key: host.id,
                  type: "button",
                  "data-buzz-ui": "",
                  "data-host": host.id,
                  "data-variant": "row",
                  "data-multiline": "",
                  "data-selected": host.id === selected?.id || undefined,
                  "aria-current": host.id === selected?.id ? "page" : undefined,
                  className: "navigation-item",
                  onClick: () => onSelect(host.id),
                },
                h(StateDot, { tone: hostTone(host) }),
                h(
                  "span",
                  { className: "navigation-item-label" },
                  h("span", { className: "block" }, host.label),
                  h("span", { className: "block text-body-sm text-secondary" }, hostLine(host)),
                ),
              ),
            ),
          )
        : h("p", { className: "m-0 text-body-sm text-secondary" }, "No hosts yet."),
      h(
        "div",
        { className: "flex items-center gap-2" },
        ready ? h(Button, { variant: adding ? "subtle" : "prominent", onClick: onAdd }, running ? "Setup running…" : "Add a host") : null,
        h(Button, { loading: checking, onClick: check }, "Check again"),
      ),
      h("p", { className: "m-0 text-body-sm text-secondary" }, LABELS.hostsFileNote),
    );
  }

  /** The whole hosts view: the Hosts page, or the Settings card on a Desktop
   * with no pages. Hosts on the left, and on the right one thing at a time,
   * so that the setup and a sign-in each have the room and the attention
   * they need. New agent offers what hosts.json lists at once. */
  function HostsView({ active }) {
    const file = useStore(() => hostsFile);
    const list = useStore(() => HOSTS);
    useStore(() => hosts);
    const run = useStore(() => signinRun);
    const setup = useStore(() => setupRun);
    // A sign-in or a setup that still runs shows again when the page opens.
    const [view, setView] = React.useState(() => (setupRun.state === "running" ? ADD_VIEW : signinRun.state === "running" ? signinRun.hostId : ""));
    const [signing, setSigning] = React.useState(() => (signinRun.state === "running" ? { id: signinRun.hostId, harness: signinRun.harness } : null));
    const [notice, setNotice] = React.useState("");
    // The file may have changed by hand since the last read.
    React.useEffect(() => {
      void readHostsFile();
    }, []);
    // A finished setup's result is for one look: the next Add a host is a new
    // host. A failed one stays, because its error and its form are still to do.
    // This hangs on the view and not on AddHostView, which also goes away while
    // the hosts file reloads, and a setup that ended unseen still shows once.
    React.useEffect(() => {
      if (view !== ADD_VIEW) return undefined;
      return () => {
        if (setupRun.state === "done") resetSetup();
      };
    }, [view]);
    const ready = file.state === "ready";
    const selected = view === ADD_VIEW ? undefined : list.find((host) => host.id === view) ?? list[0];
    const signinHost = run.state === "running" && run.hostId !== selected?.id ? list.find((host) => host.id === run.hostId) : undefined;
    const select = (id) => {
      setView(id);
      setNotice("");
    };
    // The button must always answer: on an ended setup's own view, it goes to
    // the form. From elsewhere it opens the view, so an unseen end shows first.
    const onAdd = () => {
      if (view === ADD_VIEW) resetSetup();
      select(ADD_VIEW);
    };
    // A save changes the hosts, so each is asked again for its status.
    const remove = (host) => {
      if (!active()) return;
      removeHost(host.id)
        .then(() => {
          setNotice(`Removed ${host.label}.`);
          return refresh();
        })
        .catch((cause) => setNotice(errorText(cause)));
    };
    return h(
      "section",
      { "aria-label": `${SETTINGS_TITLE} settings`, className: "grid gap-4" },
      file.state === "error" ? h("p", { role: "alert", className: "m-0 text-body-sm text-danger" }, file.error) : null,
      h(
        "div",
        { style: COLUMNS_STYLE },
        h(HostList, { list, selected, adding: !selected, ready, running: setup.state === "running", onSelect: select, onAdd }),
        h(
          "div",
          { className: "grid gap-4", style: DETAIL_STYLE },
          notice ? h("p", { role: "status", className: "m-0 text-body-sm text-secondary" }, notice) : null,
          selected
            ? h(HostDetail, {
                key: selected.id,
                host: selected,
                ready,
                busy: file.busy,
                active,
                signing: signing?.id === selected.id ? signing : null,
                signinHost,
                onSignIn: (harness) => {
                  resetSignIn();
                  setSigning({ id: selected.id, harness });
                },
                onShowSignIn: (id) => {
                  setSigning({ id, harness: run.harness });
                  select(id);
                },
                onCloseSignIn: () => setSigning(null),
                onSaved: (saved) => {
                  setNotice(`Saved ${saved.label}.`);
                  void refresh();
                },
                onRemove: remove,
              })
            : ready
              ? h(AddHostView, { active, disabled: file.busy, onOpenHost: select })
              : null,
        ),
      ),
    );
  }

  /** The Hosts page: Desktop's full-page surface and panel header, as the
   * Usage page draws them. The page owns its own scrolling. */
  function HostsPage() {
    return h(
      "div",
      { className: "h-full min-h-0" },
      h(
        "section",
        { "aria-label": SETTINGS_TITLE, "data-buzz-surface": "", "data-shape": "panel", className: "h-full min-h-0" },
        h(
          "div",
          { className: "flex h-full min-h-0 flex-col" },
          h(
            "header",
            { "data-buzz-ui": "", className: "panel-header", "data-variant": "default" },
            h("div", { className: "panel-header-title" }, h("div", { className: "panel-header-label" }, h("span", { className: "panel-header-label-icon", "aria-hidden": "true" }, h(icons.host, { size: PAGE_ICON_SIZE })), h("h2", null, SETTINGS_TITLE))),
          ),
          h("div", { style: PAGE_SCROLL_STYLE }, h("div", { style: PAGE_BODY_STYLE }, h(HostsView, { active: () => !disposed }))),
        ),
      ),
    );
  }

  /** Settings > Plugins > Tailscale hosts when Desktop has pages: how the
   * hosts stand, and the way to the page that manages them. */
  function HostsSummary() {
    const list = useStore(() => HOSTS);
    useStore(() => hosts);
    return h(
      "section",
      { "aria-label": `${SETTINGS_TITLE} settings`, className: "grid gap-4" },
      h("h2", null, SETTINGS_TITLE),
      h("p", { className: "m-0 text-body-sm text-secondary" }, LABELS.summaryIntro),
      list.length ? h(SettingsGroup, null, list.map((host) => h(PreferenceRow, { key: host.id, title: host.label, subtitle: hostLine(host) }))) : null,
      h("div", null, h(Button, { variant: "prominent", onClick: () => void openHostsPage?.() }, `Open ${SETTINGS_TITLE}`)),
    );
  }

  // Opens the Hosts page; set only when Desktop gives pages and navigation.
  let openHostsPage;

  /** The Settings card: a summary beside the page, or the whole view on a
   * Desktop with no pages, so that the hosts stay reachable there. */
  function HostsSettings({ active }) {
    return openHostsPage ? h(HostsSummary) : h(HostsView, { active });
  }

  // The first read, before the type: its picker title names the hosts. A
  // failed read leaves the list empty; the type still registers, so agents
  // made before stay listed, and every view says what is wrong.
  await readHostsFile();
  if (disposed) return;
  ctx.agents.register({
    id: TYPE_ID,
    title: pickerTitle(HOSTS),
    description: "Runs on your own Tailscale host, on any harness the host offers. The key stays on the host.",
    icon: icons.host,
    defaults: () => ({ config: cleanConfig({}) }),
    summary: (agent) => {
      const config = cleanConfig(agent.config);
      const saved = localStorage.getItem(STORE_PREFIX + agent.pubkey);
      const host = HOSTS.find((entry) => entry.id === saved) || HOSTS.find((entry) => entry.id === config.host);
      return [TYPE_TITLE, harnessTitle(host?.id, config.harness), config.model, host?.label].filter(Boolean).join(" · ");
    },
    Create,
    CreateModel,
    PanelFooter,
    provider: {
      snapshot: providerSnapshot,
      subscribe,
      check: () => refresh(),
      DialogBody,
    },
    tabs: [{ id: "settings", title: "Settings", role: "settings", splitSettings: true, component: Settings }],
    remote: {
      async provision({ name, picture, community, config }) {
        const clean = cleanConfig(config);
        const host = hostById(clean.host);
        // Refuse before a key is made: an agent on a harness that cannot
        // take a turn would sit there mute.
        const offered = parseHarnesses(await call(host, "GET", "/harnesses", undefined, HARNESS_TIMEOUT_MS));
        const entry = offered.find((item) => item.id === clean.harness);
        if (!entry || !entry.ready)
          throw new RunnerError(
            `${(entry && entry.title) || clean.harness} is not ready on ${host.label}: ${(entry && entry.message) || "not offered"}.`,
            { op: "provision", host: host.id, harness: clean.harness },
          );
        const created = await call(host, "POST", "/agents", {
          name,
          community,
          ...(picture ? { picture } : {}),
        });
        if (!created || !HEX64.test(created.pubkey))
          throw new RunnerError(`${host.label} returned no valid agent pubkey.`, { op: "provision" });
        await requireNewKey(host, created.pubkey);
        remember(created.pubkey, host.id);
        return { pubkey: created.pubkey, ...(created.picture ? { picture: created.picture } : {}) };
      },
      async activate({ pubkey, name, community, auth, config }) {
        const host = (await locate(pubkey)) || hostById(cleanConfig(config).host);
        await call(host, "POST", `/agents/${pubkey}/activate`, { name, community, auth, config: runtimeConfig(config) }, ACTIVATE_TIMEOUT_MS);
      },
      async profile({ pubkey, name, picture }) {
        const host = await locate(pubkey);
        if (!host) throw new RunnerError("No host knows this agent.", { op: "profile" });
        await call(host, "PUT", `/agents/${pubkey}/profile`, { name, ...(picture ? { picture } : {}) });
      },
      async interrupt({ pubkey, channelId, threadRootId }) {
        const host = await locate(pubkey);
        if (!host) return false;
        const result = await call(host, "POST", `/agents/${pubkey}/interrupt`, { channelId, threadRootId });
        return !!result?.interrupted;
      },
      async remove({ pubkey }) {
        const host = await locate(pubkey);
        // An agent no host knows is already gone, which counts as removed.
        if (host) await call(host, "DELETE", `/agents/${pubkey}`);
        forget(pubkey);
      },
    },
  });

  // The page and the card are optional: inside scopes, so the agent type still
  // works on a Desktop without them. The page's scope comes first: the card
  // shows a summary when the page exists, and the whole view when it does not.
  if (typeof ctx.inject === "function") {
    ctx.inject(["communityReader"], (scope) => void (communityReader = scope.communityReader));
    ctx.inject(["pages", "navigation"], (scope) => {
      scope.pages.register({ id: HOSTS_PAGE_ID, title: SETTINGS_TITLE, component: HostsPage, primary: true, icon: HOSTS_PAGE_ICON, layout: "workspace" });
      openHostsPage = () => scope.navigation.open({ version: 1, kind: "plugin", pluginId: PLUGIN_ID, pageId: HOSTS_PAGE_ID });
    });
    ctx.inject(["settingsCards"], (scope) => {
      scope.settingsCards.register({ id: SETTINGS_CARD_ID, title: SETTINGS_TITLE, group: SETTINGS_GROUP, icon: icons.host, component: HostsSettings });
    });
  }

  if (typeof ctx.effect === "function")
    ctx.effect(() => {
      void refresh();
      const timer = setInterval(() => void refresh(), STATUS_POLL_MS);
      return () => {
        disposed = true;
        clearInterval(timer);
        helper.stop("The plugin stopped.");
      };
    });
  else void refresh();
}
