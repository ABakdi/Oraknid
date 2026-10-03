# Realtime Transport

[[ADR-004-Realtime-Transport]] in practice.

| Topic | Content | Rate |
| :-- | :-- | :-- |
| `overview` | Leg cards, totals, problems, inhibitor state; and what has no topic of its own: `server.*`, `chat.*`, `helper.*`, `device.*`, `lock.*`, `terminal.*`, `settings.updated`, `project.localPorts`. | On change, coalesced 4/s. |
| `job:<id>` | Web changes, task states, activity, Silk changes, budgets. | On change. |
| `leg:<id>` | Condensed output stream of the Leg's current session. | Coalesced 4/s. |
| `inbox` | Items opened, answered, withdrawn. | On change. |
| `mail` | Accounts' state, `mail.new` (from IDLE on INBOX), `mail.synced`, `mail.changed`, drafts and sends, `mail.agent.*` (Phase 12). | On change; a sync pass is one event, not one per message. |
| `storage` | `cloud.*` events: providers added, checked, changed, removed; the placement; files uploaded, moved, deleted; folders moved, deleted; a sign-in ready ([[ADR-046-Cloud-Storage]]). Uploads' progress comes as `transfer { transfer }` frames to sockets subscribed here, **not events**: never stored or replayed. | On change; a transfer at most 4/s. |
| `metrics` | CPU/RAM/GPU/VRAM/disk/net per Leg and process. Sent as `metrics` frames, **not events**: never stored in the event log or replayed. The last hour is in memory (`metrics.recent`). | 1/s. |

Server frames: `hello { version, seq }`, `event { event }`, `metrics { sample }`,
`transfer { transfer }` (2026-10-03),
`snapshot-needed { seq }`, `ping`, `error { message }` (`packages/contracts/src/live.ts`).
Client → server: `subscribe`, `unsubscribe`, `resume { lastSeq }`.

A server's log ([[ADR-043-Server-Insight]]): the client sends
`logs-open { id, serverId, source }` and gets `log { id, lines }` (every
250 ms, at most 500 lines at once, the rest counted) until `log-end { id,
error }`; `logs-close { id }`, or the socket closing, ends the follower's
input on the server, which stops it. At most four per socket; not events,
never stored or replayed; the client opens them again after a reconnect.

**Reconnect:** the client sends `lastSeq`. The server replays events with
`seq > lastSeq` for the subscribed topics. If more than 5,000 are
missing, it sends a `snapshot` instead.

**Auth:** the WebSocket upgrade requires a paired device's token and an
unlocked session (`unlock` in the address; [[ADR-029-App-Lock]]). The
socket is checked again at every heartbeat and closed at once when the
device locks or is revoked (see [[Security]]).

The topic pattern also accepts `chat:<id>`; nothing publishes there yet
(chats use `chat.*` on `overview`).

A job's state, its tasks' states and its sessions' starts and ends also
reach `overview` subscribers as a hint to reload, at most 4/s per
client, never stored or replayed ([[Audit-1]] Q1-05).

Related: [[ADR-004-Realtime-Transport]] · [[Web-UI]] · [[API-Contract]]
