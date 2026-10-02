# Phase 9 — Servers

Touches [[Servers]], [[Security]], [[Web-UI]], [[Jobs-and-Projects]].
Written 2026-10-02.

## Why

My work ends on servers. Oraknid should know them, keep a document of
what they have, let the projects I choose use them without breaking
them, show how they are doing, and give me a terminal to them.

## Milestones

### M9.1 — Servers and their state
- [x] Add a server (host, port, user, password or key, my description); host key pinned
- [x] Oraknid's own key installed, a password deleted after ([[ADR-026-Servers]])
- [x] Read-only discovery, and the state document written by The Eye, versioned, editable
- [x] Servers page: list, state document, discover again, remove

### M9.2 — Servers in projects
- [x] A project's servers (none by default); its jobs' sessions get the state documents and an SSH alias and key in the Leg's home
- [x] The state document refreshed after a job that had the server

### M9.3 — oraknid-monitor
- [x] Installed at setup; sampled over SSH every 15 s ([[ADR-027-Oraknid-Monitor]])
- [x] Live and 24-hour charts, services and ports on the Servers page

### M9.4 — Terminal
- [x] xterm.js page: this computer (node-pty) or a server (SSH) ([[ADR-028-Terminal]])
- [x] Off by default (Settings), audited

Tested against a stand-in SSH server (setup, discovery, documents,
host key change, monitor, removal, a job with a server), a real local
terminal, and a real Debian server: setup, its state document,
oraknid-monitor readings (after making its numbers plain for mawk) and
a terminal to it.

## Exit criterion

I add my VPS, Oraknid discovers it and writes its state document,
oraknid-monitor shows its load, a job of a project I gave it deploys
there through approvals and the document is updated after, and I open a
terminal on it from the web UI.

Related: [[Roadmap]] · [[Servers]]
