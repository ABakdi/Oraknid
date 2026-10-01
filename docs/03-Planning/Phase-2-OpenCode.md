# Phase 2 — OpenCode

Touches [[Legs-and-Capability-Profiles]], [[Leg-Adapters]], [[The-Eye]].
Written 2026-10-01 as an outline; detailed when Phase 1 ships.

## Why

With only Claude Code and local models, a job stops when the Claude
accounts run out of quota. OpenCode adds a third kind of Leg, which
makes fallback and cross-Leg handoff real.

## Milestones

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
