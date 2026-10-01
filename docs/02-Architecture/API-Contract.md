# API Contract

oRPC procedures under `/api`, schemas in `packages/contracts`
([[ADR-010-API-Contracts]]). OpenAPI is generated at build time. This
table is the summary and is kept in step with the contracts.

| Area | Procedure | Purpose |
| :-- | :-- | :-- |
| System | `system.status` | Version, uptime, pid, data directory, last event `seq` (inhibitor, keychain and sandbox status join in M1.2). |
| | `system.doctor` | Run the checks. |
| Devices | `devices.pairStart` / `devices.pairComplete` / `devices.list` / `devices.revoke` | Pairing. |
| Projects | `projects.create` / `list` / `get` / `archive` / `delete` / `stats` | |
| Jobs | `jobs.create` / `list` / `get` / `start` / `pause` / `resume` / `cancel` / `redirect` / `setAutonomy` / `stats` / `export` | |
| Web | `web.get` / `web.edit` (add, remove, reorder, rewrite tasks) | Plan editing. |
| Tasks | `tasks.get` / `tasks.pin` (to a Leg) / `tasks.takeOver` / `tasks.handBack` / `tasks.rollback` / `tasks.diff` | |
| Legs | `legs.create` / `update` / `delete` / `list` / `test` / `pause` / `resume` / `profile.get` / `profile.update` | |
| Silk | `silk.list` / `silk.add` / `silk.edit` / `silk.supersede` / `silk.importMirror` | |
| Inbox | `inbox.list` / `inbox.answer` | Approvals, questions, interview rounds. |
| Skills | `skills.list` / `get` / `upload` / `edit` / `delete` | |
| Logs | `audit.search` / `logs.tail` / `logs.export` | |
| Settings | `settings.get` / `settings.update` / `policies.get` / `policies.update` / `notifications.test` | |
| Storage | `storage.usage` / `storage.prune` | |

Every mutating procedure takes a client-generated `requestId`
(idempotency). Errors carry a code **and** a sentence for the UI
(BR-17).

Outside `/api`: `GET /health` (liveness, used by the CLI) and the
`/live` WebSocket ([[Realtime-Transport]]).

Related: [[ADR-010-API-Contracts]] · [[Realtime-Transport]] · [[Core-Entities]]
