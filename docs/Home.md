# Oraknid

*Always watching, many legs. A local background orchestrator that runs
AI coding agents and local models from goal to verified completion.*

**Where it stands (2026-10-07):** Phases 1 to 12 are built and tested
on `dev`; what is left in each is hands-on (mine), named in its phase
note and in the [[Roadmap]]. Phase 13 is built through M13.26; open:
the piano job's last push check, mine to resume, M13.12's SQLite files
and sizes inside containers, and [[Audit-2]] S2-02 (fixed in part).
Phase 15, agents that deliver, is in progress before Phase 14: M15.1 to
M15.6 built (the harness's first fixes, auto mode, whole goals and the
ladder, Oraknid's own agent, local models, the terminal app), the
harness taken apart (M15.8: the Gate, the Verifier, the attempt log, one
decision, the task controller; 2026-10-08), a Codex Leg built
([[ADR-057-Codex-Adapter]], not yet run on a real job), and M15.7's
proof not run yet. Released: v0.1.0 to v0.2.4
([[ADR-047-Releases]]).

## 00 — Overview
- [[Vision]] — why Oraknid exists, what it must feel like, pillars, MVP scope
- [[Product-Requirements]] — entities, modules, rules in one paragraph, foundation
- [[Glossary]] — every term (The Eye, Legs, The Web, Silk, The Nest, auto mode, the Gate, the ladder…) with one meaning

## 01 — Specification
- [[Core-Entities]] — the data model and life cycles
- [[Business-Rules]] — the constitution, BR-1 to BR-23
- [[Jobs-and-Projects]] — creating, following, controlling and ending jobs
- [[The-Eye]] — planning, routing, self-prompting, verification, evaluation
- [[Legs-and-Capability-Profiles]] — the pool, health, profiles and learning, unusable agents, the ladder, Oraknid's own agent and the Local Leg
- [[Silk]] — job memory, handoffs, context packs, the markdown mirror
- [[Drift-Control]] — detectors D1–D8, the escalation ladder, rollback
- [[Budgets-and-Quotas]] — tokens, quota windows, context, time, money
- [[Approvals-and-Autonomy]] — autonomy levels (Auto, Careful, Full), auto mode, the Gate, gated actions, the inbox
- [[Skills]] — the skill format, the library, the interview stage
- [[Chats-and-Helper]] — free chats with my models, and the Oraknid helper
- [[Servers]] — my servers: state documents, oraknid-monitor, terminal, a chat and jobs on each, backups
- [[Durability]] — service, sleep inhibition, crash recovery, lossless pause, watchdog
- [[Notifications]] — desktop, web push, email, routing
- [[Security]] — secrets, scope, command filter, prompt injection, pairing, the PIN, device rights, mail, audit
- [[Web-UI]] — every screen, live, mobile: tabs, shortcuts, going back, set up in place, Mail, Models, the lock
- [[Terminal-App]] — `oraknid` in a terminal: The Eye's conversation, a prompt, slash commands, numbered lists; installs without the web UI
- [[The-Nest]] — the remote relay, private or public (Phase 4, Phase 11)

## 02 — Architecture
- [[Architecture-Overview]] — packages (the guard, the harness, the terminal app, local models), layers, data flow, paths
- [[Leg-Adapters]] — the adapter interface; Claude Code, OpenAI-compatible, OpenCode, Antigravity, Oraknid's own agent, Codex
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
- [[Phase-11-Workspace]] — built: pages in tabs, terminal workspace, device rights, a public Nest, the app's own look and the product site; both Nests deployed; the mark kept, its pupil made vertical and gently wavy (2026-10-03)
- [[Phase-12-Email]] — built: the Mail page, IMAP and POP3, agents' drafts; my Gmail syncs; an approved agent draft and an IMAP account to try
- [[Phase-13-Projects-First]] — built on `dev` through M13.26: projects first, Nest pages by mode, the one-script install, questions with options, Workflow, GitHub per project, Repos, Docs and the helper, several repos and servers, server insight, backups, The Eye speaks up, cloud storage, job names; setup fixes, updates, the planner and agents fixed, archive and delete, a chat and jobs on each server, The Eye thinking out loud, parallel by default
- [[Phase-15-Agents-That-Deliver]] — in progress, before Phase 14: M15.1–M15.6 built (a harness for any model, auto mode, Oraknid's own agent, local models, the terminal app), M15.8 done (the Gate, the Verifier, the attempt log, one decision, the task controller), a Codex Leg (M15.9), the proof (M15.7) not run
- [[Phase-14-Oraknid-Over-MCP]] — planned: Oraknid as an MCP server, a command center for any agent
- Later: containers per job, teams

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
- [[ADR-045-The-Eye-Speaks-Up]] · [[ADR-046-Cloud-Storage]] — Phase 13: The Eye reports in the conversation and every answer says what it does; my storage providers as one pool
- [[ADR-047-Releases]] — semantic versions, a tag and a GitHub pre-release with a pinned install script; `main` follows the releases; 0.x.y until I say 1.0 (v0.1.0 to v0.2.4)
- [[ADR-050-Parallel-By-Default]] — tasks in parallel by default, admitted by the machine (memory, CPU, disk, pressure), the Legs' sessions and my cap; a guard that pauses work before the computer crashes and tells me once per incident
- [[ADR-051-Oraknid-Over-MCP]] — proposed (Phase 14): Oraknid as an MCP server; connected clients with rights I give; long jobs started, followed and steered from any agent; GitHub, mail and servers without secrets
- [[ADR-052-A-Harness-For-Any-Model]] — whole goals in one session, checks in the loop, a ladder up when a model fails, only usable agents, The Eye on the strongest model, Oraknid's own agent
- [[ADR-053-Auto-Mode]] — a safety layer instead of approvals per command: open-source rules, a model judge on doubt, me only for what I might not want
- [[ADR-054-Local-Models]] — download, run and manage local models; roles like translation and OCR as tools for every agent
- [[ADR-055-Terminal-App]] — `oraknid` in the terminal with slash commands; an install without the web UI
- [[ADR-056-The-Harness]] — the task harness taken apart: one attempt log, one gate for every action, one verifier, one place that decides an attempt's end, a controller (built in five stages, 2026-10-07/08)
- [[ADR-057-Codex-Adapter]] — OpenAI's Codex CLI as a Leg: `codex exec --json` per turn in Oraknid's sandbox, its own sandbox off, every action through Oraknid's policy by its PreToolUse hook, a CODEX_HOME per Leg
- [[ADR-059-Project-Secrets]] — a project's `.env` values per environment (dev, testing, production) in the keychain, never shown after save, given to its jobs' sandboxes and, through Oraknid, to a server's env file (0600)
- [[ADR-060-Sites-Domains-And-Uptime]] — every site my servers' proxies serve: where its domain points, when its certificate ends, and uptime checks from this computer with a notification when one goes down and comes back
- [[ADR-061-Moving-Oraknid]] — a job or a project as a zip and back; the whole Oraknid (database, config, keychain) as one archive encrypted to a passphrase, restored on another computer
- [[ADR-062-Git-Hosts]] — GitLab, Gitea and Forgejo beside GitHub: accounts by token, one GitHost interface GitHub's client fills too, read in Repos, linked, cloned and pushed to by Oraknid
- [[ADR-063-Mail-OAuth]] — Gmail and Outlook sign in with Google or Microsoft again, through an app I register: the browser with PKCE or Microsoft's code, XOAUTH2, tokens in the keychain
- [[ADR-048-Updates]] — updates from inside Oraknid: install.sh records what it installed; Oraknid checks GitHub on its channel (dev: pre-releases and new work on dev; stable: releases) and updates in one click, the database copied first, a failed update rolled back
- [[ADR-049-Server-Chat-And-Server-Jobs]] — a chat on each server: The Eye answers from its state document or sends an agent into it as a server job (the server's own hidden project), says what will change first, runs its checks on the server, asks before any change on production, and writes the job's changes into the state document
- [[ADR-043-Server-Insight]] · [[ADR-044-Backups]] — Phase 13: Docker, databases, the proxy, traffic and logs of a server; scheduled, encrypted database backups
- [[ADR-042-Several-Repos-And-Servers]] — Phase 13: a project of several repos, each committed and pushed on its own; servers with roles, picked by name and confirmed
- [[ADR-041-Docs-And-A-Guiding-Helper]] — Phase 13: the guide inside Oraknid, and a helper that knows it, my data and the screens, and shows me where things are
- [[ADR-039-Plan-Usage-In-View]] · [[ADR-040-Repos-Page]] — Phase 13: a Leg's plan usage on the Overview and its details; my GitHub repositories inside Oraknid

## 05 — Checkpoints
- [[Checkpoints-Home]] — the index
- [[Checkpoint-1]] — the first real job: too many approvals, the inbox across projects, agent output, talking to The Eye, the result

## 06 — Audit
- [[Audit-Home]] — [[Audit-1]] (closed) and [[Audit-2]] (nobody else drives my computer: every critical and high finding fixed; four in part, two open)

## Methodology
- [[skill]] — Canon-Driven Development, the method this canon follows and Oraknid's first built-in skill
