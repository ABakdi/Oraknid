# ADR-010 — Zod 4 contracts, served through oRPC mounted in Express

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
The daemon, the web UI and later The Nest and the CLI share every request,
response and frame. Express is fixed by the brief. Typing on both sides
should come from one definition, and an OpenAPI description helps
tooling and non-TypeScript clients.

## Decision
- **Zod 4** schemas in `packages/contracts` for every entity, request,
  response, WebSocket frame and event.
- **oRPC** procedures defined against those schemas, mounted into Express
  under `/api`. The web client and the CLI use oRPC's typed client.
  An OpenAPI document is generated from it at build time.
- Plain Express handles everything else: static UI, health, the
  WebSocket upgrade, web push endpoints.

## Consequences
- One definition, typed end to end, validated at runtime on the server.
- A documented API for free ([[API-Contract]] is generated from it,
  plus a hand-written summary).

## As built (2026-10-07, [[ADR-058-CI-In-Oraknid]])
The OpenAPI document was promised and not made until then. It is
generated from the router by `@orpc/openapi` with `@orpc/zod`'s Zod 4
converter (both 1.15.4, the installed oRPC): served at
`GET /api/openapi.json` to paired devices (made when first asked, then
kept), and written to `docs/02-Architecture/openapi.json` by `pnpm
--filter @oraknid/daemon openapi`. Not by the plain build: an install
builds in its own checkout, and a file changed there would make the next
update refuse ("local changes"); the release script regenerates it and
CI fails when it isn't the router's. It describes each procedure's input
and output under `/api/<path>`; the wire stays oRPC's RPC protocol
(`POST` with `{"json": input}`), as its description says. No REST-shaped
handler is mounted beside it. [[API-Contract]] stays the hand-written
summary.

## Why not tRPC
Its RPC-only wire format is less friendly to the relay and to
non-TypeScript clients than oRPC with OpenAPI.

## Why not ts-rest
No release since early 2025. Looks unmaintained.

Related: [[API-Contract]] · [[ADR-001-Monorepo]] · [[ADR-004-Realtime-Transport]]
