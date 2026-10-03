# ADR-019 — Where my phone gets the web UI from, when away from home

**Status:** Accepted · 2026-10-02 · [[Phase-4-The-Nest]] · my decision: the recommended option

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

## Decision
Option 1, as built (2026-10-02): The Nest serves only a small loader.
The UI comes from the daemon through the end-to-end tunnel, which
already authenticates it (only the daemon holds the keys), so no
separate signature is needed. What a browser can't guarantee is the
loader itself: a service worker can't stop its own replacement by the
server. The loader's hash is shown at home and on the loader page for
me to compare ([[Nest-Protocol]]).

Since 2026-10-03 the loader lives at `/app/` and The Nest's root is the
static product site, which has no part in the tunnel
([[ADR-033-Product-Site]]).

Related: [[The-Nest]] · [[ADR-017-Nest-E2E-Protocol]] · [[ADR-018-Nest-Hosting]] · [[Security]]
