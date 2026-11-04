#!/usr/bin/env bash
# node-setup.sh: gives the runner its own Node when the machine has none
# that the setup may use, so that Add host on the plugin's Settings page
# needs no step by hand on the machine (scripts/host-setup.mjs, step
# "node"). The runner, its harness wrapper and the setup itself run on this
# Node as root, so only root may change it, and it is on no PATH: a newer
# Node here does not change the Node of other tools on the machine.
#
# Trust: the helper sends this script in the root command itself, as it does
# setup.sh, so root runs only what the helper sent. The release and its
# SHA-256 are pinned below. They come from the release's SHASUMS256.txt, whose
# signature was checked against the Node.js release keys
# (github.com/nodejs/release-keys) when the pin was set. Root downloads the
# archive into a folder that only root can write, checks the hash before it
# unpacks anything, and switches the link with one rename.
#
# Usage (as root): bash -c "<this script>" node-setup.sh
#
# stdout: one `@@node <path> <version>` line for the Node the runner gets.
#
# Exit: 0 done (or the pinned Node was already there); 69 a tool is missing
# or the download failed; 70 the archive is not what the pin names; 79 a
# user who is not root can change the install folder; 64 an unknown machine
# type.
set -euo pipefail
umask 022
# The root PATH, so that no folder of the SSH user names a program here.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# The pinned release (Node 24 LTS, a security release), and the SHA-256 of
# its .tar.gz per machine type. .tar.gz, not .tar.xz: gzip is on every
# Linux, xz is not.
readonly NODE_VERSION=24.22.1
readonly NODE_SHA256_X64=eb6728e77c576a35162c122c45ccadf224d89ff00abc8dae46cc2897c6002d7c
readonly NODE_SHA256_ARM64=33c37be234ba8bee041961047b19160f4d7d0f164e8e246f78bdd10feff148b3
readonly NODE_DIST=https://nodejs.org/dist
readonly VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+$'
# The folder and the link that setup.sh and host-setup.mjs NODE_PATHS name
# first. The release folder sits beside the link, so the link stays
# relative and the whole install is one root-only folder.
readonly PREFIX=/opt/buzz-runner
readonly LINK=$PREFIX/node
readonly WORK_TEMPLATE=$PREFIX/.node-setup.XXXXXXXXXX
# Download bounds: the archive is about 55 MB. A stalled link gives up after
# SPEED_TIME seconds below SPEED_LIMIT bytes per second.
readonly CONNECT_TIMEOUT_S=20
readonly DOWNLOAD_TIMEOUT_S=900
readonly SPEED_LIMIT=1024
readonly SPEED_TIME_S=60
# The most symlinks to follow from a program path to its file.
readonly LINK_MAX=8
readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_UNSAFE=79

die() {
	echo "node-setup.sh: $2" >&2
	exit "$1"
}

# root_only and program_root_only repeat setup.sh: each root script comes in
# its own command, so they cannot share a file on the machine.
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

# The version of the Node at a path, or nothing when it does not run.
node_version() {
	"$1" -p process.versions.node 2>/dev/null || true
}

# Whether version $1 is the pin or newer.
at_least_pin() {
	[ "$(printf '%s\n%s\n' "$NODE_VERSION" "$1" | sort -V | head -n 1)" = "$NODE_VERSION" ]
}

# Downloads one https URL to a file with the bounds above, by curl or, on a
# machine without it (a desktop install of Ubuntu), by wget.
fetch() {
	local url=$1 to=$2
	if [ -x /usr/bin/curl ]; then
		/usr/bin/curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout "$CONNECT_TIMEOUT_S" \
			--max-time "$DOWNLOAD_TIMEOUT_S" --speed-limit "$SPEED_LIMIT" --speed-time "$SPEED_TIME_S" -o "$to" -- "$url"
	elif [ -x /usr/bin/wget ]; then
		# wget has no bound on the whole download, so timeout gives it one.
		timeout "$DOWNLOAD_TIMEOUT_S" /usr/bin/wget -q --https-only --timeout="$SPEED_TIME_S" --tries=1 -O "$to" -- "$url"
	else
		die "$EX_UNAVAILABLE" "no /usr/bin/curl or /usr/bin/wget to download Node with"
	fi
}

case "$(uname -m)" in
x86_64) arch=x64 sha=$NODE_SHA256_X64 ;;
aarch64) arch=arm64 sha=$NODE_SHA256_ARM64 ;;
*) die "$EX_USAGE" "no Node pin for this machine type: $(uname -m)" ;;
esac
for tool in tar gzip sha256sum timeout; do
	command -v "$tool" >/dev/null || die "$EX_UNAVAILABLE" "no $tool on the machine"
done

# A Node that is already at the link stays when only root can change it and
# it is the pin or newer, so a run again changes nothing and a newer Node
# that the owner put there stays. An older one, also an earlier pin of this
# script, is replaced: a pin bump reaches the machine at the next setup.
if [ -e "$LINK" ] && program_root_only "$LINK"; then
	found=$(node_version "$LINK")
	if [[ "$found" =~ $VERSION_RE ]] && at_least_pin "$found"; then
		printf '@@node %s %s\n' "$LINK" "$found"
		exit 0
	fi
fi

install -d -m 0755 -o root -g root -- "$PREFIX"
root_only "$PREFIX" || die "$EX_UNSAFE" "a user who is not root can change $PREFIX or a folder above it"

release=node-v$NODE_VERSION-linux-$arch
work=$(mktemp -d "$WORK_TEMPLATE")
trap 'rm -rf -- "${work:?}"' EXIT
fetch "$NODE_DIST/v$NODE_VERSION/$release.tar.gz" "$work/node.tar.gz" ||
	die "$EX_UNAVAILABLE" "the download of $release failed"
got=$(sha256sum <"$work/node.tar.gz")
[ "${got%% *}" = "$sha" ] || die "$EX_SOFTWARE" "the download of $release does not match its pinned SHA-256; nothing was installed"
# Root owns every unpacked file, and no group or other user can write one,
# whatever the archive says.
tar -xzf "$work/node.tar.gz" -C "$work" --no-same-owner --no-same-permissions
[ -x "$work/$release/bin/node" ] || die "$EX_SOFTWARE" "$release has no bin/node"
chown -R root:root -- "$work/$release"
chmod -R go-w -- "$work/$release"
[ "$("$work/$release/bin/node" -p process.versions.node)" = "$NODE_VERSION" ] ||
	die "$EX_SOFTWARE" "$release does not run as Node $NODE_VERSION on this machine"

# An earlier run of this pin, or one stopped half way, is replaced whole.
rm -rf -- "${PREFIX:?}/$release"
mv -- "$work/$release" "$PREFIX/$release"
ln -sfn -- "$release/bin/node" "$work/node"
mv -Tf -- "$work/node" "$LINK"
program_root_only "$LINK" || die "$EX_UNSAFE" "a user who is not root can change $LINK after the install"
printf '@@node %s %s\n' "$LINK" "$NODE_VERSION"
