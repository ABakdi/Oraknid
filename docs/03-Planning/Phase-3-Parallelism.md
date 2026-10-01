# Phase 3 — Parallelism

Touches [[The-Eye]], [[Jobs-and-Projects]], [[Sandboxing]], [[Durability]].
Written 2026-10-01 as an outline; detailed 2026-10-01 with [[ADR-016-Parallel-Work]]. M3.3 is built first: it is the smallest step, and several jobs could already run unlimited.

## Why

One task at a time leaves Legs idle while others work. Independent
tasks in The Web, and independent jobs, can run together.

## Milestones

### M3.1 — Parallel tasks in one job
- [ ] A worktree per running task, branched from the job's work branch
- [ ] Scheduler limits: per Leg, per job, global; CPU/RAM/VRAM-aware for local Legs
- [ ] Scope-overlap check before running two tasks at once

### M3.2 — Merging
- [ ] Merge a verified task's worktree back into the job branch
- [ ] Conflicts become a new task (routed like any other), never a silent overwrite
- [ ] Re-verify after every merge

### M3.3 — Several jobs (first)
- [ ] A running-jobs limit (setting, default 2), enforced by the runner for every start and resume; past it, the job is queued
- [ ] Priorities: higher first, then oldest; changeable while queued
- [ ] A per-Leg session limit; a task whose Legs are all busy waits for one without blocking its job
- [ ] BR-19 replaced; UI: queued badge, priority, the limits in Settings

## Exit criterion

Two jobs and four parallel tasks run together, merge cleanly or raise
conflicts as tasks, and the machine stays responsive.

Related: [[Roadmap]] · [[ADR-003-Job-Execution-Engine]]
