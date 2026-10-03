# ADR-035 — What a Nest shows, by its mode

**Status:** Accepted · 2026-10-03

## Context
Every Nest served the product site at its root ([[ADR-033-Product-Site]]).
On the public Nest the site read as a plain landing page, with no way
to tell it also relays devices or to get to pairing. A private Nest is
for me alone: it should not introduce anything, be found by a search
engine, or appear anywhere unless I share its address.

## Decision
- **Public Nest**: the product site at its root, plus:
  - an **Open Oraknid** button in the header and the hero, to `/app/`,
    where a device is paired or opens its daemon;
  - a line on the home page that this server is a public Nest, whether
    registering needs an invite (from `/info`), and how to use it from
    Oraknid (Settings → Devices & phone → Use a public Nest).
- **Private Nest**: no site. Its root and every path other than the
  loader (`/app/…`), the relay's own endpoints and `/robots.txt` answer
  a bare `404` with no name or branding. Every response carries
  `X-Robots-Tag: noindex, nofollow, noarchive`; `/robots.txt` disallows
  everything; the loader page has `noindex` and no description or
  preview tags. Nothing links to it: not the public site, the guide,
  the repository or the canon (which say "my private Nest").
- **The public Nest** also says `noindex` on `/app/` (the loader isn't
  content), and keeps its site indexable.

## Consequences
- A search engine finds nothing on a private Nest, and a visitor who
  guesses its address sees only "not found" at its root.
- What this can't hide: a certificate from Let's Encrypt is published
  in Certificate Transparency logs, which name the domain. A private
  Nest under a wildcard certificate (DNS challenge) or an unguessable
  name avoids that; `install.sh` keeps using a certificate per domain,
  and the guide says so.
- Old commits in the public repository still name my private Nest's
  address; only rewriting that history would take it out.

Related: [[The-Nest]] · [[ADR-031-Public-Nest]] · [[ADR-033-Product-Site]] · [[Nest-Protocol]]
