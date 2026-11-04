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
#   sudo runner/deploy/install.sh [--bundle FILE] [--config FILE] [--login-user NAME] [--no-start] [--dry-run]
#
#   --bundle FILE  the runner bundle (default: runner/dist/buzz-runner.mjs)
#   --config FILE  install FILE as the runner config (default: keep the
#                  installed one; a first install without it stops before
#                  start, with the example config to edit)
#   --login-user NAME
#                  let the login NAME run buzz-login as the harness user
#                  without a password, so that Sign in on the Settings page
#                  asks for none (default: keep the installed rule, if any);
#                  setup.sh passes the login that ran it through sudo
#   --no-start     install everything, but do not enable or restart
#   --dry-run      print every step, change nothing (no root needed)
#   --print-values print the host values as NAME=value lines and change
#                  nothing; setup.sh reads them before its install
#
# Each host value below comes from the environment first, for example
#   sudo AGENT_USER=agents NODE_BIN=/opt/node/bin/node runner/deploy/install.sh
# When buzz-runner is already installed, a value that the environment does
# not set comes next from the files that this script installed (the unit,
# the sudoers rule, buzz-login), so a run again keeps the names of that
# deployment. An installed value that cannot be read stops the run: set it
# in the environment. The defaults are for a first install only.
set -euo pipefail
umask 022

# ---- Host value defaults (first install) ----------------------------------
# The runner's system user; it owns the agent keys and nothing else.
readonly DEFAULT_RUNNER_USER=buzz-runner
# Name of the systemd state, runtime and config directories
# (/var/lib/<name>, /run/<name>, /etc/<name>).
readonly DEFAULT_RUNNER_DIRNAME=buzz-runner
# The harness user; every harness runs as it, through the wrappers only.
readonly DEFAULT_AGENT_USER=buzz-agent
readonly DEFAULT_HOME_PARENT=/home
# Node >= 24 for the runner, and >= 22.19 for Pi's launcher.
readonly DEFAULT_NODE_BIN=/usr/bin/node
readonly DEFAULT_LIB_DIR=/usr/local/lib/buzz-runner
readonly DEFAULT_LIBEXEC_DIR=/usr/local/libexec/buzz-runner
# Pinned harness installs; installing them is the owner's step (README).
readonly DEFAULT_HARNESS_ROOT=/usr/local/lib/buzz-harness
readonly PIN_CLAUDE=claude/2.1.316
readonly PIN_CODEX=codex/0.164.0/bin/codex
readonly PIN_GOOSE=goose/1.57.0/goose-acp
readonly PIN_PI=pi/1.4.0/node_modules
# The host values, in the order --print-values prints them.
readonly VALUE_NAMES='RUNNER_USER RUNNER_DIRNAME AGENT_USER AGENT_HOME NODE_BIN LIB_DIR LIBEXEC_DIR CLAUDE_WRAPPER HARNESS_WRAPPER CLAUDE_DIR CODEX_BIN GOOSE_BIN PI_MODULES'

# ---- Fixed names -----------------------------------------------------------
readonly SERVICE=buzz-runner
readonly UNIT_PATH=/etc/systemd/system/$SERVICE.service
readonly SUDOERS_PATH=/etc/sudoers.d/$SERVICE
readonly LOGIN_FRONT=/usr/local/bin/buzz-login
# The sign-in rule (--login-user), in its own file: install.sh reads the
# installed wrapper rules back from SUDOERS_PATH by their order, and a run
# without --login-user keeps this file as it is. No "." in the name, as
# sudo skips such files in /etc/sudoers.d.
readonly LOGIN_SUDOERS_PATH=/etc/sudoers.d/buzz-login
readonly NODE_MAJOR_MIN=24
# Groups that would let the runner user (and so a stolen agent session)
# become root or reach the container daemon.
readonly PRIVILEGED_GROUPS='sudo admin wheel docker lxd adm'
# The wrappers call these by absolute path (no PATH lookup as the harness
# user), as a usr-merged distribution places them.
readonly WRAPPER_TOOLS='/bin/bash /usr/bin/env /usr/bin/id /usr/bin/prlimit /usr/bin/setpriv /usr/bin/flock'
readonly USER_RE='^[a-z_][a-z0-9_-]{0,31}$'
# A login is an existing account, not one this script makes, so it may have
# a "." as the SSH login on the Settings page may (host-setup.mjs
# SSH_USER_RE). None of these characters is special in sudoers.
readonly LOGIN_USER_RE='^[a-z_][a-z0-9_.-]{0,31}$'
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
login_user=
start=1
dry_run=0
print_values=0

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
	--login-user)
		[ $# -ge 2 ] || die "$EX_USAGE" "--login-user needs a user name"
		login_user=$2
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
	--print-values)
		print_values=1
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*) die "$EX_USAGE" "unknown argument: $1 (see --help)" ;;
	esac
done

# ---- Host values -------------------------------------------------------------
# INSTALLED_ROOT lets the smoke run show an installed deployment from a
# folder. Only the two modes that change nothing take it, so a real run
# always reads the host's own files.
installed_root=${INSTALLED_ROOT:-}
if [ -n "$installed_root" ] && [ "$dry_run" -eq 0 ] && [ "$print_values" -eq 0 ]; then
	die "$EX_USAGE" "INSTALLED_ROOT needs --dry-run or --print-values"
fi

# installed FILE PREFIX [SUFFIX]: the value that render (below) put between
# PREFIX and SUFFIX on the one line of FILE that starts with PREFIX; nothing
# when the file, that one line or the suffix is not there.
installed() {
	local file=$installed_root$1
	[ -r "$file" ] || return 0
	awk -v pre="$2" -v suf="${3:-}" '
		index($0, pre) == 1 { n++; v = substr($0, length(pre) + 1) }
		END {
			if (n != 1) exit
			if (suf != "") {
				if (length(v) < length(suf) || substr(v, length(v) - length(suf) + 1) != suf) exit
				v = substr(v, 1, length(v) - length(suf))
			}
			print v
		}' "$file"
}

# installed_rule N: "<run-as user> <command>" of the Nth rule of the installed
# sudoers file, as the render below writes it (1: claude, 2: harness, in
# sudoers.template's order); nothing when that rule is not in that shape.
installed_rule() {
	local file=$installed_root$SUDOERS_PATH
	[ -r "$file" ] || return 0
	awk -v want="$1" '
		/^#/ || !NF { next }
		{ n++ }
		n == want && NF == 4 && $3 == "NOPASSWD:" && $2 ~ /^ALL=\([^)]+\)$/ {
			user = $2; sub(/^ALL=\(/, "", user); sub(/\)$/, "", user)
			print user " " $4
		}' "$file"
}

installed=0
i_runner_user='' i_dirname='' i_agent_user='' i_agent_home='' i_node='' i_lib_dir=''
i_libexec_dir='' i_claude_wrapper='' i_harness_wrapper='' i_claude_dir='' i_codex='' i_goose='' i_pi=''
if [ -f "$installed_root$UNIT_PATH" ]; then
	installed=1
	i_runner_user=$(installed "$UNIT_PATH" "User=")
	i_dirname=$(installed "$UNIT_PATH" "StateDirectory=")
	# render writes ExecStart as "<node> <lib>/buzz-runner.mjs --config /etc/<dir>/config.json".
	read -r exec_node exec_bundle exec_flag exec_config exec_rest <<<"$(installed "$UNIT_PATH" "ExecStart=")" || true
	if [ "${exec_bundle##*/}" = buzz-runner.mjs ] && [ "$exec_flag" = --config ] && [ "$exec_config" = "/etc/$i_dirname/config.json" ] && [ -z "$exec_rest" ]; then
		i_node=$exec_node
		i_lib_dir=${exec_bundle%/*}
	fi
	# render writes the harness home without its leading slash.
	home=$(installed "$UNIT_PATH" "ReadWritePaths=/")
	[ -z "$home" ] || i_agent_home=/$home
	login=$(installed "$LOGIN_FRONT" "readonly LOGIN=")
	[ "${login##*/}" != buzz-login.mjs ] || i_libexec_dir=${login%/*}
	if [ -n "$i_libexec_dir" ]; then
		login_mjs=$i_libexec_dir/buzz-login.mjs
		i_agent_user=$(installed "$login_mjs" 'const RUN_AS = "' '";')
		i_claude_dir=$(installed "$login_mjs" 'const CLAUDE_DIR = "' '";')
		i_codex=$(installed "$login_mjs" 'const CODEX_BIN = "' '";')
		i_goose=$(installed "$login_mjs" 'const GOOSE_BIN = "' '";')
		i_pi=$(installed "$login_mjs" 'const PI_MODULES = "' '";')
	fi
	read -r claude_user claude_cmd <<<"$(installed_rule 1)" || true
	read -r harness_user harness_cmd <<<"$(installed_rule 2)" || true
	# Both rules run as the harness user that buzz-login names; anything else
	# is not this script's sudoers file.
	if [ -n "$i_agent_user" ] && [ "$claude_user" = "$i_agent_user" ] && [ "$harness_user" = "$i_agent_user" ]; then
		i_claude_wrapper=$claude_cmd
		i_harness_wrapper=$harness_cmd
	fi
fi

# pick NAME FOUND DEFAULT: the environment's value, else the installed one
# (FOUND), else DEFAULT. A run again must not put default names next to an
# installed deployment, so an installed value that cannot be read stops it;
# only a dry run (which may lack root to read sudoers) goes on with DEFAULT.
pick() {
	local name=$1 found=$2 default=$3
	[ -z "${!name:-}" ] || return 0
	if [ "$installed" -eq 1 ]; then
		if [ -n "$found" ]; then
			printf -v "$name" '%s' "$found"
			return 0
		fi
		[ "$dry_run" -eq 1 ] || die "$EX_CONFIG" "buzz-runner is installed, but its $name cannot be read from the installed files; set $name in the environment"
		echo "install.sh: dry run: cannot read the installed $name; using $default" >&2
	fi
	printf -v "$name" '%s' "$default"
}
pick RUNNER_USER "$i_runner_user" "$DEFAULT_RUNNER_USER"
pick RUNNER_DIRNAME "$i_dirname" "$DEFAULT_RUNNER_DIRNAME"
pick AGENT_USER "$i_agent_user" "$DEFAULT_AGENT_USER"
pick AGENT_HOME "$i_agent_home" "$DEFAULT_HOME_PARENT/$AGENT_USER"
pick NODE_BIN "$i_node" "$DEFAULT_NODE_BIN"
pick LIB_DIR "$i_lib_dir" "$DEFAULT_LIB_DIR"
pick LIBEXEC_DIR "$i_libexec_dir" "$DEFAULT_LIBEXEC_DIR"
pick CLAUDE_WRAPPER "$i_claude_wrapper" "$LIBEXEC_DIR/claude-wrapper"
pick HARNESS_WRAPPER "$i_harness_wrapper" "$LIBEXEC_DIR/harness-wrapper"
# Only the defaults below use it; an installed deployment names each path.
HARNESS_ROOT=${HARNESS_ROOT:-$DEFAULT_HARNESS_ROOT}
pick CLAUDE_DIR "$i_claude_dir" "$HARNESS_ROOT/$PIN_CLAUDE"
pick CODEX_BIN "$i_codex" "$HARNESS_ROOT/$PIN_CODEX"
pick GOOSE_BIN "$i_goose" "$HARNESS_ROOT/$PIN_GOOSE"
pick PI_MODULES "$i_pi" "$HARNESS_ROOT/$PIN_PI"

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
if [ -n "$login_user" ]; then
	[[ "$login_user" =~ $LOGIN_USER_RE ]] || die "$EX_USAGE" "--login-user has an unsafe value: $login_user"
	# The runner user may start only the two wrappers, and the harness user
	# needs no rule to be itself.
	[ "$login_user" != "$RUNNER_USER" ] && [ "$login_user" != "$AGENT_USER" ] ||
		die "$EX_USAGE" "--login-user must be the owner's login, not $login_user"
fi
for name in AGENT_HOME NODE_BIN LIB_DIR LIBEXEC_DIR CLAUDE_WRAPPER HARNESS_WRAPPER CLAUDE_DIR CODEX_BIN GOOSE_BIN PI_MODULES; do
	check_value "$name" "${!name}" "$PATH_RE"
done

# Every value passed check_value, so no line can hold a space, a quote or a
# newline: setup.sh splits them at the first "=".
if [ "$print_values" -eq 1 ]; then
	echo "INSTALLED=$installed"
	for name in $VALUE_NAMES; do echo "$name=${!name}"; done
	exit 0
fi
[ "$installed" -eq 0 ] || note "updating the installed deployment of $UNIT_PATH; it keeps its names and paths unless the environment sets them"

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
	if [ -n "$login_user" ]; then
		login_uid=$(id -u -- "$login_user" 2>/dev/null) || die "$EX_USAGE" "--login-user names no user on this host: $login_user"
		# Root needs no rule, and a rule for it would only hide a mistake.
		[ "$login_uid" -ne 0 ] || die "$EX_USAGE" "--login-user must not be root"
	fi
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
# The sign-in rule: only buzz-login, by its fixed root-owned path, and only as
# the harness user. buzz-login gives that user nothing new (its header), so
# the rule saves the owner a second password, and grants no other program.
if [ -n "$login_user" ]; then
	{
		echo "# buzz-login: the owner's login may run the harness sign-in tool as the"
		echo "# harness user without a password (Sign in on the Settings page)."
		echo "# install.sh --login-user writes this file; delete it to ask again."
		echo "$login_user ALL=($AGENT_USER) NOPASSWD: $LOGIN_FRONT"
	} >"$stage/sudoers-login"
	note "sign-in rule for $LOGIN_SUDOERS_PATH: $(tail -n 1 -- "$stage/sudoers-login")"
fi
cp -- "$here/pi-launch.mjs" "$stage/pi-launch.mjs"

# ---- Users -----------------------------------------------------------------
if id -u "$RUNNER_USER" >/dev/null 2>&1; then
	note "runner user $RUNNER_USER exists"
else
	run useradd --system --home-dir "/var/lib/$RUNNER_DIRNAME" --no-create-home --shell /usr/sbin/nologin "$RUNNER_USER"
fi
# An existing account may be reused, so its groups are checked: a member of
# one of these groups reaches root (sudo) or its equivalent (docker, lxd), and
# no-new-privs in the wrappers does not stop a docker socket.
refuse_privileged() {
	local user=$1 group bad
	id -u "$user" >/dev/null 2>&1 || return 0
	for group in $(id -nG "$user"); do
		for bad in $PRIVILEGED_GROUPS; do
			[ "$group" != "$bad" ] || die "$EX_CONFIG" "$user is in group $bad; remove it (it must not reach root or docker)"
		done
	done
}
refuse_privileged "$RUNNER_USER"
if id -u "$AGENT_USER" >/dev/null 2>&1; then
	note "harness user $AGENT_USER exists"
else
	# No login shell: the owner reaches it only with `sudo -u` and a command.
	run useradd --create-home --home-dir "$AGENT_HOME" --shell /usr/sbin/nologin "$AGENT_USER"
fi
# Agents run their tools as this user, so it is held to the runner's rule.
refuse_privileged "$AGENT_USER"
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

# visudo checks each rendered rule before it can lock sudo out, and both
# before either is installed, so a bad sign-in rule leaves sudo as it was.
if [ "$dry_run" -eq 0 ]; then
	visudo -cf "$stage/sudoers" >/dev/null || die "$EX_SOFTWARE" "rendered sudoers rule does not parse"
	[ -z "$login_user" ] || visudo -cf "$stage/sudoers-login" >/dev/null || die "$EX_SOFTWARE" "rendered sign-in rule does not parse"
fi
run install -o root -g root -m 0440 "$stage/sudoers" "$SUDOERS_PATH"
# After buzz-login is in place above, so that the rule never names a
# missing tool.
[ -z "$login_user" ] || run install -o root -g root -m 0440 "$stage/sudoers-login" "$LOGIN_SUDOERS_PATH"
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
