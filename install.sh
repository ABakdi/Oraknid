#!/bin/sh
# Install Oraknid, start it, and keep it running in the background.
# docs/04-Decisions/ADR-036-One-Script-Install.md
#
#   curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh -s -- --ref dev
#   sh install.sh [options]          (from a clone)
#
# Options:
#   --ref <branch>       what to install (default: main)
#   --dir <path>         where the program lives (default: ~/.local/share/oraknid/app)
#   --from <path|url>    the repository to install from (default: GitHub)
#   --no-service         build and link, but don't install the background service
#   --uninstall          remove the service and the `oraknid` command (your data is kept)
#
# Run it as yourself: it asks for sudo only to install missing packages
# (and, on OpenRC or runit, to write the service once). Running it again updates.

set -eu

REPO="https://github.com/ABakdi/Oraknid.git"
NODE_MIN="22.12.0"
REF="main"
FROM="$REPO"
DIR="${XDG_DATA_HOME:-$HOME/.local/share}/oraknid/app"
BIN_DIR="$HOME/.local/bin"
SERVICE=1
UNINSTALL=0
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
	pacman:python3) echo python ;;
	*:python3) echo python3 ;;
	apt-get:cc) echo build-essential ;;
	pacman:cc) echo base-devel ;;
	apk:cc) echo build-base linux-headers ;;
	*:cc) echo gcc-c++ make ;;
	apt-get:curl) echo curl ca-certificates ;;
	*:curl) echo curl ;;
	zypper:node) echo nodejs22 ;;
	*:node) echo nodejs ;;
	zypper:npm) echo npm22 ;;
	*:npm) echo npm ;;
	esac
}

refresh_index() {
	case "$PM" in
	apt-get) as_root apt-get update -q ;;
	apk) as_root apk update ;;
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

# The Node version the distribution would install, or nothing.
distro_node_version() {
	case "$PM" in
	apt-get) apt-cache policy nodejs 2>/dev/null | awk '/Candidate:/ { print $2 }' ;;
	dnf) dnf -q repoquery --latest-limit 1 --qf '%{version}\n' nodejs 2>/dev/null | head -n 1 ;;
	pacman) pacman -Si nodejs 2>/dev/null | awk -F': *' '/^Version/ { print $2; exit }' ;;
	zypper) zypper --non-interactive -q info nodejs22 2>/dev/null | awk -F': *' '/^Version/ { print $2; exit }' ;;
	apk) apk policy nodejs 2>/dev/null | awk 'NR == 2 { sub(":$", "", $1); print $1 }' ;;
	esac | sed 's/^[0-9]*://; s/[-+~].*//' | grep -E '^[0-9]+\.[0-9]+' || true
}

NODE_LOCAL=0

ensure_packages() {
	title "Checking what this computer has"
	needs=""
	have git || needs="$needs git"
	have bwrap || needs="$needs bwrap"
	have python3 || needs="$needs python3"
	{ have make && { have c++ || have g++; }; } || needs="$needs cc"
	node_ok || needs="$needs node"
	optional=""
	have pasta || optional="pasta"

	if [ -z "$needs" ] && [ -z "$optional" ]; then
		say "git, Node $(node -p 'process.versions.node'), bubblewrap, passt, python3 and a C++ compiler are here."
		return
	fi
	detect_pm
	if [ -z "$PM" ]; then
		say "I don't know this system's package manager. Please install:$needs $optional"
		say "(git, Node $NODE_MIN or newer, bubblewrap, python3, make and a C++ compiler; passt is recommended)"
		case "$needs" in *git* | *bwrap* | *python3* | *cc*) die "missing:$needs" ;; esac
		node_ok || NODE_LOCAL=1
		return
	fi
	say "Missing:$needs${optional:+ (recommended: $optional)}. Installing with $PM; sudo may ask for your password."
	refresh_index
	pkgs=""
	for need in $needs; do
		if [ "$need" = node ]; then
			candidate="$(distro_node_version)"
			if [ -n "$candidate" ] && version_ge "$candidate" "$NODE_MIN"; then
				pkgs="$pkgs $(pkg node)"
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
	if [ -n "$optional" ]; then
		install_pkgs "$(pkg pasta)" || warn "passt could not be installed; sandboxes will share the network."
	fi
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
	if ! have npm; then
		[ -n "$PM" ] || detect_pm
		[ -n "$PM" ] || die "pnpm needs corepack or npm, and neither is here"
		install_pkgs "$(pkg npm)" || die "$PM could not install npm"
	fi
	run npm install --prefix "$DIR/.tools/corepack" --no-fund --no-audit --loglevel=error corepack
	pnpm_shim "$own"
	pnpm_works || die "pnpm does not run through corepack"
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
	run git -C "$DIR" fetch --quiet "$FROM" "$REF"
	run git -C "$DIR" checkout --quiet --detach FETCH_HEAD
	say "At $(git -C "$DIR" log -1 --format='%h %s')"
	grep -qx '/.tools/' "$DIR/.git/info/exclude" 2>/dev/null || echo '/.tools/' >>"$DIR/.git/info/exclude"
}

build() {
	title "Installing dependencies and building"
	export TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
	(cd "$DIR" && run pnpm install --frozen-lockfile && run pnpm build)
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
		url="$("$BIN_DIR/oraknid" status | awk '$1 == "url" { print $2 }')"
		say "Oraknid is running. Open ${url:-http://127.0.0.1:7417} in your browser."
		"$BIN_DIR/oraknid" pair || true
	elif [ "$SERVICE" = 1 ]; then
		say "Oraknid did not answer yet. See: oraknid status, oraknid logs"
	else
		say "Start Oraknid with: oraknid start"
		say "Then open http://127.0.0.1:7417 and pair this browser with the code from: oraknid pair"
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
		--ref) REF="${2:?--ref needs a branch}"; shift 2 ;;
		--ref=*) REF="${1#*=}"; shift ;;
		--dir) DIR="${2:?--dir needs a path}"; shift 2 ;;
		--dir=*) DIR="${1#*=}"; shift ;;
		--from) FROM="${2:?--from needs a path or URL}"; shift 2 ;;
		--from=*) FROM="${1#*=}"; shift ;;
		--no-service) SERVICE=0; shift ;;
		--uninstall) UNINSTALL=1; shift ;;
		-h | --help) sed -n '2,17p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true; exit 0 ;;
		*) die "unknown option $1 (see --help)" ;;
		esac
	done
	case "$DIR" in /*) ;; *) DIR="$(pwd)/$DIR" ;; esac

	if [ "$UNINSTALL" = 1 ]; then
		uninstall
		return
	fi
	[ "$(uname -s)" = Linux ] || die "Oraknid runs on Linux for now."
	[ "$(id -u)" != 0 ] || warn "running as root: Oraknid will run as root. It is meant to run as you."

	# What an earlier run put here comes first.
	PATH="$DIR/.tools/bin:$DIR/.tools/node/bin:$PATH"
	export PATH

	ensure_packages
	fetch_source
	[ "$NODE_LOCAL" = 0 ] || install_local_node
	node_ok || die "Node $NODE_MIN or newer is needed"
	ensure_pnpm
	build
	link_command

	title "Checking this computer (oraknid doctor)"
	"$BIN_DIR/oraknid" doctor </dev/null || true

	if [ "$SERVICE" = 1 ]; then
		title "Running Oraknid in the background"
		"$BIN_DIR/oraknid" install </dev/null || warn "the service is not fully set up (see above)"
	fi
	finish
}

main "$@"
