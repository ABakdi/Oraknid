# Persistence and Recovery

SQLite with better-sqlite3 and Drizzle ([[ADR-002-Persistence]]). The
durable step engine runs on the same database ([[ADR-003-Job-Execution-Engine]]).

## Tables (as built, 2026-10-03)

| Table | Holds |
| :-- | :-- |
| `projects` | Workspaces, with their skills and servers (`skill_ids`, `server_ids`); a server's own project names it (`server_id`, migration 0037, [[ADR-049-Server-Chat-And-Server-Jobs]]). |
| `jobs`, `tasks`, `task_edges` | The work. The Web's version is a number on the job (`web_version`), raised at every plan change. |
| `attempts`, `sessions` | Who tried what, native session IDs, end reasons, usage totals. |
| `legs`, `leg_models` | The pool. Capability profiles and quota windows are JSON on `leg_models` (per model) and `legs` (account-wide), with `limited_until` on the Leg. |
| `silk_entries` | Silk. |
| `silk_mirror` | What Oraknid last wrote to each mirror file (hash), and the open import question. |
| `skills` | The library: one row per skill and version. |
| `inbox_items` | Approvals and questions. |
| `eye_messages` | My conversation with The Eye per job, with what it did about each message (migration 0012); in a server's conversation, a question answered without a job has no job (migration 0037). |
| `eye_plans` | Every plan and its shadow's, to compare ([[ADR-022-Eye-Decision-Models]]). |
| `steps` | The step journal: `(job_id, step_key)` PK, status, input hash, output. |
| `side_effects` | The outbox with idempotency keys. |
| `events` | Append-only, `seq` PK. Feeds the UI, the stats and the audit. |
| `devices`, `push_subscriptions` | Pairing and notifications. |
| `settings` | One JSON value per key: limits, policies, The Eye's models, the PIN's hash, device rights, a project's local ports… ([[Data-Map]] → Settings keys). |
| `tools` | MCP servers for skills ([[ADR-021-Tools-Broker]]). |
| `chats`, `chat_messages`, `helper_messages` | Chats and the helper ([[Chats-and-Helper]]). |
| `servers`, `server_states`, `server_samples` | My servers (with my Production mark), their state documents (each with the job whose end wrote it), oraknid-monitor's readings ([[Servers]]). |
| `mail_accounts`, `mail_folders`, `mail_messages`, `mail_drafts`, `mail_image_senders`, `mail_pop_uidls` | Mail ([[ADR-032-Email]]). |

Git checkpoints are refs in the repository, not rows ([[Sandboxing]]).
Unlocked sessions are in memory only ([[ADR-029-App-Lock]]).

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

- `.backup()` before every migration (10 kept), and nightly: the first
  check of each day takes `nightly-YYYY-MM-DD.db` (7 kept).
- Storage (Settings): the size of the database, Leg logs per job,
  backups, the audit export and the daemon log.
- Pruning (Settings): drop raw Leg logs last written before a date, for
  finished jobs I choose; a running job's logs are refused. Silk,
  sessions, stats and audit entries are kept unless I delete the job;
  a pruned session's output view is then empty.
- Export: a job or project as a zip (JSON + Silk markdown + logs).

Related: [[Durability]] · [[Data-Map]] · [[ADR-002-Persistence]] · [[ADR-003-Job-Execution-Engine]]
