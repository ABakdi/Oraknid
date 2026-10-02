# Phase 6 — Non-coding skills

Touches [[Skills]], [[Security]], [[Approvals-and-Autonomy]].
Written 2026-10-01 as an outline.

## Why

A job can be any goal a skill describes, not just software. Email first.

## Milestones

### M6.1 — Tools for skills
- [x] Skills declare `requires.tools`; the job form shows what's needed and missing, and a job can't start without them
- [x] MCP servers run by the daemon's broker in their own sandbox, reached by the Leg through a bridge, every call judged ([[ADR-021-Tools-Broker]]); Claude Code, OpenCode (checked with the real binary) and Antigravity (unverified) get them
- [x] Credentials stay with the daemon: a tool's secrets are read only for the sessions of a job that has it, and never reach a Leg

### M6.2 — Verification without tests
- [x] Skill-defined checks for non-code results: a skill's `## Checks`, applied by The Eye's review
- [x] Untrusted-content handling end to end (BR-15): a tool's output wrapped as data and flagged when suspicious; the task untrusted from then on, so a send always asks

### M6.3 — The email flow (reference)
- [x] read → classify → draft → approve → send → log: the built-in `email-triage` skill
- [x] Every send is an approval (tested end to end with a stand-in mail server)
- [x] Every send goes through the outbox (BR-6): the same message is never sent twice in a job, and one caught mid-way by a crash is asked of me ("did it go out?") before anything else
- [ ] An automatic Sent-folder check for that question (a tool-declared confirming read)
- [ ] On my real inbox: set up an email MCP server in Settings → Tools and run the skill

## Exit criterion

The email skill runs read → classify → draft → approve → send → log on
my real inbox, with every send approved.

Related: [[Roadmap]] · [[Skills]]
