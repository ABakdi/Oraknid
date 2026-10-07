#!/bin/sh
# Install Oraknid, start it, and keep it running in the background.
# docs/04-Decisions/ADR-036-One-Script-Install.md
#
#   curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh     (main: the latest release)
#   curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/dev/install.sh | sh -s -- --dev
#   sh install.sh [options]          (from a clone)
#
# Options:
#   --ref <branch|tag>   what to install (default: main, the latest release)
#   --dev                the dev branch, where the newest work is: the same as --ref dev
#   --dir <path>         where the program lives (default: ~/.local/share/oraknid/app)
#   --from <path|url>    the repository to install from (default: GitHub)
#   --no-service         build and link, but don't install the background service
#   --local-models       also get llama.cpp's llama-server for running models on this
#                        computer (the build for its GPU: CUDA, ROCm, Vulkan or CPU)
#   --gui | --no-gui     with the web UI, or terminal only (`oraknid` in a terminal); asked
#                        when neither is given (no question: the web UI when there is a display)
#   --uninstall          remove the service and the `oraknid` command (your data is kept)
#
# Run it as yourself: it asks for sudo only to install missing packages
# (and, on OpenRC or runit, to write the service once). Running it again updates,
# and so does Oraknid itself (Settings -> About, or `oraknid update`): it runs this
# script with what <dir>/.oraknid-install.json says was installed.

set -eu

REPO="https://github.com/ABakdi/Oraknid.git"
NODE_MIN="22.12.0"
REF="main"
FROM="$REPO"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/oraknid/app"
BIN_DIR="$HOME/.local/bin"
SERVICE=1
# 1: build the web UI, 0: terminal only (ADR-055); empty until chosen.
GUI=""
UNINSTALL=0
LOCAL_MODELS=0
DATA_DIR="${ORAKNID_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/oraknid}"
PM=""

say() { printf '%s\n' "$*"; }
title() { printf '\n==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
	printf '\nOraknid was not installed: %s\n' "$*" >&2
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }
# Print a command, then run it with nothing on its standard input
# (under `curl | sh` that is the rest of this script).
run() {
	printf '+ %s\n' "$*"
	"$@" </dev/null
}

as_root() {
	if [ "$(id -u)" = 0 ]; then
		run "$@"
	elif have sudo; then
		printf '+ sudo %s\n' "$*"
		sudo "$@" </dev/null
	elif have doas; then
		printf '+ doas %s\n' "$*"
		doas "$@" </dev/null
	else
		die "this needs root and there is no sudo or doas. Run it as root: $*"
	fi
}

# $1 >= $2, comparing major.minor.patch.
version_ge() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		split(a, x, "."); split(b, y, ".")
		for (i = 1; i <= 3; i++) {
			if (x[i] + 0 > y[i] + 0) exit 0
			if (x[i] + 0 < y[i] + 0) exit 1
		}
		exit 0
	}'
}

node_ok() {
	have node && version_ge "$(node -p 'process.versions.node' 2>/dev/null || echo 0)" "$NODE_MIN"
}

fetch() {
	if have curl; then
		curl -fsSL "$1"
	else
		wget -qO- "$1"
	fi
}

sha256() {
	if have sha256sum; then
		sha256sum "$1" | cut -d' ' -f1
	elif have shasum; then
		shasum -a 256 "$1" | cut -d' ' -f1
	else
		openssl dgst -sha256 -r "$1" | cut -d' ' -f1
	fi
}

# ── packages ──────────────────────────────────────────────────────────

detect_pm() {
	for pm in apt-get dnf pacman zypper apk; do
		if have "$pm"; then
			PM="$pm"
			return
		fi
	done
}

# The distribution's package(s) for one need.
pkg() {
	case "$PM:$1" in
	*:git) echo git ;;
	*:bwrap) echo bubblewrap ;;
	*:pasta) echo passt ;;
	*:rclone) echo rclone ;;
	pacman:python3) echo python ;;
	*:python3) echo python3 ;;
	apt-get:cc) echo build-essential ;;
	pacman:cc) echo base-devel ;;
	apk:cc) echo build-base linux-headers ;;
	*:cc) echo gcc-c++ make ;;
	apt-get:curl) echo curl ca-certificates ;;
	*:curl) echo curl ;;
	zypper:node) echo nodejs24 nodejs22 ;;
	*:node) echo nodejs ;;
	# openSUSE's npm and corepack are wrappers that need the package for Node's major version.
	zypper:npm) echo "npm$(node -p 'process.versions.node.split(".")[0]')" ;;
	*:npm) echo npm ;;
	esac
}

refresh_index() {
	case "$PM" in
	apt-get) as_root apt-get update -q ;;
	apk) as_root apk update ;;
	zypper) as_root zypper --non-interactive --quiet refresh ;;
	pacman) [ -n "$(ls /var/lib/pacman/sync 2>/dev/null)" ] || as_root pacman -Sy --noconfirm ;;
	esac
}

install_pkgs() {
	case "$PM" in
	apt-get) as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" ;;
	dnf) as_root dnf install -y "$@" ;;
	pacman) as_root pacman -S --needed --noconfirm "$@" ;;
	zypper) as_root zypper --non-interactive install "$@" ;;
	apk) as_root apk add "$@" ;;
	esac
}

# The version of a package the distribution would install, or nothing.
distro_version() {
	case "$PM" in
	apt-get) apt-cache policy "$1" 2>/dev/null | awk '/Candidate:/ { print $2 }' ;;
	dnf) dnf -q repoquery --latest-limit 1 --qf '%{version}\n' "$1" 2>/dev/null | head -n 1 ;;
	pacman) pacman -Si "$1" 2>/dev/null | awk -F': *' '/^Version/ { print $2; exit }' ;;
	zypper) zypper --non-interactive -q info "$1" 2>/dev/null | awk -F': *' '/^Version/ { print $2; exit }' ;;
	apk) apk policy "$1" 2>/dev/null | awk 'NR == 2 { sub(":$", "", $1); print $1 }' ;;
	esac | sed 's/^[0-9]*://; s/[-+~].*//' | grep -E '^[0-9]+\.[0-9]+' || true
}

NODE_LOCAL=0
NODE_PKG=""

ensure_packages() {
	title "Checking what this computer has"
	# This script reads versions with awk; a minimal system may not have it.
	if ! have awk; then
		detect_pm
		[ -n "$PM" ] || die "awk is missing; please install it and run this again"
		say "awk is missing. Installing it with $PM; sudo may ask for your password."
		refresh_index
		install_pkgs gawk || die "$PM could not install gawk"
	fi
	needs=""
	have git || needs="$needs git"
	have bwrap || needs="$needs bwrap"
	have python3 || needs="$needs python3"
	{ have make && { have c++ || have g++; }; } || needs="$needs cc"
	node_ok || needs="$needs node"
	optional=""
	have pasta || optional="pasta"
	# Cloud storage's rclone (ADR-046): recommended, nothing else needs it.
	have rclone || optional="${optional:+$optional }rclone"

	if [ -z "$needs" ] && [ -z "$optional" ]; then
		say "git, Node $(node -p 'process.versions.node'), bubblewrap, passt, rclone, python3 and a C++ compiler are here."
		return
	fi
	detect_pm
	if [ -z "$PM" ]; then
		say "I don't know this system's package manager. Please install:$needs $optional"
		say "(git, Node $NODE_MIN or newer, bubblewrap, python3, make and a C++ compiler; passt and rclone are recommended)"
		case "$needs" in *git* | *bwrap* | *python3* | *cc*) die "missing:$needs" ;; esac
		node_ok || NODE_LOCAL=1
		return
	fi
	say "Missing:$needs${optional:+ (recommended: $optional)}. Installing with $PM; sudo may ask for your password."
	refresh_index
	pkgs=""
	for need in $needs; do
		if [ "$need" = node ]; then
			candidate=""
			for p in $(pkg node); do
				candidate="$(distro_version "$p")"
				if [ -n "$candidate" ] && version_ge "$candidate" "$NODE_MIN"; then
					NODE_PKG="$p"
					break
				fi
			done
			if [ -n "$NODE_PKG" ]; then
				pkgs="$pkgs $NODE_PKG"
				# openSUSE splits corepack out, per Node version.
				if [ "$PM" = zypper ]; then pkgs="$pkgs corepack${NODE_PKG#nodejs}"; fi
			else
				say "The distribution's Node is ${candidate:-not available}; I'll put Node 22 in $DIR/.tools/node."
				NODE_LOCAL=1
				have curl || have wget || pkgs="$pkgs $(pkg curl)"
			fi
		else
			pkgs="$pkgs $(pkg "$need")"
		fi
	done
	if [ -n "$pkgs" ]; then
		# shellcheck disable=SC2086 # one argument per package
		install_pkgs $pkgs || die "$PM could not install:$pkgs"
	fi
	for want in $optional; do
		case "$want" in
		pasta) install_pkgs "$(pkg pasta)" || warn "passt could not be installed; sandboxes will share the network." ;;
		rclone) install_pkgs "$(pkg rclone)" || warn "rclone could not be installed; Cloud storage waits for it (oraknid doctor says how)." ;;
		esac
	done
}

# ── Node and pnpm ─────────────────────────────────────────────────────

install_local_node() {
	case "$(uname -m)" in
	x86_64 | amd64) arch=x64 ;;
	aarch64 | arm64) arch=arm64 ;;
	armv7l) arch=armv7l ;;
	ppc64le) arch=ppc64le ;;
	s390x) arch=s390x ;;
	*) die "nodejs.org has no Node for $(uname -m). Install Node $NODE_MIN or newer yourself and run this again." ;;
	esac
	if ls /lib/ld-musl-* >/dev/null 2>&1; then
		die "this system uses musl, and nodejs.org builds Node only for glibc. Install Node $NODE_MIN or newer from your distribution and run this again."
	fi
	title "Getting Node 22 from nodejs.org"
	base="https://nodejs.org/dist/latest-v22.x"
	tmp="$(mktemp -d)"
	fetch "$base/SHASUMS256.txt" >"$tmp/SHASUMS256.txt" || die "could not reach nodejs.org"
	file="$(awk -v s="-linux-$arch.tar.gz" '$2 ~ /^node-v[0-9.]+-linux-/ && substr($2, length($2) - length(s) + 1) == s { print $2; exit }' "$tmp/SHASUMS256.txt")"
	sum="$(awk -v f="$file" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
	[ -n "$file" ] && [ -n "$sum" ] || die "nodejs.org lists no $arch build of Node 22"
	say "+ $base/$file"
	fetch "$base/$file" >"$tmp/$file" || die "could not download $file"
	[ "$(sha256 "$tmp/$file")" = "$sum" ] || die "$file does not match its checksum from nodejs.org"
	say "Checksum matches."
	rm -rf "$DIR/.tools/node"
	mkdir -p "$DIR/.tools/node"
	tar -xzf "$tmp/$file" -C "$DIR/.tools/node" --strip-components=1
	rm -rf "$tmp"
	PATH="$DIR/.tools/node/bin:$PATH"
	node_ok || die "the Node from nodejs.org does not run here"
}

# turbo looks for a `pnpm` binary: a small one in .tools/bin runs it through corepack.
pnpm_shim() {
	mkdir -p "$DIR/.tools/bin"
	printf '#!/bin/sh\nexec %s pnpm "$@"\n' "'$1'" >"$DIR/.tools/bin/pnpm"
	chmod 755 "$DIR/.tools/bin/pnpm"
}

pnpm_works() {
	(cd "$DIR" && pnpm --version >/dev/null 2>&1 </dev/null)
}

ensure_pnpm() {
	title "Getting pnpm"
	export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
	if have corepack; then
		pnpm_shim "$(command -v corepack)"
		pnpm_works && return
	fi
	rm -f "$DIR/.tools/bin/pnpm"
	if have pnpm && version_ge "$(pnpm --version 2>/dev/null || echo 0)" 9.0.0 && pnpm_works; then
		return
	fi
	# No corepack with this Node (or one too old to check pnpm's signature): a current one, just for Oraknid.
	own="$DIR/.tools/corepack/node_modules/.bin/corepack"
	if [ -x "$own" ]; then
		pnpm_shim "$own"
		pnpm_works && return
	fi
	if ! npm --version >/dev/null 2>&1; then
		[ -n "$PM" ] || detect_pm
		[ -n "$PM" ] || die "pnpm needs corepack or npm, and neither is here"
		install_pkgs "$(pkg npm)" || die "$PM could not install npm"
	fi
	run npm install --prefix "$DIR/.tools/corepack" --no-fund --no-audit --loglevel=error corepack
	pnpm_shim "$own"
	pnpm_works || die "pnpm does not run through corepack"
}

# ── local models (ADR-054) ────────────────────────────────────────────

# This computer's GPU, for the right llama.cpp build: cuda, rocm, vulkan or cpu.
gpu_kind() {
	if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
		echo cuda
	elif [ -e /dev/kfd ]; then
		echo rocm
	elif ls /dev/dri/renderD* >/dev/null 2>&1; then
		echo vulkan
	else
		echo cpu
	fi
}

# The builds to try for a GPU, best first: the GPU's own, Vulkan, then the CPU.
builds_for() {
	case "$1" in
	cuda) echo "cuda vulkan cpu" ;;
	rocm) echo "rocm vulkan cpu" ;;
	vulkan) echo "vulkan cpu" ;;
	*) echo cpu ;;
	esac
}

# Of a release's asset names (one a line, on stdin), the Linux build of one
# kind (cuda, rocm, vulkan, cpu) for one architecture (x64, arm64).
pick_llama_asset() {
	awk -v kind="$1" -v arch="$2" '
	{
		s = tolower($0)
		if (s !~ /bin-(ubuntu|linux)/ || s !~ ("-" arch "[.-]") || s !~ /\.(zip|tar\.gz)$/) next
		if (kind == "cpu") { if (s ~ /(cuda|rocm|hip|vulkan|sycl|openvino|kompute|opencl)/) next }
		else if (kind == "rocm") { if (s !~ /(rocm|hip)/) next }
		else if (s !~ kind) next
		print; exit
	}'
}

# llama.cpp's latest release from GitHub into <data>/bin/llama.cpp, checked
# against its digest, the build for this computer's GPU (falling back to
# Vulkan and the CPU when that build doesn't run here).
install_local_models() {
	title "Local models: llama.cpp"
	if have llama-server; then
		say "llama-server is here already: $(command -v llama-server)"
	else
		case "$(uname -m)" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*)
			warn "llama.cpp publishes no build for $(uname -m): build it (github.com/ggml-org/llama.cpp) and put llama-server on the PATH."
			return 0
			;;
		esac
		tmp="$(mktemp -d)"
		if ! fetch "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest" >"$tmp/release.json"; then
			warn "could not reach GitHub for llama.cpp; run this again with --local-models later."
			rm -rf "$tmp"
			return 0
		fi
		# name, URL and digest of each asset, one a line, tab-separated.
		python3 -c 'import json,sys
r = json.load(open(sys.argv[1]))
print(r.get("tag_name", "?"))
for a in r.get("assets", []):
    print("\t".join([a["name"], a["browser_download_url"], a.get("digest") or ""]))' "$tmp/release.json" >"$tmp/assets" ||
			{ warn "GitHub's answer about llama.cpp could not be read."; rm -rf "$tmp"; return 0; }
		tag="$(head -n 1 "$tmp/assets")"
		gpu="$(gpu_kind)"
		say "This computer's GPU: $gpu. llama.cpp release $tag."
		done_ok=0
		for kind in $(builds_for "$gpu"); do
			name="$(tail -n +2 "$tmp/assets" | cut -f1 | pick_llama_asset "$kind" "$arch")"
			[ -n "$name" ] || { say "No $kind build of llama.cpp for $arch."; continue; }
			url="$(awk -F'\t' -v n="$name" '$1 == n { print $2 }' "$tmp/assets")"
			digest="$(awk -F'\t' -v n="$name" '$1 == n { print $3 }' "$tmp/assets")"
			say "+ $url"
			fetch "$url" >"$tmp/$name" || { warn "could not download $name"; continue; }
			case "$digest" in
			sha256:*)
				[ "$(sha256 "$tmp/$name")" = "${digest#sha256:}" ] || { warn "$name does not match its digest from GitHub"; continue; }
				say "Checksum matches."
				;;
			esac
			rm -rf "$tmp/x"
			mkdir -p "$tmp/x"
			case "$name" in
			*.zip) python3 -m zipfile -e "$tmp/$name" "$tmp/x" ;;
			*) tar -xzf "$tmp/$name" -C "$tmp/x" ;;
			esac
			server="$(find "$tmp/x" -type f -name llama-server | head -n 1)"
			[ -n "$server" ] || { warn "$name has no llama-server"; continue; }
			chmod -R u+rwX,go+rX "$tmp/x"
			chmod 755 "$server"
			if ! LD_LIBRARY_PATH="$(dirname "$server")${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" "$server" --version >/dev/null 2>&1 </dev/null; then
				say "The $kind build doesn't run here (a driver or library missing); trying the next."
				continue
			fi
			mkdir -p "$DATA_DIR/bin"
			rm -rf "$DATA_DIR/bin/llama.cpp"
			cp -R "$(dirname "$server")" "$DATA_DIR/bin/llama.cpp"
			say "Installed llama-server ($kind, $tag) in $DATA_DIR/bin/llama.cpp"
			done_ok=1
			break
		done
		rm -rf "$tmp"
		[ "$done_ok" = 1 ] || warn "llama.cpp was not installed. Oraknid can still use an Ollama on this computer."
	fi
	if have whisper-cli || [ -x "$DATA_DIR/bin/whisper.cpp/whisper-cli" ]; then
		say "whisper.cpp is here for speech to text."
	else
		say "Speech to text needs whisper.cpp, which publishes no Linux build: install it from your distribution or build it (github.com/ggml-org/whisper.cpp), then put whisper-cli on the PATH or in $DATA_DIR/bin/whisper.cpp."
	fi
}

# ── the program ───────────────────────────────────────────────────────

fetch_source() {
	title "Getting Oraknid ($REF) into $DIR"
	if [ -d "$DIR/.git" ]; then
		if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no)" ]; then
			die "$DIR has local changes. Commit or discard them, then run this again."
		fi
	elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR")" ]; then
		die "$DIR exists and is not an Oraknid checkout. Choose another with --dir."
	else
		mkdir -p "$(dirname "$DIR")"
		run git clone --quiet --no-checkout "$FROM" "$DIR"
	fi
	if is_commit "$REF" && git -C "$DIR" cat-file -e "$REF^{commit}" 2>/dev/null; then
		# A commit this checkout has: an update going back to the version before (ADR-048).
		run git -C "$DIR" checkout --quiet --detach "$REF"
	else
		run git -C "$DIR" fetch --quiet "$FROM" "$REF"
		run git -C "$DIR" checkout --quiet --detach FETCH_HEAD
	fi
	say "At $(git -C "$DIR" log -1 --format='%h %s')"
	for own in /.tools/ /.oraknid-install.json; do
		grep -qx "$own" "$DIR/.git/info/exclude" 2>/dev/null || echo "$own" >>"$DIR/.git/info/exclude"
	done
}

# A full commit id (40 hex digits).
is_commit() {
	case "$1" in *[!0-9a-f]*) return 1 ;; esac
	[ "${#1}" = 40 ]
}

# A string made safe inside a JSON string.
json_str() {
	printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# What was installed, for Oraknid's updates (ADR-048): the ref asked for and
# its channel (dev for the dev branch; main, a release's tag or any other ref
# is stable), the commit, the version, when, from where, and whether the
# background service runs it, and with the web UI or terminal only (ADR-055).
write_record() {
	case "$REF" in
	dev) channel=dev ;;
	*) channel=stable ;;
	esac
	commit="$(git -C "$DIR" rev-parse HEAD)"
	version="$(sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -n 1)"
	if [ "$SERVICE" = 1 ]; then service=true; else service=false; fi
	if [ "$GUI" = 0 ]; then gui=false; else gui=true; fi
	cat >"$DIR/.oraknid-install.json.new" <<EOF
{
  "ref": "$(json_str "$REF")",
  "channel": "$channel",
  "commit": "$commit",
  "version": "$(json_str "$version")",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "from": "$(json_str "$FROM")",
  "service": $service,
  "gui": $gui
}
EOF
	mv -f "$DIR/.oraknid-install.json.new" "$DIR/.oraknid-install.json"
	say "Recorded $REF ($channel channel, version $version$([ "$GUI" = 0 ] && printf ', terminal only')) in $DIR/.oraknid-install.json"
}

# With the web UI or terminal only (ADR-055): --gui / --no-gui; else what an
# earlier install chose; else asked on a terminal; else the web UI when this
# computer has a display (or a browser named), terminal only when it has none.
choose_gui() {
	[ -z "$GUI" ] || return 0
	if grep -q '"gui": *false' "$DIR/.oraknid-install.json" 2>/dev/null; then
		GUI=0
		return 0
	elif grep -q '"gui": *true' "$DIR/.oraknid-install.json" 2>/dev/null; then
		GUI=1
		return 0
	fi
	if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}${BROWSER:-}" ]; then default=1; else default=0; fi
	# Under `curl | sh` the script is standard input: the question goes to the terminal itself.
	if [ -z "${ORAKNID_UPDATE:-}" ] && [ -t 1 ] && { : </dev/tty; } 2>/dev/null; then
		if [ "$default" = 1 ]; then hint="Y/n"; else hint="y/N"; fi
		printf '\nInstall the web UI too? Without it Oraknid is used in a terminal (`oraknid`),\nand the install is smaller and quicker. [%s] ' "$hint"
		answer=""
		read -r answer </dev/tty || answer=""
		case "$answer" in
		[yY]*) GUI=1 ;;
		[nN]*) GUI=0 ;;
		*) GUI="$default" ;;
		esac
	else
		GUI="$default"
	fi
	if [ "$GUI" = 1 ]; then say "With the web UI."; else say "Terminal only: no web UI (add it later with: oraknid install --gui)."; fi
}

build() {
	title "Installing dependencies and building"
	export TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
	if [ "$GUI" = 0 ]; then
		# Terminal only: apps/web is neither installed nor built, and an earlier build of it goes.
		(cd "$DIR" && run pnpm install --frozen-lockfile --filter '!@oraknid/web' &&
			run pnpm exec turbo run build --filter '!@oraknid/web' &&
			run rm -rf apps/web/dist apps/web/dist-remote)
	else
		(cd "$DIR" && run pnpm install --frozen-lockfile && run pnpm build)
	fi
}

link_command() {
	node_bin="$(command -v node)"
	mkdir -p "$BIN_DIR"
	cat >"$BIN_DIR/oraknid.new" <<EOF
#!/bin/sh
# Written by Oraknid's install.sh: runs the build in $DIR.
exec '$node_bin' '$DIR/apps/daemon/dist/cli.mjs' "\$@"
EOF
	chmod 755 "$BIN_DIR/oraknid.new"
	mv -f "$BIN_DIR/oraknid.new" "$BIN_DIR/oraknid"
	say "Linked $BIN_DIR/oraknid"
}

wait_until_up() {
	i=0
	while [ "$i" -lt 30 ]; do
		"$BIN_DIR/oraknid" status >/dev/null 2>&1 && return 0
		sleep 1
		i=$((i + 1))
	done
	return 1
}

finish() {
	title "Done"
	if [ "$SERVICE" = 1 ] && wait_until_up; then
		if [ "$GUI" = 0 ]; then
			say "Oraknid is running. Open it in a terminal with: oraknid"
		else
			url="$("$BIN_DIR/oraknid" status | awk '$1 == "url" { print $2 }')"
			say "Oraknid is running. Open ${url:-http://127.0.0.1:7417} in your browser, or run: oraknid"
			# An update from inside Oraknid: its browsers are paired already, and no code goes in its log.
			[ -n "${ORAKNID_UPDATE:-}" ] || "$BIN_DIR/oraknid" pair || true
		fi
	elif [ "$SERVICE" = 1 ]; then
		say "Oraknid did not answer yet. See: oraknid status, oraknid logs"
	elif [ "$GUI" = 0 ]; then
		say "Start Oraknid with: oraknid start"
		say "Then open it in a terminal with: oraknid"
	else
		say "Start Oraknid with: oraknid start"
		say "Then open http://127.0.0.1:7417 and pair this browser with the code from: oraknid pair"
	fi
	if [ "$LOCAL_MODELS" = 0 ] && [ "$(gpu_kind)" != cpu ] && ! have llama-server && [ ! -x "$DATA_DIR/bin/llama.cpp/llama-server" ]; then
		say "This computer has a GPU: run this again with --local-models to run models on it (Models in Oraknid)."
	fi
	case ":$PATH:" in
	*":$BIN_DIR:"*) ;;
	*) say "
$BIN_DIR is not on your PATH. Add it to your shell's profile:
  export PATH=\"$BIN_DIR:\$PATH\"" ;;
	esac
}

uninstall() {
	title "Removing Oraknid's service and command"
	if grep -q "Oraknid's install.sh" "$BIN_DIR/oraknid" 2>/dev/null; then
		"$BIN_DIR/oraknid" uninstall </dev/null || warn "the service was not fully removed (see above)"
		rm -f "$BIN_DIR/oraknid"
		say "Removed $BIN_DIR/oraknid"
	else
		say "No oraknid command from this script in $BIN_DIR."
	fi
	say "
Your data is kept in ${ORAKNID_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/oraknid}.
The program stays in $DIR; remove it with: rm -rf '$DIR'"
}

main() {
	while [ $# -gt 0 ]; do
		case "$1" in
		--dev) REF=dev; shift ;;
		--ref) REF="${2:?--ref needs a branch}"; shift 2 ;;
		--ref=*) REF="${1#*=}"; shift ;;
		--dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
		--dir=*) DIR="${1#*=}"; shift ;;
		--from) FROM="${2:?--from needs a path or URL}"; shift 2 ;;
		--from=*) FROM="${1#*=}"; shift ;;
		--no-service) SERVICE=0; shift ;;
		--local-models) LOCAL_MODELS=1; shift ;;
		--gui) GUI=1; shift ;;
		--no-gui) GUI=0; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h | --help) sed -n '2,24p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; exit 0 ;;
		*) die "unknown option $1 (see --help)" ;;
		esac
	done
	case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac
	# Another clone on this computer is recorded by its full path, for the updates.
	if [ -d "$FROM" ]; then FROM="$(cd "$FROM" && pwd)"; fi

	if [ "$UNINSTALL" = 1 ]; then
		uninstall
		return
	fi
	[ "$(uname -s)" = Linux ] || die "Oraknid runs on Linux for now."
	[ "$(id -u)" != 0 ] || warn "running as root: Oraknid will run as root. It is meant to run as you."

	# What an earlier run put here comes first.
	PATH="$DIR/.tools/bin:$DIR/.tools/node/bin:$PATH"
	export PATH

	# Asked first, before the long part.
	choose_gui
	ensure_packages
	fetch_source
	[ "$NODE_LOCAL" = 0 ] || install_local_node
	node_ok || die "Node $NODE_MIN or newer is needed"
	ensure_pnpm
	build
	link_command
	write_record
	[ "$LOCAL_MODELS" = 0 ] || install_local_models

	title "Checking this computer (oraknid doctor)"
	"$BIN_DIR/oraknid" doctor </dev/null || true

	if [ "$SERVICE" = 1 ]; then
		title "Running Oraknid in the background"
		"$BIN_DIR/oraknid" install </dev/null || warn "the service is not fully set up (see above)"
	fi
	finish
}

# ORAKNID_INSTALL_LIB=1 only defines the functions, running nothing (the tests).
[ "${ORAKNID_INSTALL_LIB:-}" = 1 ] || main "$@"
