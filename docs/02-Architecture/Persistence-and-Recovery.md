# Persistence and Recovery

SQLite with better-sqlite3 and Drizzle ([[ADR-002-Persistence]]). The
durable step engine runs on the same database ([[ADR-003-Job-Execution-Engine]]).

## Tables (as built, 2026-10-07; migrations 0000 to 0039; 0043 below)

| Table | Holds |
| :-- | :-- |
| `projects` | Workspaces, with their skills and servers (`skill_ids`, `server_ids`); a server's own project names it (`server_id`, migration 0037, [[ADR-049-Server-Chat-And-Server-Jobs]]). |
| `jobs`, `tasks`, `task_edges` | The work. The Web's version is a number on the job (`web_version`), raised at every plan change. |
| `attempts`, `sessions` | Who tried what, native session IDs, end reasons, usage totals. |
| `attempt_events` | The attempt log ([[ADR-056-The-Harness]] §1, migration 0040): append-only, typed events per attempt (`kind`, JSON `data`), `seq` in order within the attempt, `id` across all: sessions opened, the agent's actions and their results, every Gate decision (by whom, the grant's scope, counted toward the stuck rule, a grant given or used, a refusal), my questions and answers, the Stop hook's requests, each check report, signals (stuck, drift, untrusted), the outcome, handoffs, the end; actions a crash left without a result marked uncertain and how each was reconciled (`Reconciled`); the task controller's moves (`Transition{from, to, why, key}`, the key `attempt:n:state`, Done with its checkpoint). A task's grants, refusals, stuck count, untrusted mark and open questions are read from it (`eye/task-memory.ts`), from its last `Forgotten` mark on. Kept with its job, deleted with it. |
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
| `sites`, `site_checks` | Sites across my servers: domain, where served, DNS and certificate last read, up or down; each uptime check, kept 7 days (migration 0041, [[ADR-060-Sites-Domains-And-Uptime]]). |
| `mail_accounts`, `mail_folders`, `mail_messages`, `mail_drafts`, `mail_image_senders`, `mail_pop_uidls` | Mail ([[ADR-032-Email]]); an account's `auth` (password, Google or Microsoft) since migration 0042 ([[ADR-063-Mail-OAuth]]). |
| `backup_plans`, `backup_runs`, `backup_keys` | Database backups: plans, each run, the age public keys (migration 0033, [[ADR-044-Backups]]). |
| `cloud_providers` | My storage accounts in the pool (migration 0034, [[ADR-046-Cloud-Storage]]). |
| `project_secrets` | A project's secrets by environment and name, never a value (that is in the keychain); migration 0041, [[ADR-059-Project-Secrets]]. |
| `reviews`, `review_notes` | A design or the running app opened for me to annotate, per evaluation step and round, and my notes on it per device (migration 0044, [[ADR-064-Design-And-Approval-By-Experience]]); a note's picture is a file under `<data>/reviews/<id>/`. Deleted with their job. |
| `local_models` | Models downloaded to this computer, their files' checksums, run settings and measurements (migration 0038, [[ADR-054-Local-Models]]). |

Git checkpoints are refs in the repository, not rows ([[Sandboxing]]).
Unlocked sessions are in memory only ([[ADR-029-App-Lock]]).

Since 2026-10-03: `jobs` carries its name and description (0035);
`projects` what archiving did (`archived_with`, 0036) and a server's own
project (`server_id`, 0037, which also gave `server_states` its job and
let an `eye_messages` row have none); 0039 renamed the autonomy levels
(`standard` to `auto`, `supervised` to `careful`).

## Write discipline

- Every transition is a single transaction (BR-8). Effects outside the
  process happen **after** the commit, and are recorded as steps.
- Leg output chunks are written to the NDJSON log file and batched into
  `events` as condensed summaries every 250 ms.
- `synchronous=FULL`; WAL checkpointed when idle (every 5 minutes while
  no job is active, `wal_checkpoint(TRUNCATE)`, 2026-10-07).

## Size caps (2026-10-08, migration 0043)

A blocked reason that was a tool's whole output (3.2 MB, in a job, its
`job.state` and `job.error` events and an Eye message) and a Silk entry
holding a diff stat of thousands of files (1.5 MB) froze every screen
that read them. What one row may hold (`apps/daemon/src/db/caps.ts`):

| Where | Cap | Kept |
| :-- | :-- | :-- |
| `eye_messages.text` | 20,000 characters | start and end |
| each string of `events.payload` (the bus) | 32,000 | start and end |
| `silk_entries.body` | 64,000 | start and end |
| `inbox_items.detail` | 20,000 | start and end |
| `jobs.blocked_reason`, `pause_reason` | 600 | start |

A text cut short says so: `(cut short; N characters)`. The writers of
the 1.5 MB entry are bounded at the source: a diff stat in Silk lists 60
files, how many more and git's summary (`briefStat`); a rebuilt handoff
lists the last 40 commands, one line each.

Migration 0043 marks the rows of before for cutting (`upkeep.clipOversizedRows`
in `settings`); SQL can't write files, so the daemon does it at its next
start (`db/upkeep.ts`): each original goes first, whole, to
`<data>/archive/oversized-rows-<time>.ndjson` (0600 in 0700, one line per
row: table, key, column, original, synced to disk), then the rows are
cut in one transaction and the mark removed. Nothing is lost; a crash
before the end runs it again. The database file keeps its size until a
`VACUUM`.

## Recovery sequence

The order is set out in [[Durability]]. Implementation notes:

- Leg processes are matched by `(pid, start_time from /proc/<pid>/stat)`
  to avoid killing a reused PID.
- Steps in `running` with an expired lease are replayed. A step is
  idempotent by construction, or guarded by `side_effects`.
- A task's next attempt reads the one before in the attempt log: an
  action asked for with no result is marked `ActionUncertain`, said in the
  job's events (`task.actions-uncertain`) and to the next model (in the
  handoff built for a crashed attempt, or a Silk issue), never re-run by
  Oraknid ([[ADR-056-The-Harness]] §1). What the Gate remembered of the
  task survives because it is read back from the log.
- **Reconciled** by the task controller as the next attempt prepares
  (`harness/reconcile.ts`, a `Reconciled` event each, said in the job's
  events as `task.actions-reconciled` and in a Silk issue): a file tool's
  write is looked at in the tree since the checkpoint before that attempt
  (changed: it happened; unchanged: it didn't); an agent's `git commit` by
  whether the branch moved past that checkpoint; a command on one of the
  job's servers, or any command whose effect the tree can't show, is asked
  of the agent in the next session, once, to look and never run it again
  (`decideOutcome`'s rule 7b), and what it says at that turn's end is the
  finding. Nothing is run to find out.
- **Oraknid's own commit**: the controller's move to Done is a
  `Transition` carrying the checkpoint the commit is measured from, written
  before the commit. If Oraknid stops after it (while committing, or before
  the job's step for the attempt is written) and the branch moved past
  that checkpoint, the next run of the task finds the commit, ends the
  attempt `succeeded` and the task `done` with it, and runs nothing again.
  A project of several repos isn't reconciled this way yet: its task runs
  again, finds its work there and is done.
- Recovery is tested by fault injection: a test harness kills the daemon
  (`SIGKILL`) at every step boundary in a scripted job, restarts it, and
  asserts that no step completed twice and that every side effect is at
  most once.

## Backups and pruning

- `.backup()` before every migration (10 kept), and nightly: the first
  check of each day takes `nightly-YYYY-MM-DD.db` (7 kept); before an
  update, `pre-update-<time>-v<version>.db` (3 kept, [[ADR-048-Updates]]).
- Storage (Settings): the size of the database, Leg logs per job,
  backups, the audit export and the daemon log.
- Pruning (Settings): drop raw Leg logs last written before a date, for
  finished jobs I choose; a running job's logs are refused. Silk,
  sessions, stats and audit entries are kept unless I delete the job;
  a pruned session's output view is then empty.
- Export: a job or project as a zip (JSON + Silk markdown + logs), built
  2026-10-07 ([[ADR-061-Moving-Oraknid]]): **Export** on a job's result
  and on a project's page, a one-time download. Per job: `job.json` (its
  record as `jobs.export` gives it), `rows.json` (its rows: the job, its
  skill's version, tasks and edges, attempts and the attempt log,
  sessions, Silk, The Eye's messages and plans, events), `silk/*.md`,
  `logs/*.ndjson`; all scrubbed of known secrets and secret-shaped text.
  **Import** (Settings → Storage) adds its jobs as ended, read-only
  records under a project of the zip's name (made with a folder of
  Oraknid's, `imported/…`, when none has it); a job already here is
  skipped; nothing runs.
- Moving to another computer ([[ADR-061-Moving-Oraknid]]): `oraknid
  export --all` (or Settings → About) is the database by `.backup()`,
  the config folder and the keychain's entries in one age-encrypted
  archive; `oraknid import` puts it in place on a fresh install; one
  imported from the web waits as `import-pending.db` and replaces the
  database at the next start, before it opens, the one before kept as
  `backups/pre-import-<time>.db`.
- Worktrees of finished jobs: their sizes and removal in Settings →
  Storage ([[Sandboxing]] → Worktrees).

Related: [[Durability]] · [[Data-Map]] · [[ADR-002-Persistence]] · [[ADR-003-Job-Execution-Engine]]
