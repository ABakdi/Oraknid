# Oraknid

*Always watching, many legs. A local background orchestrator that runs
AI coding agents and local models from goal to verified completion.*

**Where it stands (2026-10-03):** Phases 1 to 12 are built and tested
on `dev`; what is left in each is hands-on (mine), named in its phase
note and in the [[Roadmap]]. Next: those runs, then Later.

## 00 — Overview
- [[Vision]] — why Oraknid exists, what it must feel like, pillars, MVP scope
- [[Product-Requirements]] — entities, modules, rules in one paragraph, foundation
- [[Glossary]] — every term (The Eye, Legs, The Web, Silk, The Nest…) with one meaning

## 01 — Specification
- [[Core-Entities]] — the data model and life cycles
- [[Business-Rules]] — the constitution, BR-1 to BR-23
- [[Jobs-and-Projects]] — creating, following, controlling and ending jobs
- [[The-Eye]] — planning, routing, self-prompting, verification, evaluation
- [[Legs-and-Capability-Profiles]] — the pool, health, profiles and learning
- [[Silk]] — job memory, handoffs, context packs, the markdown mirror
- [[Drift-Control]] — detectors D1–D8, the escalation ladder, rollback
- [[Budgets-and-Quotas]] — tokens, quota windows, context, time, money
- [[Approvals-and-Autonomy]] — autonomy levels, gated actions, the inbox
- [[Skills]] — the skill format, the library, the interview stage
- [[Chats-and-Helper]] — free chats with my models, and the Oraknid helper
- [[Servers]] — my servers: state documents, oraknid-monitor, terminal
- [[Durability]] — service, sleep inhibition, crash recovery, lossless pause, watchdog
- [[Notifications]] — desktop, web push, email, routing
- [[Security]] — secrets, scope, command filter, prompt injection, pairing, the PIN, device rights, mail, audit
- [[Web-UI]] — every screen, live, mobile: tabs, shortcuts, going back, set up in place, Mail, the lock
- [[The-Nest]] — the remote relay, private or public (Phase 4, Phase 11)

## 02 — Architecture
- [[Architecture-Overview]] — packages, layers, data flow, paths
- [[Leg-Adapters]] — the adapter interface; Claude Code, OpenAI-compatible, OpenCode, Antigravity, checked 2026-10-02
- [[Persistence-and-Recovery]] — tables, write discipline, recovery, backups
- [[Realtime-Transport]] — topics, frames, reconnect
- [[Nest-Protocol]] — the end-to-end tunnel through The Nest, registering on a public Nest, the loader
- [[OS-Integration]] — service, inhibitor, keychain, metrics, notifier, sandbox per OS
- [[Sandboxing]] — worktrees, checkpoints, the bwrap wrapper, Landlock, a network of its own (pasta)
- [[API-Contract]] — every procedure
- [[Data-Map]] — where data lives, who reads it, what leaves the machine

## 03 — Planning
- [[Roadmap]] — phases, exit criteria, changes of order
- [[Phase-1-MVP]] — built
- [[Phase-2-OpenCode]] — done
- [[Phase-3-Parallelism]] — done
- [[Phase-4-The-Nest]] — built and deployed
- [[Phase-5-Antigravity]] — done
- [[Phase-6-Non-Coding-Skills]] — built
- [[Phase-7-Eye-Decision-Models]] — done
- [[Phase-8-Daily-Use]] — built
- [[Phase-9-Servers]] — built
- [[Phase-10-Lockdown]] — built: the PIN, Audit 2's fixes, settings in tabs
- [[Phase-11-Workspace]] — built: pages in tabs, terminal workspace, device rights, a public Nest, the app's own look and the product site; both Nests deployed; the new mark mine to choose
- [[Phase-12-Email]] — built: the Mail page, IMAP and POP3, agents' drafts; my Gmail syncs; an approved agent draft and an IMAP account to try
- Later ← **next**: containers per job, teams

## 04 — Decisions
- [[ADR-001-Monorepo]] — one pnpm + Turborepo monorepo with the canon inside
- [[ADR-002-Persistence]] — SQLite (better-sqlite3, WAL, FULL) + Drizzle
- [[ADR-003-Job-Execution-Engine]] — a custom durable step engine on SQLite
- [[ADR-004-Realtime-Transport]] — plain `ws`, sequenced replayable events
- [[ADR-005-Charts-and-Graph-Visualization]] — Recharts via shadcn; React Flow + ELK + Motion
- [[ADR-006-Sandbox]] — git worktree + bubblewrap per Leg
- [[ADR-007-Silk-Storage]] — database + markdown mirror
- [[ADR-008-Eye-Brain]] — borrow a pool Leg behind `EyeBrain`; Jev/Kev later
- [[ADR-009-Multiple-Accounts-Per-Provider]] — supported, no quota hopping by default (a per-provider setting, off)
- [[ADR-010-API-Contracts]] — Zod 4 + oRPC in Express
- [[ADR-011-Claude-Code-Adapter]] — the Agent SDK, `canUseTool`, one config dir per account
- [[ADR-012-Sleep-Inhibition]] — a `systemd-inhibit` holder process
- [[ADR-013-Model-Aware-Routing]] — route to Leg + model + effort; smallest sufficient model; reserve scarce windows
- [[ADR-014-Auto-Approval]] — rules first, then a classifier; asked only when it matters
- [[ADR-015-OpenCode-Adapter]] — OpenCode v2 through a private server per session, every action asked
- [[ADR-016-Parallel-Work]] — a job queue first, then tasks side by side in their own worktrees
- [[ADR-017-Nest-E2E-Protocol]] · [[ADR-018-Nest-Hosting]] · [[ADR-019-Nest-UI-Serving]] — The Nest: libsodium E2E, a VPS with Compose and Caddy, a UI signed by the daemon
- [[ADR-020-Antigravity-Adapter]] — Antigravity through its official headless CLI, approvals by allow list and replay
- [[ADR-021-Tools-Broker]] — tools for skills: MCP servers the daemon runs, judged call by call
- [[ADR-022-Eye-Decision-Models]] — a model per kind of Eye decision, and shadow plans to compare
- [[ADR-023-GitHub-By-Token]] · [[ADR-024-Oraknid-Helper]] · [[ADR-025-Chats]] — Phase 8: GitHub by token, the helper acting through the API, chats that read and research
- [[ADR-026-Servers]] · [[ADR-027-Oraknid-Monitor]] · [[ADR-028-Terminal]] — Phase 9: servers over SSH with a state document, the monitor read over SSH, a terminal with xterm.js
- [[ADR-029-App-Lock]] — Phase 10: a PIN on every device, checked by the daemon
- [[ADR-030-Device-Rights]] · [[ADR-031-Public-Nest]] — Phase 11: full rights for a chosen device; a public Nest
- [[ADR-033-Product-Site]] — the product site at a Nest's root, the phone loader under `/app/`
- [[ADR-032-Email]] — Phase 12: an email client, mail for agents through the broker
- [[ADR-034-Projects-First]] · [[ADR-035-Nest-Pages-By-Mode]] — Phase 13: the project is the place, jobs its history; what a public and a private Nest show
- [[ADR-036-One-Script-Install]] · [[ADR-037-Questions-With-Options]] · [[ADR-038-Project-Accounts]] — Phase 13: one install script with services for systemd, OpenRC and runit; questions with options; a project's GitHub repo and servers, chosen once
- [[ADR-039-Plan-Usage-In-View]] · [[ADR-040-Repos-Page]] — Phase 13: a Leg's plan usage on the Overview and its details; my GitHub repositories inside Oraknid

## 05 — Checkpoints
- [[Checkpoints-Home]] — the index
- [[Checkpoint-1]] — the first real job: too many approvals, the inbox across projects, agent output, talking to The Eye, the result

## 06 — Audit
- [[Audit-Home]] — [[Audit-1]] (closed) and [[Audit-2]] (nobody else drives my computer: every critical and high finding fixed; four in part, two open)

## Methodology
- [[skill]] — Canon-Driven Development, the method this canon follows and Oraknid's first built-in skill
