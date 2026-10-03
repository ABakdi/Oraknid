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
- [x] Silk store and kinds ([[Silk]]): entries are added or superseded, never edited in place; only I can supersede an entry I wrote; `silk.list` / `add` / `edit` / `importMirror` on the API
- [~] Handoffs: rebuilt from the session's raw log and `git diff --stat` (commands run, failed ones as traps, the last words) with the same headings a Leg is asked for. Asking the outgoing Leg for its own (`HANDOFF_REQUEST`) happens when The Eye rotates sessions in M1.6.
- [~] Context pack builder with a token cap: the spec's order, superseded entries out, issues near the task's scope only; over the cap, the oldest entries shrink to their titles (mine stay whole) and then the digest is trimmed. Summarising shrunk entries into a new entry with a cheap Leg needs The Eye's brain (M1.6).
- [x] Markdown mirror + hand-edit import ([[ADR-007-Silk-Storage]]): written atomically after every change; a hand edit is noticed within 30 s (or on `silk.importMirror`), asked about once in the inbox, left untouched until I answer, then imported as my entries or replaced by Oraknid's version
- [x] `inbox.list` / `inbox.answer` on the API, early, so the import question can be answered before M1.7

### M1.6 — The Eye
- [~] `EyeBrain` interface + `PoolLegBrain` ([[ADR-008-Eye-Brain]]): `plan`, `replan`, `summarize`; a short read-only session, JSON validated by schema **and** by The Web's rules, one retry with the exact problems. The Eye Leg is a setting (`settings.setEyeLeg`); asking for it at first run is the UI's job (M1.8). `interviewRound` arrived with M1.7, `evaluate` (a second look at tasks without verify commands) with M1.9.
- [x] Planning to a validated Web (unique keys, existing dependencies, no cycles, verify commands and relative scopes); replans add tasks and never touch done ones
- [x] Model-aware routing ([[ADR-013-Model-Aware-Routing]]): difficulty fit, capability, past success, quota cost per window, scarce-window reservation, step-ups (effort, then strength), avoidance of models that failed the task; every exclusion says why; the choice is recorded on the task
- [x] Fallback to another Leg on a usage limit (with a handoff); `blocked` until the earliest reset when none is left, resumed on its own (checked every 30 s)
- [x] Self-prompting: after each turn The Eye runs the checks and sends the exact failure back
- [x] Verifier runs `verify[]` in the sandbox (private `/tmp`, no Leg home), stops at the first failure, fingerprints failures for D3; job-level verification, with a replan when it fails
- [x] Drift detectors D1–D8 and the ladder ([[Drift-Control]]): out-of-scope edits reverted (only those), false claims corrected with the failure, stalls watched every 30 s, a refused gated action tried again counts as D8; step up, reassign, kill with rollback, then ask me (retry with guidance, take over, skip, cancel)
- [x] Git checkpoints on private refs through a temporary index (my branch, HEAD and index untouched), rollback to the trash, `.oraknid/` never in a checkpoint; a verified task is one commit on the job branch; a folder without git gets a shadow repo
- [x] Session rotation at 60% of the context window, with a handoff asked of the Leg (rebuilt from its log if it can't answer)
- [x] Projects and jobs on the API (`projects.create/list`, `jobs.create/start/get/list`); the canon-driven skill is seeded as the built-in, jobs pin its version
- [x] Learning: every attempt's outcome updates the Leg model's observed record
- [~] Task leases are not needed while one job runs one task at a time; they return with Phase 3. Summarising shortened Silk entries with `brain.summarize` is wired in M1.7 with budgets.
- [x] Found live (2026-10-01): `sh` and `[` were not on the allow list, so an agent checking its own script had to ask; approvals of an attempt that ended were left open in the inbox — both fixed with tests

### M1.7 — Approvals, budgets, skills
- [x] Autonomy levels, gated actions, permission policy, inbox ([[Approvals-and-Autonomy]]): Supervised approves the plan and each replan, asked on every run so a resume can't skip it (found by a test: a denied plan once ran after a resume); a Leg's request can be approved once, denied, or approved for the rest of the job (a waiver or an allow rule, audited); autonomy, waivers and rules can change mid-job and apply to the next decision; answering resumes the job that waited; open approvals first
- [~] Command allow/deny list: the shipped never-allowed and gated lists, plus my rules per job and globally (most specific level decides, deny beats allow within it, invalid patterns refused). Rules per project are on the project page (M1.9).
- [~] Budgets ([[Budgets-and-Quotas]]): tokens and time per job, warned once at 80% of a hard limit, paused at the limit with "raise it by half / double it / keep it paused"; time is an alarm by default; money 0 means none. Quota-share is enforced in routing and budgets can be changed after the start (M1.9); per-task budgets are recorded but not enforced yet; money is counted once a per-token Leg exists.
- [x] Skills library on the API (list, get, upload, edit, remove): built-ins read-only, edits make versions, a skill used by a job that hasn't ended can't be removed; `docs/skill.md` ships as the built-in `canon-driven-development` (`skills/` at the repo root)
- [x] Interview stage ([[Skills]]): rounds of at most four questions in one inbox item each, my answers kept verbatim in Silk, a playback ending "Is this right?", "Enough, start" records what stays open; durable across pauses and restarts
- [x] Untrusted-content wrapping (BR-15): inputs marked untrusted are wrapped as data in context packs, scanned once for attempts to steer the agent (flagged in Silk and the stream), and make every gated action ask, waivers and Full autonomy or not
- [x] Audit log + daily JSONL: every event records its actor (me, The Eye, a Leg, Oraknid), is scrubbed of known secrets and secret-shaped strings before it's stored (Leg logs too), is searchable (`audit.search`), and exported once to `logs/audit/<day>.jsonl`
- [x] From M1.2: notification routing per event (the spec's table, my changes win), quiet hours, grouping ("2 approvals waiting"), email only after 15 minutes unanswered
- [x] Moved to M1.9 hardening and built there: summarising shortened Silk entries with `brain.summarize`, and `brain.evaluate`, a second reasoning look at tasks without verify commands

### M1.8 — Web UI
- [x] Shell: sidebar / bottom tabs ("More" for the rest), ⌘K palette (pages, jobs, pause and resume), live indicator, "awake" badge, inbox count, dark-first theme with light and system
- [x] Overview: Legs now (what each runs, model and effort, every quota window with its reset, context), activity stream, problems, resources (CPU, memory, disk, network, GPU, per process with VRAM), totals, tokens today by Leg
- [~] Job page: The Web as a live graph (React Flow, ELK in a Web Worker; nodes glide to new places, running tasks pulse, edges into running work animate), task drawer (instructions, scope, checks and their last result, why this model, attempts with rollback, pin, take over / hand back, edit, remove), tabs (Activity, Silk, Inbox, Budget, Stats), controls (pause, resume, redirect, autonomy, cancel with a confirmation). The plan editor edits, adds and removes tasks and their dependencies; drag-to-reorder is not built. Motion was not needed: CSS transitions move the nodes.
- [x] Charts ([[ADR-005-Charts-and-Graph-Visualization]]): tokens over time stacked by Leg model (The Eye on its own line), success by Leg model, sparklines
- [x] Projects (with per-project stats and history), New job (one form; Start says why it's disabled), Inbox (approvals, questions, interview rounds, approve-all-like-this), Legs (add and test, login hint, models, profile editor with learned values next to mine), Skills (view, upload, edit with preview, delete), Logs (audit search), Settings (the machine, The Eye Leg, notifications with the routing table and quiet hours, email, push on this device, my rules, devices and pairing, look)
- [~] Pairing (`oraknid pair`, and `oraknid open` pairs this machine's browser by itself), an installable PWA (manifest and a hand-written service worker), push subscription from Settings. Push on a phone needs the phone to reach the daemon: The Nest (Phase 4). Device tokens are long-lived and revocable rather than short-lived sessions.
- [x] Empty, loading and error states (BR-17): every empty list says what it is and what to do; errors are sentences
- [x] Checked by hand on 2026-10-01 against the real daemon and the earlier live job: desktop, and 390 px frames in dark and light; nothing scrolls sideways. That found the graph fitting before its layout, the graph controls ignoring the theme, and activity lines shown twice; all fixed.
- [x] Built in M1.9: storage use and pruning, nightly backups, rules per project, editing a job's budget after it starts

### M1.9 — Dogfood
- [x] Run a real job on a real project with the canon-driven skill, from interview to completion (the web piano, 2026-10-01)
- [~] Pause/resume mid-task and `kill -9` the daemon mid-task, on a real Claude job: completed, every step once, the Leg process gone with the daemon; two bugs found and fixed (B1-02, B1-03 in [[Checkpoint-1]]). A reboot mid-job is still to try.
- [ ] Hit a Claude quota window during a job and watch fallback or blocked → automatic resume
- [x] Take the first checkpoint ([[Checkpoint-1]])
- [x] Audit before `v0.1.0` ([[Audit-1]]): 61 findings, 56 fixed, 5 documented; closed 2026-10-01
- Moved to Phase 2 by Audit 1: git off the event loop (D1-05), attempt step keys (D1-12), the job settings tab, diff, checkpoint list, log export and drag-to-reorder (Q1-20), a per-job network allow list (S1-10)

## Left from the brief

Found when the canon was checked against the brief (2026-10-03); the
spec says them, they aren't built:
- [ ] The Web: a Leg's avatar on its task, and a handoff animation along the edge when a task moves to another Leg ([[Web-UI]] → Job; the name shows as text)
- [ ] Charts beyond tokens over time, success by Leg model and sparklines: cost, task throughput, success and failure by task kind, tokens per verified task, time per task, budget burn against limits ([[Web-UI]] → Charts)
- [x] Pausing a Leg pauses its running session in place: a safe point, a checkpoint and a handoff; the task waits for the Leg, or is reassigned (2026-10-03)
- [x] Cancelling one Leg's work in a job, or on one task: its sessions end at a safe point, the tasks go on without it (`jobs.cancelLegWork`, 2026-10-03)

## Exit criterion

I run a real job on a real project with the canon-driven skill, from
interview to verified completion, without touching a terminal. It
survives a pause/resume, a `kill -9` of the daemon and a reboot without
redoing work or repeating any side effect. Released as `v0.1.0`.

Related: [[Roadmap]] · [[Product-Requirements]] · [[Architecture-Overview]]
