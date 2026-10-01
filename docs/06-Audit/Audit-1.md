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
| S1-01 | High | `workspace/git.ts` | Oraknid's own git calls ran in the Leg-writable worktree: a rewritten `.git` file, or a shadow repo inside the project, could set `core.fsmonitor` and run a command on the host. | Fixed: git calls on a worktree use the main repo's records (`worktreeGit`), with fsmonitor and hooks off; shadow repos live in the data folder; handoffs get their diff from that handle. |
| S1-02 | High | Leg config, `legs/plan.ts` | My real `~/.claude` was the Leg's config dir, bound read-write in the sandbox: a Leg could plant hooks or settings my own Claude Code then runs, and read every transcript. | Fixed (my choice, 2026-10-01: no login sharing): a Leg's config folder can't be my `~/.claude` or around it; a Leg that had it is moved to `legs/<id>/claude-config` at start and asks for one login. |
| S1-03 | High | `eye/verify.ts` | Verify commands (planner output) ran with no command policy, and with the Leg's home. | Fixed: every check goes through the policy (never-allowed or gated: a failed check, not run); checks get a throwaway home. |
| S1-04 | High | `auth/devices.ts` | Pairing codes had no attempt limit: a Leg (the network is shared) could guess an open six-digit code and get a device token. | Fixed: five wrong codes cancel every open code. Documented: the API stays reachable from the sandbox, but only with a token. |
| S1-05 | Medium | `core/policy.ts` | The "inside the worktree" check didn't resolve `..`. | Fixed: paths are resolved before the check. |
| S1-06 | Medium | `silk/store.ts` | The Silk mirror is Leg-writable: a Leg's edits are offered as mine, and symlinks in it are followed. | Fixed: links in the mirror are never followed; the import question says Legs work there and has no default. |
| S1-07 | Medium | `eye/attempt.ts` | The classifier's yes was cached per program: one allowed `curl` allowed every later `curl` in the job. | Fixed: a yes covers one exact command. |
| S1-08 | Medium | `eye/brain.ts` | The judged command (and a Leg's report to `evaluate`) sat raw in the prompt and could close its fence; the classifier could read planted files. | Fixed: the command and a Leg's report are passed as JSON data; the classifier reads no files. Documented: a model can still be wrong; the sandbox stays the second wall. |
| S1-09 | Medium | `eye/policy.ts` | Untrusted content (BR-15) was tracked only for job inputs, not for what a Leg fetched. | Fixed: once a task fetches from the web (WebFetch, WebSearch, curl, wget), gated actions ask me. |
| S1-10 | Medium | `core/policy.ts` | Interpreters and package runners are allowed without a look while the network is shared: they can send data out or fetch code. | Fixed: fetching and running code (`npx <pkg>`, `dlx`, `pip install`) or inline code (`-c`, `-e`) gets a look at Standard. Documented: a per-job network allow list (a proxy) is Phase 2 work. |
| S1-11 | Medium | `core/policy.ts` | Gates match raw text in a fixed word order: `git -C . push` is not seen as a push. | Fixed: git's and package managers' global options are taken out before the lists are read. |
| S1-12 | Low | data folder | `~/.local/share/oraknid` was readable by other local users. | Fixed: the data folder is created and kept at 0700. |
| S1-13 | Low | `core/scrub.ts` | Secret scrubbing misses several token shapes, and Silk and inbox text. | Fixed: more token shapes, passwords in URLs; Silk and inbox text are scrubbed. |
| S1-14 | Low | `auth/devices.ts` | A token in the address was accepted by every `/api` call. | Fixed: only the live socket takes a token in its address. |
| S1-15 | Low | `core/policy.ts` | An unknown MCP tool is classified, not gated as `external-write`. | Fixed: MCP tools are gated as external writes, waivable. |

## Durability

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| D1-01 | High | `eye/attempt.ts`, `program.ts` | Every pause, restart or crash counted as a failed attempt; after eight the task was blocked for good. | Fixed: only failed or reassigned attempts count. |
| D1-02 | High | `eye/budgets.ts` | Answering a budget question after cancelling the job crashed the daemon (an unhandled rejection). | Fixed: the watch skips ended jobs; an ended job's questions are withdrawn; every voided promise is caught, and a last-resort handler logs. |
| D1-03 | Medium | `daemon.ts` | "Oraknid recovered" and questions opened during recovery were never notified: the router started after recovery. | Fixed: notifications start before recovery. |
| D1-04 | Medium | `eye/budgets.ts` | A crash while pausing at a hard budget left the limit marked reached: the job then ran past it. | Fixed: a hard limit is marked reached only once the job is paused and asked. |
| D1-05 | Medium | `workspace/git.ts` | Git runs synchronously: a huge first snapshot can block past the systemd watchdog. | Documented: git stays synchronous for `v0.1.0`; moving it off the event loop (and a size guard for shadow repos) is Phase 2 work. A first snapshot of a very large folder can still trip the watchdog. |
| D1-06 | Medium | `engine/recovery.ts` | Recovery doesn't take a checkpoint or build a handoff from the cut-short session (Durability step 4). | Fixed: the next attempt builds the missing handoff from the cut-short session's log; scope is measured from the task's first checkpoint. |
| D1-07 | Medium | `eye/attempt.ts` | The "keeps going wrong" question stayed open after a pause or crash, and its answer was dropped. | Fixed: the question is withdrawn when its attempt stops. |
| D1-08 | Medium | `daemon.ts`, `engine/runner.ts` | During shutdown, a resume could start a run nobody waited for. | Fixed: timers and watchers stop first, the runner refuses new runs once closing, and the wait is capped under systemd's stop timeout. |
| D1-09 | Medium | `workspace/git.ts` | Git objects weren't fsynced like the database. | Fixed: `core.fsync=committed` (batch) on every git call. |
| D1-10 | Low | `workspace/git.ts` | A worktree folder left half made by a crash was reused as it was. | Fixed: a folder that isn't a registered worktree is set aside and made again; an existing branch is reused. |
| D1-11 | Low | `eye/talk.ts` | A message to The Eye was lost if the daemon died while handling it. | Fixed: a message without a reply is handled at the next start. |
| D1-12 | Low | `eye/program.ts` | A few steps write Silk outside their journal transaction, and an attempt's step key depends on a counter changed inside it. | Documented: the duplicates on replay are a Silk entry or a Web version number, never work done twice. In Phase 2 (M2.0), an attempt's outcome recorded but not applied is replayed instead of the task running again. |
| D1-13 | Low | `engine/effects.ts`, `program.ts` | An inbox item and the record of it were written in two transactions. | Fixed: approval and "did it happen?" questions are opened with their record in one transaction; an interview round reuses its open question. |
| D1-14 | Low | `storage/storage.ts` | A nightly backup was written under its final name. | Fixed: written aside, checked, made self-contained, then named. |
| D1-15 | Low | `silk/store.ts`, `legs/supervisor.ts` | Mirror temp files could be committed; a Leg pid is known only after its first event. | Fixed: mirror temp files are excluded from git; a Leg's pid is recorded at its spawn. |
| D1-16 | Low | `workspace/git.ts` | A nested repo with no commit in the worktree breaks every checkpoint (found while testing S1-01). | Fixed: a nested repo with no commit is left out of the snapshot. |

## Code quality

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| Q1-01 | High | `eye/attempt.ts` | The escalation ladder climbed every 30 s on the same old evidence (D2, D3, D6), and D6 measured the whole session, not tokens since progress. | Fixed: evidence is consumed after each step; burn counts from the last step, per session. |
| Q1-02 | High | `eye/attempt.ts` | Waiting for my approval counted as a stall (D5). | Fixed: no stall while a permission waits for me. |
| Q1-03 | High | `legs/session-log.ts` | A log line over 512 KB stopped the output view for good. | Fixed: an overlong line is skipped with a note; unit tests for the reader. |
| Q1-04 | High | daemon | No last-resort handler for unhandled rejections; several voided promises had no catch. | Fixed: as D1-02. |
| Q1-05 | High | events, web | Job and task state changes never reached the `overview` topic: job lists didn't update live. | Fixed: a coalesced hint reaches overview (4/s), not stored. |
| Q1-06 | Medium | `web/pages/job.tsx`, `shell.tsx` | The job page refetched the whole job on every streamed event; the palette refetched on every overview event. | Fixed: the job page reloads only on job, task, web, budget and policy events; the palette loads when open. |
| Q1-07 | Medium | `api/router.ts` | Every job view read every task edge of every job. | Fixed: edges are read per job. |
| Q1-08 | Medium | | Same as D1-01. | Fixed: as D1-01. |
| Q1-09 | Medium | `engine/runner.ts` | A resume sent while a pause was in progress was dropped. | Fixed: a resume waits for the pause, then applies. |
| Q1-10 | Medium | `eye/controls.ts` | Plan edits skipped The Web's checks (cycles, foreign tasks, ended jobs). | Fixed: circles and self-dependencies are refused and undone; ended jobs can't be edited. |
| Q1-11 | Medium | `inbox/store.ts` | Answers weren't checked against an approval's options, and the answering device was never recorded. | Fixed: an approval takes one of its options; the device is recorded; a withdrawn item says so. |
| Q1-12 | Medium | | An ended job's open questions stayed in my inbox. | Fixed: as D1-02. |
| Q1-13 | Medium | `legs/supervisor.ts`, `attempt.ts` | A session or attempt whose start failed stayed open until a restart. | Fixed: a failed start closes its session as crashed; a failed first checkpoint closes the attempt. |
| Q1-14 | Medium | `api/router.ts` | Every error became `BAD_REQUEST` with its raw message. | Fixed: `NOT_FOUND`, `CONFLICT`, `BAD_REQUEST` for Oraknid's own sentences; anything else is `INTERNAL_SERVER_ERROR` with a generic sentence, the details logged. |
| Q1-15 | Medium | `API-Contract.md` | The contract lists procedures and a `requestId` that don't exist, and misses some that do. | Fixed: the contract lists what exists; what doesn't is named with where it lands; `requestId` is explained as Phase 4. |
| Q1-16 | Medium | `db/schema.ts` | No index on `sessions.job_id`, `inbox_items.job_id`, `attempts.job_id`, `task_edges.depends_on`. | Fixed: four indexes (migration 0014). |
| Q1-17 | Low | `inbox/store.ts`, `job.tsx` | Inbox reads were unbounded; the job's inbox tab loaded every item. | Fixed: lists are capped (500 by default); the job's tab asks for its own items. |
| Q1-18 | Low | `legs/supervisor.ts` | Every Leg event is stored twice, once per topic. | Documented: one row per topic keeps replay a single indexed query per topic; the web dedupes by `seq`. Storing once with several topics is a later storage change. |
| Q1-19 | Low | `attempt.ts`, `talk.ts` | Per-job maps were never cleared. | Fixed: an ended job's classifier cache and guidance are cleared. |
| Q1-20 | Low | web | UI the Web-UI spec promises is missing (job settings tab, diff, checkpoint list, log export, drag to reorder). | Documented: the job settings tab, the diff and checkpoint list, log export and drag-to-reorder move to Phase 2 (named in the Phase 1 note). |
| Q1-21 | Low | web | Links wrapping buttons; the running pulse ignores reduced motion. | Fixed: links no longer wrap buttons; the pulse respects reduced motion. |
| Q1-22 | Low | `web/lib/live.ts`, `job.tsx` | Switching jobs could show the last job's numbers. | Fixed: live data resets when its job or filter changes; Budget and Stats follow the job. |
| Q1-23 | Low | `eye/attempt.ts` | Session rotation waits for a turn without watching it. | Fixed: the rotation's turn is watched like any other. |
| Q1-24 | Medium | tests | No tests for the session log reader, the budget watch, rotation, stalls while waiting, invalid plan edits, resume during pause, or the web's live data. | Fixed in part: tests for the log reader, the budget watch, resume during a pause, plan edits, restart notifications, crash handoffs, metrics. Documented: rotation, a stall while waiting, and the web's live data stay untested for now. |
| Q1-25 | Low | tests | Several tests wait a fixed time. | Documented: the fixed waits are short and have not flaked; they are replaced as each test is touched. |

## Performance

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| P1-01 | High | `os/metrics-loop.ts` | Idle, with no job and no UI, the daemon used 7.5% of a core: metrics were sampled every second, `nvidia-smi` spawned each time, for nobody. | Fixed: every second only while someone watches metrics or a Leg works, every 15 s otherwise. Measured on the real daemon after the fix: 1.5% of a core idle, children included (was 7.5%); 115 MB resident. |

## By hand

| ID | Severity | Where | Finding | Status |
| :-- | :-- | :-- | :-- | :-- |
| U1-01 | Medium | real job | A paused task still said "running" (B1-02 in [[Checkpoint-1]]). | Fixed: set to `ready` when the attempt stops. |
| U1-02 | Medium | real job | A `kill -9` left the cut-short attempt open (B1-03). | Fixed: recovery closes it as `abandoned`. |
| U1-03 | Low | Agents tab | A session stopped by a pause looks finished, not stopped. | Fixed: a session stopped by a pause or shutdown says "Stopped". |
| U1-04 | — | every screen | Phone width not checked: the browser here can't be resized. | Fixed: checked on my phone, 2026-10-01. Everything fit except the overview: the chart cards (Resources) and the activity stream ran off to the right. Fixed: grid cells may shrink (`min-w-0`), values and activity lines wrap. |

## Where it ended

61 findings: 15 security, 16 durability, 25 quality, 1 performance,
4 by hand. **56 fixed** (four of them in part, the rest documented:
S1-04, S1-08, S1-10, Q1-24), **5 documented** (D1-05, D1-12, Q1-18,
Q1-20, Q1-25). Every wave ended with `pnpm check` green and a check on
the real daemon; the last one, my phone check, found the overview's
overflow, fixed the same day. **Closed 2026-10-01.**

Related: [[Audit-Home]] · [[Checkpoint-1]] · [[Security]] · [[Durability]]
