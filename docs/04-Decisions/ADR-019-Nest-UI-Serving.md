# ADR-019 — Where my phone gets the web UI from, when away from home

**Status:** Proposed · 2026-10-01 · [[Phase-4-The-Nest]] · waiting for my decision

## Context
Away from home, the browser loads the UI from The Nest's address. A web
page's code comes from whoever serves it: if The Nest could change the
UI, it could read what the UI decrypts, and the end-to-end encryption
([[ADR-017-Nest-E2E-Protocol]]) would protect nothing.

## Options
1. **A signed UI (recommended)**: The Nest serves only a tiny loader and
   service worker. The UI itself comes from the daemon through the
   encrypted tunnel, signed with the daemon's key; the service worker,
   installed while pairing at home, runs only code with that signature.
   The Nest can't change what runs. The PWA installs from The Nest's
   address once, at pairing.
2. **The Nest serves the UI build**: simplest, and the UI is the same
   for everyone; but The Nest (or whoever breaks into it) could serve a
   changed UI.
3. **A native app** (later, if ever): the strongest, but a second
   client to build.

## Proposed decision
Option 1. The first visit to The Nest's address happens during local
pairing, so the service worker is installed while I'm at home, and it
refuses any UI code the daemon didn't sign.

Related: [[The-Nest]] · [[ADR-017-Nest-E2E-Protocol]] · [[ADR-018-Nest-Hosting]] · [[Security]]
