# Phase 4 — The Nest

Touches [[The-Nest]], [[Security]], [[Notifications]], [[Realtime-Transport]].
Written 2026-10-01 as an outline. The spec still has open questions.

## Why

I want to approve and answer from anywhere, without opening ports at home.

## Milestones

### M4.1 — Decide the open questions
- [ ] ADR: E2E protocol
- [ ] ADR: hosting and deploy shape
- [ ] ADR: where the UI is served from

### M4.2 — Relay
- [ ] `apps/nest`: Express + WebSocket relay, outbound daemon connection, reconnect
- [ ] Device ↔ daemon E2E; The Nest sees only ciphertext
- [ ] Deploy files in `deploy/` (compose, proxy, TLS)

### M4.3 — Remote use
- [ ] Web push through The Nest
- [ ] Mobile pass of every screen over the relay

## Exit criterion

From my phone on mobile data, I approve an action and answer a question
on a job running at home.

Related: [[Roadmap]] · [[The-Nest]]
