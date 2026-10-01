# Phase 4 — The Nest

Touches [[The-Nest]], [[Security]], [[Notifications]], [[Realtime-Transport]].
Written 2026-10-01 as an outline. The spec still has open questions.

## Why

I want to approve and answer from anywhere, without opening ports at home.

## Milestones

### M4.1 — Decide the open questions
- [x] ADR: E2E protocol ([[ADR-017-Nest-E2E-Protocol]]: libsodium kx + secretstream)
- [x] ADR: hosting and deploy shape ([[ADR-018-Nest-Hosting]]: a VPS with Docker Compose and Caddy)
- [x] ADR: where the UI is served from ([[ADR-019-Nest-UI-Serving]]: a UI signed by the daemon, checked by a service worker)

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
