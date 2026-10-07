# Product Requirements

## Summary

Oraknid is a local background daemon with a web UI. It runs jobs to
verified completion by orchestrating a pool of AI coding agents and
local models (Legs) under a supervisor (The Eye), from a web UI or a
terminal app. It keeps job memory
in Silk, outside every Leg's session. It is economical with tokens,
catches drift, settles ordinary commands by rules and a model judge
and asks me before anything irreversible, survives crashes
and reboots, and keeps the machine awake while it works. One owner,
several devices. Linux first.

## Entities

| Entity | One line | Spec |
| :-- | :-- | :-- |
| Project | A workspace that many jobs run against. | [[Jobs-and-Projects]] |
| Job | A goal run to verified completion. | [[Jobs-and-Projects]] |
| The Web / Task | A job's task graph and its nodes. | [[The-Eye]] |
| Attempt / Session | One Leg's try at a task, and its short-lived runs. | [[Core-Entities]] |
| Leg / Capability profile | An agent account or model, and what it's good at. | [[Legs-and-Capability-Profiles]] |
| Silk entry | One item of job memory. | [[Silk]] |
| Skill | A markdown methodology. | [[Skills]] |
| Inbox item | An approval or a question waiting for me. | [[Approvals-and-Autonomy]] |
| Side effect | An external action with an idempotency key. | [[Durability]] |
| Event / Audit entry | The append-only record. | [[Security]] |
| Device | A paired browser or phone, with its rights; the PIN unlocks it. | [[Security]] |
| Tool | An MCP server a skill can require. | [[ADR-021-Tools-Broker]] |
| Chat / Helper message | A free conversation with a model; the helper's conversation. | [[Chats-and-Helper]] |
| Server / State document | A machine of mine over SSH, and what it has. | [[Servers]] |
| Mail account / message / draft | My mail in Oraknid, and the agents' drafts. | [[ADR-032-Email]] |
| Project repo | One git repo of a project, with its branches and GitHub link. | [[ADR-042-Several-Repos-And-Servers]] |
| Backup plan / run | One database's scheduled, encrypted backup, and each time it ran. | [[ADR-044-Backups]] |
| Cloud provider | One storage account in the pool, through rclone. | [[ADR-046-Cloud-Storage]] |
| Local model | A model downloaded and run on this computer, with its roles. | [[ADR-054-Local-Models]] |

Full data model: [[Core-Entities]].

## Modules

| Module | What it does | Spec | Phase |
| :-- | :-- | :-- | :-- |
| The Eye | Plan, route, monitor, verify, self-prompt. | [[The-Eye]] | 1 |
| Legs | Adapters, pool, health, profiles. | [[Legs-and-Capability-Profiles]] | 1 (Claude Code, OpenAI-compatible); 2, 5; 15 (Oraknid's own agent, Codex) |
| Silk | Job memory, handoffs, context packs. | [[Silk]] | 1 |
| Drift control | Detectors, escalation ladder, checkpoints. | [[Drift-Control]] | 1 |
| Budgets | Tokens, quota windows, context, time, money. | [[Budgets-and-Quotas]] | 1 |
| Approvals | Autonomy levels, gates, inbox. | [[Approvals-and-Autonomy]] | 1 |
| Skills | Library, interview step. | [[Skills]] | 1 |
| Durability | Service, inhibitor, recovery, pause/resume, watchdog. | [[Durability]] | 1 |
| Notifications | Desktop, push, email. | [[Notifications]] | 1 |
| Security | Secrets, sandbox, command filter, injection, audit. | [[Security]] | 1 |
| Web UI | Live overview, Workflow (The Web), charts, controls, management. | [[Web-UI]] | 1 |
| Parallelism | Several tasks and jobs at once, merges. | [[Phase-3-Parallelism]] | 3 |
| The Nest | Remote relay. | [[The-Nest]] | 4 |
| Non-coding jobs | MCP tools, scoped credentials, the email flow. | [[Phase-6-Non-Coding-Skills]] | 6 |
| Eye decision models | A model per kind of Eye decision, a shadow planner to compare. | [[The-Eye]] | 7 |
| Daily use | The New work page and drafts, skills per project, GitHub repos, Chats, the helper. | [[Jobs-and-Projects]] · [[Chats-and-Helper]] | 8 |
| Servers | State documents, oraknid-monitor, a terminal. | [[Servers]] | 9 |
| Lockdown | A PIN on every device, Audit 2's fixes. | [[Security]] | 10 |
| Workspace | Pages in tabs, shortcuts, a terminal workspace, device rights, a public Nest, the app's own look, the product site. | [[Web-UI]] · [[The-Nest]] | 11 |
| Email | A mail client, agents that read, sort and draft. | [[Web-UI]] → Mail | 12 |
| Projects first | The project as the place (its Eye, Work, Workflow, Repo tabs), Nest pages by mode, the one-script install, questions with options, GitHub per project, Repos, Docs and the helper, several repos and servers, server insight, backups, The Eye speaking up, cloud storage, job names; then updates from inside, archive and delete, a chat and jobs on each server, The Eye thinking out loud, parallel by default within the machine's limits. | [[Jobs-and-Projects]] · [[Phase-13-Projects-First]] | 13 |
| Agents that deliver | A harness for any model (whole goals, checks in the loop, the ladder, only usable agents, the Gate), auto mode, Oraknid's own agent. | [[The-Eye]] · [[Approvals-and-Autonomy]] · [[Phase-15-Agents-That-Deliver]] | 15 |
| Local models | Find, download, run and manage models on this computer; roles as tools for every agent. | [[Web-UI]] → Models · [[ADR-054-Local-Models]] | 15 |
| Terminal app | `oraknid` in a terminal with slash commands; an install without the web UI. | [[Terminal-App]] | 15 |
| Oraknid over MCP | Oraknid as an MCP server for other agents (planned). | [[Phase-14-Oraknid-Over-MCP]] | 14 |

## Business rules in one paragraph

Done means verified by The Eye, never claimed by a Leg. Silk is the
only continuity, and sessions stay short. Oraknid works with any set of
Legs and needs none in particular. Ordinary commands are settled by
rules and a model judge; what I might not want waits for approval,
external actions are never duplicated, and pausing loses nothing. The
database is written before the world is touched. Budgets are hard
except time, and no money is spent by default. The machine stays awake
while jobs are active. Legs are confined to their workspace, secrets
stay in the keychain, the repo's own branches are respected, untrusted
input is data, everything is audited, nothing fails silently, and I
can always take over. Full table: [[Business-Rules]].

## Technical foundation

TypeScript everywhere. A Node.js daemon and The Nest. Express for HTTP
and WebSocket. React, shadcn/ui and Tailwind for the UI; Ink for the
terminal app. A pnpm monorepo
([[ADR-001-Monorepo]]). Persistence, queue, transport and visualization
choices are recorded as ADRs (listed in [[Home]]). Overview:
[[Architecture-Overview]].

Related: [[Vision]] · [[Glossary]] · [[Business-Rules]] · [[Roadmap]]
