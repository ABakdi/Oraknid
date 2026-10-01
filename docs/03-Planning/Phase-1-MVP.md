# Phase 1 — MVP

Touches every specification note listed in [[Home]] except [[The-Nest]].
Written 2026-10-01.

## Why

I babysit Claude Code today. This phase replaces that: a job runs from
interview to verified completion while I'm away, and it survives pauses,
crashes and reboots.

| Today | After Phase 1 |
| :-- | :-- |
| I re-prompt Claude Code when it stops. | The Eye self-prompts. |
| I copy context into a new session by hand. | Silk handoffs and context packs. |
| I check whether "done" is true. | The Eye runs verification itself. |
| I wait for quota resets. | Fallback to other Legs, or an automatic resume at the reset. |
| The laptop sleeps mid-job. | The inhibitor keeps it awake. |

## Milestones

### M1.1 — Foundation
- [~] Monorepo scaffold ([[ADR-001-Monorepo]]): pnpm, Turborepo, Biome, Vitest, tsdown done; Vite comes with `apps/web` in M1.8. Node is **≥ 22.12**, not the Active LTS: this machine has Node 22, and every dependency supports it (2026-10-01). Move to the LTS when it's installed.
- [x] Biome covers the React-hooks rules: `useExhaustiveDependencies` and `useHookAtTopLevel` turn on with Biome's React domain, so no ESLint plugin is needed
- [x] `packages/contracts` with the core entities from [[Core-Entities]], events and live frames
- [x] SQLite + Drizzle + migrations + backup-before-migrate ([[ADR-002-Persistence]]); WAL, `synchronous=FULL` and foreign keys checked by tests
- [x] Daemon skeleton: Express, oRPC `/api` (`system.status`, `system.doctor`), `ws` `/live` with topics, replay from `lastSeq` without duplicates and `snapshot-needed` past 5,000; event bus that commits before notifying
- [x] Until pairing (M1.8), only local requests are accepted: loopback address, a local `Host` (stops DNS rebinding) and a local or absent `Origin` (stops web pages calling the API)
- [~] `oraknid` CLI: `run`, `start`, `stop`, `status`, `logs`, `open`, `doctor` done; `install` moves to M1.2 with the systemd unit it writes

### M1.2 — OS layer (Linux)
- [ ] systemd user unit, linger, `WatchdogSec` ping
- [ ] Inhibitor via `systemd-inhibit` holder ([[ADR-012-Sleep-Inhibition]]); released ≤ 60 s after the last active job
- [ ] SecretStore via `@napi-rs/keyring`, with a kernel-keyring fallback warning and the encrypted-file fallback
- [ ] Metrics: per-process tree CPU/RAM, system, `nvidia-smi` stream, Ollama `/api/ps`
- [ ] Notifier: `notify-send`, web push (VAPID), SMTP
- [ ] bwrap sandbox wrapper + `doctor` check ([[Sandboxing]])

### M1.3 — Durable step engine
- [ ] Step journal, leases, side-effects outbox ([[ADR-003-Job-Execution-Engine]])
- [ ] Recovery sequence ([[Durability]])
- [ ] Fault-injection test: `SIGKILL` at every step boundary of a scripted job, with no duplicate steps or effects
- [ ] Lossless pause/resume with safe points

### M1.4 — Legs
- [ ] `LegAdapter` interface + contract test kit
- [ ] Claude Code adapter via the Agent SDK ([[ADR-011-Claude-Code-Adapter]]); one config dir per Leg; Oraknid never handles tokens
- [ ] OpenAI-compatible adapter with Oraknid's minimal tool loop, executed in the sandbox
- [ ] Leg registry: add, test (`probe`), health checks every 60 s, capability profiles with defaults, learned values and overrides
- [ ] Quota tracking from `rate_limit_event` and usage fields; "estimated" labelling
- [ ] Re-check the Anthropic Agent SDK credit status (paused 2026-06-15) and record it here

### M1.5 — Silk
- [ ] Silk store and kinds ([[Silk]])
- [ ] Handoffs (from the Leg, or reconstructed from the event log + diff)
- [ ] Context pack builder with a token cap
- [ ] Markdown mirror + hand-edit import ([[ADR-007-Silk-Storage]])

### M1.6 — The Eye
- [ ] `EyeBrain` interface + `PoolLegBrain` ([[ADR-008-Eye-Brain]]); first-run Eye Leg choice
- [ ] Planning to a validated Web; replans that keep done tasks
- [ ] Model-aware routing ([[ADR-013-Model-Aware-Routing]]): Leg models discovered by `probe`, difficulty estimates, per-model windows, scarce-window reservation, step up / start lower
- [ ] Fallback + `blocked` until reset with an automatic resume
- [ ] Self-prompting loop
- [ ] Verifier: runs `verify[]` in the sandbox; job-level verification
- [ ] Drift detectors D1–D8 and the escalation ladder ([[Drift-Control]])
- [ ] Git checkpoints and rollback
- [ ] Session rotation at the context threshold (BR-3)

### M1.7 — Approvals, budgets, skills
- [ ] Autonomy levels, gated actions, permission policy, inbox ([[Approvals-and-Autonomy]])
- [ ] Command allow/deny list with shipped defaults ([[Security]])
- [ ] Budgets: tokens, quota share, context, time alarm, money (0 by default) ([[Budgets-and-Quotas]])
- [ ] Skills library; `docs/skill.md` shipped as the built-in `canon-driven-development`
- [ ] Interview stage ([[Skills]])
- [ ] Untrusted-content wrapping (BR-15)
- [ ] Audit log + daily JSONL

### M1.8 — Web UI
- [ ] Shell: sidebar / bottom tabs, ⌘K palette, live indicator, inhibitor badge, inbox count, dark-first theme
- [ ] Overview: Legs now, activity stream, problems, resources, totals
- [ ] Job page: animated Web (React Flow + ELK + Motion), task drawer, tabs, controls, plan editor
- [ ] Charts ([[ADR-005-Charts-and-Graph-Visualization]])
- [ ] Projects, New job, Inbox (with interview rounds), Legs, Skills, Logs, Settings
- [ ] Pairing flow; PWA install; push subscription
- [ ] Empty, loading and error states for every screen (BR-17)
- [ ] Check every screen at phone width

### M1.9 — Dogfood
- [ ] Run a real job on a real project with the canon-driven skill, from interview to completion
- [ ] Pause/resume mid-task; `kill -9` the daemon mid-task; reboot mid-job, with no work redone
- [ ] Hit a Claude quota window during a job and watch fallback or blocked → automatic resume
- [ ] Take the first checkpoint ([[Checkpoints-Home]])
- [ ] Audit before `v0.1.0` ([[Audit-Home]])

## Exit criterion

I run a real job on a real project with the canon-driven skill, from
interview to verified completion, without touching a terminal. It
survives a pause/resume, a `kill -9` of the daemon and a reboot without
redoing work or repeating any side effect. Released as `v0.1.0`.

Related: [[Roadmap]] · [[Product-Requirements]] · [[Architecture-Overview]]
