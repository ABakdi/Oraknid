# ADR-071 — A site is down only when it is down

**Status:** Accepted · 2026-10-16 · extends [[ADR-060-Sites-Domains-And-Uptime]], [[Notifications]]

## Context
On 2026-10-16 the uptime watch (ADR-060) sent about 300 desktop
notifications in a day: "Down: files.example.app. No answer in 10
seconds. Two checks in a row from this computer failed.", then "Up
again: www.example.app …", over and over, each critical, each waiting
for a click, each emailed at once by default.

What the data showed:

1. **18 sites, one server.** All found from the nginx of one server,
   checked every 5 minutes. In 24 hours each failed about 30 of 83
   checks, at random; in every round 7 to 12 of the 18 failed at once
   with "No answer in 10 seconds". 371 flips between up and down, 192
   `site.down`/`site.up` events.
2. **The sites weren't down.** The route from this computer to that
   server drops connections: from here a well known site answered 6 of
   6 while the server's sites (and others hosted near it) answered
   about half the time; pings to a public resolver lost nothing. "Two
   checks in a row from this computer failed" is a bad signal on a
   lossy path.
3. **Each site flapped on its own**, and each flap was its own
   notification: one cause, the path, said as dozens of outages.
4. Two hosts were really gone from DNS. They were said once, which was
   right.

## Decision
**A site is said down only when it doesn't answer, not when the way to
it is losing packets. What only fails from here is one incident about
the server, said once, quietly.**

### 1. Try again before counting
A check that got no answer at all (a timeout, the connection refused or
cut, the host unreachable, a DNS server that didn't answer) is tried
again after 2 s, then after 5 s, within the same check. Only the last
try counts. A 5xx, or a domain DNS doesn't know, is an answer: it counts
at once and isn't tried again. On a path losing 40% of its connections,
a check now fails about 6% of the time instead of 40%.

### 2. Ask the server before saying down
When a site would be down (two failed checks in a row, §4 aside) and
its last failure was no answer, and it has a server Oraknid can reach
(set up, its host key accepted), the server is asked: over Oraknid's
SSH connection, one short script for all the round's sites of that
server, each fetched by the server itself with
`curl -sk --resolve <domain>:<port>:127.0.0.1 <url>` (then the site's
own addresses when they are the server's). A GET, nothing changed; 8 s
per site, 30 s for the whole, the connection tried twice.

- **The server gets an answer below 500**: the site answers; it is down
  **from here only** (`downReason: path`). Not `site.down`.
- **The server gets no answer, or a 5xx**: it is down (`site`), said as
  `site.down` with "<server> gets no answer from it either." or "On
  <server> itself it answers 502."
- **The server can't be reached either**: Oraknid can't tell whether
  the sites are down or the way to them is (`server`). Not `site.down`.
- **The server has no curl**, or it has no server (added by hand), or
  the failure was an answer (DNS gone, a 5xx): no second opinion; down
  after two failures, as before.

A site down from here only is asked again each round it still fails; if
the server later stops getting an answer, it becomes a real down then.

### 3. One incident per cause, not per site
The sites of one server that are down from here only, or whose server
can't be reached, are one incident about the server, `site.path`:

- "This computer is losing its connection to staging: 9 of its 18
  sites didn't answer from here; from the server they answer. They
  aren't counted as down."
- "Can't reach staging from this computer: 9 of its 18 sites didn't
  answer from here, and neither did staging over SSH: it may be down,
  or the way to it."

Normal urgency, desktop only by default (no push, no email), one per
server at most once a day (the last one is read from the events table,
so a restart doesn't say it again). Its end, when no site of that server
is down from here any more, is `site.path-ok`, which notifies nobody.
Real downs (DNS gone, a 5xx, the server agrees) keep `site.down` and
`site.up`, critical, once each.

### 4. Flap damping
A site that came back (a `site.up`) less than 30 minutes ago and fails
again is said down only after failing for 15 minutes and at least 3
checks in a row. A down that was never said comes back without a word,
as before.

### 5. Shown in words
`sites.down_reason` (`site`, `path`, `server`), `failing_since` (the
first failed check in a row: a down's start) and `back_at` (the last
`site.up`), migration 0046; sites down before it stay `site`. `SiteView`
carries `downReason`. The Sites tab shows "down from here only" and
"<server> unreached" in amber, not "down" in red, and one line per
server: "This computer is losing its connection to staging: 9 of its 18
sites don't answer from here; from the server they answer." The helper's
`sites` and the terminal's `/sites` say the same; the helper counts only
real downs.

## As built (2026-10-16)
- `apps/daemon/src/sites/probes.ts`: `transient()` (no answer, not a
  5xx, not a domain DNS doesn't know).
- `apps/daemon/src/sites/service.ts`: a round's checks are probed (with
  the retries), then judged together (`#settle`): kept, counted, the
  candidates asked of their server (`askScript`, `Servers.run`), the
  incidents opened and closed per server. A check of one site (Check
  now) goes through the same judgment, alone.
- `apps/daemon/src/notify/router.ts`: `site.path` in words; `site.down`
  carries `why`. `site.path` is in the routing table and Settings →
  Notifications ("A server's sites don't answer from this computer").
- Tests (`sites.test.ts`), with a probe and a server's `run` as
  stand-ins: the owner's day (18 sites, 288 rounds, 40% of connections
  lost and one round in four losing 90%, the server answering) makes no
  `site.down`, no `site.up` and one notification; a real outage the
  server confirms is said down once and up once; DNS gone and a 5xx are
  said without asking and aren't tried again; the server out of reach
  is one incident, its end quiet, not said again within the day; flap
  damping; the server's script run here with `sh` against a stand-in on
  127.0.0.1.

## Consequences
- A server that is really off is said as "can't reach <server> from
  this computer", normal urgency, not as its sites down: Oraknid can't
  tell it from the way to it being cut. The server going stale
  (ADR-026) says the rest.
- A check that gets no answer takes up to about 37 s (three tries of
  10 s, and the pauses); a round of many failing sites takes longer,
  four at a time.
- The second opinion runs a read-only command on the server over SSH,
  the way oraknid-monitor's readings do; nothing is installed.
- A site that only the server can reach (nginx listening on another
  address than 127.0.0.1 and the site's own) is said down when it fails
  from here, as before.

Related: [[ADR-060-Sites-Domains-And-Uptime]] · [[Servers]] · [[Notifications]] · [[ADR-026-Servers]]
