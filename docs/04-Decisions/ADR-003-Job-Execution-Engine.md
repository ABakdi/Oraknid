# ADR-003 — A custom durable step engine on SQLite, not an external queue

**Status:** Accepted · 2026-10-01 · [[Phase-1-MVP]]

## Context
Jobs run for hours. They must pause losslessly, survive crashes and
reboots, resume without redoing completed steps, and never duplicate
external side effects (BR-6, BR-7, BR-8). The step state should commit
in the same transaction as the app state.

## Decision
A small durable-execution engine in `apps/daemon`, on the same SQLite
database:

- **`steps` journal**, keyed by `(job_id, step_key)`: status, input hash,
  output. A step is "check the journal, else execute, then record the
  output in one transaction". On restart, completed steps replay from
  the journal (the DBOS model, done locally).
- **Leases**: a running task holds `lease_until`. At boot, expired leases
  return to `ready` through recovery ([[Durability]]).
- **Outbox / side effects table**: `intended` → `approved` → `performed`
  → `confirmed`, each external action with a deterministic idempotency
  key `job:task:effect-name`. Effects whose target supports idempotency
  keys get them. Others are reconciled on restart, or asked about.
- **Pause** is a flag checked at step boundaries, plus the adapter's
  interrupt for in-flight Leg turns.
- **Scheduling**: one runnable job in the MVP (BR-19). The scheduler is
  written for N from the start, so Phase 3 only lifts the limit.

## Consequences
- Full control over pause, safe points and recovery semantics, which
  are the product's core promise.
- Code Oraknid owns and has to test hard: recovery tests kill the daemon
  at every step boundary (`kill -9` fault injection) and check
  there's no duplicate work.

## Why not DBOS
The right model, but its TypeScript system database is Postgres. SQLite
support is unmerged and described as dev/test only. Revisit if that
changes.

## Why not BullMQ or pg-boss
They need Redis or Postgres, and they give a second commit point
separate from the app state.

## Why not Temporal, Inngest or Restate
Each needs its own server process. Too heavy for a single-user local app.

Related: [[Persistence-and-Recovery]] · [[Durability]] · [[ADR-002-Persistence]]
