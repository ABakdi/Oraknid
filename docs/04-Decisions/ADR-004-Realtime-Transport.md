# ADR-004 — Plain WebSocket (ws) with sequenced, replayable events

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Every screen updates live. Phones background and reconnect. In Phase 4
the same traffic has to pass through The Nest, a relay the daemon
connects to outbound.

## Decision
- **`ws`** attached to the Express `http.Server` through `upgrade`.
- One multiplexed connection per client. Frames are a Zod-validated union
  `{ type, topic, seq, payload }` from `packages/contracts`.
- Every event has a monotonically increasing `seq`, persisted in the
  `events` table. A client reconnects with `lastSeq` and receives the
  gap. If the gap is too large, it receives a fresh snapshot.
- Clients subscribe to topics (`overview`, `job:<id>`, `leg:<id>`,
  `inbox`, `metrics`). High-rate topics (metrics, Leg output) are
  coalesced server-side to at most 4 frames per second per topic.
- App-level heartbeat every 15 s.
- Commands (pause, approve…) go over HTTP, not the socket, so they get
  normal status codes, auth and idempotency keys.
- Browser side: native WebSocket with a small reconnecting wrapper.

## Consequences
- The Nest only forwards opaque frames in an envelope `{ deviceId, frame }`.
  Plain WebSocket keeps the relay trivial.
- Reconnects are lossless up to the retention of the events table.

## Why not Socket.IO
Its own protocol on top of WebSocket makes the relay speak engine.io,
and its rooms and acks are easy to build ourselves.

## Why not Server-Sent Events
One-way only, so commands would still need another channel.
Acceptable later as a read-only fallback.

Related: [[Realtime-Transport]] · [[The-Nest]]
