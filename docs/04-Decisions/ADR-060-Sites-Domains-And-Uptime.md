# ADR-060 — Sites, domains, certificates and uptime, seen from this computer

**Status:** Accepted · 2026-10-07 · builds on [[ADR-043-Server-Insight]], [[ADR-026-Servers]], [[Notifications]]

## Context
My servers' reverse proxies serve sites (ADR-043 reads them per server).
I want the sites across all my servers in one place: which domain points
where, when each certificate ends, and whether each site answers, with a
notification when one goes down and when it is back.

## Decision
- **A site** is a domain (`sites`: host, the URL checked, the server and
  proxy that serve it, the upstream). Sites come from the proxies' sites
  of my ready servers (nginx, Caddy, Traefik, HAProxy; ADR-043's proxy
  part), read with **Find sites** and after each discovery; a domain with
  a wildcard or none (`_`, `localhost`, an IP) is left out. I can add one
  by hand (a domain or a URL) and remove any; a removed site found again
  stays removed (kept as `hidden`).
- **DNS, resolved from the daemon** (`dns.promises`, the system's
  resolver): A, AAAA and CNAME; the site **points here** when one of its
  addresses is one of its server's (the server's host, resolved);
  otherwise it says where it points. Read with each check of the
  certificate, and on demand.
- **The certificate, from a TLS handshake** from the daemon (port 443,
  SNI the domain, not verified so an expired one is still read): its
  expiry, issuer and names, and whether it is valid for the domain.
  Red under 14 days, ended in red. Read every 6 hours, and on demand.
- **Uptime from this computer**: an HTTP(S) `GET` of the site's URL
  every N minutes (default 5, 1–60, per site), 10 s limit, redirects not
  followed; **up** is any answer below 500, **down** a 5xx, a timeout or
  no connection. Each check (`site_checks`: time, up, status, latency,
  error) is kept **7 days**. A site **down twice in a row** is the
  `site.down` notification, once; the first check up after is
  `site.up`, with how long it was down. Checks run only while Oraknid
  runs, a few at a time, and stop for a site I turn off.
- **Where**: a **Sites** tab on the Servers page (every site: domain,
  server, up or down with a latency sparkline of the last day and its
  uptime over 24 hours and 7 days, the certificate's end, DNS); the
  helper (`sites` read action) and the terminal app (`/sites`) list them.
- Nothing here changes a server; it reads public answers. Adding,
  removing and changing a site work away from home (they reach nothing
  of mine).

## Consequences
- The checks are from this computer: a site down for the world but
  reachable from here (or the reverse) reads so. Oraknid off, no checks.
- A domain served by no proxy Oraknid reads is added by hand.

Related: [[Servers]] · [[ADR-043-Server-Insight]] · [[Notifications]] · [[Web-UI]]
