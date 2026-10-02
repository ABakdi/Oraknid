# Phase 7 — Eye decision models

Touches [[The-Eye]], [[ADR-008-Eye-Brain]], [[Web-UI]].
Written 2026-10-02.

## Why

The Eye's calls differ: a plan needs the strongest reasoning I have; a
command check or a triage needs a quick, cheap answer many times a job.
And I want to know whether a dedicated decision model (Jev, Kev or a
local one) plans as well as a pool Leg, on my own jobs, before trusting
it ([[ADR-022-Eye-Decision-Models]]).

## Milestones

### M7.1 — A model per kind of decision
- [x] Settings → The Eye: a model for **planning** (plan, replan, interview), one for **judging** (reviews, check repairs) and one for **quick** calls (command checks, my messages, summaries); each falls back to The Eye's Leg, then to the pool
- [x] Every call says which model answered (events)

### M7.2 — Compare on real jobs
- [x] A **shadow** model plans each job too, in the background, never used
- [x] Both plans kept with their measures: valid on the first try, tasks, checks per task, depth, time
- [x] The job page shows them side by side, with how the plan that ran fared (tasks done, attempts, checks repaired, replans)
- [x] A real comparison on one of my jobs (2026-10-02, OpenCode's free models): big-pickle planned, mimo-v2.6-flash as shadow. First run, the shadow's plan was refused, wrapped in a copy of the schema; The Eye now unwraps that. Second run, both valid on the first try, same two tasks, the shadow with 2.5 checks a task against 1, in 16 s against 24 s
- [ ] The exit criterion with a dedicated decision model of my choice planning a whole job

## Exit criterion

The Eye runs a job with a dedicated decision model, and plan quality is
compared against a pool Leg on the same job.

Related: [[Roadmap]] · [[The-Eye]] · [[ADR-008-Eye-Brain]]
