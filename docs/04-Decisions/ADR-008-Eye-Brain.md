# ADR-008 — The Eye borrows a pool Leg for reasoning, behind an EyeBrain interface

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
The Eye needs judgement for planning, evaluating and corrective prompts.
Dedicated decision models (Jev, and Kev, which is open source) are new
and could suit this role, but they aren't part of the first version.
Oraknid must not depend on any particular Leg (BR-4).

## Decision
- The Eye is deterministic code: the state machine, routing scores, drift
  detectors and verification runner.
- Reasoning calls go through an `EyeBrain` interface (`plan`, `replan`,
  `evaluate`, `correct`, `summarize`, `interviewRound`), each with a
  Zod-validated structured output.
- v1 implementation: `PoolLegBrain`. It uses the **Eye Leg** chosen at
  first-run setup, falling back to the best available Leg with the
  `planning` strength. Calls are short, stateless and built from Silk.
- Phase 7 adds dedicated decision-model brains, local or remote.

## Consequences
- The Eye works with whatever Legs I have.
- Reasoning costs come out of the same budgets and quotas as tasks, and
  are shown separately as "Eye" in the stats.
- Structured outputs that fail validation are retried once with the
  validation error, then the step escalates.

## Why not a dedicated model now
Not needed to replace babysitting, and it would make a specific model a
requirement.

Related: [[The-Eye]] · [[Roadmap]]
