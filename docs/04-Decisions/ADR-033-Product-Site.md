# ADR-033 — The product site at a Nest's root, the loader under /app/

**Status:** Accepted · 2026-10-03

## Context
`oraknid.abakdi.com` should introduce Oraknid: what it is, how to
install it, its guide, the repository and my contact. The same address
already serves The Nest's loader at `/`, which paired phones open.

## Decision
- **`apps/site`**: a static site (a home page and a guide written in
  Markdown), built by one script with the app's self-hosted fonts (IBM
  Plex Sans, JetBrains Mono) and Phosphor icons, nothing loaded from
  elsewhere. It follows the mark (an octopus eye on eight spider legs):
  deep ink, violet, amber only in the eye. Its pictures are real
  screenshots of the app, on a sample project (`public/shots/`, and
  `og.png` for links shared elsewhere).
- **The Nest serves it at its root**; the phone loader moves to
  `/app/` (its manifest, service worker and icons with it). Pairing
  links are `…/app/#oraknid=…`. An old pairing link is sent on to
  `/app/` by the site. *Changed 2026-10-04:* a device already paired is no
  longer sent on (with my computer off, the site never showed and I saw
  only "daemon isn't reachable"); it stays on the site, whose header
  button reads "Open your Oraknid". The installed app opens `/app/`
  itself. The loader, when my daemon can't be reached, says that Oraknid
  runs on my computer and, on a public Nest, links to the site and the
  guide.
- The loader's fingerprint is still shown at home and on the loader
  page ([[ADR-019-Nest-UI-Serving]]).

- **Where**: `oraknid.abakdi.com` (and my private Nest beside it) for
  now; `oraknid.com`, the name's own domain, isn't set up yet.

## Consequences
- A public Nest serves the product site; a private one shows no site
  at all (*changed 2026-10-03*, [[ADR-035-Nest-Pages-By-Mode]]).
- The guide on the site is for users; the canon (this folder) stays the
  design record.

Related: [[The-Nest]] · [[Nest-Protocol]] · [[ADR-031-Public-Nest]]
