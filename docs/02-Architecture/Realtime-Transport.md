# Realtime Transport

[[ADR-004-Realtime-Transport]] in practice.

| Topic | Content | Rate |
| :-- | :-- | :-- |
| `overview` | Leg cards, totals, problems, inhibitor state. | On change, coalesced 4/s. |
| `job:<id>` | Web changes, task states, activity, Silk changes, budgets. | On change. |
| `leg:<id>` | Condensed output stream of the Leg's current session. | Coalesced 4/s. |
| `inbox` | Items opened, answered, withdrawn. | On change. |
| `metrics` | CPU/RAM/GPU/VRAM/disk/net per Leg and process. | 1/s. |

Frame: `{ type: "event" | "snapshot" | "hello" | "ping", topic, seq, payload }`.
Client → server: `subscribe`, `unsubscribe`, `resume { lastSeq }`.

**Reconnect:** the client sends `lastSeq`. The server replays events with
`seq > lastSeq` for the subscribed topics. If more than 5,000 are
missing, it sends a `snapshot` instead.

**Auth:** the WebSocket upgrade requires a paired device's session token
(see [[Security]]).

Related: [[ADR-004-Realtime-Transport]] · [[Web-UI]] · [[API-Contract]]
