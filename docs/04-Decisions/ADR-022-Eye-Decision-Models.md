# ADR-022 — A model per kind of Eye decision, and shadow plans to compare

**Status:** Accepted · 2026-10-02 · [[Phase-7-Eye-Decision-Models]]

## Context
The Eye's reasoning (ADR-008) goes to one pinned Leg model, or else to
the pool's best for the call's difficulty. Its calls are of three
kinds: planning (plan, replan, interview: rare, decisive), judging
(reviews of work without checks, check repairs: a few per task) and
quick (command classification, triage of my messages, Silk summaries:
many, small). A dedicated decision model may suit some kinds and not
others, and the only way to know is to compare on my own jobs.

## Decision
- **Three optional pins** in Settings → The Eye: `planning`, `judging`,
  `quick`, each a Leg model. A call uses its kind's pin, else The Eye's
  Leg, else the pool's best, as before. An unavailable pin falls
  through the same way, and the event says which model answered.
- **A shadow model** (optional): for every plan and replan, the same
  input also goes to the shadow, in the background, after the real plan
  is made. Its plan is never used. A shadow that fails or isn't
  available records why; the job never waits for it.
- **What is kept** for each plan call: both plans, the model, the time,
  whether the answer was valid on the first try. Measures are computed
  when read: tasks, share with checks, checks per task, the longest
  dependency chain, kinds. For the plan that ran, the job's outcome is
  added: tasks done, attempts, checks repaired, replans.
- Shown on the job page, side by side.

## Consequences
- A shadow doubles the planning cost of a job; it's off until I pick
  one, and a free model makes it cost nothing.
- The comparison is of plans, not of finished work: only one plan runs.
  Running both is a later idea, if the measures are not enough.

Related: [[ADR-008-Eye-Brain]] · [[The-Eye]] · [[Phase-7-Eye-Decision-Models]]
