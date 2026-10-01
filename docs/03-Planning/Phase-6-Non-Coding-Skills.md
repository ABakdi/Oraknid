# Phase 6 — Non-coding skills

Touches [[Skills]], [[Security]], [[Approvals-and-Autonomy]].
Written 2026-10-01 as an outline.

## Why

A job can be any goal a skill describes, not just software. Email first.

## Milestones

### M6.1 — Tools for skills
- [ ] Skills declare `requires.tools`; the job form shows what's needed and missing
- [ ] MCP servers configured per job, launched inside the job's sandbox
- [ ] Credentials scoped per job (keychain entries bound to a job)

### M6.2 — Verification without tests
- [ ] Skill-defined checks for non-code results (e.g. "draft exists, addressed correctly")
- [ ] Untrusted-content handling end to end (BR-15)

### M6.3 — The email flow (reference)
- [ ] read → classify → draft → approve → send → log
- [ ] Every send is an approval; side-effect reconciliation checks the Sent folder

## Exit criterion

The email skill runs read → classify → draft → approve → send → log on
my real inbox, with every send approved.

Related: [[Roadmap]] · [[Skills]]
