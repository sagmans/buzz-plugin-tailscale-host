#!/usr/bin/env bash
# install.sh: installs or updates buzz-runner on one Linux host (systemd,
# sudo, util-linux). Safe to run again: users are created only when missing,
# files are replaced with the same or newer content, the config is replaced
# only when --config names one, and the service restarts only at the end.
#
# Why one script: the runner's safety rests on several root-owned pieces
# that must agree (the runner user, the harness user, two wrappers with
# fixed paths, one sudoers rule, the unit's sandbox, the config). Writing
# them by hand lets one drift; here they come from one set of values below.
#
# Usage (as root, from a checkout with a built bundle):
#   sudo runner/deploy/install.sh [--bundle FILE] [--config FILE] [--no-start] [--dry-run]
#
#   --bundle FILE  the runner bundle (default: runner/dist/buzz-runner.mjs)
#   --config FILE  install FILE as the runner config (default: keep the
#                  installed one; a first install without it stops before
#                  start, with the example config to edit)
#   --no-start     install everything, but do not enable or restart
#   --dry-run      print every step, change nothing (no root needed)
#
# Every value below can be set in the environment, for example
#   sudo AGENT_USER=agents NODE_BIN=/opt/node/bin/node runner/deploy/install.sh
# An existing deployment that uses other names keeps them by setting these.
set -euo pipefail
umask 022

# ---- Host values (environment overrides) --------------------------------
# The runner's system user; it owns the agent keys and nothing else.
RUNNER_USER=${RUNNER_USER:-buzz-runner}
# Name of the systemd state, runtime and config directories
# (/var/lib/<name>, /run/<name>, /etc/<name>).
RUNNER_DIRNAME=${RUNNER_DIRNAME:-buzz-runner}
# The harness user; every harness runs as it, through the wrappers only.
AGENT_USER=${AGENT_USER:-buzz-agent}
AGENT_HOME=${AGENT_HOME:-/home/$AGENT_USER}
# Node >= 24 for the runner, and >= 22.19 for Pi's launcher.
NODE_BIN=${NODE_BIN:-/usr/bin/node}
LIB_DIR=${LIB_DIR:-/usr/local/lib/buzz-runner}
LIBEXEC_DIR=${LIBEXEC_DIR:-/usr/local/libexec/buzz-runner}
CLAUDE_WRAPPER=${CLAUDE_WRAPPER:-$LIBEXEC_DIR/claude-wrapper}
HARNESS_WRAPPER=${HARNESS_WRAPPER:-$LIBEXEC_DIR/harness-wrapper}
# Pinned harness installs; installing them is the owner's step (README).
HARNESS_ROOT=${HARNESS_ROOT:-/usr/local/lib/buzz-harness}
CLAUDE_DIR=${CLAUDE_DIR:-$HARNESS_ROOT/claude/2.1.316}
CODEX_BIN=${CODEX_BIN:-$HARNESS_ROOT/codex/0.164.0/bin/codex}
GOOSE_BIN=${GOOSE_BIN:-$HARNESS_ROOT/goose/1.57.0/goose-acp}
PI_MODULES=${PI_MODULES:-$HARNESS_ROOT/pi/1.4.0/node_modules}

# ---- Fixed names -----------------------------------------------------------
readonly SERVICE=buzz-runner
readonly UNIT_PATH=/etc/systemd/system/$SERVICE.service
readonly SUDOERS_PATH=/etc/sudoers.d/$SERVICE
readonly LOGIN_FRONT=/usr/local/bin/buzz-login
readonly NODE_MAJOR_MIN=24
# Groups that would let the runner user (and so a stolen agent session)
# become root or reach the container daemon.
readonly PRIVILEGED_GROUPS='sudo admin wheel docker lxd adm'
# The wrappers call these by absolute path (no PATH lookup as the harness
# user), as a usr-merged distribution places them.
readonly WRAPPER_TOOLS='/bin/bash /usr/bin/env /usr/bin/id /usr/bin/prlimit /usr/bin/setpriv /usr/bin/flock'
readonly USER_RE='^[a-z_][a-z0-9_-]{0,31}$'
readonly DIRNAME_RE='^[a-z0-9][a-z0-9._-]{0,63}$'
readonly PATH_RE='^/[A-Za-z0-9._/+-]+$'
# How long the service may take to report active after a restart.
readonly START_WAIT_S=10
readonly EX_USAGE=64
readonly EX_SOFTWARE=70
readonly EX_NOPERM=77
readonly EX_CONFIG=78

here=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
runner_dir=$(dirname -- "$here")
bundle=$runner_dir/dist/buzz-runner.mjs
config_src=
start=1
dry_run=0

die() {
	echo "install.sh: $2" >&2
	exit "$1"
}
note() { echo "install.sh: $*"; }
# Every change goes through run, so --dry-run shows exactly what would happen.
run() {
	if [ "$dry_run" -eq 1 ]; then
		printf 'would run:'
		printf ' %q' "$@"
		printf '\n'
	else
		"$@"
	fi
}

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
	case "$1" in
	--bundle)
		[ $# -ge 2 ] || die "$EX_USAGE" "--bundle needs a file"
		bundle=$2
		shift 2
		;;
	--config)
		[ $# -ge 2 ] || die "$EX_USAGE" "--config needs a file"
		config_src=$2
		shift 2
		;;
	--no-start)
		start=0
		shift
		;;
	--dry-run)
		dry_run=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "$EX_USAGE" "unknown argument: $1 (see --help)" ;;
	esac
done

# ---- Validate inputs before any change ----------------------------------
check_value() {
	local name=$1 value=$2 pattern=$3
	[[ "$value" =~ $pattern ]] || die "$EX_USAGE" "$name has an unsafe value: $value"
	case "$value" in */../* | */.. | *//*) die "$EX_USAGE" "$name must be a plain path: $value" ;; esac
}
check_value RUNNER_USER "$RUNNER_USER" "$USER_RE"
check_value AGENT_USER "$AGENT_USER" "$USER_RE"
check_value RUNNER_DIRNAME "$RUNNER_DIRNAME" "$DIRNAME_RE"
[ "$RUNNER_USER" != "$AGENT_USER" ] || die "$EX_USAGE" "RUNNER_USER and AGENT_USER must differ: the harness user must not read the keys"
for name in AGENT_HOME NODE_BIN LIB_DIR LIBEXEC_DIR CLAUDE_WRAPPER HARNESS_WRAPPER CLAUDE_DIR CODEX_BIN GOOSE_BIN PI_MODULES; do
	check_value "$name" "${!name}" "$PATH_RE"
done

[ "$(uname -s)" = Linux ] || [ "$dry_run" -eq 1 ] || die "$EX_SOFTWARE" "buzz-runner runs on Linux only"
[ "$(id -u)" -eq 0 ] || [ "$dry_run" -eq 1 ] || die "$EX_NOPERM" "run as root (or with --dry-run)"
[ -f "$bundle" ] || die "$EX_USAGE" "no runner bundle at $bundle: build it with scripts/build-runner.mjs, or pass --bundle"
[ -z "$config_src" ] || [ -f "$config_src" ] || die "$EX_USAGE" "no config at $config_src"
for file in claude-wrapper harness-wrapper buzz-login buzz-login.mjs pi-launch.mjs check-config.mjs sudoers.template; do
	[ -f "$here/$file" ] || die "$EX_SOFTWARE" "missing $here/$file: run from a full checkout"
done
for file in README.md buzz-runner.service; do
	[ -f "$runner_dir/$file" ] || die "$EX_SOFTWARE" "missing $runner_dir/$file: run from a full checkout"
done

if [ "$dry_run" -eq 0 ]; then
	for tool in useradd visudo systemctl install; do
		command -v "$tool" >/dev/null || die "$EX_SOFTWARE" "missing $tool"
	done
	for tool in $WRAPPER_TOOLS; do
		[ -x "$tool" ] || die "$EX_SOFTWARE" "missing $tool (the wrappers run it by this path; util-linux provides prlimit, setpriv and flock)"
	done
	[ -x "$NODE_BIN" ] || die "$EX_CONFIG" "no Node at $NODE_BIN (set NODE_BIN)"
	node_major=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
	[ "$node_major" -ge "$NODE_MAJOR_MIN" ] || die "$EX_CONFIG" "Node $node_major at $NODE_BIN; the runner needs $NODE_MAJOR_MIN or newer"
fi

# The config must agree with what this run installs; checked before any
# change, so a wrong config leaves the host as it was.
config_dir=/etc/$RUNNER_DIRNAME
config_path=$config_dir/config.json
check_config() {
	"$NODE_BIN" "$here/check-config.mjs" "$1" \
		"runtimeDir=/run/$RUNNER_DIRNAME" \
		"stateDir=/var/lib/$RUNNER_DIRNAME" \
		"runAsUser=$AGENT_USER" \
		"workspaceRoot=$AGENT_HOME/agents" \
		"wrapper=$CLAUDE_WRAPPER" \
		"harnessWrapper=$HARNESS_WRAPPER" \
		"codex=$CODEX_BIN" \
		"goose=$GOOSE_BIN" \
		"pi=$PI_MODULES"
}
config_to_check=${config_src:-}
[ -n "$config_to_check" ] || [ ! -f "$config_path" ] || config_to_check=$config_path
if [ -n "$config_to_check" ]; then
	if [ -x "$NODE_BIN" ]; then
		check_config "$config_to_check" || exit "$EX_CONFIG"
	else
		note "dry run: no Node at $NODE_BIN, config not checked"
	fi
fi

stage=$(mktemp -d "${TMPDIR:-/tmp}/buzz-runner-install.XXXXXX")
trap 'rm -rf -- "${stage:?}"' EXIT

# ---- Render the root-owned files for this host -----------------------------
# render FILE OUT SUFFIX PREFIX VALUE [PREFIX VALUE]...: each PREFIX must
# start exactly one line of FILE; that line becomes PREFIX VALUE SUFFIX.
# awk index() compares plain text, so no value is read as a pattern.
render() {
	local src=$1 out=$2 suffix=$3
	shift 3
	cp -- "$src" "$out"
	while [ $# -ge 2 ]; do
		awk -v pre="$1" -v val="$2" -v suf="$suffix" '
			index($0, pre) == 1 { print pre val suf; n++; next }
			{ print }
			END { if (n != 1) exit 3 }
		' "$out" >"$out.next" || die "$EX_SOFTWARE" "cannot render '$1' in $src: it must start exactly one line"
		mv -- "$out.next" "$out"
		shift 2
	done
}

render "$here/claude-wrapper" "$stage/claude-wrapper" "" \
	"readonly RUN_AS=" "$AGENT_USER" \
	"readonly HOME_DIR=" "$AGENT_HOME" \
	"readonly AGENTS_ROOT=" "$AGENT_HOME/agents" \
	"readonly CLAUDE_BIN=" "$CLAUDE_DIR/claude"
render "$here/harness-wrapper" "$stage/harness-wrapper" "" \
	"readonly RUN_AS=" "$AGENT_USER" \
	"readonly HOME_DIR=" "$AGENT_HOME" \
	"readonly AGENTS_ROOT=" "$AGENT_HOME/agents" \
	"readonly STATE_ROOT=" "$AGENT_HOME/.local/share/buzz-runner" \
	"readonly NODE=" "$NODE_BIN" \
	"readonly PI_MODULES=" "$PI_MODULES" \
	"readonly PI_LAUNCH=" "$LIBEXEC_DIR/pi-launch.mjs" \
	"readonly GOOSE_BIN=" "$GOOSE_BIN" \
	"readonly CODEX_BIN=" "$CODEX_BIN"
render "$here/buzz-login" "$stage/buzz-login" "" \
	"readonly RUN_AS=" "$AGENT_USER" \
	"readonly HOME_DIR=" "$AGENT_HOME" \
	"readonly NODE=" "$NODE_BIN" \
	"readonly LOGIN=" "$LIBEXEC_DIR/buzz-login.mjs"
render "$here/buzz-login.mjs" "$stage/buzz-login.mjs" '";' \
	'const RUN_AS = "' "$AGENT_USER" \
	'const HOME_DIR = "' "$AGENT_HOME" \
	'const CLAUDE_DIR = "' "$CLAUDE_DIR" \
	'const CODEX_BIN = "' "$CODEX_BIN" \
	'const GOOSE_BIN = "' "$GOOSE_BIN" \
	'const PI_MODULES = "' "$PI_MODULES"
render "$runner_dir/buzz-runner.service" "$stage/$SERVICE.service" "" \
	"User=" "$RUNNER_USER" \
	"Group=" "$RUNNER_USER" \
	"ExecStart=" "$NODE_BIN $LIB_DIR/buzz-runner.mjs --config /etc/$RUNNER_DIRNAME/config.json" \
	"StateDirectory=" "$RUNNER_DIRNAME" \
	"RuntimeDirectory=" "$RUNNER_DIRNAME" \
	"ConfigurationDirectory=" "$RUNNER_DIRNAME" \
	"ReadWritePaths=/" "${AGENT_HOME#/}"
# The sudoers rule names only the two wrappers, as the harness user.
awk -v runner="$RUNNER_USER" -v agent="$AGENT_USER" -v claude="$CLAUDE_WRAPPER" -v harness="$HARNESS_WRAPPER" '
	/^#/ { print; next }
	/claude-wrapper$/ { print runner " ALL=(" agent ") NOPASSWD: " claude; n++; next }
	/harness-wrapper$/ { print runner " ALL=(" agent ") NOPASSWD: " harness; n++; next }
	NF { exit 3 }
	END { if (n != 2) exit 3 }
' "$here/sudoers.template" >"$stage/sudoers" || die "$EX_SOFTWARE" "sudoers.template must hold exactly the two wrapper rules"
cp -- "$here/pi-launch.mjs" "$stage/pi-launch.mjs"

# ---- Users -----------------------------------------------------------------
if id -u "$RUNNER_USER" >/dev/null 2>&1; then
	note "runner user $RUNNER_USER exists"
else
	run useradd --system --home-dir "/var/lib/$RUNNER_DIRNAME" --no-create-home --shell /usr/sbin/nologin "$RUNNER_USER"
fi
if id -u "$RUNNER_USER" >/dev/null 2>&1; then
	for group in $(id -nG "$RUNNER_USER"); do
		for bad in $PRIVILEGED_GROUPS; do
			[ "$group" != "$bad" ] || die "$EX_CONFIG" "$RUNNER_USER is in group $bad; remove it (it must not reach root or docker)"
		done
	done
fi
if id -u "$AGENT_USER" >/dev/null 2>&1; then
	note "harness user $AGENT_USER exists"
else
	# No login shell: the owner reaches it only with `sudo -u` and a command.
	run useradd --create-home --home-dir "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"
fi
run install -d -o "$AGENT_USER" -g "$AGENT_USER" -m 0700 "$AGENT_HOME"

# ---- Files -----------------------------------------------------------------
run install -d -o root -g root -m 0755 "$LIB_DIR" "$LIBEXEC_DIR"
run install -o root -g root -m 0644 "$bundle" "$LIB_DIR/buzz-runner.mjs"
run install -o root -g root -m 0644 "$runner_dir/README.md" "$LIB_DIR/README.md"
run install -o root -g root -m 0755 "$stage/claude-wrapper" "$CLAUDE_WRAPPER"
run install -o root -g root -m 0755 "$stage/harness-wrapper" "$HARNESS_WRAPPER"
run install -o root -g root -m 0644 "$stage/pi-launch.mjs" "$LIBEXEC_DIR/pi-launch.mjs"
run install -o root -g root -m 0644 "$stage/buzz-login.mjs" "$LIBEXEC_DIR/buzz-login.mjs"
run install -o root -g root -m 0755 "$stage/buzz-login" "$LOGIN_FRONT"

# visudo checks the rendered rule before it can lock sudo out.
if [ "$dry_run" -eq 0 ]; then
	visudo -cf "$stage/sudoers" >/dev/null || die "$EX_SOFTWARE" "rendered sudoers rule does not parse"
fi
run install -o root -g root -m 0440 "$stage/sudoers" "$SUDOERS_PATH"
run install -o root -g root -m 0644 "$stage/$SERVICE.service" "$UNIT_PATH"

# ---- Config ----------------------------------------------------------------
run install -d -o root -g "$RUNNER_USER" -m 0750 "$config_dir"
if [ -n "$config_src" ]; then
	# Readable by the runner, never writable by it.
	run install -o root -g "$RUNNER_USER" -m 0640 "$config_src" "$config_path"
elif [ -f "$config_path" ]; then
	note "keeping $config_path"
else
	note "no config yet: copy $runner_dir/config.example.json, edit it, and run again with --config <file>"
	start=0
fi

# ---- Service ---------------------------------------------------------------
run systemctl daemon-reload
if [ "$start" -eq 0 ]; then
	note "installed; not started"
	exit 0
fi
run systemctl enable "$SERVICE"
run systemctl restart "$SERVICE"
[ "$dry_run" -eq 0 ] || exit 0

for _ in $(seq "$START_WAIT_S"); do
	systemctl is-active --quiet "$SERVICE" && break
	sleep 1
done
systemctl is-active --quiet "$SERVICE" || die "$EX_SOFTWARE" "$SERVICE did not start: journalctl -u $SERVICE"
# sudo needs setuid; with no_new_privs set every turn would fail.
pid=$(systemctl show -p MainPID --value "$SERVICE")
grep -q '^NoNewPrivs:[[:space:]]*0$' "/proc/$pid/status" ||
	die "$EX_SOFTWARE" "$SERVICE runs with no_new_privs, so sudo cannot work: check local unit overrides"
note "$SERVICE is active. Expose it on the tailnet only:"
note "  tailscale serve --bg --https=10000 unix:/run/$RUNNER_DIRNAME/api.sock"
