# ADR-013 — Route to a Leg model and effort level, not just to a Leg

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Agents offer several models. Claude Code has Opus, Sonnet and Haiku.
Stronger models do better on hard work, but use more tokens and draw on
tighter limits. Some limits are shared by the whole account (the 5-hour
window), and some apply to one model (the weekly Opus and Sonnet
windows). Other agents and local servers work the same way. If routing
only chooses a Leg, either every task runs on the strongest model and
burns the scarce windows on trivial work, or every task runs on a cheap
model and hard tasks fail.

## Decision
- A Leg offers **Leg models**, each with an effort range, its own
  capability profile, a `quotaWeight` and the quota windows that apply
  to it ([[Legs-and-Capability-Profiles]]).
- Planning estimates each task's **difficulty**. The router scores
  `(Leg, model, effort)` candidates on difficulty fit, capability,
  past success, the expected cost in every applicable window, context
  fit and speed ([[The-Eye]]).
- **The smallest sufficient model wins** (BR-21). Being far above what
  the task needs counts as a penalty.
- **Scarce windows are reserved.** When a window falls below 25% (default,
  editable), its models only take `high` difficulty tasks until it resets.
- **Step up on failure:** higher effort → stronger model on the same
  Leg → another Leg, before the rest of the escalation ladder.
  **Start lower on success:** the observed tier that succeeds for a
  task kind becomes the starting point for similar tasks.
- The Eye's own reasoning calls are routed the same way: planning and
  evaluation go to strong models, summaries and classification to cheap
  ones.
- I can pin a task, a task kind, or The Eye's planning to a Leg model.

## Consequences
- The pool's real capacity goes much further: Haiku-class or local
  models do the mechanical work, and Opus-class windows last for the
  hard parts.
- Routing has more candidates and more state to track (per-model
  windows, effort multipliers). The scoring stays a pure function in
  `packages/core` with table-driven tests.
- `quotaWeight` and effort multipliers are estimates at first. They are
  learned from how windows actually move, and labelled estimated in the
  UI until they settle.

## Why not let the agent pick (e.g. Claude Code's default model or `fallbackModel`)
The agent doesn't know the job's other tasks, the other Legs, or how
scarce each window is across the pool. The Eye does.

Related: [[The-Eye]] · [[Legs-and-Capability-Profiles]] · [[Budgets-and-Quotas]] · [[Business-Rules]]
