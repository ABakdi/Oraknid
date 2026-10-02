# Phase 5 — Antigravity

Touches [[Leg-Adapters]], [[Legs-and-Capability-Profiles]].
Written 2026-10-01 as an outline.

## Why

Antigravity is part of my pool. As of 2026-10-01 its official `agy` CLI
has a headless mode that Google staff describe as supported when it is
launched as a child process (see [[Leg-Adapters]]). Some details are
still unknown (usage fields, quota errors, several accounts, MCP), so
this phase starts by closing them.

## Milestones

### M5.1 — Re-check the interface
- [x] Verify Antigravity's current headless or programmatic options against its official docs and terms (2026-10-02, from the docs: `agy` isn't installed here)
- [x] ADR: adapter, workaround, or not supported → [[ADR-020-Antigravity-Adapter]]: an adapter

### M5.2 — Adapter or workaround
- [x] Implement what the ADR decides: `packages/legs/antigravity`, passing the Leg contract against a stand-in `agy`, and inside bwrap
- [x] Sign-in from the Leg's card (Google's page, code pasted back)
- [x] Default capability profile: Gemini Pro up to high tasks, Flash up to medium
- [x] A real run (2026-10-02, agy 1.2.14): a Leg signed in from its card, its login in its own folder; a job of two tasks (a script and its tests) on Gemini 3.8 Flash, at Standard autonomy, completed and verified. Getting there fixed four things the docs didn't say: how refusals and tool steps really read, file writes in a worktree, and token counting (ADR-020)
- [ ] How a quota error reads (not hit yet)

## Exit criterion

An Antigravity Leg completes a verified task unattended, or an ADR
records why that isn't possible and what replaces it.

Related: [[Roadmap]] · [[Leg-Adapters]]
