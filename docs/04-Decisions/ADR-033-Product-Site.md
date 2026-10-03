# ADR-033 — The product site at a Nest's root, the loader under /app/

**Status:** Accepted · 2026-10-03

## Context
`oraknid.abakdi.com` should introduce Oraknid: what it is, how to
install it, its guide, the repository and my contact. The same address
already serves The Nest's loader at `/`, which paired phones open.

## Decision
- **`apps/site`**: a static site (a home page and a guide written in
  Markdown), built by one script with self-hosted fonts (Geist, Geist
  Mono) and Phosphor icons, nothing loaded from elsewhere. It follows
  the mark (an octopus eye on eight spider legs): deep ink, violet,
  amber only in the eye.
- **The Nest serves it at its root**; the phone loader moves to
  `/app/` (its manifest, service worker and icons with it). Pairing
  links are `…/app/#oraknid=…`. A device that was paired before, or an
  old pairing link, is sent on to `/app/` by the site.
- The loader's fingerprint is still shown at home and on the loader
  page ([[ADR-019-Nest-UI-Serving]]).

## Consequences
- Every Nest built from this repository serves the product site; a
  self-hosted private Nest shows it too.
- The guide on the site is for users; the canon (this folder) stays the
  design record.

Related: [[The-Nest]] · [[Nest-Protocol]] · [[ADR-031-Public-Nest]]
