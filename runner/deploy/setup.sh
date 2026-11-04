#!/usr/bin/env bash
# setup.sh: the root half of a host setup from the plugin's Settings page
# (scripts/host-setup.mjs). The helper copies a runner tree into a fresh
# stage folder on the host over Tailscale SSH, as the SSH user, then runs
# this script as root. One script, so that the install and the serve step
# are one root session with one sudo password.
#
# Trust: the SSH user owns the stage, so any process of that user can change
# it until root reads it. So root never runs a file from the stage. The
# helper sends this script in the root command itself, not as a stage file.
# The script copies the files that the SHA-256 manifest lists into a fresh
# folder that only root can write, with bounded reads, and checks every file
# there against the manifest that the helper pins in the command. Only then
# do harnesses.sh and install.sh run, from that copy.
#
# Usage (as root): bash -c "<this script>" setup.sh <stage> <port> <node> <sha>
#   <stage>  the folder the helper made: /tmp/buzz-runner-setup.<random>
#   <port>   the tailnet HTTPS port for `tailscale serve`
#   <node>   a Node of NODE_PATHS: this script runs it, and a first install
#            gives it to the runner (an installed runner keeps its own Node)
#   <sha>    the SHA-256 of the stage's MANIFEST, in lowercase hex
#
# stdout: harnesses.sh's `@@harness` lines, install.sh's lines, one
# `@@step <name>` line as each step starts, which the helper turns into the
# page's progress, and one `@@agent-user <name>` line, for the page's sign-in
# command. No line holds a secret: the sudo password never reaches this
# script.
#
# Exit: 0 done; 64 wrong arguments; 77 the machine has no ACL tag; 79 a
# non-root user can change the Node (not 78, which install.sh uses for its
# own config errors); 80 the stage is not what the helper sent; 81 a
# non-root user can change the tailscale CLI; 82 a harness install failed
# (harnesses.sh says why); 69 no tailscale CLI at TAILSCALE_PATHS; other
# codes come from install.sh or tailscale.
set -euo pipefail
umask 077
# The root PATH, so that no folder of the SSH user names a program here.
# Programs outside it, such as the tailscale CLI, go by a fixed path.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# The helper makes the stage with Node's mkdtemp and this prefix. Root only
# reads the stage; the helper removes it as the SSH user.
readonly STAGE_RE='^/tmp/buzz-runner-setup\.[A-Za-z0-9]{6,}$'
# The root-only copy: under /run, which only root can write, and which a
# reboot clears if this script is killed before its own cleanup.
readonly COPY_TEMPLATE=/run/buzz-runner-setup.XXXXXXXXXX
# The stage file that lists `<sha256>  <path>` for every other stage file.
readonly MANIFEST=MANIFEST
readonly SHA_RE='^[0-9a-f]{64}$'
# A manifest line as sha256sum writes it, for the paths the helper's unpack
# program accepts (scripts/host-setup.mjs UNPACK).
readonly MANIFEST_LINE_RE='^[0-9a-f]{64}  (runner/[A-Za-z0-9._/-]+|config\.json)$'
# /run is a small tmpfs that the whole machine needs, and the SSH user can
# grow a stage file while root reads it. So root reads at most these bytes
# from the stage: the manifest, then all listed files together. The helper
# refuses a bigger stage before the copy (host-setup.mjs STAGE_BYTES_MAX).
readonly MANIFEST_BYTES_MAX=65536
readonly STAGE_BYTES_MAX=16777216
# The dd block size for the bounded reads.
readonly READ_BLOCK=65536
readonly PORT_RE='^[1-9][0-9]{0,4}$'
readonly PORT_MAX=65535
# The socket's name in the runtime folder (/run/<RUNNER_DIRNAME>), as
# install.sh's last note and config.example.json name it.
readonly SOCKET_NAME=api.sock
# The Node paths the helper may name (scripts/host-setup.mjs NODE_PATHS). The
# first is for the runner only, so that a newer Node there does not change
# the system Node that other tools need. sudo clears the environment, so the
# path comes as an argument and only these are taken.
readonly NODE_PATHS=(/opt/buzz-runner/node /usr/bin/node)
# Where the tailscale CLI is on Linux (scripts/host-setup.mjs
# HOST_TAILSCALE_PATHS): the packages put it in /usr/bin, a manual install
# of the static binary often in /usr/local/bin, which the root PATH leaves
# out. The first that is there is used, and only if root alone can change it.
readonly TAILSCALE_PATHS=(/usr/bin/tailscale /usr/local/bin/tailscale)
# The most symlinks to follow from a program path to its file.
readonly LINK_MAX=8
readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_NOPERM=77
readonly EX_UNSAFE_NODE=79
readonly EX_TAMPERED=80
readonly EX_UNSAFE_TAILSCALE=81
readonly EX_HARNESS=82
# install.sh's LOGIN_USER_RE: a login it would refuse gets no sign-in rule
# here, and the setup goes on without it.
readonly LOGIN_USER_RE='^[a-z_][a-z0-9_.-]{0,31}$'
# buzz-app's Pi package.json and lock in the copy (host-setup.mjs PI_DEPS):
# harnesses.sh installs the Pi packages from them.
readonly PI_DEPS=runner/pi

die() {
	echo "setup.sh: $2" >&2
	exit "$1"
}
step() { printf '@@step %s\n' "$1"; }

# Root owns the path and no group or other user can write it, and the same
# holds for every folder above it. Then only root can replace the file, or a
# link on the way to it.
root_only() {
	local path=$1 facts
	while :; do
		facts=$(stat -L -c '%u %a' -- "$path") || return 1
		[ "${facts% *}" -eq 0 ] || return 1
		((8#${facts#* } & 8#022)) && return 1
		[ "$path" = / ] && return 0
		path=$(dirname -- "$path")
	done
}

# Root runs this program (the runner's Node, the tailscale CLI), so a user
# who can change it, or a link or folder on its way (for example a version
# manager in a home), could run code as root. Every hop of the link chain
# and the last file pass root_only.
program_root_only() {
	local hop=$1 target hops=0
	root_only "$hop" || return 1
	while [ -L "$hop" ]; do
		hops=$((hops + 1))
		[ "$hops" -le "$LINK_MAX" ] || return 1
		target=$(readlink -- "$hop") || return 1
		case "$target" in
		/*) hop=$target ;;
		*) hop=$(dirname -- "$hop")/$target ;;
		esac
		root_only "$hop" || return 1
	done
	root_only "$(readlink -f -- "$1")"
}

# Reads one stage file into the copy, at most <max> bytes, and prints how
# many it read. Fails when the file itself is a link (nofollow), and never
# waits on a FIFO (nonblock), so a swap in the stage cannot stop the setup.
# nofollow does not cover a folder link on the path: such a read can come
# from any file outside the stage, but the <max> bound and the manifest
# check in copy_checked still hold for it. One byte over <max> is read, so
# that a bigger file shows as too big.
read_bounded() {
	local from=$1 to=$2 max=$3
	dd if="$from" of="$to" bs="$READ_BLOCK" count=$((max + 1)) \
		iflag=nofollow,nonblock,count_bytes conv=excl status=none || return 1
	stat -c %s -- "$to"
}

# Copies the files that the pinned manifest lists from the stage into the
# root-only folder, then checks the copy, so that install.sh reads exactly
# what the helper sent, and no user can change it after the check. Root
# reads only the listed paths, each with a bounded read, so a stage file that
# grows, or a file that is not listed, cannot fill /run. Fails if the
# manifest or any file differs, is missing or is too big.
copy_checked() {
	local from=$1 want=$2 to=$3 got size line path budget=$STAGE_BYTES_MAX
	size=$(read_bounded "$from/$MANIFEST" "$to/$MANIFEST" "$MANIFEST_BYTES_MAX") || return 1
	[ "$size" -le "$MANIFEST_BYTES_MAX" ] || return 1
	got=$(sha256sum <"$to/$MANIFEST") || return 1
	[ "${got%% *}" = "$want" ] || return 1
	# The pin makes the manifest the helper's own; the line check keeps every
	# path inside the copy all the same.
	[ -s "$to/$MANIFEST" ] || return 1
	while IFS= read -r line; do
		[[ "$line" =~ $MANIFEST_LINE_RE ]] || return 1
		path=${line:66}
		case "/$path/" in */../* | */./* | *//*) return 1 ;; esac
		mkdir -p -- "$to/$(dirname -- "$path")" || return 1
		size=$(read_bounded "$from/$path" "$to/$path" "$budget") || return 1
		budget=$((budget - size))
		[ "$budget" -ge 0 ] || return 1
	done <"$to/$MANIFEST"
	(cd -- "$to" && sha256sum --check --strict --quiet -- "$MANIFEST") || return 1
}

# The login that ran this script through sudo, for the sign-in rule
# (install.sh --login-user): Sign in then runs buzz-login with no second
# password. sudo itself sets SUDO_USER and SUDO_UID, and both must name the
# same account. Root, or no sudo at all (a root SSH login), needs no rule.
sudo_login() {
	local name=${SUDO_USER:-} uid=${SUDO_UID:-}
	[ -n "$name" ] && [ -n "$uid" ] && [ "$uid" != 0 ] || return 1
	[[ "$name" =~ $LOGIN_USER_RE ]] || return 1
	[ "$(id -u -- "$name" 2>/dev/null)" = "$uid" ]
}

[ $# -eq 4 ] || die "$EX_USAGE" "usage: setup.sh <stage> <https-port> <node> <manifest-sha256>"
stage=$1
port=$2
node=$3
sha=$4
[[ "$stage" =~ $STAGE_RE ]] || die "$EX_USAGE" "stage must match $STAGE_RE: $stage"
[[ "$port" =~ $PORT_RE ]] && [ "$port" -le "$PORT_MAX" ] || die "$EX_USAGE" "port must be 1-$PORT_MAX: $port"
[[ "$sha" =~ $SHA_RE ]] || die "$EX_USAGE" "the manifest hash must be 64 lowercase hex characters"
[ -d "$stage" ] && [ ! -L "$stage" ] || die "$EX_USAGE" "no stage folder at $stage"
known=0
for path in "${NODE_PATHS[@]}"; do [ "$node" = "$path" ] && known=1; done
[ "$known" -eq 1 ] || die "$EX_USAGE" "node must be one of ${NODE_PATHS[*]}: $node"
[ -x "$node" ] || die "$EX_USAGE" "no Node at $node"
program_root_only "$node" || die "$EX_UNSAFE_NODE" "a user who is not root can change $node or a folder above it; the root runner does not run it"
tailscale=
for path in "${TAILSCALE_PATHS[@]}"; do
	if [ -x "$path" ]; then
		tailscale=$path
		break
	fi
done
[ -n "$tailscale" ] || die "$EX_UNAVAILABLE" "no tailscale CLI at ${TAILSCALE_PATHS[*]}"
program_root_only "$tailscale" || die "$EX_UNSAFE_TAILSCALE" "a user who is not root can change $tailscale or a folder above it; root does not run it"

copy=$(mktemp -d "$COPY_TEMPLATE")
trap 'rm -rf -- "${copy:?}"' EXIT
copy_checked "$stage" "$sha" "$copy" || die "$EX_TAMPERED" "the stage at $stage is not what the helper sent; nothing was installed"

install_sh=$copy/runner/deploy/install.sh
bundle=$copy/runner/dist/buzz-runner.mjs
# An installed deployment keeps its own names, folders and Node, as the owner
# may have set them by hand (install.sh, "Each host value"); only a first
# install takes the Node the helper found. The values come from install.sh
# itself, so both scripts read the deployment the same way. INSTALLED_ROOT
# is a smoke run aid and must never point a root run elsewhere.
values=$(/usr/bin/env -u INSTALLED_ROOT /bin/bash "$install_sh" --print-values)
value() { sed -n "s/^$1=//p" <<<"$values"; }
dirname=$(value RUNNER_DIRNAME)

# Before the install, so that the runner starts with every harness there.
# The paths are the deployment's own, so an installed host with its own
# harness paths keeps them. harnesses.sh uses the Node that this script
# checked: its npm installs Pi.
step harnesses
/bin/bash "$copy/runner/deploy/harnesses.sh" "$node" "$copy/$PI_DEPS" \
	"$(value CLAUDE_DIR)" "$(value CODEX_BIN)" "$(value GOOSE_BIN)" "$(value PI_MODULES)" ||
	die "$EX_HARNESS" "a harness install failed (exit $?); the runner was not installed"

step install
runner_node=$node
if [ "$(value INSTALLED)" = 1 ]; then
	runner_node=$(value NODE_BIN)
	program_root_only "$runner_node" || die "$EX_UNSAFE_NODE" "a user who is not root can change the installed runner's Node $runner_node or a folder above it; the root runner does not run it"
	echo "setup.sh: keeping the installed deployment's values, with the Node at $runner_node"
fi
config_path=/etc/$dirname/config.json
login_args=()
if login=$(sudo_login && printf '%s' "$SUDO_USER"); then
	login_args=(--login-user "$login")
else
	echo "setup.sh: no sign-in rule: root, or no login that sudo names, ran this setup"
fi
# A config already on the host may hold the owner's own edits, so a first
# install takes the generated one and every later run keeps what is there.
if [ -f "$config_path" ]; then
	echo "setup.sh: keeping $config_path"
	NODE_BIN=$runner_node /bin/bash "$install_sh" --bundle "$bundle" "${login_args[@]}"
else
	NODE_BIN=$runner_node /bin/bash "$install_sh" --bundle "$bundle" --config "$copy/config.json" "${login_args[@]}"
fi
printf '@@agent-user %s\n' "$(value AGENT_USER)"

step serve
# On an untagged machine, serve names the machine's owner as the caller of a
# request from the machine itself, so a harness would pass the runner's
# allowlist (runner/README.md, "Security notes"). The serve step therefore
# needs a tag; the helper checks it too, but this is the last word.
tags=$("$tailscale" status --json | "$node" -e '
	let text = "";
	process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
		const tags = JSON.parse(text).Self?.Tags ?? [];
		process.stdout.write(String(tags.length));
	});
')
[ "$tags" -gt 0 ] || die "$EX_NOPERM" "this machine has no ACL tag; tag it in the Tailscale admin console, then run the setup again"
"$tailscale" serve --bg --yes --https="$port" "unix:/run/$dirname/$SOCKET_NAME"

step 'done'
