# The Nest protocol

How my devices reach the daemon through The Nest, encrypted end to end
([[ADR-017-Nest-E2E-Protocol]], [[ADR-018-Nest-Hosting]],
[[ADR-019-Nest-UI-Serving]]). Written 2026-10-02, before the code.

## Who holds what

| Party | Holds |
| :-- | :-- |
| Daemon | Its static X25519 key pair (in its data folder, 0600), its id, the Nest URL and the daemon secret The Nest knows it by. Each paired device's static public key. |
| Device | Its static X25519 key pair (browser storage), the daemon's id and static public key, the Nest URL, its device token. All given at **local pairing**, which is the trusted channel. |
| The Nest | The daemon secrets it accepts (its config) and, when public, the ids of the daemons that registered with a SHA-256 hash of each secret (`daemons.json` on its volume), and nothing else: no keys, no tokens, no job data. |

## Connections

```mermaid
sequenceDiagram
    participant D as Device
    participant N as The Nest
    participant A as Daemon
    A->>N: WSS /daemon (id, secret), outbound, kept open
    D->>N: WSS /device?daemon=id
    N->>A: open (connection c)
    D->>A: hello: device id, ephemeral pk, box(eph pk → daemon static)
    A->>D: welcome: ephemeral pk, box(both eph pks → device static)
    Note over D,A: session keys from the ephemerals (crypto_kx); secretstream each way
    D->>A: sealed frames (requests, live)
    A->>D: sealed frames (responses, live events)
```

- **A public Nest** (`NEST_MODE=public`, [[ADR-031-Public-Nest]]):
  a daemon first calls `POST /register` (JSON, `{ invite }` when the
  Nest sets `NEST_INVITE`) and gets `{ id, secret }`: a new id and a
  random 43-character secret, shown once. Oraknid keeps them as it keeps
  a configured Nest (the secret in the secret store) and connects to
  `/daemon` like any other. Registering is refused with 404 on a private
  Nest, 403 without the right code or from another site's page, 429 past
  the registrations of its address this hour, 503 when the Nest is full.
  `GET /info` answers `{ mode, inviteRequired }`; the loader shows it.
- The daemon's link to The Nest carries many device connections,
  tagged by a connection number The Nest assigns. The Nest only moves
  opaque bytes between the two sockets of one connection.
- **Handshake**: each side proves its static key by sealing its fresh
  ephemeral public key to the other's static key (`crypto_box`); the
  daemon accepts only devices paired and not revoked. Session keys come
  from the two ephemerals (`crypto_kx`), so a later leak of a static key
  doesn't open recorded traffic. Then each direction is one
  `crypto_secretstream` (ordered, tamper-evident, rekeyed). Each end
  accepts one handshake and one stream header per tunnel: a recorded
  header replayed by The Nest would rewind the stream ([[Audit-2]]).
- **Inside the tunnel**, JSON messages:
  - `req {id, method, path, headers, body}` → `res {id, status, headers, body}`:
    an `/api` call, which the daemon makes to itself with the device's
    own token and its unlocked session ([[ADR-029-App-Lock]]), marked as
    coming from away: every rule of the local API applies, and what
    opens a new way in (pairing, the terminal, policies, projects, Legs,
    tools, servers, the PIN) is refused, unless the device has full
    rights ([[ADR-030-Device-Rights]]); what stays home only for every
    device is refused whatever its rights.
  - `live-open`, `live {frame}`, `live-close`: the `/live` socket.
  - `term-open {id, token, unlock, target, cols, rows}`, `term-in {id, f}`,
    `term {id, d}`, `term-close {id}`: a terminal (2026-10-03), several
    at once by `id`. The daemon checks the token is this device's and
    opens its own `/term` marked as from away, which opens only for a
    device with full rights; it closes with the tunnel.
  - `ui` → `ui {html}`: the remote web UI, one self-contained page
    built for this ([[ADR-019-Nest-UI-Serving]]).

## The UI away from home
The Nest serves a small **loader** (a page and its script) at `/app/`,
and the static product site at its root, nothing else
([[ADR-033-Product-Site]]); a pairing link is `…/app/#oraknid=…`. The loader opens the tunnel with the keys stored at pairing, asks
the daemon for the UI through it, and starts it in place; the UI then
calls the API and the live socket through the same tunnel. The UI's
code comes only from the daemon, authenticated by the tunnel. It runs
in a **sandboxed frame** (an opaque origin): it can't read the loader's
storage, where the device's keys and token are, and reaches the tunnel
only through a message port the loader hands it.

What the browser can't guarantee: the loader itself comes from The
Nest. A Nest that was broken into could serve a changed loader, and a
changed loader could lie about itself. The loader is small and its hash
is shown both in Settings at home and on the loader page, so I can
compare them; that narrows the risk, it doesn't remove it (a changed
loader can print the right hash). What such a loader could do is
bounded: it needs my PIN, which it could catch as I type it, and then
it has only what a device away from home may do: for a standard
device no terminal, no new devices, no policies, projects, Legs, tools
or servers; for a device with full rights, all but what stays home only
([[ADR-030-Device-Rights]]). A native app would remove the risk. The
remote UI passes what breaks in its frame (errors, failed promises) to
the loader, which logs it in its own console, where I can read it.

## Limits
The Nest caps connections per address (an IPv6 address by its /64) and
per daemon, sizes of frames, and drops sockets idle past a minute
without a ping. A device socket opens only from the Nest's own page
(its Origin), sends at most three small frames until its daemon
answers, and has ten seconds for that. A daemon's secret is 32
characters or more. The Nest's page can't be framed (HSTS,
`X-Frame-Options`, no-sniff, no referrer).

A public Nest adds, for the daemons that registered (not those in
`NEST_DAEMONS`): five registrations per address an hour (every try
counts), a thousand daemons, ten devices each, 2 GB relayed per daemon
a day (past it, its devices are closed with 4029 and new ones refused
until the next UTC day), and a daemon unseen for 30 days is forgotten.
Registering is for Oraknid at home only: a device away from home can't
move its daemon to another Nest.

Related: [[The-Nest]] · [[Security]] · [[Realtime-Transport]] · [[ADR-017-Nest-E2E-Protocol]]
