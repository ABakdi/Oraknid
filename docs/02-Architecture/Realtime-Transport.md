# Realtime Transport

[[ADR-004-Realtime-Transport]] in practice.

| Topic | Content | Rate |
| :-- | :-- | :-- |
| `overview` | Leg cards, totals, problems, inhibitor state. | On change, coalesced 4/s. |
| `job:<id>` | Web changes, task states, activity, Silk changes, budgets. | On change. |
| `leg:<id>` | Condensed output stream of the Leg's current session. | Coalesced 4/s. |
| `inbox` | Items opened, answered, withdrawn. | On change. |
| `mail` | Accounts' state, `mail.new` (from IDLE on INBOX), `mail.synced`, `mail.changed`, drafts and sends, `mail.agent.*` (Phase 12). | On change; a sync pass is one event, not one per message. |
| `metrics` | CPU/RAM/GPU/VRAM/disk/net per Leg and process. Sent as `metrics` frames, **not events**: never stored in the event log or replayed. The last hour is in memory (`metrics.recent`). | 1/s. |

Server frames: `hello { version, seq }`, `event { event }`, `metrics { sample }`,
`snapshot-needed { seq }`, `ping`, `error { message }` (`packages/contracts/src/live.ts`).
Client → server: `subscribe`, `unsubscribe`, `resume { lastSeq }`.

**Reconnect:** the client sends `lastSeq`. The server replays events with
`seq > lastSeq` for the subscribed topics. If more than 5,000 are
missing, it sends a `snapshot` instead.

**Auth:** the WebSocket upgrade requires a paired device's session token
(see [[Security]]).

A job's state, its tasks' states and its sessions' starts and ends also
reach `overview` subscribers as a hint to reload, at most 4/s per
client, never stored or replayed ([[Audit-1]] Q1-05).

Related: [[ADR-004-Realtime-Transport]] · [[Web-UI]] · [[API-Contract]]
