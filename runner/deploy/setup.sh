#!/usr/bin/env bash
# setup.sh: the root half of a host setup from the plugin's Settings page
# (scripts/host-setup.mjs). The helper copies a runner tree into a fresh
# stage folder on the host over Tailscale SSH, then runs this script as root
# from it. One script, so that the install and the serve step are one root
# session with one sudo password, and the stage is removed on every exit.
#
# Usage (as root): setup.sh <stage-dir> <https-port>
#   <stage-dir>   the folder the helper made: /tmp/buzz-runner-setup.<random>
#   <https-port>  the tailnet HTTPS port for `tailscale serve`
#
# stdout: install.sh's lines, and one `@@step <name>` line as each step
# starts, which the helper turns into the page's progress. No line holds a
# secret: the sudo password never reaches this script.
#
# Exit: 0 done; 64 wrong arguments; 77 the machine has no ACL tag; other
# codes come from install.sh or tailscale.
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
# install.sh's NODE_BIN default; sudo clears the environment, so it is fixed.
readonly NODE_BIN=/usr/bin/node
readonly EX_USAGE=64
readonly EX_NOPERM=77

die() {
	echo "setup.sh: $2" >&2
	exit "$1"
}
step() { printf '@@step %s\n' "$1"; }

[ $# -eq 2 ] || die "$EX_USAGE" "usage: setup.sh <stage-dir> <https-port>"
stage=$1
port=$2
[[ "$stage" =~ $STAGE_RE ]] || die "$EX_USAGE" "stage must match $STAGE_RE: $stage"
[[ "$port" =~ $PORT_RE ]] && [ "$port" -le "$PORT_MAX" ] || die "$EX_USAGE" "port must be 1-$PORT_MAX: $port"
[ -d "$stage" ] && [ ! -L "$stage" ] || die "$EX_USAGE" "no stage folder at $stage"
trap 'rm -rf -- "${stage:?}"' EXIT

step install
# A config already on the host may hold the owner's own edits, so a first
# install takes the generated one and every later run keeps what is there.
if [ -f "$CONFIG_PATH" ]; then
	echo "setup.sh: keeping $CONFIG_PATH"
	/bin/bash "$stage/runner/deploy/install.sh" --bundle "$stage/runner/dist/buzz-runner.mjs"
else
	/bin/bash "$stage/runner/deploy/install.sh" --bundle "$stage/runner/dist/buzz-runner.mjs" --config "$stage/config.json"
fi

step serve
# On an untagged machine, serve names the machine's owner as the caller of a
# request from the machine itself, so a harness would pass the runner's
# allowlist (runner/README.md, "Security notes"). The serve step therefore
# needs a tag; the helper checks it too, but this is the last word.
tags=$(tailscale status --json | "$NODE_BIN" -e '
	let text = "";
	process.stdin.on("data", (chunk) => (text += chunk)).on("end", () => {
		const tags = JSON.parse(text).Self?.Tags ?? [];
		process.stdout.write(String(tags.length));
	});
')
[ "$tags" -gt 0 ] || die "$EX_NOPERM" "this machine has no ACL tag; tag it in the Tailscale admin console, then run the setup again"
tailscale serve --bg --yes --https="$port" "unix:$SOCKET_PATH"

step 'done'
