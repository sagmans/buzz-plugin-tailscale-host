# AGENTS.md

Guidance for coding agents that work in this repository.

## Project

A Buzz desktop plugin (plugin API version 1) and its host daemon. The
plugin adds the hosted agent type "Tailscale host"; the runner on a Linux
host keeps the agent keys and runs the harness turns. The README describes
the behavior, the install and the mobile behavior. Keep the README and
`docs/` true when you change behavior.

| Path | Purpose |
| --- | --- |
| `plugin/manifest.json`, `plugin/plugin.js` | Plugin source. Not installable as is: it has no hosts. |
| `scripts/build-plugin.mjs` | Builds `dist/` from `hosts.json` (gitignored; see `hosts.example.json`). |
| `runner/src/` | Runner source (TypeScript). Imports buzz-app modules unchanged. |
| `runner/smoke/` | End-to-end smoke scenarios: mock relay, fake harnesses, the built plugin. |
| `runner/deploy/` | Host install: `install.sh`, wrappers, sudoers template, `buzz-login`. |
| `scripts/build-runner.mjs`, `scripts/link-toolchain` | Runner build with a buzz-app clone at `BUZZ_APP_REV`. |
| `runner/package.json`, `runner/pnpm-lock.yaml`, `runner/pnpm-workspace.yaml` | The runner's own pinned packages and the 14-day minimum release age. |
| `docs/` | Runner contract (`RUNNER_CONTRACT.md`) and harness design (`HARNESSES.md`). |
| `scripts/check` | All repository checks. The Git hooks call it. |
| `scripts/setup-hooks`, `.githooks/` | Generic hooks and helpers, copied from a template. |
| `.githooks/<hook>.d/` | This repository's own hook checks. |

## Setup and checks

1. Run `scripts/setup-hooks` once after you clone.
2. Set up the runner toolchain once: `runner/README.md`, section "Build".
3. Run `scripts/check --quick` while you work, and `scripts/check` before
   you push. The full check builds the plugin and the runner and runs the
   smoke scenarios.

Never use `--no-verify`, and never change `core.hooksPath` or other Git
settings. Do not edit the files that come from the hook template:
`.githooks/*` (outside the `*.d/` folders), `.githooks/lib/` and
`scripts/setup-hooks`.

## Plugin rules

- `plugin/plugin.js` must stay one file with no runtime imports. Use
  `ctx.react` for React.
- `hosts.json` is the one host list. The plugin reads it at runtime
  through the build's one host process (`scripts/hosts-helper.mjs`), and
  every runner call goes through that helper. Never put a host list in
  `plugin/plugin.js` or app storage, and never grant network origins.
  Never add a `host` block to `plugin/manifest.json`; `scripts/check`
  rejects it. The helper's grant is security-relevant: keep its arguments
  fixed in the build, accept only the hosts in `hosts.json` and the `/v1`
  paths, and check every request before a write or a call.
- The helper's `setup` op (`scripts/host-setup.mjs`) runs root commands on
  a host and is security-relevant. **Add host** on the Settings page is its
  only caller. Keep these rules: a tagged Linux peer from `tailscale status`
  only, found by the address's MagicDNS name; committed runner code only,
  with a new bundle per setup; `ssh` pinned to Tailscale's host keys with
  no trust on first use; the sudo password on sudo's stdin only, never in
  argv, a file, a log, a progress event or plugin storage; one setup at a
  time; the stage folder removed on every exit. Add a smoke check for each
  rule you change (`runner/smoke/setup.mjs`).
- Do not change the manifest `id` (`sagmans.tailscale-host`), the type id
  (`tailscale-host`) or the storage key shapes. Saved agents match on them.
  A new storage shape needs a new key suffix and a migration.
- Change `plugin/plugin.js` and the runner API together, and update
  `docs/RUNNER_CONTRACT.md` in the same change.

## Runner rules

- Import buzz-app modules unchanged. Do not edit the buzz-app clone. A
  revision change goes through `BUZZ_APP_REV` and the smoke run.
- No new runtime dependencies. The runner is one bundled file. A package
  that a buzz-app module needs goes into `runner/package.json` with an exact
  version that is at least 14 days old; never lower the minimum release age.
- Every subprocess, socket and relay wait has a timeout. Each failure is
  logged once, as JSON, with its context and without secrets.
- The harness process never gets an agent key. Keep tools in the runner.
- `runner/deploy/install.sh` must stay idempotent and must check all input
  before it changes the host. Run it with `--dry-run` to see the plan.

## Code rules

- Put each fixed value in a named constant at the top of the file.
- Comments explain why the code exists, not what it does.
- Where code repeats buzz-app code, say so in a comment at those lines and
  keep `NOTICE` true.

## Tests

Do not add a unit test framework. Add or update a scenario in
`runner/smoke/` for each behavior change, and make sure that the scenario
fails without the change.

## Private data

This repository is public. Never commit names of people, private host or
tailnet names, real public keys, local home paths, issue tracker links or
secrets. Use neutral words, such as "the user" or `example.ts.net`.
`scripts/check` blocks the common shapes of such data.

## Commits

- Follow `.githooks/GIT_CONVENTION.md` (Conventional Commits with a body).
- Sign and sign off each commit: `git commit -s -S`.
- Make each commit one logical change, and make sure that `scripts/check`
  passes on it.
