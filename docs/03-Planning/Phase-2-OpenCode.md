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
- [x] Job settings tab: waivers and the job's own rules; autonomy stays in the header and the budget in its tab (Q1-20)
- [x] Task drawer: the diff of the task's work (its commit once done, its work so far before); its checkpoints are its attempts, each with rollback (Q1-20)
- [x] Logs: export the audit log as JSON lines and read the daemon's log in the UI; the daemon writes its own log, rotated at 10 MB (Q1-20)
- [x] Git off the event loop: snapshots, diffs, rollbacks and commits run asynchronously, so a huge work tree can't stall the daemon past its watchdog (D1-05); quick lookups stay synchronous
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
