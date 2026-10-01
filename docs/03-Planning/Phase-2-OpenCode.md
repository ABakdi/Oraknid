# Phase 2 — OpenCode

Touches [[Legs-and-Capability-Profiles]], [[Leg-Adapters]], [[The-Eye]].
Written 2026-10-01 as an outline; detailed 2026-10-01 after [[Audit-1]],
which moved some Phase 1 work here.

## Why

With only Claude Code and local models, a job stops when the Claude
accounts run out of quota. OpenCode adds a third kind of Leg, which
makes fallback and cross-Leg handoff real.

## Milestones

### M2.0 — Carried over from Audit 1
- [ ] Job settings tab: waivers, the job's own rules, autonomy and budget in one place (Q1-20)
- [ ] Task drawer: the diff of the task's work and its checkpoints, each with rollback (Q1-20)
- [ ] Logs: export the audit log and read the daemon's log in the UI (Q1-20)
- [ ] Git off the event loop: Oraknid's git calls run asynchronously, so a huge snapshot can't stall the daemon past its watchdog (D1-05)
- [ ] Plan editor: drag to reorder dependencies (Q1-20)
- [ ] Attempt step keys from a durable attempt id (D1-12)

### M2.1 — OpenCode adapter
- [ ] Adapter on OpenCode's headless/server interface (see [[Leg-Adapters]])
- [ ] Usage reporting, permission mapping, resume
- [ ] Default capability profile
- [ ] Contract tests shared with the other adapters

### M2.2 — Routing across three kinds
- [ ] Routing and fallback exercised across all three kinds
- [ ] Cross-Leg handoff tests (Claude Code → OpenCode → Claude Code) through Silk only

## Exit criterion

A job uses Claude Code and OpenCode, with at least one cross-Leg handoff
through Silk, and completes verified.

Related: [[Roadmap]] · [[Phase-1-MVP]]
