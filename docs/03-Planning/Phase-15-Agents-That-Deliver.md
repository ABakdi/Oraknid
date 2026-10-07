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
- [x] The oraknid-agent Leg: a tool loop over any OpenAI-compatible model, Claude-Code-like tools, compaction, checks on "done" (2026-10-07: on the AI SDK's loop; the job's MCP tools too; sessions resumed from stored history; Add a Leg offers it)
- [x] Tool calling probed; grammar-constrained JSON for models without native calls; non-tool models limited to text work

Tested: the Leg contract kit against a stand-in llama-server and the real
bwrap sandbox; a task end to end (todo, write, bash in the sandbox, edit,
read); the same through a JSON grammar for a model without tool calls;
checks failing then passing; resume from stored history by a new adapter;
compaction near a small window; a text-only model given no tools; the
probe's three outcomes; each model's own address and the key; the job's
tools through an MCP server; the tools' edge cases (pages, unique edits,
the workspace's edge, glob, grep, todo, web fetch); the OpenAI-compatible
probe saying which models call tools (`packages/legs/oraknid-agent`,
`packages/legs/openai-compatible`, `packages/core/src/profiles.test.ts`).

### M15.5 — Local models ([[ADR-054-Local-Models]])
- [x] Models page and `/models`: find (Hugging Face GGUF, Ollama), download (resumable, checked), run (llama-server or Ollama), load / unload, measured speed, memory and VRAM (2026-10-07: the page and the `models.*` API; `/models` is the terminal app's, M15.6)
- [x] Admitted under ADR-050; idle models unloaded first under danger
- [x] Roles (translate, OCR / vision, speech to text, embeddings, mail, simple code) and their tools for every agent
- [x] `install.sh --local-models`

Tested: through the daemon with a stand-in Hugging Face, ollama.com,
Ollama registry and a local Ollama, and a stand-in llama-server program:
search with fit, download, the GGUF's context read, load as the Local
Leg's model (healthy, tool calls native, 42.5 t/s measured), Oraknid's
agent doing a task on it, unload; roles suggested and set, the
local-models tool translating, summarising and embedding, OCR refused
outside the job's project; a load refused for room and idle models
unloaded to make it; a checksum mismatch; pause and resume with a Range
request; an Ollama library model from the registry; Ollama pulls and
loads when llama-server isn't installed; fit, run plans, GGUF headers,
quantisation and kinds; `admitModel` and the GPU check in `admit()`;
install.sh's choice of llama.cpp build (`apps/daemon/src/models`,
`packages/core/src/admission.test.ts`,
`apps/daemon/src/updates/install-script.test.ts`). Never a real model, a
real download or a real agent; llama.cpp's real release and a real GPU
are still to try by hand.

### M15.6 — The terminal app and a terminal-only install ([[ADR-055-Terminal-App]])
- [ ] `oraknid` opens the Ink app: the prompt, The Eye's transcript live, slash commands with completion, numbered lists, picking by number
- [ ] `/projects`, `/jobs`, `/inbox`, `/servers` (and a server's `/chat`, `/docker`, `/db`, `/proxy`, `/logs`, `/state`, `/ssh`, `/backups`), `/agents`, `/models`, `/usage`, `/health`, `/mail`, `/repos`, `/storage`, `/chats`, `/skills`, `/settings`, `/update`, `/doctor`, `/help`
- [ ] `install.sh --no-gui` / `--gui`, asked when unset; terminal-only skips the web build; `oraknid install --gui` later

### M15.7 — The proof
- [ ] My piano project (React, every feature of its spec) built in under 30 minutes from the spec, verified by its checks, with free models doing the simple parts and climbing when they fail
- [ ] The misahaty-style server job done in one session, one approval of its plan, in minutes

## Exit criterion
The piano project, from its spec to a running, verified React app with
every specified feature, in under 30 minutes, without me answering
anything but the plan; a server job like the misahaty removal in
minutes with one approval; the same from the terminal app on a
machine installed without the web UI.
