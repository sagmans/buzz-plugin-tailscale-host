# buzz-runner

Headless daemon that hosts Buzz agents on a Linux host for the `tailscale-host`
plugin.
It drives the official harness programs (`claude`, `codex`, `goose-acp`, Pi) in
the same way as Buzz Desktop 1.0.
It imports the Desktop harness modules from buzz-app without changes.

| Part | Source |
| --- | --- |
| Sessions, `claude` process, steering, `final` hook, 15 min idle stop | buzz-app `bundled/claude-code/{sessions,claude}.ts` |
| Codex, Goose and Pi clients, settings and model lists | buzz-app `bundled/{codex,goose,pi}`, `features/agent-harness/acp` |
| System prompt, turn prompt, steer prompt | buzz-app `bundled/claude-code/prompt.ts` |
| Buzz tools (in-process, over `mcp_message` or loopback MCP) | buzz-app `buzz-mcp/{rpc,tools,node}.ts` |
| Wake rule (addressing), owner `auth` tag check | buzz-app `features/agents/{attention,owner-attestation}.ts` |
| Typing pulses (kind 20002) | buzz-app `features/agents/typing.ts` |
| Live activity (kind 24200 observer frames, shaped as buzz-acp and claude-agent-acp) | this directory (`src/telemetry.ts`) |
| HTTP API (Unix socket), key store, NIP-42 live feed, sender gate, optional untagged publish, sudo spawn, limits | this directory (`src/`) |

Contract: [`../docs/RUNNER_CONTRACT.md`](../docs/RUNNER_CONTRACT.md). Harness
design: [`../docs/HARNESSES.md`](../docs/HARNESSES.md).

## Build

The runner has its own pinned build tools and libraries: `package.json` and
`pnpm-lock.yaml` in this directory. pnpm takes only versions that have been
public for 14 days (`pnpm-workspace.yaml`). The harness modules come from a
buzz-app clone at the revision in `src/constants.ts` (`BUZZ_APP_REV`). The
type check also reads the types of buzz-app's own packages, so the clone needs
its dependencies too.

```sh
git clone https://github.com/block/buzz-app.git <clone>
git -C <clone> checkout <BUZZ_APP_REV>
(cd <clone> && pnpm install --frozen-lockfile)
scripts/link-toolchain <clone>          # links runner/buzz-app (gitignored)
(cd runner && pnpm install --frozen-lockfile)
node scripts/build-runner.mjs           # type check, then runner/dist/buzz-runner.mjs (one file, Node >= 24)
node scripts/build-runner.mjs --out <dir>   # build somewhere else
node scripts/build-runner.mjs --check-only  # type check only
```

The build stops when the clone is at another revision or has local changes.
It also stops when a buzz-app module imports a package that `package.json`
does not declare. Add the package with a pinned version, then
`pnpm install` in this directory to update the lockfile.

## Smoke test (local, no real relay, no real harness)

```sh
node runner/smoke/run.mjs               # SMOKE_KEEP=1 keeps the temp dir and logs
BUZZ_RUNNER_BUNDLE=<dir>/buzz-runner.mjs node runner/smoke/run.mjs
```

| File | Purpose |
| --- | --- |
| `smoke/run.mjs` | Writes a temp config, a fake `sudo` and fake wrappers, starts the runner, checks every scenario |
| `smoke/mock-relay.mjs` | In-memory relay: NIP-11 `self`, `/query`, `/events` (NIP-98 checked), NIP-42 WebSocket |
| `smoke/fake-claude.mjs` | Speaks stream-json: `initialize`, turn, `tools/list` and `tools/call send`, `final` hook, `interrupt`. Modes by message word: `SLOW`, `HANG`, `MEDIA <url>`, `FLOOD`, `STUCK`, `MEMORY` |
| `smoke/fake-codex.mjs`, `smoke/codex.mjs` | Codex app-server stand-in and its scenarios |
| `smoke/fake-goose.mjs`, `smoke/goose.mjs` | `goose-acp` stand-in and its scenarios |
| `smoke/fake-pi.mjs`, `smoke/pi.mjs` | Pi host stand-in and its scenarios |
| `smoke/plugin.mjs` | Builds the plugin for a smoke host and drives it against the live runner |

## Deploy (systemd Linux, for example Ubuntu 24.04)

`deploy/install.sh` installs or updates everything as root. Run it again after
each build; it is idempotent.

The plugin's Settings page does the install and step 4 below (`tailscale
serve`) for you when you add a host, over Tailscale SSH (see the root
README, "Add a host from the app"). It copies the files to a stage folder
in `/tmp` as the SSH user. Root never runs a file from that folder: the root
command carries `deploy/setup.sh` itself, which copies the files that the
pinned SHA-256 manifest lists to a folder under `/run` that only root can
write. It reads at most 16 MiB of them, and no other stage file. It refuses
a listed file that is itself a link. A link to a folder on the way to that
file is followed, so the read can come from outside the stage; the size
limit and the manifest check still apply to it. It checks each copied file
against the manifest, and exits 80 on any difference or on a bigger file.
The SSH user removes the stage after the install. If the helper is killed
before that, the next copy to the machine removes the stage: it removes only
the SSH user's own stage folders whose time is more than twice the longest
setup in the past or in the future. The next setup also removes such a
helper's work folder (the bundle and `known_hosts`) from the temp folder of
the device that runs the app, by the same rule. The manual steps here stay
the reference.

```sh
sudo runner/deploy/install.sh --dry-run                     # show every step, change nothing
sudo runner/deploy/install.sh --config /path/to/config.json # first install
sudo runner/deploy/install.sh                               # update; keeps the installed config
```

| Flag | Effect |
| --- | --- |
| `--bundle FILE` | Runner bundle (default `runner/dist/buzz-runner.mjs`) |
| `--config FILE` | Install this config. Without it the installed config stays. A first install without it stops before start |
| `--no-start` | Install, but do not enable or restart |
| `--dry-run` | Print the steps; no root needed |
| `--print-values` | Print the names and paths below as `NAME=value` lines; change nothing |

Every name is an environment variable. A value comes from the environment
first. On a host where buzz-runner is installed, a value that the
environment does not set comes next from the installed unit, sudoers rule
and `buzz-login`, so a run again (and **Add host**) keeps the host's own
names. If the script cannot read an installed value, it stops with exit 78:
set that value in the environment.

This also applies to the harness pins (`CLAUDE_DIR`, `CODEX_BIN`,
`GOOSE_BIN`, `PI_MODULES`). An installed host keeps the harness paths that
it has, so a pin bump in this script does not reach it. To move an installed
host to a new pin, install that harness version at its path (see
[Harnesses](#harnesses)), then run the script again with the variable set to
that path.

The defaults apply to a first install:

| Variable | Default |
| --- | --- |
| `RUNNER_USER` | `buzz-runner` |
| `RUNNER_DIRNAME` | `buzz-runner` (`/var/lib/<name>`, `/run/<name>`, `/etc/<name>`) |
| `AGENT_USER` | `buzz-agent` |
| `AGENT_HOME` | `/home/$AGENT_USER` |
| `NODE_BIN` | `/usr/bin/node` (Node >= 24) |
| `LIB_DIR` | `/usr/local/lib/buzz-runner` |
| `LIBEXEC_DIR` | `/usr/local/libexec/buzz-runner` |
| `CLAUDE_WRAPPER` | `$LIBEXEC_DIR/claude-wrapper` |
| `HARNESS_WRAPPER` | `$LIBEXEC_DIR/harness-wrapper` |
| `HARNESS_ROOT` | `/usr/local/lib/buzz-harness` |
| `CLAUDE_DIR` | `$HARNESS_ROOT/claude/2.1.316` |
| `CODEX_BIN` | `$HARNESS_ROOT/codex/0.164.0/bin/codex` |
| `GOOSE_BIN` | `$HARNESS_ROOT/goose/1.57.0/goose-acp` |
| `PI_MODULES` | `$HARNESS_ROOT/pi/1.4.0/node_modules` |

What it does, in order. It stops at the first failure:

1. Checks every value, root, Linux, Node, and the tools the wrappers run by
   absolute path (`/usr/bin/prlimit`, `/usr/bin/setpriv`, `/usr/bin/flock`, from
   util-linux).
2. Checks the config (`deploy/check-config.mjs`): it must name the same users,
   paths and wrappers as this install, and not the example owner. A mismatch
   stops the run before any change.
3. Renders the wrappers, `buzz-login`, the unit and the sudoers rule for these
   values. The sudoers rule passes `visudo -cf` before it is installed.
4. Creates the runner user (system, no login shell, refused when it is in
   `sudo`, `admin`, `wheel`, `docker`, `lxd` or `adm`) and the harness user
   (home 0700, no login shell).
5. Installs the files (root-owned), the config (`root:<runner user>` 0640), and
   the unit, then enables and restarts the service.
6. Checks that the service is active and that `no_new_privs` is off (sudo needs
   setuid).

| User | Role | Rule |
| --- | --- | --- |
| `buzz-runner` | Runs the runner, owns the agent keys | System user, no login shell, NOT in any group with sudo or docker rights |
| `buzz-agent` | Runs every harness and owns the workspaces | Reached only through the two sudoers lines (one per wrapper) |

The owner's steps after install:

1. Install each harness at its pinned path (`CLAUDE_DIR`, `CODEX_BIN`,
   `GOOSE_BIN`, `PI_MODULES`), root-owned and read-only. Verify each download
   (checksum, signature or provenance) first. **Add host** does this step
   (see [Harnesses](#harnesses)).
2. Sign each harness in as the harness user: `sudo -u buzz-agent
   /usr/local/bin/buzz-login status`, then `buzz-login <harness>`.
3. Check sudo for the nologin user: `sudo -u buzz-runner sudo -n -u buzz-agent
   -- /usr/local/libexec/buzz-runner/claude-wrapper <64-hex> --version` prints
   the claude version.
4. Expose the API on the tailnet only: `tailscale serve --bg --https=10000
   unix:/run/buzz-runner/api.sock`. Limit the port to the owner in the tailnet
   policy. The host must be a tagged node (`tailscale up
   --advertise-tags=tag:<name>`): see the network note in
   [Security notes](#security-notes).
5. Check it as root: `curl -s --unix-socket /run/buzz-runner/api.sock -H
   'Tailscale-User-Login: <owner login>' http://runner/v1/health`.
6. Check that the host cannot call itself: `sudo -u buzz-agent curl -s -o
   /dev/null -w '%{http_code}\n' https://<host>.example.ts.net:10000/v1/health`
   must print `403`.

The API has no TCP listener. The runner refuses to start (exit 78) when the
socket directory is not 0700 or not owned by its uid, when another runner still
answers on the socket, or when something other than its own stale socket is at
the path.

Logs: `journalctl -u buzz-runner` (one JSON object per line).

### Node

The runner service and the harness wrapper (as root, through sudo) run on
Node 24 or later. A user who can change that Node, or a link or folder on
its way to it, could thus run code as root.

The setup from the Settings page gives the runner its own Node first, as
root, with `deploy/node-setup.sh`. The script comes in the root command, as
`deploy/setup.sh` does. It keeps a Node that is already at
`/opt/buzz-runner/node` when it is the pinned version or newer and only
root can change it. Otherwise it installs the pinned release:

1. It downloads `node-v<version>-linux-<x64|arm64>.tar.gz` from
   `nodejs.org` with `/usr/bin/curl` or, if there is none,
   `/usr/bin/wget`, into a new folder under `/opt/buzz-runner` that only
   root can write.
2. It checks the SHA-256 that the script pins, before it unpacks anything.
   The pin comes from the release's `SHASUMS256.txt`, whose signature was
   checked against the Node.js release keys when the pin was set.
3. It unpacks the release as root-owned files that no group or other user
   can write, to `/opt/buzz-runner/node-v<version>-linux-<arch>`, and
   points the link `/opt/buzz-runner/node` at its `bin/node` with one
   rename.

`/opt/buzz-runner/node` is for the runner only. It is on no `PATH`, so it
does not change the Node of other tools on the machine. The copy step and
`deploy/setup.sh` run on it, and a first install gives it to the runner.

`deploy/setup.sh` also takes `/usr/bin/node`, for a host that was set up
by hand. It refuses a Node path (exit 79) unless root owns the path, each
link on its way, the last file, and every folder above them, and no group
or other user can write any of them.

A runner that is already installed keeps the Node that its unit names,
which can be another path (for example one that `NODE_BIN` set at the first
install). `deploy/setup.sh` checks that Node in the same way.

To move to a newer Node, change the pin in `deploy/node-setup.sh` (the
version and both SHA-256 values), then run **Add host** again for the
machine: an older Node at the link is replaced. The installed runner keeps
the Node path that its unit names, which is the same link.

### Harnesses

The setup from the Settings page installs each missing harness as root,
with `deploy/harnesses.sh`, before it installs the runner. `deploy/setup.sh`
runs the script from its root-only copy of the stage, after the copy passed
the pinned manifest.

| Harness | Download | Check |
| --- | --- | --- |
| Claude Code | `claude` from `downloads.claude.ai` | SHA-256 from the release's signed `manifest.json` |
| Codex | `codex-package-<arch>-unknown-linux-musl.tar.gz` from the GitHub release | SHA-256 of the release asset |
| Goose | `goose-acp-<arch>-unknown-linux-gnu.tar.gz` from the GitHub release | The SHA-256 that buzz-app pins, with a GitHub attestation |
| Pi | `npm ci --ignore-scripts` of buzz-app's Pi lock, from `registry.npmjs.org` | The lock's integrity hashes, then `npm audit signatures` |

For each harness, the script does this:

1. A harness that is there stays as it is: an earlier setup, or your own
   install.
2. A missing harness whose path is not the pinned path stays missing. The
   page shows it as not installed.
3. Otherwise the script downloads the release into a new folder under
   `/usr/local/lib/buzz-harness` that only root can write. It checks the
   SHA-256 that it pins before it unpacks anything, makes every file
   root-owned and not writable by a group or other user, and moves the
   version folder into place with one rename.

npm runs on the runner's Node, with no npm config of the machine and no
package scripts. The Pi package files come from the buzz-app clone that the
runner bundle comes from, so `deploy/pi-launch.mjs` accepts the packages.

A failed download or check stops the setup before the runner install
(exit 82). Nothing of that harness is installed.

To move to a new harness version, change its pin in `deploy/harnesses.sh`,
`deploy/install.sh`, the wrappers and `deploy/buzz-login.mjs` (the smoke run
fails when they differ). An installed host keeps its harness paths, as
described in the Deploy section.

### Tailscale CLI

`deploy/setup.sh` runs `tailscale status` and `tailscale serve` as root.
Root's `PATH` there has only the system folders, so the script takes the
first of these paths that is there:

1. `/usr/bin/tailscale`: where the Tailscale packages put it.
2. `/usr/local/bin/tailscale`: a manual install of the static binary.

It refuses the path (exit 81) with the same rule as the Node: root owns the
path, each link on its way, the last file, and every folder above them, and
no group or other user can write any of them. With no CLI at these paths,
the setup stops before the copy.

### What the wrappers do

`deploy/claude-wrapper` starts `claude`; `deploy/harness-wrapper` starts
`codex`, `goose-acp` and Pi, and answers `--path` with the install it runs. The
runner gives a wrapper only argv (`<agentPk> <args…>`) and `PATH`. sudo resets
the environment anyway. Each wrapper:

| Step | Why |
| --- | --- |
| Checks that it runs as the harness user and that `<agentPk>` is 64 lowercase hex characters | It becomes a path |
| Makes `<workspaceRoot>/<agentPk>` (0700) and `cd`s into it | The model sees this as its working directory |
| Rebuilds the environment from nothing (`env -i`) with fixed values only | Drops `ANTHROPIC_API_KEY` and the `CLAUDE_*` session variables, so each harness uses the harness user's own sign-in |
| Sets `CLAUDE_CODE_ENTRYPOINT=sdk-ts`, `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`, `DISABLE_AUTOUPDATER=1` for `claude` | Desktop `ENV`. Without the session-state events, turns end on `result` instead of on idle |
| Keeps Codex, Goose and Pi state per agent under `~/.local/share/buzz-runner/<harness>/<agentPk>`, with shared sign-ins | One sign-in per host, no shared conversation state |
| Writes `1000` to `/proc/self/oom_score_adj` and stops if that fails | The runner has `-900`; the kernel must kill a harness first |
| `prlimit --core=0`, `--nproc`, and for `claude` `--nofile`; no `--as` or `--data` | No core dumps of agent context; V8 and Bun reserve much virtual memory, so an address-space limit breaks them |
| `setpriv --no-new-privs --inh-caps=-all` | A harness needs no privilege gain |
| Writes nothing to stdout itself; diagnostics go to stderr | The runner parses every stdout line, and stops a child whose line passes 8 MiB |
| `exec`s the harness as the last step | So stdin EOF and signals reach the harness, not a shell |

### Stopping `claude` under real sudo

The direct child is the root-owned `sudo`, so a signal from `buzz-runner` can
fail with EPERM. The stop sequence does not depend on signals:

| Step | Time | Effect |
| --- | --- | --- |
| Close stdin | 0 s | A stream-json `claude` exits on EOF. This is the primary stop |
| SIGTERM | 5 s | Best effort. A refusal logs `claude stop signal not delivered (sudo may run as root: EPERM); relying on stdin EOF` |
| SIGKILL | 10 s | Best effort, as above |
| Give up | 20 s | Logs `claude did not exit; giving up on it and freeing its turn`. The turn slot is free again |

A process left this way stays in the unit's cgroup until `systemctl stop
buzz-runner`, which kills the whole cgroup (`KillMode=mixed`).

Host test (not possible on macOS, where the smoke run has no second user):

1. Start a turn, then as root `kill -STOP <claude pid>` so that it ignores EOF.
2. `DELETE /v1/agents/<pk>` (or wait for the 30 min turn limit).
3. Expect the two log lines above within 20 s, and the stopped `claude` still
   present.
4. Send the next mention to another agent with `maxParallelTurns` slots busy: it
   runs, so the slot was freed.
5. `systemctl stop buzz-runner`: the stopped `claude` is gone (`pgrep -u
   buzz-agent claude` prints nothing).

### Runner stop (SIGTERM, SIGINT, delete, re-activation)

systemd sends SIGTERM and SIGKILLs what is left after `TimeoutStopSec=30`. A
killed `claude` can lose the end of its session file and shows as a "left-over
process" on the next start. So the runner stops its children itself, within 20
s:

| Step | Bound | Why |
| --- | --- | --- |
| Refuse new events, close the API | at once | No new turn can start during the stop |
| Interrupt each busy turn | 3 s | A turn may run 30 min, the stop has 20 s. An interrupt ends the turn at a safe point and `claude` writes its session file, so `--resume` works after the restart. The event is not run again (the cursor moved) and no failure message is posted |
| Stop every `claude` (stdin EOF, SIGTERM, SIGKILL, as above) and wait for each exit | 16 s | stdin EOF is the main path, because signals to the root `sudo` can fail with EPERM |
| Exit | 20 s in total | Below `TimeoutStopSec=30`. Past 20 s the runner logs `shutdown deadline passed; exiting` and exits 1 |

Every agent stops in parallel on its own budget. A delete or re-activation stops
only that agent, the same way, and never waits for other agents. One line
reports each stop; on shutdown, one line for all agents:

```json
{"level":"info","msg":"claude children stopped","component":"agents","children":2,"exited":2,"alive":0,"elapsedMs":3}
```

A delete adds `"agent":"<first 12 hex>"`. A `claude` still running at the
deadline is logged as `claude children still running at the stop deadline` with
its pids. `runner stopped` is logged only after the wait.

### Live-session cap (`maxLiveSessions`)

Each conversation keeps its `claude` for 15 min after its last turn, as Desktop
does. One idle `claude` holds about 190 MiB, so on a 2 GB host about 8 quiet
threads reach the OOM killer. `maxLiveSessions` (default 4) caps live `claude`
processes across all agents:

1. A turn that needs a new process asks the cap first. A turn for a conversation
   that already has a process does not.
2. At the cap, the runner stops the idle process used least recently (the saved
   session's last-use time), of any agent. A process that is busy, still
   starting, or has a runner turn on its way is never chosen. The log line is
   `idle session stopped for the live-session cap`.
3. The saved session stays, so the next message in that conversation starts
   `claude --resume <id>`, as after the 15 min idle stop.
4. When every live process is busy, the turn waits, in arrival order, until one
   is idle (`live-session cap reached and every session is busy; turn waits`,
   then `session slot free; turn continues`). It is never refused. Busy
   processes are bounded by `maxParallelTurns`, so set `maxParallelTurns` <=
   `maxLiveSessions`.

buzz-app's `AgentSessions` is imported unchanged and has no cap. The runner
stops a process through the only public stop that keeps the saved session:
`reconfigure()`, which stops a process whose settings fingerprint changed, and
only if it is idle, in one synchronous step. For that step the runner reports a
fingerprint no settings produce for the chosen conversation. Other idle
processes whose settings already changed stop with it, which `reconfigure()`
does anyway.

### Harnesses (`harnesses`)

The plugin makes one hosted agent type: `tailscale-host`, shown as "Tailscale
host". Desktop locks the type of a hosted agent, so the harness is a setting
inside the type, not a type. The Harness field (New agent dialog and Settings >
runtime) lists every harness that `GET /v1/harnesses` lists, in Desktop's order.
A harness that is not ready is shown but cannot be picked; its text is the
runner's message. A new harness starts on its default model and thinking. The
agent summary is `Tailscale host · <harness> · <model> · <host>`. To add a
harness: add it to `harnesses` and add runner support. The plugin does not
change.

| Harness | Started through | Readiness source |
| --- | --- | --- |
| `claude-code` | `wrapper` (`claude-wrapper`) | `claude --version` and `claude auth status --json` through the wrapper, as Desktop's provider menu (cached 60 s). Models: a `claude` in discovery mode (`--safe-mode`, no tools), cached 10 min, admitted under `maxLiveSessions` |
| `codex`, `goose`, `pi` | `harnessWrapper` (`harness-wrapper <id>`) | Ready when installed: the configured `path` exists and is the path `harness-wrapper <id> --path` reports. Provider sign-in is not a gate: a turn without one fails and the failure is posted in the thread. Models: a short discovery process of that harness (Codex `app-server`, `goose-acp`, a Pi host) |

An activated agent can move to another harness only when that harness is ready
on this runner; else activate and `PUT /config` give 409 `harness_unavailable`
with the reason. On a move, the runner stops the agent's sessions, drops its
saved sessions (they belong to the old program), saves the config and starts the
agent on the new harness. An agent whose harness is no longer offered is not
started at boot (`agent harness not offered on this runner; not started`).

`scope` (`thread` default, `channel`) is Desktop's Sessions setting: with
`channel`, every thread in a channel shares one `claude`, and what it has seen
is kept per thread.

### Why no cgroup per `claude`

A scope or slice per child needs `Delegate=yes` and cgroup management in the
runner, or `systemd-run --scope`, which needs root or polkit. Both add
privilege. All children stay in the unit's cgroup: `MemoryMax`, `TasksMax` and
the stop cover them, and `oom_score_adj` 1000 makes a `claude` the first OOM
victim.

## Config

Path: `--config <path>`, else `BUZZ_RUNNER_CONFIG`, else
`/etc/buzz-runner/config.json`. Unknown keys (also the old `listen`) and bad
values stop the start with exit code 78.

| Field | Required | Default | Rule |
| --- | --- | --- | --- |
| `ownerPubkey` | yes | — | 64 hex characters. Only this owner can activate agents and wake them |
| `allowedSenders` | no | `[]` | Extra pubkeys (64 hex) that can wake agents, with or without an owner `auth` tag |
| `acceptAttested` | no | `true` | As Desktop: a mention from an agent with a valid owner `auth` tag (desktop agents, this runner's other agents) wakes an agent. `false`: only `ownerPubkey` and `allowedSenders`, and this runner's other agents never wake one |
| `replyWake` | no | `true` | The owner's untagged thread reply wakes the agent it is for: the author of the replied message, else the thread's last agent of the owner. Same rule as the `sagmans.reply-wake` plugin, which cannot wake hosted agents. Owner messages only. `false`: only mentions and DMs wake |
| `allowedLogins` | yes | — | Tailnet logins that `tailscale serve` puts in `Tailscale-User-Login` |
| `relays` | yes | — | Allowed communities. `wss://` only (`ws://` only for loopback). No credentials, query or fragment |
| `socket` | no | `/run/buzz-runner/api.sock` | Absolute, at most 107 bytes. Its directory must be 0700 and owned by the runner user. Socket mode 0600 |
| `wrapper` | yes | — | Absolute path of the claude wrapper |
| `harnessWrapper` | no | `/usr/local/libexec/buzz-runner/harness-wrapper` | Absolute path of the wrapper for `codex`, `goose` and `pi` |
| `sudo` | no | `/usr/bin/sudo` | Absolute path |
| `runAsUser` | no | `buzz-agent` | Unix user name |
| `workspaceRoot` | no | `/home/buzz-agent/agents` | Shown to the model as `<root>/<agentPk>`. The runner does not write it |
| `stateDir` | no | `/var/lib/buzz-runner` | Keys, sessions, cursor, media (0700 dir, 0600 files) |
| `maxParallelTurns` | no | `2` | 1 to 16, for all agents together. Up to 100 more turns wait in a queue |
| `maxLiveSessions` | no | `4` | 1 to 32, live `claude` processes for all agents together. At the cap the least recently used idle one stops (it resumes on its next message); when all are busy, new turns wait. See [Live-session cap](#live-session-cap-maxlivesessions) |
| `harnesses` | no | all four, no paths | `{ "<id>": { "path"?: "/abs/path" } }`, offered in key order. Ids: `claude-code` `codex` `goose` `pi`. `path`: absolute and normalized, where that harness is installed. Not allowed for `claude-code` (`wrapper` starts it). See [Harnesses](#harnesses-harnesses) |
| `publishTelemetry` | no | `true` | Send live activity (kind 24200) to the owner's Desktop, as buzz-acp does. Frames hold prompts and tool input and output, NIP-44 encrypted to `ownerPubkey` only. `false`: none are sent |
| `attestEvents` | no | `true` | As Desktop: agent events carry the owner `auth` tag, so desktop agents can be woken by hosted agents. `false`: only the kind 0 profile carries it. NIP-42 AUTH and the `x-auth-tag` header always carry it |
| `model`, `effort` | no | — | Host defaults. The agent's own config has priority. `model` matches `^[A-Za-z0-9][A-Za-z0-9._:\-\[\]]*$`. `effort`: `low` `medium` `high` `xhigh` `max` |
| `logLevel` | no | `info` | `debug` `info` `warn` `error` |

## HTTP API

All requests need `Tailscale-User-Login` in `allowedLogins`, else 403 (before
routing). A missing and a wrong login get the same 403 body. Bodies must be
`application/json` and at most 64 KiB. Errors are `{error, message}`.

| Call | Success |
| --- | --- |
| `GET /v1/health` | `200 {ok, version, agents}` |
| `GET /v1/harnesses` | `200 {harnesses: [{id, title, supported, installed, ready, state, version?, account?, message?}]}`, in config order. `state`: `ready` `missing` `outdated` `signed-out` `error` |
| `GET /v1/harnesses/{id}/models` | `200 {current, models: [{id, label, efforts: [{id, label}], effort?}]}` with Desktop's labels; `default` and Claude's `max` are not listed. 404 when not offered, 409 `harness_unavailable` when not ready, 503 `busy` when every live session is busy |
| `POST /v1/agents {name, picture?, community}` | `200 {pubkey, picture?}`. The same name and community, not yet activated, returns the same agent. 409 `agent_limit` at 20 records; 429 `rate_limited` after 10 new agents in 10 min |
| `GET /v1/agents/{pk}` | `200 {pubkey, name, picture?, community, activated, config, workspace}` or 404. `config` always shows `harness` and `scope` |
| `POST /v1/agents/{pk}/activate {name, community, auth, config?}` | `204`. 400 `invalid_auth`, 409 when the community differs, 409 `harness_unavailable` for a harness the runner cannot run, or, on an activated agent, a new harness that is not ready. 502 `relay_unavailable` after 75 s; that work then stops at its next step, and the next call for the agent (for example a DELETE) waits until it has |
| `PUT /v1/agents/{pk}/profile {name, picture?}` | `204`. Publishes kind 0 again when activated |
| `PUT /v1/agents/{pk}/config {instructions?, model?, effort?, harness?, scope?}` | `204`. Idle sessions restart with it on their next message. Absent `harness` keeps the agent's. A changed `harness` on an activated agent moves it (see [Harnesses](#harnesses-harnesses)); 409 `harness_unavailable` when that harness is not ready; 400 for effort `max` on Claude (Desktop does not offer it) |
| `POST /v1/agents/{pk}/interrupt {channelId, threadRootId}` | `200 {interrupted}` |
| `DELETE /v1/agents/{pk}` | `204`, also when absent. The workspace is kept |

## Security notes

- **Network:** the API listens only on a Unix socket (0600) in a 0700 directory
  owned by `buzz-runner`. Only `buzz-runner` and root (`tailscaled`) can
  connect, so no local user can forge the login header. `tailscale serve` is the
  only way in. The allowlist check fails closed.
- **Tagged host:** a process on the host, such as a harness, can also reach
  `tailscale serve` over the tailnet. On an untagged node, serve names the
  node's owner as the caller and adds that login, so a harness would pass the
  allowlist and control every agent. Tailscale adds no identity headers for
  traffic from a tagged node, so on a tagged host such a call gets 403. Use a
  tagged host, and run the self-call check in section "Deploy", step 6.
- **Runner user:** `buzz-runner` is a system user without a login shell or
  sudo/docker groups. Its only privilege is the sudoers rule to run the two
  wrappers as `buzz-agent`.
- **Key custody:** each key is generated in the runner and stored in
  `stateDir/agents/<pk>.json` (0600, atomic write). It is used only in the
  runner process. It is never in a response, a log, the child argv or the child
  environment. Tool calls are signed in the runner. `claude` never holds the
  key. DELETE removes the key file. `LimitCORE=0` prevents core dumps.
- **Process isolation:** every harness runs as `buzz-agent` through two sudoers
  lines, one per wrapper. `buzz-agent` cannot read the files of `buzz-runner`.
  Agents share `buzz-agent`, so they can read each other's workspaces and the
  shared harness sign-ins. This is an accepted trade-off for one owner; one Unix
  user per harness or per agent would close it.
- **File tools:** the `path`/`files` arguments of the Buzz tools can read only
  an empty runner-owned directory. The runner user can read the key files, so a
  wider root would let a prompt post a key.
- **Wake gate (as Desktop):** a turn starts only for an event by `ownerPubkey`,
  by a pubkey in `allowedSenders`, or (with `acceptAttested`) by an agent whose
  single `auth` tag names `ownerPubkey`, is bound to that agent's pubkey, and
  has a valid BIP-340 signature. Forged, misbound or other-owner tags are
  dropped. An agent never wakes on its own events. With `replyWake`, an untagged
  owner thread reply also wakes the agent when the replied message, or else the
  newest earlier message by one of the owner's agents in that thread, is this
  agent's. The deciding event's signature is checked, and a failed read drops
  the event. Channel types and rosters are trusted only when signed by the relay
  key from NIP-11 `self`. Drops are logged with a reason and never with content.
- **Agent-to-agent traffic:** with the defaults, hosted and desktop agents of
  the same owner can mention and wake each other, as in Desktop. Two agents that
  keep mentioning each other can loop and spend turns; the parallel limit and
  the 30 min turn limit bound the cost, not the count. For a closed host set
  `acceptAttested: false` and `attestEvents: false`. Relay membership still
  works then through NIP-42 AUTH, the kind 0 profile and the `x-auth-tag`
  header, and memory stays encrypted to the owner.
- **Live scope (relay behaviour):** the relay gives a REQ without `#h` a
  community-global live scope, and that scope never matches channel events. Such
  a REQ returns stored events only (buzz-relay `handlers/req.rs`,
  `subscription.rs`). So the mention REQ names the agent's channels from the
  relay-signed rosters, is re-sent on every join or leave, and, when it holds
  more than one channel, is renewed on every probe tick, as Desktop does. The
  relay sends no roster live to the membership REQ. A join or leave after the
  connect arrives as a relay-signed membership notice (kind 44100 or 44101,
  `limit: 0`, also with `#t:["system"]`). The notice's channel joins or leaves
  the mention REQ at once. The relay sends the notice before it stores the
  roster and serves a cached channel list for 10 s, so the runner loads the
  rosters again 12 s after the last notice; a load has 15 s to finish, or the
  socket is replaced. A notice that the relay did not sign is dropped. The
  probe is Desktop's `{kinds:[44100], "#p":[agent], limit:0}`, with a fresh
  id each time.
- **Working signals:** while a turn runs, the agent sends typing (kind 20002,
  empty content, every 3 s, at most 30 min) where its reply goes, over `POST
  /events` like a reply, so it has the owner `auth` tag exactly when replies do.
  With `publishTelemetry`, it also sends observer frames (kind 24200, tags
  `p`=owner, `agent`, `frame`=`telemetry`) over its authenticated WebSocket: at
  most 1 frame per second per agent, coalesced and batched, large strings elided
  to fit the 65535-byte NIP-44 limit, a 4 MiB queue that drops the oldest. Each
  frame is NIP-44 v2 encrypted from the agent key to `ownerPubkey`. A frame that
  cannot be encrypted or sent is dropped and logged once per run of failures, by
  stage and frame kind only, never with content.
- **Cursor:** only admitted events move the catch-up cursor. Their `created_at`
  is clamped to now + 60 s, and events older than the subscription's `since` are
  dropped, so a future-dated event cannot make the runner skip messages.
- **Activation:** the `auth` tag must name `ownerPubkey` and carry a valid
  BIP-340 signature over `sha256("nostr:agent-auth:<pk>:")`. Conditional tags
  are rejected.
- **Limits:** request timeout 30 s, body 64 KiB, 20 agent records, 10 new agents
  per 10 min, one turn at most 30 min (interrupt, then stop after 60 s), stop of
  a `claude` bounded to 20 s, whole runner stop bounded to 20 s, at most
  `maxLiveSessions` live `claude` processes, one stdout line at most 8 MiB,
  downloaded media at most 200 MiB per agent (oldest removed first), global
  parallel limit, bounded retries with backoff and jitter, timeouts on every
  network call.
- **Failures:** the channel gets only a generic failure message. Details go to
  the log.
- **Logs:** JSON lines. Fields that can hold secrets or personal data (keys,
  signatures, auth tags, logins, message text) are redacted by name.
- **systemd:** `NoNewPrivileges` is off because sudo is setuid. The unit
  therefore uses only mount-namespace hardening (see the comments in
  `buzz-runner.service`). `OOMScoreAdjust=-900` keeps the runner alive under
  memory pressure.
