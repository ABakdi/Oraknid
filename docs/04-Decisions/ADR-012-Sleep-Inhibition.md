# ADR-012 — Hold a systemd-inhibit child process while jobs are active

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
BR-11: no sleep or hibernation while a job is active, released when idle.
logind's `Inhibit()` returns a file descriptor that holds the lock until
it's closed. Holding that fd from Node needs a D-Bus library with
unix-fd passing. The maintained options are thin.

## Decision
While any job is active, the daemon spawns
`systemd-inhibit --what=sleep:idle --who=Oraknid --why="<n> job(s) running" --mode=block sleep infinity`
and kills it to release. The holder is supervised: if it dies while
jobs are active, it's restarted and a warning is logged. If polkit
refuses `block`, it retries with `--mode=delay` and warns in the UI.
The `inhibitor` interface lives in `packages/os`. Windows (final phase) uses
`PowerSetRequest(PowerRequestSystemRequired)` from a small helper.

## Consequences
- No native D-Bus dependency.
- `systemd-inhibit --list` shows the lock, which makes it easy to check.
- The lock is released automatically if the daemon dies (the child dies
  with it via its process group). On restart, recovery takes it again.

## Why not D-Bus from Node
It works, but adds a dependency for one call. Revisit if more D-Bus use
appears (desktop notifications use `notify-send` for the same reason).

Related: [[OS-Integration]] · [[Durability]]
