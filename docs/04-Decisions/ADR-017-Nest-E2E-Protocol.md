# ADR-017 — End-to-end encryption between my devices and the daemon

**Status:** Proposed · 2026-10-01 · [[Phase-4-The-Nest]] · waiting for my decision

## Context
The Nest relays my devices' traffic to the daemon at home. It must see
only ciphertext (The Nest spec). Devices are paired with the daemon
locally first ([[Security]]); the `devices` table already has a
`publicKey` column, empty so far.

## Options
1. **libsodium (recommended)**: at local pairing, the device and the
   daemon exchange X25519 public keys (the pairing channel is local, so
   it is trusted). Each connection through The Nest derives session keys
   with `crypto_kx`, then every frame is sealed with
   `crypto_secretstream` (XChaCha20-Poly1305, ordered, tamper-evident,
   rekeys). One small, audited library (`libsodium-wrappers`) works the
   same in Node and the browser; no handshake protocol of our own.
2. **Noise (XX or IK)**: the textbook protocol for this, with forward
   secrecy built in. The maintained JavaScript implementations are part
   of larger stacks (libp2p); a hand-written one is risky.
3. **TLS inside the tunnel**: the daemon terminates a second TLS
   session relayed by The Nest. Browsers can't speak raw TLS over a
   WebSocket, so it doesn't fit a web UI.

## Proposed decision
Option 1. Forward secrecy comes from fresh ephemeral keys per
connection, signed by the paired long-term keys. Revoking a device
removes its key, so The Nest can't replay or forge it.

Related: [[The-Nest]] · [[Security]] · [[ADR-018-Nest-Hosting]] · [[ADR-019-Nest-UI-Serving]]
