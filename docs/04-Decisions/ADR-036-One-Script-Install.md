# ADR-036 — Install and run Oraknid with one script

**Status:** Accepted · 2026-10-03

## Context
Installing took a clone, `pnpm install`, `pnpm build`, `oraknid doctor`
and `oraknid install`, and the service only knew systemd. I want one
command that installs Oraknid, starts it, and keeps it running in the
background, which I can stop later with whatever my system uses for
services.

## Decision
- **`install.sh` at the repository's root**, run as me (it asks for
  `sudo` only to install missing packages):
  `curl -fsSL https://raw.githubusercontent.com/ABakdi/Oraknid/main/install.sh | sh`
  or `sh install.sh` from a clone. Options: `--ref <branch>`,
  `--dir <path>` (default `~/.local/share/oraknid/app`), `--no-service`,
  `--uninstall`.
- It **installs what is missing** with the system's package manager
  (apt, dnf, pacman, zypper, apk; it says what it would run when it
  knows none): git, Node 22.12 or newer (from the distribution, or a
  user-local Node when the distribution's is older), pnpm through
  corepack, bubblewrap, passt, python3. Then clones or updates,
  installs, builds, links `oraknid` into `~/.local/bin`, and runs
  `oraknid doctor`.
- **The service**, by what the system runs (PID 1, then tools present):
  - **systemd**: a user unit, `loginctl enable-linger` (as before);
  - **OpenRC**: a system service running as me (`/etc/init.d/oraknid`,
    `rc-update add oraknid default`);
  - **runit**: a service directory running as me, linked into the
    distribution's service folder (`/var/service` or `/etc/runit/runsvdir/default`);
  - **s6** and others: no service; it says how to start Oraknid at login
    (an XDG autostart entry is offered for a desktop session).
  `oraknid install` and `oraknid uninstall` do the same, so the script
  and the CLI agree. Stopping, disabling and logs are the system's own
  (`systemctl --user stop oraknid`, `rc-service oraknid stop`,
  `sv down oraknid`); the script prints them.
- It ends with the address to open and a pairing code.

## Consequences
- The guide's install section and the site's install block become the
  one command; the manual steps stay in the guide for those who want
  them.
- OpenRC and runit services are system services that drop to my user:
  they need `sudo` once to be written.

## As built (2026-10-03)
- A **C++ compiler** (and `make`) is among what it installs: `node-pty`
  has no Linux prebuild and compiles on install.
- The user-local Node is the latest 22 from nodejs.org, checked
  against its `SHASUMS256.txt`, in `<dir>/.tools/node`. nodejs.org
  builds only for glibc: on musl (Alpine) the distribution's Node must
  be recent enough, or the script stops and says so.
- pnpm runs through corepack: the one with Node, or, when Node comes
  without it (Arch, Alpine, Fedora's packages), a current corepack
  installed with npm into `<dir>/.tools/corepack`. A small `pnpm` in
  `<dir>/.tools/bin` runs it, because turbo looks for a `pnpm` binary.
  On openSUSE, Node is `nodejs24` or `nodejs22`, with its `corepack24`
  or `corepack22` (the plain `npm` and `corepack` are wrappers needing
  them).
- The script reads versions with awk, so it installs awk first on a
  system without it (openSUSE's minimal image).
- `--from <path or URL>` installs from another clone (how the script is
  tested); `ORAKNID_SERVICE=systemd|openrc|runit|autostart` chooses the
  service by hand.
- `oraknid` in `~/.local/bin` is a two-line script running the build
  with the Node it was built with; `--uninstall` removes only one it
  wrote, and keeps the program folder and the data.

Related: [[OS-Integration]] · [[ADR-012-Sleep-Inhibition]] · [[ADR-033-Product-Site]]
