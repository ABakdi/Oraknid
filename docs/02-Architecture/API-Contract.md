# API Contract

oRPC procedures under `/api`, schemas in `packages/contracts`
([[ADR-010-API-Contracts]]). OpenAPI is generated at build time. This
table is the summary and is kept in step with the contracts.

| Area | Procedure | Purpose |
| :-- | :-- | :-- |
| System | `system.status` | Version, uptime, pid, data directory, last event `seq`, inhibitor, secret store, sandbox and service status. |
| | `system.doctor` | Run the checks. |
| Devices | `devices.pairStart` / `devices.pairComplete` / `devices.list` / `devices.revoke` | Pairing. |
| Projects | `projects.create` / `list` / `get` / `archive` / `delete` / `stats` | |
| Jobs | `jobs.create` / `list` / `get` / `start` / `pause` / `resume` / `cancel` / `redirect` / `setAutonomy` / `stats` / `export` | |
| Web | `web.get` / `web.edit` (add, remove, reorder, rewrite tasks) | Plan editing. |
| Tasks | `tasks.get` / `tasks.pin` (to a Leg) / `tasks.takeOver` / `tasks.handBack` / `tasks.rollback` / `tasks.diff` | |
| Legs | `legs.list` / `get` / `create` / `test` / `update` / `pause` / `resume` / `remove` / `setModelHidden` / `setProfile` | Creating tests the Leg at once. A Leg's view carries its models with effective profiles (defaults, learned, my overrides), quota windows, VRAM, and a setup hint (e.g. how to log in). |
| Silk | `silk.list` / `silk.add` / `silk.edit` / `silk.importMirror` | Editing supersedes. `importMirror` looks for hand edits now. |
| Inbox | `inbox.list` / `inbox.answer` | Approvals, questions, interview rounds. (A first version exists since M1.5.) |
| Skills | `skills.list` / `get` / `upload` / `edit` / `delete` | |
| Logs | `audit.search` / `logs.tail` / `logs.export` | |
| Secrets | `secrets.unlock` | Opens the encrypted-file store when there is no keychain. |
| Metrics | `metrics.recent` | Samples since a time, up to the last hour. |
| Notifications | `notifications.get` / `update` / `configureEmail` / `test` / `vapidPublicKey` / `subscribe` / `unsubscribe` | Per-channel switches, SMTP setup (password to the secret store), web push. |
| Settings | `settings.get` / `settings.update` / `policies.get` / `policies.update` | |
| Storage | `storage.usage` / `storage.prune` | |

Every mutating procedure takes a client-generated `requestId`
(idempotency). Errors carry a code **and** a sentence for the UI
(BR-17).

Outside `/api`: `GET /health` (liveness, used by the CLI) and the
`/live` WebSocket ([[Realtime-Transport]]).

Related: [[ADR-010-API-Contracts]] · [[Realtime-Transport]] · [[Core-Entities]]
