# Phase 3 — Parallelism

Touches [[The-Eye]], [[Jobs-and-Projects]], [[Sandboxing]], [[Durability]].
Written 2026-10-01 as an outline; detailed 2026-10-01 with [[ADR-016-Parallel-Work]]. M3.3 is built first: it is the smallest step, and several jobs could already run unlimited.

## Why

One task at a time leaves Legs idle while others work. Independent
tasks in The Web, and independent jobs, can run together.

## Milestones

### M3.1 — Parallel tasks in one job
- [x] A worktree per running task, branched from the job branch's tip, when more than one task at once is allowed (Settings; 1 by default)
- [x] Scheduler limits: per Leg (sessions at once), per job (tasks at once), global (jobs at once), and the machine's room (2026-10-02): a local model starts only with memory under 85%, CPU under 90% and a GPU with VRAM under 90%; nothing starts above 95% memory. A task that waits says why and starts when there is room
- [x] Scope-overlap check before running two tasks at once (their globs' fixed roots)

### M3.2 — Merging
- [x] Merge a verified task's branch into the job branch, one merge at a time per job; its worktree and branch removed after
- [x] A conflict merges nothing: the task is redone on top of the newer work, with an issue in Silk (a redo rather than a separate task, [[ADR-016-Parallel-Work]]), never a silent overwrite
- [x] Re-verify after every merge: the task's checks run again on the merged tree; a failure takes the merge back

### M3.3 — Several jobs (first)
- [x] A running-jobs limit (setting, default 2), enforced by the runner for every start and resume; past it, the job is queued
- [x] Priorities: higher first, then oldest; changeable while queued
- [x] A per-Leg session limit (on its card, 1 by default); a task whose Legs are all busy waits for one without blocking its job
- [x] BR-19 replaced; UI: queued badge, priority in the job header, jobs at once in Settings

## Exit criterion

Two jobs and four parallel tasks run together, merge cleanly or raise
conflicts as tasks, and the machine stays responsive.

**Met 2026-10-02**: two jobs of three independent scripts each, on
OpenCode's free models and an Antigravity Leg (two tasks a job, two
sessions a Leg): four tasks ran at once, all six were verified and
merged cleanly into their job branches, both jobs completed in about
six minutes. The machine peaked at a load of 3.3 on 12 cores with over
16 GB free.

Related: [[Roadmap]] · [[ADR-003-Job-Execution-Engine]]
