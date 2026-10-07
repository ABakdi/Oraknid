# Phase 15 — Agents that deliver, fast, with any model

Touches [[The-Eye]], [[Approvals-and-Autonomy]], [[Legs-and-Capability-Profiles]],
[[Drift-Control]], [[Web-UI]], [[ADR-052-A-Harness-For-Any-Model]],
[[ADR-053-Auto-Mode]], [[ADR-054-Local-Models]], [[ADR-055-Terminal-App]].
Written 2026-10-07. Comes before [[Phase-14-Oraknid-Over-MCP]].

## Why
Autonomous development is the product. On 2026-10-06 two simple jobs
failed inside Oraknid that the same models finish on their own: the
work cut into crumbs, broken checks failing right work, 22 approvals in
one session, unusable agents chosen, seven retries on one model
([[ADR-052-A-Harness-For-Any-Model]] → Context). I want any set of
models to produce quality work, fast; Claude there when needed; models
on my own machine for specialised work; and Oraknid usable from a
terminal alone.

## Milestones

### M15.1 — What sank the two jobs
- [ ] A check is run once before it judges; a broken check (syntax, quoting, a missing tool) is repaired, never counted against an agent; an agent's evidence that a check is broken gets it reviewed
- [ ] Unusable agents never routed to (out of quota, rate-limited, paused, failing to start, deprecated model), the reason read from their own words and kept until it clears; a deprecated model replaced by the one named
- [ ] A blocked job says the real reason and what to do ("Claude is paused in Oraknid: unpause it", "Antigravity is out of quota until …")
- [ ] Scope drift ignores Oraknid's own files (`notes/handoff.md`, `.oraknid/`)

### M15.2 — Auto mode ([[ADR-053-Auto-Mode]])
- [ ] The rule layer from open-source parts: allow at once, block at once, judge the rest; read-only commands over ssh recognised
- [ ] The judge: a fast model, then a stronger one on doubt, reasoning-blind; I am asked only when it says no on something I might want, or for production
- [ ] Claude Code runs in its own auto mode in the sandbox; its denials come back as events
- [ ] Approvals per command gone from the default autonomy; one approval of a server job's plan, production per change

### M15.3 — Whole goals, checks in the loop, the ladder ([[ADR-052-A-Harness-For-Any-Model]] §1–3, §5)
- [ ] The planner makes substantial, independent tasks; chains of crumbs merged; a goal one agent can do is one task
- [ ] The agent gets the goal, the acceptance criteria and the check commands, runs them itself; Claude Code's Stop hook
- [ ] Retries resume the session with what failed
- [ ] The ladder: rungs per kind of work, one failure moves the task up with a handoff, the top rung the strongest allowed, a Claude share per job
- [ ] The Eye's own calls on the strongest model allowed for it
- [ ] One interview round when the spec is complete

### M15.4 — Oraknid's own agent ([[ADR-052-A-Harness-For-Any-Model]] §6)
- [ ] The oraknid-agent Leg: a tool loop over any OpenAI-compatible model, Claude-Code-like tools, compaction, checks on "done"
- [ ] Tool calling probed; grammar-constrained JSON for models without native calls; non-tool models limited to text work

### M15.5 — Local models ([[ADR-054-Local-Models]])
- [ ] Models page and `/models`: find (Hugging Face GGUF, Ollama), download (resumable, checked), run (llama-server or Ollama), load / unload, measured speed, memory and VRAM
- [ ] Admitted under ADR-050; idle models unloaded first under danger
- [ ] Roles (translate, OCR / vision, speech to text, embeddings, mail, simple code) and their tools for every agent
- [ ] `install.sh --local-models`

### M15.6 — The terminal app and a terminal-only install ([[ADR-055-Terminal-App]])
- [x] `oraknid` opens the Ink app: the prompt, The Eye's transcript live, slash commands with completion, numbered lists, picking by number
- [x] `/projects`, `/jobs`, `/inbox`, `/servers` (and a server's `/chat`, `/docker`, `/db`, `/proxy`, `/logs`, `/state`, `/ssh`, `/backups`), `/agents`, `/models`, `/usage`, `/health`, `/mail`, `/repos`, `/storage`, `/chats`, `/skills`, `/settings`, `/update`, `/doctor`, `/help`
- [x] `install.sh --no-gui` / `--gui`, asked when unset; terminal-only skips the web build; `oraknid install --gui` later

Done 2026-10-07 ([[ADR-055-Terminal-App]] → As built, [[Terminal-App]],
[[ADR-036-One-Script-Install]] → With or without the web UI). Tested:
`apps/daemon/src/tui/tui.test.tsx` (ink-testing-library, a stand-in API
and live socket): commands parsed, completed and ordered by where I am,
picking by number at once or on Enter, the help; Markdown for the
terminal; the transcript (my prompt `›`, a rendered reply, a folded
thought, a running task), thinking live with its text, Esc stopping it,
Tab choosing redo for a message sent while it thinks (`projects.talk`
with `mode: "redo"`), `auto` otherwise; `/` listing and filtering, a
server picked by typing 2, its overview, Esc back a panel at a time; a
job's plan tree, ↑↓ Enter opening a task, `/pause` on the current job;
the inbox answered by number; the notice and bell for a question; a
missing procedure (`/models`) said in words; a command needing a server,
an unknown command. `tui-daemon.test.tsx`: the app on a whole daemon
with the CLI's token and the real live socket (the project chosen,
`/projects`, `/settings` read and written through the real procedures,
`/models` on a daemon without them, `/doctor`, `/servers`).
`no-web-ui.test.ts`: `/` answered in text with the daemon's words, other
pages 404, `system.status.webUi` (false from a terminal-only record, true
for a clone), pairing a phone refused, the web UI served when built. `install-script.test.ts`: `choose_gui` (flags, the
record of an earlier install, a display, `$BROWSER`, none), the record's
`gui`, `build` terminal only (the filtered install and build, an old web
build removed; a fake `pnpm`) and with the web UI, `--help`, updates
passing `--no-gui`/`--gui` (and to the version before), `oraknid install
--gui`'s steps and record. By hand: a terminal-only install and build of
the repository in a temp folder (`pnpm install --frozen-lockfile --filter
'!@oraknid/web'` then the filtered turbo build: the daemon, the Nest and
the site built, apps/web untouched); the daemon's build puts Ink in its
own chunk.

### M15.7 — The proof
- [ ] My piano project (React, every feature of its spec) built in under 30 minutes from the spec, verified by its checks, with free models doing the simple parts and climbing when they fail
- [ ] The misahaty-style server job done in one session, one approval of its plan, in minutes

## Exit criterion
The piano project, from its spec to a running, verified React app with
every specified feature, in under 30 minutes, without me answering
anything but the plan; a server job like the misahaty removal in
minutes with one approval; the same from the terminal app on a
machine installed without the web UI.
