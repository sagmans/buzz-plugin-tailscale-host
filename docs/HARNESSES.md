# Harnesses on hosted agents

This document describes how a hosted agent gets the same harness, model and
effort choices as a Desktop agent, and what differs. Paths are relative to
buzz-app's `src/` at the revision in `runner/src/constants.ts`
(`BUZZ_APP_REV`), unless they say otherwise.

## 1. Desktop's create dialog, profile and hosted hooks

### 1.1 Main fact

Desktop has no special path for local types. Claude, Codex, Pi and Goose are
bundled plugins that use the same `AgentType` contract as a hosted type
(`features/agents/service.ts`). A hosted type is an `AgentType` with
`remote`. `register()` rejects a hosted type that has `run`, `models` or
`timeoutMs`.

### 1.2 Design: one hosted type with a harness field

Desktop blocks any harness switch that involves a remote type
(`bundled/agents/AgentSettingsHost.tsx`). Several hosted types (one per
harness) would make the harness fixed after create. So the plugin registers
one type, "Tailscale host", and the harness is a setting inside it:

| Field | Where | Source |
| --- | --- | --- |
| Harness | New agent dialog, Settings > runtime | `GET /v1/harnesses`, in Desktop's order: Claude Code, Codex, Goose, Pi. A harness that is not ready is shown but cannot be picked |
| Model | Same | `GET /v1/harnesses/{id}/models`, with Desktop's labels, plus a custom entry |
| Thinking (effort) | Same | Per model, with Desktop's labels. Claude does not offer `max`, as in Desktop |
| Sessions | Settings > runtime | `thread` (default) or `channel`, as Desktop's Sessions setting |
| Workspace | Settings > runtime, read-only | `<workspaceRoot>/<agentPk>` on the host |
| Host | Dialog and Settings | The hosts in this build's `hosts.json` |

A harness change on an activated agent is allowed when the target harness is
ready on the host. The runner stops the agent's sessions, drops its saved
sessions (they belong to the old program), saves the config and starts the
agent on the new harness.

### 1.3 Differences from a Desktop agent

P = the plugin closes it, R = the runner closes it, U = a Desktop limit
(upstream).

| Item | Desktop agent | Hosted agent | Close |
| --- | --- | --- | --- |
| Harness choice | Claude, Codex, Pi, Goose | Same list, from the host | P+R |
| Model and effort pickers | `ModelPicker`, per model | Plugin selects with Desktop's labels and classes | P+R. Exact components: U |
| Instructions editor | `AgentInstructions` | A text area | Works. Exact component: U |
| Activity tab | Yes | No | U: needs a relay or activity injectable for external plugins |
| Composer per-turn model and effort | Yes | No | U: `models` is not allowed for hosted types |
| History tab, tabs from other plugins | Yes | No | U |
| Attention, watches, timers | Yes | No | U |
| Import and export, agent-made agents | Yes | No | U |
| Memory tab, public key, delete, rename, Stop | Yes | Yes | Done |
| Typing, live activity frames | Yes | Yes | Done (runner `src/telemetry.ts`) |

Upstream asks: export `ModelPicker`, `AgentInstructions` and `PreferenceRow`
to external plugins; allow `models` for hosted types; add a relay or
activity injectable for an Activity tab.

## 2. Harness bundles

| Item | Claude Code | Codex | Goose | Pi |
| --- | --- | --- | --- | --- |
| Process | One `claude` per conversation | One `codex app-server` per agent, one thread per conversation | One `goose-acp` per agent, one ACP session per conversation | One Pi host per agent |
| Protocol | stream-json on stdio | JSONL app-server on stdio | ACP (JSON-RPC) on stdio | Pi host line protocol on stdio |
| Buzz tools | In-process MCP over the control channel | Dynamic tools in the `buzz` namespace | Loopback HTTP MCP, per-session bearer token | `buzz_<name>` tools that call back over stdio |
| Steer and stop | stdin message; `interrupt` | `turn/steer`; turn interrupt | `_goose/unstable/session/steer`; `session/cancel` | `whenBusy:"steer"`; `conversation.abort` |
| Models | Discovery spawn, `initialize` models | `listModels` | `providers/list`, `supported-models/list` | Host `models` |
| Effort | Per model `supportedEffortLevels`, without `max` | Per model | Config option `thought_level` | `off` to `max`, clamped per model |
| State | `~/.claude` of the harness user | Per agent `CODEX_HOME`, shared `config.toml` and `auth.json` | Per agent data and state, shared config and `secrets.yaml` | Per agent SQLite under the runner state root |

### 2.1 What the runner imports

| Harness | Imported unchanged | Not imported (needs Desktop's store or Tauri) | Runner side |
| --- | --- | --- | --- |
| Claude Code | `bundled/claude-code/{sessions,claude,setup,prompt}.ts` | `runtime.ts` | `wrapperSpawn`, `ChildTracker`, live-session cap |
| Codex | `bundled/codex/{rpc,config,prompt}.ts`, `codexStep` from `runtime.ts` | `CodexRuntime` | `codex-engine.ts`, which follows Desktop's turn rules |
| Goose | `bundled/goose/{goose,sessions,setup}.ts`, `features/agent-harness/acp/*` | `runtime.ts` | `goose-engine.ts`, `mcp-server.ts` (loopback MCP, a port of `src-tauri/src/host_mcp.rs`) |
| Pi | `bundled/pi/{pi,setup}.ts` and the host source | `runtime.ts`, `launch.mjs` | `pi-engine.ts`, `deploy/pi-launch.mjs` (uses root-installed packages; no `npm ci` at run time) |

## 3. Host installs

Each harness is installed once by root, read-only, at a pinned path. The
wrappers run only those paths, and `harness-wrapper <id> --path` reports the
path, so the runner can tell an installed harness from a missing one.
**Add host** installs a missing harness with `runner/deploy/harnesses.sh`
(runner/README.md, "Harnesses").

| Harness | Default path | Supply chain checks |
| --- | --- | --- |
| Claude Code | `/usr/local/lib/buzz-harness/claude/<version>/claude` | The official release, checksum verified |
| Codex | `/usr/local/lib/buzz-harness/codex/<version>/bin/codex` | Release checksum and provenance |
| Goose | `/usr/local/lib/buzz-harness/goose/<version>/goose-acp` | The version and sha256 that buzz-app pins (`runtime/goose-acp.json`); GitHub artifact attestation |
| Pi | `/usr/local/lib/buzz-harness/pi/<version>/node_modules` | `npm ci --ignore-scripts` from buzz-app's Pi lock; `npm audit signatures`. `pi-launch.mjs` refuses packages that do not match the lock |

Use a minimum release age before you install a new version, unless the
version fixes a security issue.

## 4. Credentials

| Harness | Sign-in | Place | Scope |
| --- | --- | --- | --- |
| Claude Code | `claude auth login` as the harness user (`buzz-login claude`) | `~/.claude/` of the harness user | All agents on the host |
| Codex | `codex login --device-auth` or an API key on stdin (`buzz-login codex`) | `~/.codex/auth.json` | All agents on the host |
| Goose | Provider setup over ACP (`buzz-login goose`). `GOOSE_DISABLE_KEYRING=1`, so keys go to `secrets.yaml` (0600) | `~/.config/goose/` | All agents on the host |
| Pi | pi-ai `models.login` (`buzz-login pi`) | `~/.pi/agent/auth.json` | All agents on the host |

Rules:

- The owner signs in on the host with `buzz-login`, as the harness user:
  from the Settings page (**Sign in**, `scripts/host-signin.mjs`), or in a
  shell on the host.
- **Sign in** sends only fixed `buzz-login` commands. A key typed there goes
  from the page to the hosts helper and on to the terminal on the host. It
  is never saved or logged, and it is masked in the output that the page
  shows.
- Keys never go into plugin config, the create dialog, the runner API or
  runner logs.
- Agents share the harness user, so any agent can read every sign-in. This
  is accepted for one owner; one Unix user per harness or per agent would
  close it.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Memory: harness processes on a small host | `maxLiveSessions` counts every harness process; idle ones stop first |
| Loopback MCP for Goose can be reached by any local user | Per-session random bearer token, bound to 127.0.0.1, closed with the session |
| The shared harness user reads all provider keys | Accepted for one owner; split users later |
| Upstream API changes in buzz-app's harness modules | Imports are pinned to `BUZZ_APP_REV`; the smoke fakes match the protocols |
