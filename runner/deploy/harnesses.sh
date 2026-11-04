#!/usr/bin/env bash
# harnesses.sh: installs each harness that the host does not have yet at its
# pinned path, so that Add host on the plugin's Settings page needs no step
# by hand on the machine (setup.sh, step "harnesses"). The wrappers run only
# these paths (install.sh PIN_*), and the harness user runs the programs, so
# only root may change them.
#
# Trust: setup.sh runs this script from its root-only copy of the stage,
# after the copy passed the manifest that the helper pins, so root runs only
# what the helper sent. Each release and its SHA-256 are pinned below; the
# Pi packages are pinned by buzz-app's lock, whose integrity hashes npm
# checks. Root downloads into a folder that only root can write, checks the
# hash before it unpacks anything, and moves a complete install into place
# with one rename, so a stopped run leaves no half install at a pinned path.
#
# Usage (as root): harnesses.sh <node> <pi-deps> <claude-dir> <codex-bin>
#                  <goose-bin> <pi-modules>
#   <node>       the runner's Node; its own npm installs the Pi packages
#   <pi-deps>    the folder with buzz-app's Pi package.json and lock
#   <claude-dir> ... <pi-modules>  the host's harness paths, as install.sh
#                --print-values names them (CLAUDE_DIR, CODEX_BIN, GOOSE_BIN,
#                PI_MODULES)
#
# A harness that is there stays as it is. A missing harness is installed only
# when its path is the pinned one below: another path names a version that
# this script has no pin for, so it stays missing and the line says so.
#
# stdout: one `@@harness <name> <kept|installed|missing> <path>` line per
# harness, which the helper shows as the step's progress.
#
# Exit: 0 done; 64 wrong arguments or an unknown machine type; 69 a tool is
# missing or a download failed; 70 a download is not what its pin names; 79
# a user who is not root can change the install folder or the Node.
set -euo pipefail
umask 022
# The root PATH, so that no folder of the SSH user names a program here.
export PATH=/usr/sbin:/usr/bin:/sbin:/bin

# The pinned harness paths (install.sh DEFAULT_HARNESS_ROOT and PIN_*; the
# smoke run fails when they differ).
readonly HARNESS_ROOT=/usr/local/lib/buzz-harness
readonly CLAUDE_VERSION=2.1.316
readonly CODEX_VERSION=0.164.0
readonly GOOSE_VERSION=1.57.0
readonly PI_VERSION=1.4.0
readonly CLAUDE_PIN=$HARNESS_ROOT/claude/$CLAUDE_VERSION
readonly CODEX_PIN=$HARNESS_ROOT/codex/$CODEX_VERSION/bin/codex
readonly GOOSE_PIN=$HARNESS_ROOT/goose/$GOOSE_VERSION/goose-acp
readonly PI_PIN=$HARNESS_ROOT/pi/$PI_VERSION/node_modules
# Claude Code: the official binary per machine type. The SHA-256 values come
# from the release's manifest.json, whose signature was checked against the
# Claude Code release key when the pin was set.
readonly CLAUDE_URL=https://downloads.claude.ai/claude-code-releases/$CLAUDE_VERSION
readonly CLAUDE_SHA256_X64=fd13c70000fec3f2116dfbcbb6121210b4a29328bf0e46210a59dd594a67d824
readonly CLAUDE_SHA256_ARM64=55cdb8e162d190432696ea54010e0fca2e18d06fa7a7127fd563b9ffd4f22624
# Codex: the release package (bin/codex and the files it reads beside it).
# The static musl build runs on any Linux. SHA-256 from the release digest.
readonly CODEX_URL=https://github.com/openai/codex/releases/download/rust-v$CODEX_VERSION
readonly CODEX_SHA256_X64=3ec55053109608d5038f7e50750f7d25f768dfd740fef071aa710e2559b63aac
readonly CODEX_SHA256_ARM64=5918add6c7e9cf1e14a9af1b4c0f4bf1d24a43903faac26df5dc4c019ea91bd5
# Goose: the ACP server alone. The version and SHA-256 are the ones that
# buzz-app pins (runtime/goose-acp.json), which match the release digest and
# its GitHub attestation.
readonly GOOSE_URL=https://github.com/aaif-goose/goose/releases/download/v$GOOSE_VERSION
readonly GOOSE_SHA256_X64=647e4a68ff60ca6e49fee5d7b4c7a27a891b840c55e209b6830e05a2223ec7e7
readonly GOOSE_SHA256_ARM64=4c832916626f5743f3551d267c7068c46cbeea203ecc5ab77bfb4101845beb5f
# Pi: npm's public registry only, whatever an npmrc on the machine says.
readonly NPM_REGISTRY=https://registry.npmjs.org/
# The Node paths setup.sh accepts (setup.sh NODE_PATHS).
readonly NODE_PATHS=(/opt/buzz-runner/node /usr/bin/node)
readonly WORK_TEMPLATE=$HARNESS_ROOT/.harness-setup.XXXXXXXXXX
# Download bounds: the largest file (Claude Code) is about 330 MB. A stalled
# link gives up after SPEED_TIME_S seconds below SPEED_LIMIT bytes per second.
# Each harness ends within one download and its unpack, so the helper sees a
# line well within its idle bound (plugin.js SETUP_IDLE_MS).
readonly CONNECT_TIMEOUT_S=20
readonly DOWNLOAD_TIMEOUT_S=900
readonly SPEED_LIMIT=1024
readonly SPEED_TIME_S=60
readonly NPM_TIMEOUT_S=300
# The most symlinks to follow from a program path to its file.
readonly LINK_MAX=8
readonly EX_USAGE=64
readonly EX_UNAVAILABLE=69
readonly EX_SOFTWARE=70
readonly EX_UNSAFE=79

die() {
	echo "harnesses.sh: $2" >&2
	exit "$1"
}
report() { printf '@@harness %s %s %s\n' "$1" "$2" "$3"; }

# root_only and program_root_only repeat setup.sh: each root script reads
# them from its own file, so the checks stay next to their use.
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
		die "$EX_UNAVAILABLE" "no /usr/bin/curl or /usr/bin/wget to download the harnesses with"
	fi
}

# Downloads <url> to <file> and fails unless its SHA-256 is <sha>, so that
# nothing of a changed or broken download is unpacked or kept.
fetch_checked() {
	local name=$1 url=$2 file=$3 sha=$4 got
	fetch "$url" "$file" || die "$EX_UNAVAILABLE" "the download of $name failed: $url"
	got=$(sha256sum <"$file")
	[ "${got%% *}" = "$sha" ] || die "$EX_SOFTWARE" "the download of $name does not match its pinned SHA-256; nothing was installed"
}

# Makes the unpacked release root-owned and read-only for every other user,
# whatever the archive says, then moves it to <dest> in one rename. An
# earlier half install at <dest> (an older run, stopped half way) is replaced.
place() {
	local from=$1 dest=$2
	chown -R root:root -- "$from"
	chmod -R go-w -- "$from"
	install -d -m 0755 -o root -g root -- "$(dirname -- "$dest")"
	rm -rf -- "${dest:?}"
	mv -T -- "$from" "$dest"
}

# Whether harness <name> needs an install: it does not when <probe>, the
# file its path names, is there (an earlier setup, or the owner's own
# install), or when its path is not the pin, which this script cannot
# install.
needs_install() {
	local name=$1 path=$2 pin=$3 probe=${4:-$2}
	if [ -e "$probe" ]; then
		report "$name" kept "$path"
		return 1
	fi
	if [ "$path" != "$pin" ]; then
		echo "harnesses.sh: no $name at $path, which is not the pinned $pin; install it there by hand" >&2
		report "$name" missing "$path"
		return 1
	fi
	return 0
}

install_claude() {
	local dir=$work/claude
	mkdir -m 0755 -- "$dir"
	fetch_checked "Claude Code $CLAUDE_VERSION" "$CLAUDE_URL/linux-$arch/claude" "$dir/claude" "$claude_sha"
	chmod 0755 -- "$dir/claude"
	place "$dir" "$CLAUDE_PIN"
	report claude installed "$CLAUDE_PIN"
}

# The release archives unpack into the version folder: codex's bin/codex,
# goose's goose-acp. tar refuses absolute and `..` paths by default.
install_archive() {
	local name=$1 label=$2 url=$3 sha=$4 pin=$5 release=$6
	local dir=$work/$name
	mkdir -m 0755 -- "$dir"
	fetch_checked "$label" "$url" "$work/$name.tar.gz" "$sha"
	tar -xzf "$work/$name.tar.gz" -C "$dir" --no-same-owner --no-same-permissions
	rm -f -- "$work/$name.tar.gz"
	[ -f "$dir/${pin#"$release"/}" ] && [ -x "$dir/${pin#"$release"/}" ] || die "$EX_SOFTWARE" "$label has no ${pin#"$release"/}"
	place "$dir" "$release"
	report "$name" installed "$pin"
}

# Runs the runner's own npm in <dir> as root, with no config of the machine
# or the SSH user (an npmrc could name another registry or a script), and
# within NPM_TIMEOUT_S. Its output goes to stderr, so stdout keeps only the
# @@harness lines.
npm_in() {
	local dir=$1
	shift
	(
		cd -- "$dir"
		env -i PATH="$PATH" HOME="$work/npm-home" \
			npm_config_userconfig="$work/npm-home/user.npmrc" npm_config_globalconfig="$work/npm-home/global.npmrc" \
			npm_config_cache="$work/npm-home/cache" npm_config_registry="$NPM_REGISTRY" \
			npm_config_update_notifier=false \
			timeout "$NPM_TIMEOUT_S" "$node" "$npm_cli" "$@" --loglevel=error >&2
	)
}

# npm ci installs exactly what buzz-app's lock pins and checks each package
# against the lock's integrity hash; pi-launch.mjs later refuses packages
# that differ from the lock that pi.ts sends. No package script runs as root
# (--ignore-scripts). The registry signatures then show that the registry
# published each package.
install_pi() {
	local dir=$work/pi
	npm_cli=$(dirname -- "$(readlink -f -- "$node")")/../lib/node_modules/npm/bin/npm-cli.js
	if ! { [ -f "$npm_cli" ] && root_only "$npm_cli"; }; then
		die "$EX_UNAVAILABLE" "the runner's Node at $node has no npm that only root can change"
	fi
	mkdir -m 0755 -- "$dir" "$work/npm-home"
	# npm loads its user and global config from two different files, so
	# each gets its own empty one.
	: >"$work/npm-home/user.npmrc"
	: >"$work/npm-home/global.npmrc"
	install -m 0644 -o root -g root -- "$pi_deps/package.json" "$pi_deps/package-lock.json" "$dir/"
	npm_in "$dir" ci --ignore-scripts --omit=dev --no-audit --no-fund ||
		die "$EX_UNAVAILABLE" "npm ci of the Pi $PI_VERSION packages failed"
	[ -d "$dir/node_modules" ] || die "$EX_SOFTWARE" "npm ci of the Pi $PI_VERSION packages made no node_modules"
	npm_in "$dir" audit signatures ||
		die "$EX_SOFTWARE" "the Pi $PI_VERSION packages failed npm audit signatures; nothing was installed"
	place "$dir" "$(dirname -- "$PI_PIN")"
	report pi installed "$PI_PIN"
}

[ $# -eq 6 ] || die "$EX_USAGE" "usage: harnesses.sh <node> <pi-deps> <claude-dir> <codex-bin> <goose-bin> <pi-modules>"
node=$1
pi_deps=$2
claude_dir=$3
codex_bin=$4
goose_bin=$5
pi_modules=$6
known=0
for path in "${NODE_PATHS[@]}"; do [ "$node" = "$path" ] && known=1; done
[ "$known" -eq 1 ] || die "$EX_USAGE" "node must be one of ${NODE_PATHS[*]}: $node"
program_root_only "$node" || die "$EX_UNSAFE" "a user who is not root can change $node or a folder above it"
[ -f "$pi_deps/package.json" ] && [ -f "$pi_deps/package-lock.json" ] || die "$EX_USAGE" "no Pi package.json and package-lock.json in $pi_deps"

case "$(uname -m)" in
x86_64)
	arch=x64 target=x86_64
	claude_sha=$CLAUDE_SHA256_X64 codex_sha=$CODEX_SHA256_X64 goose_sha=$GOOSE_SHA256_X64
	;;
aarch64)
	arch=arm64 target=aarch64
	claude_sha=$CLAUDE_SHA256_ARM64 codex_sha=$CODEX_SHA256_ARM64 goose_sha=$GOOSE_SHA256_ARM64
	;;
*) die "$EX_USAGE" "no harness pins for this machine type: $(uname -m)" ;;
esac
for tool in tar gzip sha256sum timeout; do
	command -v "$tool" >/dev/null || die "$EX_UNAVAILABLE" "no $tool on the machine"
done

install -d -m 0755 -o root -g root -- "$HARNESS_ROOT"
root_only "$HARNESS_ROOT" || die "$EX_UNSAFE" "a user who is not root can change $HARNESS_ROOT or a folder above it"
work=$(mktemp -d "$WORK_TEMPLATE")
trap 'rm -rf -- "${work:?}"' EXIT
chmod 0755 -- "$work"

if needs_install claude "$claude_dir" "$CLAUDE_PIN" "$claude_dir/claude"; then install_claude; fi
if needs_install codex "$codex_bin" "$CODEX_PIN"; then
	install_archive codex "Codex $CODEX_VERSION" "$CODEX_URL/codex-package-$target-unknown-linux-musl.tar.gz" \
		"$codex_sha" "$CODEX_PIN" "$HARNESS_ROOT/codex/$CODEX_VERSION"
fi
if needs_install goose "$goose_bin" "$GOOSE_PIN"; then
	install_archive goose "Goose $GOOSE_VERSION" "$GOOSE_URL/goose-acp-$target-unknown-linux-gnu.tar.gz" \
		"$goose_sha" "$GOOSE_PIN" "$HARNESS_ROOT/goose/$GOOSE_VERSION"
fi
if needs_install pi "$pi_modules" "$PI_PIN"; then install_pi; fi
