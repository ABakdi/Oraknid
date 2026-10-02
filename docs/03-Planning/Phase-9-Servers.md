# Phase 9 — Servers

Touches [[Servers]], [[Security]], [[Web-UI]], [[Jobs-and-Projects]].
Written 2026-10-02.

## Why

My work ends on servers. Oraknid should know them, keep a document of
what they have, let the projects I choose use them without breaking
them, show how they are doing, and give me a terminal to them.

## Milestones

### M9.1 — Servers and their state
- [ ] Add a server (host, port, user, password or key, my description); host key pinned
- [ ] Oraknid's own key installed, a password deleted after ([[ADR-026-Servers]])
- [ ] Read-only discovery, and the state document written by The Eye, versioned, editable
- [ ] Servers page: list, state document, discover again, remove

### M9.2 — Servers in projects
- [ ] A project's servers (none by default); its jobs' sessions get the state documents and an SSH alias and key in the Leg's home
- [ ] The state document refreshed after a job that had the server

### M9.3 — oraknid-monitor
- [ ] Installed at setup; sampled over SSH every 15 s ([[ADR-027-Oraknid-Monitor]])
- [ ] Live and 24-hour charts, services and ports on the Servers page

### M9.4 — Terminal
- [ ] xterm.js page: this computer (node-pty) or a server (SSH) ([[ADR-028-Terminal]])
- [ ] Off by default (Settings), audited

## Exit criterion

I add my VPS, Oraknid discovers it and writes its state document,
oraknid-monitor shows its load, a job of a project I gave it deploys
there through approvals and the document is updated after, and I open a
terminal on it from the web UI.

Related: [[Roadmap]] · [[Servers]]
