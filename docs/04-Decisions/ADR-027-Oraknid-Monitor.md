# ADR-027 — oraknid-monitor: a shell program read over SSH

**Status:** Accepted · 2026-10-02 · [[Phase-9-Servers]]

## Context
I want my servers' resources, services and network on the Servers
page, sent to Oraknid encrypted. Oraknid runs at home, usually behind
NAT: a server can't open a connection to it, and opening one would
mean another port and another secret.

## Decision
- **oraknid-monitor is one POSIX shell file** (`~/.local/bin/oraknid-monitor`),
  reading `/proc`, `df`, `ss` and `systemctl`; no runtime to install,
  no service, no port, no root needed.
- **Oraknid pulls**: while it runs, it keeps one SSH connection to each
  server and runs `oraknid-monitor sample` every 15 s; the answer is
  one JSON line. SSH is the encryption and the authentication; the
  server never connects to my home.
- Samples live in the daemon: the last 24 hours in memory and in the
  database (pruned), shown live and as charts.
- Installed with the server's setup, updated when Oraknid's version of
  it changes (its hash), removed with the server.
- **Later**: a collector that keeps samples on the server while
  Oraknid is off, to fill the gaps.

*Extended 2026-10-03:* Docker, databases, the reverse proxy, traffic and logs ([[ADR-043-Server-Insight]]).

## As built (2026-10-02)
- Tried on a real Debian server: its `awk` is mawk, which printed large
  numbers (memory, network bytes) in e-notation and broke the reading.
  oraknid-monitor now prints every number as a plain integer
  (`printf "%.0f"`), which neither mawk nor gawk can overflow.

## Consequences
- No readings while my daemon is off.
- One SSH command every 15 s per server.

Related: [[Servers]] · [[ADR-026-Servers]]
