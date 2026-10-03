# ADR-031 — A Nest can be public: other people's daemons register themselves

**Status:** Accepted · 2026-10-03 · [[Phase-11-Workspace]]

## Context
`oraknid.abakdi.com` should serve other people too: anyone running
Oraknid connects their daemon and devices, without me adding them by
hand. A Nest carries only end-to-end encrypted traffic, so it can be
shared without seeing anyone's data. I also want a private Nest of my
own (`private.oraknid.abakdi.com`).

## Decision
- `NEST_MODE=private` (default): the daemons in `NEST_DAEMONS` only,
  as today.
- `NEST_MODE=public`: a daemon registers itself: `POST /register`
  returns a new id and a long random secret (only its hash is kept, in
  a small file on a volume). Then it connects like any daemon.
  `NEST_DAEMONS` still work beside them.
- Abuse limits in public mode: registrations per address per hour, a
  cap on daemons, devices per daemon, bytes per daemon per day; a
  daemon unseen for 30 days is forgotten. Optional `NEST_INVITE` makes
  registration need a code.
- The Nest's page says whether it is public, and that it can't read
  anything it carries; its loader fingerprint is shown as before.
- In Oraknid, Settings → Devices & phone → The Nest: "Use a public
  Nest" with its address registers in one click; "My own Nest" takes an
  id and secret as before.
- `install.sh` asks `--public` or `--private` (default private), and can
  run two Nests on one server, one per domain.

## As built (2026-10-03)
- `POST /register` and `GET /info` on The Nest; registered daemons are
  kept in `daemons.json` on its volume with the hash of their secret.
  Limits as decided: five registrations per address an hour, a thousand
  daemons, ten devices each, 2 GB a day each, forgotten after 30 days
  unseen ([[Nest-Protocol]] → Limits).
- In Oraknid, `nest.register` (home only) registers and connects; the
  address offered by default is `https://oraknid.abakdi.com`.
- `install.sh <domain> [--public | --private] [--invite CODE | --no-invite]`
  runs one Nest per domain and moves an older single install over.
  Mine: `oraknid.abakdi.com` public and `private.oraknid.abakdi.com`
  private, on the same server; both deployed 2026-10-03
  ([[Phase-11-Workspace]] → M11.4), my daemon still on the public one
  until I re-pair my phone.

## Consequences
- A public Nest sees who connects and how much, never what.
- Someone running a public Nest could serve a changed loader to its
  users (Audit-2 S2-02): users who care run their own.

Related: [[The-Nest]] · [[ADR-018-Nest-Hosting]] · [[Nest-Protocol]]
