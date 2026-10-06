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
- **Limits**: per job (a setting, **1 by default**: tasks side by side
  are turned on in Settings), per Leg (as above), and the running-jobs
  limit. With one task at a time a job works in its own worktree as in
  Phase 1; above one, every task gets a worktree of its own.
- **Merging**: a verified task's branch is merged into the job
  worktree (Oraknid's own checkout of the job branch), one merge of a
  job at a time; then that task's checks run again on the merged tree.
  A conflict, or checks that fail after the merge, merge nothing: the
  merge is taken back, an issue goes to Silk, and **the task is redone**
  in a fresh worktree from the job's newer tip (its scope measured from
  there). Built 2026-10-01 as a redo rather than a separate "resolve"
  task: with disjoint scopes a conflict is rare, and a redo on top of
  the newer work resolves it the same way, without git work for a Leg.
- Silk stays one per job; handoffs stay per task.

## Resources (added 2026-10-02)
- A new session also waits for **room on the machine**, read from the
  last ten seconds of metrics (averaged, so a spike doesn't hold work
  back). A local model (its profile's cost model is `local`) needs
  memory under 85%, CPU under 90%, and when there are GPUs, one with
  VRAM under 90%. Any Leg waits above 95% memory: even a remote agent's
  process needs some.
- The waiting task says why ("It waits for room: the machine is busy:
  memory at 90%") and starts as soon as there is room, without blocking
  its job. While it waits, the machine is sampled even with nothing
  else running.
- Thresholds are fixed for now; they become settings if I need to
  change them.

## Consequences
- BR-19 is replaced: "At most the set number of jobs run at once; the
  rest wait in a queue, by priority."
- More worktrees on disk while tasks run in parallel; each is removed
  after its merge.
- Durability: a task's worktree and branch are recorded before its
  attempt; recovery merges or re-runs as the journal says.
- In a project of several repos (2026-10-03, [[ADR-042-Several-Repos-And-Servers]]),
  a task's "worktree" is a folder of worktrees, one per repo it touches,
  and its merge is all or nothing across them.

## Changed (2026-10-04, [[ADR-050-Parallel-By-Default]])
- Tasks side by side are **on by default**: no per-job limit unless I
  set one; every ready task starts as the machine, the Legs and my cap
  across all jobs admit. Jobs at once default to 4.
- A Leg's sessions at once default by kind: 3 for Claude Code, 2 for
  OpenCode and Antigravity, 1 for a local model server.
- Scopes overlap *tightly* (same file, same folder two levels down:
  they wait) or *loosely* (only through a broad glob: side by side in
  worktrees, merged after).
- A plan that is a chain runs in the job's own tree; one where two
  tasks could ever run at once gives every task a worktree.
- The fixed resource rule above is replaced by admission and a guard
  with settings.

Related: [[Phase-3-Parallelism]] · [[ADR-003-Job-Execution-Engine]] · [[Sandboxing]] · [[Business-Rules]]
