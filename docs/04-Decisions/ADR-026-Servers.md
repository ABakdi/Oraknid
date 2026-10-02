# ADR-026 — Servers over SSH, Oraknid's own key, a state document

**Status:** Accepted · 2026-10-02 · [[Phase-9-Servers]]

## Context
I want Oraknid to know my servers: reach them, learn what is on them
without touching anything, keep a document of it, and let a project's
jobs use the ones I allow without breaking what is there. I asked for
SSH or remote desktop; a remote desktop gives an agent nothing it can
read, so SSH it is.

## Decision
- **SSH from the daemon** with the `ssh2` library (no `ssh` binary,
  no askpass): host keys pinned at first connection (its SHA-256
  fingerprint shown and stored); a changed key refuses every
  connection until I accept the new one.
- **Credentials in the keychain** (BR-13). A password is used once, to
  install **a key pair Oraknid makes for that server** (ed25519) in the
  user's `authorized_keys`; then the password is deleted. A private key
  I paste is kept as is.
- **Discovery is a fixed list of read-only commands** run by the
  daemon itself, never by a Leg: `uname`, `os-release`, `df`, `free`,
  `uptime`, the services (`systemctl list-units`), the listening ports
  (`ss -tlnp`), containers (`docker ps`), web servers' sites (the
  config files' names and `server_name`s), crontabs, the top folders of
  `/srv`, `/var/www`, `/opt` and the home. Each line is capped; a
  missing tool is skipped. Nothing is written by discovery.
- **The state document** is written by one reasoning call (The Eye's
  judging model, ADR-022) from my description, the previous document
  and the discovery; versions are kept; my edits are a version too.
  It is refreshed after a job that had the server.
- **Projects get servers explicitly** (none by default). A job's
  sessions get the state documents in their context pack, and for each
  server a host alias in the Leg's own `~/.ssh/config` with the key
  file in the Leg's home (0600). Commands on a server are the Leg's,
  through Oraknid's approvals as any command reaching outside.
- Removing a server removes Oraknid's key from it (when it can reach
  it) and oraknid-monitor, then everything Oraknid kept about it.

## Consequences
- A Leg on a job with a server can use that server's key; the
  approvals, the sandbox and the state document are what keep it safe,
  and a project gets only the servers I tick.
- A server Oraknid can't reach keeps its last document and readings,
  marked stale.

Related: [[Servers]] · [[Security]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]]
