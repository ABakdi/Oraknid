# ADR-018 — Where The Nest runs, and how it is deployed

**Status:** Accepted · 2026-10-02 · [[Phase-4-The-Nest]] · my decision: the recommended option

## Context
The Nest is self-hosted, publicly reachable over TLS, stores no job
data, and only relays. It needs a domain name and a certificate.

## Options
1. **A small VPS with Docker Compose and Caddy (recommended)**:
   `apps/nest` as one container behind Caddy, which gets and renews the
   certificate by itself. `deploy/` holds the compose file and the
   Caddyfile; one command to update. Costs a few euros a month; I need a
   domain (or a subdomain) pointed at it.
2. **A platform (Fly.io, Railway…)**: no server to keep, but tied to a
   provider's limits on long-lived WebSockets and its pricing.
3. **A machine at home with a tunnel service**: no VPS, but it puts a
   third party's tunnel in front of everything, which The Nest exists to
   avoid.

## Decision
Option 1, with rate limiting and connection caps in The Nest itself
(it's on the internet), and only device and daemon identities stored.

Amended 2026-10-02: a server that already runs nginx for other sites
keeps it. `deploy/nest/install.sh` runs The Nest alone in Docker on a
local port, adds one nginx site (checked before a reload, never a
restart) and gets the certificate with certbot. On a small server the
image is built elsewhere and brought with `--image`, so the build takes
no memory from what runs there.

Related: [[The-Nest]] · [[ADR-017-Nest-E2E-Protocol]] · [[ADR-019-Nest-UI-Serving]]
