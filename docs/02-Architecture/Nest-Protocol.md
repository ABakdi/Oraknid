# The Nest protocol

How my devices reach the daemon through The Nest, encrypted end to end
([[ADR-017-Nest-E2E-Protocol]], [[ADR-018-Nest-Hosting]],
[[ADR-019-Nest-UI-Serving]]). Written 2026-10-02, before the code.

## Who holds what

| Party | Holds |
| :-- | :-- |
| Daemon | Its static X25519 key pair (in its data folder, 0600), its id, the Nest URL and the daemon secret The Nest knows it by. Each paired device's static public key. |
| Device | Its static X25519 key pair (browser storage), the daemon's id and static public key, the Nest URL, its device token. All given at **local pairing**, which is the trusted channel. |
| The Nest | The daemon secrets it accepts (its config), and nothing else: no keys, no tokens, no job data. |

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

- The daemon's link to The Nest carries many device connections,
  tagged by a connection number The Nest assigns. The Nest only moves
  opaque bytes between the two sockets of one connection.
- **Handshake**: each side proves its static key by sealing its fresh
  ephemeral public key to the other's static key (`crypto_box`); the
  daemon accepts only devices paired and not revoked. Session keys come
  from the two ephemerals (`crypto_kx`), so a later leak of a static key
  doesn't open recorded traffic. Then each direction is one
  `crypto_secretstream` (ordered, tamper-evident, rekeyed).
- **Inside the tunnel**, JSON messages:
  - `req {id, method, path, headers, body}` → `res {id, status, headers, body}`:
    an `/api` call, which the daemon makes to itself with the device's
    own token, so every rule of the local API applies.
  - `live-open`, `live {frame}`, `live-close`: the `/live` socket.
  - `ui` → `ui {html}`: the remote web UI, one self-contained page
    built for this ([[ADR-019-Nest-UI-Serving]]).

## The UI away from home
The Nest serves a small **loader** (a page and its script), nothing
else. The loader opens the tunnel with the keys stored at pairing, asks
the daemon for the UI through it, and starts it in place; the UI then
calls the API and the live socket through the same tunnel. The UI's
code comes only from the daemon, authenticated by the tunnel.

What the browser can't guarantee: the loader itself comes from The
Nest. A Nest that was broken into could serve a changed loader, and a
changed loader could lie about itself. The loader is small and its hash
is shown both in Settings at home and on the loader page, so I can
compare them; that narrows the risk, it doesn't remove it. A native app
would.

## Limits
The Nest caps connections per address and per daemon, sizes of frames,
and drops sockets idle past a minute without a ping.

Related: [[The-Nest]] · [[Security]] · [[Realtime-Transport]] · [[ADR-017-Nest-E2E-Protocol]]
