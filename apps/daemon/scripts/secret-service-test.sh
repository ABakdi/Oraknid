#!/bin/sh
# Runs the keychain test against a real Secret Service, in a throwaway
# session: a private D-Bus and a gnome-keyring with its keyring in a
# temporary home. Never my desktop's keyring: the environment is emptied,
# so the desktop's D-Bus address can't be reached. Needs dbus-run-session
# and gnome-keyring-daemon.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/oraknid-ss-XXXXXX")
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/data" "$tmp/run"
chmod 700 "$tmp/run"
cd "$here"
env -i PATH="$PATH" HOME="$tmp/home" TMPDIR="${TMPDIR:-/tmp}" \
	XDG_DATA_HOME="$tmp/data" XDG_RUNTIME_DIR="$tmp/run" XDG_CONFIG_HOME="$tmp/home/.config" \
	ORAKNID_SECRET_SERVICE_TEST=1 \
	dbus-run-session -- sh -c '
		printf throwaway | gnome-keyring-daemon --unlock --components=secrets >/dev/null
		exec npx vitest run src/os/secrets.secret-service.test.ts
	'
