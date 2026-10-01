# Persistence and Recovery

SQLite with better-sqlite3 and Drizzle ([[ADR-002-Persistence]]). The
durable step engine runs on the same database ([[ADR-003-Job-Execution-Engine]]).

## Tables (MVP)

| Table | Holds |
| :-- | :-- |
| `projects`, `jobs`, `tasks`, `task_edges`, `web_versions` | The work. |
| `attempts`, `sessions` | Who tried what, native session IDs, end reasons, usage totals. |
| `legs`, `capability_profiles`, `leg_observations` | The pool and what was learned. |
| `quota_windows` | The latest window state per Leg. |
| `silk_entries` | Silk. |
| `skills`, `skill_versions` | The library. |
| `inbox_items` | Approvals and questions. |
| `steps` | The step journal: `(job_id, step_key)` PK, status, input hash, output. |
| `side_effects` | The outbox with idempotency keys. |
| `checkpoints` | Git refs per task. |
| `events` | Append-only, `seq` PK. Feeds the UI, the stats and the audit. |
| `devices`, `push_subscriptions` | Pairing and notifications. |
| `settings`, `policies` | Allow/deny lists, thresholds, notification routing. |

## Write discipline

- Every transition is a single transaction (BR-8). Effects outside the
  process happen **after** the commit, and are recorded as steps.
- Leg output chunks are written to the NDJSON log file and batched into
  `events` as condensed summaries every 250 ms.
- `synchronous=FULL`; WAL checkpointed when idle.

## Recovery sequence

The order is set out in [[Durability]]. Implementation notes:

- Leg processes are matched by `(pid, start_time from /proc/<pid>/stat)`
  to avoid killing a reused PID.
- Steps in `running` with an expired lease are replayed. A step is
  idempotent by construction, or guarded by `side_effects`.
- Recovery is tested by fault injection: a test harness kills the daemon
  (`SIGKILL`) at every step boundary in a scripted job, restarts it, and
  asserts that no step completed twice and that every side effect is at
  most once.

## Backups and pruning

- `.backup()` before every migration, and nightly (7 kept).
- Pruning (Settings): drop raw Leg logs and condensed events older than a
  date for chosen jobs. Silk, stats and audit entries are kept unless I
  delete the job.
- Export: a job or project as a zip (JSON + Silk markdown + logs).

Related: [[Durability]] · [[Data-Map]] · [[ADR-002-Persistence]] · [[ADR-003-Job-Execution-Engine]]
