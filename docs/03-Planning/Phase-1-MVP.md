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
- [x] systemd user unit (`Type=notify`, `WatchdogSec=30`, `Restart=always`, `TimeoutStopSec=150` for safe-point pauses), linger, watchdog pings through `systemd-notify`; `oraknid install` / `uninstall`. Tested with a real transient notify unit that stays up on pings. Still to try by hand: `oraknid install` on this machine, then a reboot.
- [x] Inhibitor via `systemd-inhibit` holder ([[ADR-012-Sleep-Inhibition]]): block lock, delay-lock fallback with a warning, re-taken if the holder dies, no gap when the reason changes; released 45 s after the last active job (≤ 60 s with the 15 s re-check). Tested against the real logind.
- [~] SecretStore via `@napi-rs/keyring`, **pinned to Secret Service**, so the silent kernel-keyring fallback can't happen and needs no warning. Without a keychain, the encrypted file (AES-256-GCM, scrypt, 0600) stays locked until `secrets.unlock` gets the passphrase. Keychain reads and writes aren't in automated tests (they would touch my real wallet); the probe was checked on the real daemon.
- [~] Metrics: per-process-tree CPU, RSS and IO, plus system CPU, memory, disk and network, read straight from `/proc` (no `pidusage` or `systeminformation`); `nvidia-smi` polled per sample, not streamed; Ollama `/api/ps` moves to the adapter in M1.4. Samples are ephemeral: 1/s to `metrics` subscribers, one hour kept in memory, `metrics.recent` for charts.
- [~] Notifier: `notify-send` (with an Open action), web push (VAPID keys in the secret store, expired subscriptions dropped), SMTP (password in the secret store); per-channel switches and `notifications.test`. Routing per event, quiet hours, grouping and "email after 15 min unanswered" come with the inbox in M1.7.
- [~] bwrap sandbox wrapper + `doctor` check ([[Sandboxing]]): tested for real (writes in the worktree, can't see or write elsewhere, environment cleared, whole tree dies with it). Detecting toolchain directories moves to M1.4, when Legs are launched.

### M1.3 — Durable step engine
- [x] Job and task life cycles as data in `packages/core`; every state change is checked against them and committed with its event (`EventBus.atomically` announces events only after the commit)
- [~] Step journal and side-effect outbox ([[ADR-003-Job-Execution-Engine]]): steps replay recorded outputs and refuse a replay with different input; effects go `intended` → `approved` → **`performing`** → `performed`, with reconcilers per action and my approval for gated ones. Task leases: the column exists and recovery clears it; taking and renewing leases arrives with task scheduling in M1.6.
- [x] Recovery sequence ([[Durability]]) before the API answers: unfinished steps forgotten, interrupted tasks back to `ready`, actions caught mid-way reconciled or asked about (job `waiting`), active jobs resumed, paused ones left paused
- [x] Fault-injection test: `SIGKILL` at all 20 step and effect boundaries of a scripted job, in a real child process on a real database file; every time the job completes, every step is recorded once, only a step killed before its commit runs twice, and both external actions happen exactly once
- [x] Lossless pause/resume with safe points: pause aborts the job's signal and waits for the step in flight; a pause that interrupts an action marks it for checking, never for repeating; a safe point that takes over 120 s is reported, not forced (Legs get killed by their adapters in M1.4); the daemon stopping leaves jobs in their state for the next start
- [x] `jobs.pause` / `jobs.resume` / `jobs.cancel` on the API; until The Eye exists, a started job stops with an honest reason

### M1.4 — Legs
- [x] `LegAdapter` interface (`packages/legs/sdk`) and a contract test kit of 8 tests (a turn, a follow-up, interrupt, permission allowed and denied, a usage limit, kill, resume) that both adapters pass
- [x] Claude Code adapter via the Agent SDK ([[ADR-011-Claude-Code-Adapter]]); one config dir per Leg, which I log into; Oraknid never handles tokens. Tested against a scripted SDK, and live on 2026-10-01 inside bubblewrap: the probe (no tokens) found my Max login and five models with effort levels; a Haiku turn asked permission for its command, which ran in the worktree
- [~] OpenAI-compatible adapter with Oraknid's tool loop (read, write, edit, list, search, run): files confined to the worktree by real path (symlinks included), `search` and `run_command` inside bubblewrap. Tested against a stand-in server and the real sandbox. **Not yet tried against a real model**: this machine has no Ollama model installed (downloading one is my call). Checking a model's tool-calling in `probe` is left to its profile's known failures for now.
- [x] Leg registry: add (Claude config dir created for me to log into, API keys straight to the secret store), test, health checks every 60 s, models synced from probes (my hidden models and overrides kept), default profiles per model, learned values and overrides side by side; pause a Leg
- [~] Quota tracking: `rate_limit_event` windows recorded per account or per model; a rejected account window makes the Leg `rate-limited` until it resets; missing utilization estimated from my window limits and labelled. Claude reports no utilization while a window is open, so the estimate matters. Job quota-share budgets arrive with budgets in M1.7.
- [x] Anthropic Agent SDK credit re-checked 2026-10-01: **still paused**; `claude -p` and Agent SDK use draw from the plan's own limits
- [x] From M1.2: toolchain directories (every PATH entry under my home, plus the agent binary's real directory) bound read-only; Ollama `/api/ps` VRAM per loaded model
- [x] Sessions and attempts tables; a session's raw stream goes to `logs/jobs/<job>/<session>.ndjson`, condensed events (text coalesced per 250 ms) to the bus; recovery kills a crashed session's processes only when pid **and** start time match
- [~] Learning from outcomes is ready in `packages/core`; The Eye records outcomes in M1.6

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
