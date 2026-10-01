# Audit 1 — before `v0.1.0`

Opened 2026-10-01 on `dev`, after M1.9's hardening and the first real
jobs. Feature work stopped. It is finished when every finding below is
**Fixed** (and how) or **Documented** (and why it stays).

## How it was run

- **Security (`S1-`)**: a read-only review of the sandbox, the command
  policy and shell lexer, prompt injection into The Eye, the API's
  authentication and the paths the daemon touches; S1-01 was
  reproduced with plain git. Building bypass commands for the lexer was
  cut short, so the policy findings come from reading it.
- **Durability (`D1-`)**: a read-only review of the engine, recovery,
  the job program and shutdown; D1-01, D1-02 and D1-03 were reproduced
  against a daemon with a scripted Leg.
- **Code quality (`Q1-`)**: a read-only review of bugs, the canon
  against the code, tests and the web UI; `pnpm check` green.
- **Performance (`P1-`)**: the real daemon's CPU and memory measured
  idle from `/proc` (2026-10-01, no job running, no UI open).
- **By hand (`U1-`)**: the web UI on the real daemon in Chrome, light
  and dark, the piano and a scratch job; a real Claude job paused and
  then killed with `SIGKILL` mid-task. Phone width could not be set
  from here: it stays for my hands-on check.

## Security

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| S1-01 | High | `workspace/git.ts` | Oraknid's own git calls ran in the Leg-writable worktree: a rewritten `.git` file, or a shadow repo inside the project, could set `core.fsmonitor` and run a command on the host. | Open |
| S1-02 | High | Leg config, `legs/plan.ts` | My real `~/.claude` was the Leg's config dir, bound read-write in the sandbox: a Leg could plant hooks or settings my own Claude Code then runs, and read every transcript. | Open |
| S1-03 | High | `eye/verify.ts` | Verify commands (planner output) ran with no command policy, and with the Leg's home. | Open |
| S1-04 | High | `auth/devices.ts` | Pairing codes had no attempt limit: a Leg (the network is shared) could guess an open six-digit code and get a device token. | Open |
| S1-05 | Medium | `core/policy.ts` | The "inside the worktree" check didn't resolve `..`. | Open |
| S1-06 | Medium | `silk/store.ts` | The Silk mirror is Leg-writable: a Leg's edits are offered as mine, and symlinks in it are followed. | Open |
| S1-07 | Medium | `eye/attempt.ts` | The classifier's yes was cached per program: one allowed `curl` allowed every later `curl` in the job. | Open |
| S1-08 | Medium | `eye/brain.ts` | The judged command (and a Leg's report to `evaluate`) sat raw in the prompt and could close its fence; the classifier could read planted files. | Open |
| S1-09 | Medium | `eye/policy.ts` | Untrusted content (BR-15) was tracked only for job inputs, not for what a Leg fetched. | Open |
| S1-10 | Medium | `core/policy.ts` | Interpreters and package runners are allowed without a look while the network is shared: they can send data out or fetch code. | Open |
| S1-11 | Medium | `core/policy.ts` | Gates match raw text in a fixed word order: `git -C . push` is not seen as a push. | Open |
| S1-12 | Low | data folder | `~/.local/share/oraknid` was readable by other local users. | Open |
| S1-13 | Low | `core/scrub.ts` | Secret scrubbing misses several token shapes, and Silk and inbox text. | Open |
| S1-14 | Low | `auth/devices.ts` | A token in the address was accepted by every `/api` call. | Open |
| S1-15 | Low | `core/policy.ts` | An unknown MCP tool is classified, not gated as `external-write`. | Open |

## Durability

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| D1-01 | High | `eye/attempt.ts`, `program.ts` | Every pause, restart or crash counted as a failed attempt; after eight the task was blocked for good. | Open |
| D1-02 | High | `eye/budgets.ts` | Answering a budget question after cancelling the job crashed the daemon (an unhandled rejection). | Open |
| D1-03 | Medium | `daemon.ts` | "Oraknid recovered" and questions opened during recovery were never notified: the router started after recovery. | Open |
| D1-04 | Medium | `eye/budgets.ts` | A crash while pausing at a hard budget left the limit marked reached: the job then ran past it. | Open |
| D1-05 | Medium | `workspace/git.ts` | Git runs synchronously: a huge first snapshot can block past the systemd watchdog. | Open |
| D1-06 | Medium | `engine/recovery.ts` | Recovery doesn't take a checkpoint or build a handoff from the cut-short session (Durability step 4). | Open |
| D1-07 | Medium | `eye/attempt.ts` | The "keeps going wrong" question stayed open after a pause or crash, and its answer was dropped. | Open |
| D1-08 | Medium | `daemon.ts`, `engine/runner.ts` | During shutdown, a resume could start a run nobody waited for. | Open |
| D1-09 | Medium | `workspace/git.ts` | Git objects weren't fsynced like the database. | Open |
| D1-10 | Low | `workspace/git.ts` | A worktree folder left half made by a crash was reused as it was. | Open |
| D1-11 | Low | `eye/talk.ts` | A message to The Eye was lost if the daemon died while handling it. | Open |
| D1-12 | Low | `eye/program.ts` | A few steps write Silk outside their journal transaction, and an attempt's step key depends on a counter changed inside it. | Open |
| D1-13 | Low | `engine/effects.ts`, `program.ts` | An inbox item and the record of it were written in two transactions. | Open |
| D1-14 | Low | `storage/storage.ts` | A nightly backup was written under its final name. | Open |
| D1-15 | Low | `silk/store.ts`, `legs/supervisor.ts` | Mirror temp files could be committed; a Leg pid is known only after its first event. | Open |
| D1-16 | Low | `workspace/git.ts` | A nested repo with no commit in the worktree breaks every checkpoint (found while testing S1-01). | Open |

## Code quality

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| Q1-01 | High | `eye/attempt.ts` | The escalation ladder climbed every 30 s on the same old evidence (D2, D3, D6), and D6 measured the whole session, not tokens since progress. | Open |
| Q1-02 | High | `eye/attempt.ts` | Waiting for my approval counted as a stall (D5). | Open |
| Q1-03 | High | `legs/session-log.ts` | A log line over 512 KB stopped the output view for good. | Open |
| Q1-04 | High | daemon | No last-resort handler for unhandled rejections; several voided promises had no catch. | Open |
| Q1-05 | High | events, web | Job and task state changes never reached the `overview` topic: job lists didn't update live. | Open |
| Q1-06 | Medium | `web/pages/job.tsx`, `shell.tsx` | The job page refetched the whole job on every streamed event; the palette refetched on every overview event. | Open |
| Q1-07 | Medium | `api/router.ts` | Every job view read every task edge of every job. | Open |
| Q1-08 | Medium | | Same as D1-01. | Open |
| Q1-09 | Medium | `engine/runner.ts` | A resume sent while a pause was in progress was dropped. | Open |
| Q1-10 | Medium | `eye/controls.ts` | Plan edits skipped The Web's checks (cycles, foreign tasks, ended jobs). | Open |
| Q1-11 | Medium | `inbox/store.ts` | Answers weren't checked against an approval's options, and the answering device was never recorded. | Open |
| Q1-12 | Medium | | An ended job's open questions stayed in my inbox. | Open |
| Q1-13 | Medium | `legs/supervisor.ts`, `attempt.ts` | A session or attempt whose start failed stayed open until a restart. | Open |
| Q1-14 | Medium | `api/router.ts` | Every error became `BAD_REQUEST` with its raw message. | Open |
| Q1-15 | Medium | `API-Contract.md` | The contract lists procedures and a `requestId` that don't exist, and misses some that do. | Open |
| Q1-16 | Medium | `db/schema.ts` | No index on `sessions.job_id`, `inbox_items.job_id`, `attempts.job_id`, `task_edges.depends_on`. | Open |
| Q1-17 | Low | `inbox/store.ts`, `job.tsx` | Inbox reads were unbounded; the job's inbox tab loaded every item. | Open |
| Q1-18 | Low | `legs/supervisor.ts` | Every Leg event is stored twice, once per topic. | Open |
| Q1-19 | Low | `attempt.ts`, `talk.ts` | Per-job maps were never cleared. | Open |
| Q1-20 | Low | web | UI the Web-UI spec promises is missing (job settings tab, diff, checkpoint list, log export, drag to reorder). | Open |
| Q1-21 | Low | web | Links wrapping buttons; the running pulse ignores reduced motion. | Open |
| Q1-22 | Low | `web/lib/live.ts`, `job.tsx` | Switching jobs could show the last job's numbers. | Open |
| Q1-23 | Low | `eye/attempt.ts` | Session rotation waits for a turn without watching it. | Open |
| Q1-24 | Medium | tests | No tests for the session log reader, the budget watch, rotation, stalls while waiting, invalid plan edits, resume during pause, or the web's live data. | Open |
| Q1-25 | Low | tests | Several tests wait a fixed time. | Open |

## Performance

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| P1-01 | High | `os/metrics-loop.ts` | Idle, with no job and no UI, the daemon used 7.5% of a core: metrics were sampled every second, `nvidia-smi` spawned each time, for nobody. | Open |

## By hand

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| U1-01 | Medium | real job | A paused task still said "running" (B1-02 in [[Checkpoint-1]]). | Fixed: set to `ready` when the attempt stops. |
| U1-02 | Medium | real job | A `kill -9` left the cut-short attempt open (B1-03). | Fixed: recovery closes it as `abandoned`. |
| U1-03 | Low | Agents tab | A session stopped by a pause looks finished, not stopped. | Open |
| U1-04 | — | every screen | Phone width not checked: the browser here can't be resized. | Open |

## Where it ended

In progress.

Related: [[Audit-Home]] · [[Checkpoint-1]] · [[Security]] · [[Durability]]
