#!/usr/bin/env bash
# setup.sh: the root half of a host setup from the plugin's Settings page
# (scripts/host-setup.mjs). The helper copies a runner tree into a fresh
# stage folder on the host over Tailscale SSH, then runs this script as root
# from it. One script, so that the install and the serve step are one root
# session with one sudo password, and the stage is removed on every exit.
#
# Usage (as root): setup.sh <stage-dir> <https-port> <node>
#   <stage-dir>   the folder the helper made: /tmp/buzz-runner-setup.<random>
#   <https-port>  the tailnet HTTPS port for `tailscale serve`
#   <node>        the Node the runner runs on, one of NODE_PATHS
#
# stdout: install.sh's lines, and one `@@step <name>` line as each step
# starts, which the helper turns into the page's progress. No line holds a
# secret: the sudo password never reaches this script.
#
# Exit: 0 done; 64 wrong arguments; 77 the machine has no ACL tag; 79 a
# non-root user can change the Node (not 78, which install.sh uses for its
# own config errors); other codes come from install.sh or tailscale.
set -euo pipefail
umask 022

# The helper makes the stage with Node's mkdtemp and this prefix; anything else
# is refused, because the script removes the stage as root.
readonly STAGE_RE='^/tmp/buzz-runner-setup\.[A-Za-z0-9]{6,}$'
readonly PORT_RE='^[1-9][0-9]{0,4}$'
readonly PORT_MAX=65535
# install.sh's defaults (RUNNER_DIRNAME): the config it keeps and the socket
# the runner listens on.
readonly CONFIG_PATH=/etc/buzz-runner/config.json
readonly SOCKET_PATH=/run/buzz-runner/api.sock
# The Node paths the helper may name (scripts/host-setup.mjs NODE_PATHS). The
# first is for the runner only, so that a newer Node there does not change
# the system Node that other tools need. sudo clears the environment, so the
# path comes as an argument and only these are taken.
readonly NODE_PATHS=(/opt/buzz-runner/node /usr/bin/node)
# The most symlinks to follow from a Node path to its file.
readonly LINK_MAX=8
readonly EX_USAGE=64
readonly EX_NOPERM=77
readonly EX_UNSAFE_NODE=79

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

# The root runner runs this Node, so a user who can change it, or a link or
# folder on its way (for example a version manager in a home), could run
# code as the runner. Every hop of the link chain and the last file pass
# root_only.
node_root_only() {
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

[ $# -eq 3 ] || die "$EX_USAGE" "usage: setup.sh <stage-dir> <https-port> <node>"
stage=$1
port=$2
node=$3
[[ "$stage" =~ $STAGE_RE ]] || die "$EX_USAGE" "stage must match $STAGE_RE: $stage"
[[ "$port" =~ $PORT_RE ]] && [ "$port" -le "$PORT_MAX" ] || die "$EX_USAGE" "port must be 1-$PORT_MAX: $port"
[ -d "$stage" ] && [ ! -L "$stage" ] || die "$EX_USAGE" "no stage folder at $stage"
trap 'rm -rf -- "${stage:?}"' EXIT
known=0
for path in "${NODE_PATHS[@]}"; do [ "$node" = "$path" ] && known=1; done
[ "$known" -eq 1 ] || die "$EX_USAGE" "node must be one of ${NODE_PATHS[*]}: $node"
[ -x "$node" ] || die "$EX_USAGE" "no Node at $node"
node_root_only "$node" || die "$EX_UNSAFE_NODE" "a user who is not root can change $node or a folder above it; the root runner does not run it"

step install
# A config already on the host may hold the owner's own edits, so a first
# install takes the generated one and every later run keeps what is there.
if [ -f "$CONFIG_PATH" ]; then
	echo "setup.sh: keeping $CONFIG_PATH"
	NODE_BIN=$node /bin/bash "$stage/runner/deploy/install.sh" --bundle "$stage/runner/dist/buzz-runner.mjs"
else
	NODE_BIN=$node /bin/bash "$stage/runner/deploy/install.sh" --bundle "$stage/runner/dist/buzz-runner.mjs" --config "$stage/config.json"
fi

step serve
# On an untagged machine, serve names the machine's owner as the caller of a
# request from the machine itself, so a harness would pass the runner's
# allowlist (runner/README.md, "Security notes"). The serve step therefore
# needs a tag; the helper checks it too, but this is the last word.
tags=$(tailscale status --json | "$node" -e '
	let text = "";
	process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
		const tags = JSON.parse(text).Self?.Tags ?? [];
		process.stdout.write(String(tags.length));
	});
')
[ "$tags" -gt 0 ] || die "$EX_NOPERM" "this machine has no ACL tag; tag it in the Tailscale admin console, then run the setup again"
tailscale serve --bg --yes --https="$port" "unix:$SOCKET_PATH"

step 'done'
