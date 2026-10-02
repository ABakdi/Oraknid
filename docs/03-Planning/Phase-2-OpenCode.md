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
- [x] Plan editor: drag (or arrow) the order waiting tasks run in when several are ready; dependencies still come first (Q1-20)
- [x] An attempt's outcome recorded but not applied before a crash is replayed, not run again (D1-12); the few duplicated Silk entries on replay stay documented in [[Audit-1]]
- [x] Projects: archive, restore and delete (Core-Entities → Project)

### M2.1 — OpenCode adapter
- [x] Adapter on OpenCode **v2**'s private `serve --stdio` per session, inside the sandbox, over HTTP and SSE ([[ADR-015-OpenCode-Adapter]]); every action asked, a Leg's own `HOME`, `TMPDIR` and XDG dirs, project config ignored, only its provider allowed
- [x] Usage from each step, permission mapping (`shell` → Bash, `edit` → Edit…), resume by session id, rate limits from retry events
- [x] Default capability profile (the generic one for agent kinds until outcomes are learned)
- [x] The shared contract tests pass against the real OpenCode 2.0.20 with a stand-in model, also inside bubblewrap
- [x] OpenCode in "Add a Leg": a provider id, its endpoint, the models and the API key (to the keychain)

### M2.2 — Routing across three kinds
- [~] Routing and fallback across kinds: a usage limit on Claude Code moves the task to OpenCode (ADR-009 keeps other Claude accounts out). Routing over all three kinds by learned profiles is exercised once real outcomes exist.
- [x] Cross-Leg handoff through Silk only (Claude Code → OpenCode), tested with the real OpenCode binary
- [x] OpenCode's free models by default, no account or key; a real run wrote a file through the adapter (2026-10-02)
- [x] A real job on an OpenCode Leg, from the UI (2026-10-02: a shell script and its tests on OpenCode's free models only, The Eye included; completed after the fixes it showed: stretch routing, a broken check repaired by The Eye, every part of a compound command judged)

## Exit criterion

A job uses Claude Code and OpenCode, with at least one cross-Leg handoff
through Silk, and completes verified.

**Met 2026-10-02**: a job of two tasks on my Claude Max Leg and
OpenCode's free models. Its first task started on Claude Sonnet; I
paused it mid-work, which wrote its handoff to Silk, and pinned it to
OpenCode's big-pickle, which finished it from that handoff alone; the
second ran on Claude Haiku; the job completed verified. (A usage limit
moving a task the same way is tested with stand-ins; a real one is in
Phase 1's hands-on list.)

Related: [[Roadmap]] · [[Phase-1-MVP]]
