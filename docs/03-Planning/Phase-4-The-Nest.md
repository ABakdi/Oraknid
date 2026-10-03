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
- [x] `apps/nest`: Express + WebSocket relay, the daemon's outbound connection with reconnects, limits per address and per daemon
- [x] Device ↔ daemon E2E (`packages/tunnel`, libsodium); The Nest sees only ciphertext; tested end to end through a real Nest and in Chrome with the loader
- [x] Deploy files in `deploy/nest/` (Dockerfile, Compose, Caddy for TLS, a guide); the image built and ran 2026-10-02
- [x] `install.sh`, one script that installs what is missing (Docker, nginx, certbot), configures nginx and HTTPS, and leaves a server's other sites alone: deployed 2026-10-02 at https://oraknid.abakdi.com on my test server (beside its other sites, untouched), the daemon at home connected to it
- [x] Pairing a device for away from Settings, by a QR code or link whose keys stay in the fragment; the loader's fingerprint shown at home

### M4.3 — Remote use
- [~] Web push away from home: the loader registers the subscription (the UI's frame can't) and a small service worker shows the notifications; the daemon sends them straight to the push service, encrypted to the browser, so The Nest isn't involved. Not yet tried on a phone (The Nest is deployed; the phone test is mine)
- [ ] Mobile pass of every screen over the relay (The Nest is deployed; needs my phone)

## Exit criterion

From my phone on mobile data, I approve an action and answer a question
on a job running at home.

Related: [[Roadmap]] · [[The-Nest]]
