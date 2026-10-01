# ADR-016 — Parallel work: a job queue first, then tasks side by side in their own worktrees

**Status:** Accepted · 2026-10-01 · [[Phase-3-Parallelism]]

## Context
Phase 1 ran one task at a time (BR-19). In fact nothing stopped several
jobs from running at once: each job's program ran on its own, with no
limit, no queue and no fairness. Phase 3 makes parallel work deliberate:
several jobs with a limit and priorities, then independent tasks of one
job side by side.

## Decision

### Several jobs (M3.3, built first)
- **A limit on running jobs**, a setting (default 2). A job counts
  while its program runs (interviewing, planning, running, verifying);
  waiting for me, paused or blocked, it holds nothing.
- **The runner is the gate.** Every start and resume (mine, after my
  answer, after a quota reset, after recovery) goes through it; past
  the limit the job is **queued** (`queuedAt`), its state unchanged, and
  the UI says so. When a run ends, the queued job with the highest
  **priority** (then the oldest) starts.
- **Priority** is a number per job (higher first), changeable any time.
- **Fair sharing of Legs**: a Leg runs at most a set number of sessions
  at once (default 1 for a subscription account, 1 for a local server).
  A task whose every allowed Leg is busy waits for one, without
  blocking its job, and Legs go to waiting tasks in queue order.

### Tasks side by side (M3.1, M3.2)
- **A worktree per running task**, on a task branch made from the job
  branch's tip; the job worktree becomes the integration tree.
- **Two tasks run together only if their scopes can't overlap** (their
  globs' fixed roots are disjoint) and neither depends on the other.
- **Limits**: per job (default 2 tasks), per Leg (as above), global
  (the running-jobs limit times the per-job limit, capped by a setting).
- **Merging**: a verified task's branch is merged into the job branch
  (`merge-tree`, no checkout touched); then that task's checks run
  again on the merged tree. A conflict, or checks that fail after the
  merge, become a **new task** ("Resolve the merge of …"), routed like
  any other, with the conflicting files in its instructions; nothing is
  overwritten.
- Silk stays one per job; handoffs stay per task.

## Consequences
- BR-19 is replaced: "At most the set number of jobs run at once; the
  rest wait in a queue, by priority."
- More worktrees on disk while tasks run in parallel; each is removed
  after its merge.
- Durability: a task's worktree and branch are recorded before its
  attempt; recovery merges or re-runs as the journal says.

Related: [[Phase-3-Parallelism]] · [[ADR-003-Job-Execution-Engine]] · [[Sandboxing]] · [[Business-Rules]]
