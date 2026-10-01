# Product Requirements

## Summary

Oraknid is a local background daemon with a web UI. It runs jobs to
verified completion by orchestrating a pool of AI coding agents and
local models (Legs) under a supervisor (The Eye). It keeps job memory
in Silk, outside every Leg's session. It is economical with tokens,
catches drift, asks me before anything irreversible, survives crashes
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
| Device | A paired browser or phone. | [[Security]] |

Full data model: [[Core-Entities]].

## Modules

| Module | What it does | Spec | Phase |
| :-- | :-- | :-- | :-- |
| The Eye | Plan, route, monitor, verify, self-prompt. | [[The-Eye]] | 1 |
| Legs | Adapters, pool, health, profiles. | [[Legs-and-Capability-Profiles]] | 1 (Claude Code, OpenAI-compatible); 2, 5 |
| Silk | Job memory, handoffs, context packs. | [[Silk]] | 1 |
| Drift control | Detectors, escalation ladder, checkpoints. | [[Drift-Control]] | 1 |
| Budgets | Tokens, quota windows, context, time, money. | [[Budgets-and-Quotas]] | 1 |
| Approvals | Autonomy levels, gates, inbox. | [[Approvals-and-Autonomy]] | 1 |
| Skills | Library, interview step. | [[Skills]] | 1 |
| Durability | Service, inhibitor, recovery, pause/resume, watchdog. | [[Durability]] | 1 |
| Notifications | Desktop, push, email. | [[Notifications]] | 1 |
| Security | Secrets, sandbox, command filter, injection, audit. | [[Security]] | 1 |
| Web UI | Live overview, The Web, charts, controls, management. | [[Web-UI]] | 1 |
| Parallelism | Several tasks and jobs at once, merges. | [[Phase-3-Parallelism]] | 3 |
| The Nest | Remote relay. | [[The-Nest]] | 4 |
| Non-coding jobs | MCP tools, scoped credentials, the email flow. | [[Phase-6-Non-Coding-Skills]] | 6 |

## Business rules in one paragraph

Done means verified by The Eye, never claimed by a Leg. Silk is the
only continuity, and sessions stay short. Oraknid works with any set of
Legs and needs none in particular. Gated actions wait for approval,
external actions are never duplicated, and pausing loses nothing. The
database is written before the world is touched. Budgets are hard
except time, and no money is spent by default. The machine stays awake
while jobs are active. Legs are confined to their workspace, secrets
stay in the keychain, the repo's own branches are respected, untrusted
input is data, everything is audited, nothing fails silently, and I
can always take over. Full table: [[Business-Rules]].

## Technical foundation

TypeScript everywhere. A Node.js daemon and The Nest. Express for HTTP
and WebSocket. React, shadcn/ui and Tailwind for the UI. A pnpm monorepo
([[ADR-001-Monorepo]]). Persistence, queue, transport and visualization
choices are recorded as ADRs (listed in [[Home]]). Overview:
[[Architecture-Overview]].

Related: [[Vision]] · [[Glossary]] · [[Business-Rules]] · [[Roadmap]]
