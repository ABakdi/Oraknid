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
- [x] The rule layer from open-source parts: allow at once, block at once, judge the rest; read-only commands over ssh recognised
- [x] The judge: a fast model, then a stronger one on doubt, reasoning-blind; I am asked only when it says no on something I might want, or for production
- [x] Claude Code runs in its own auto mode in the sandbox; its denials come back as events
- [x] Approvals per command gone from the default autonomy; one approval of a server job's plan, production per change

Done 2026-10-07 (ADR-053 → As built; Approvals-and-Autonomy → Auto mode;
ADR-014 partly superseded). The new package `@oraknid/guard`; autonomy
is Auto (default), Careful or Full, old jobs moved by migration 0038.
Tested: `packages/guard` — `corpus.test.ts` (112 cases: the owner's
commands of 2026-10-06 allowed, among them `ssh -F … oraknid-spinet-staging
'cd /root/spinet-deploy && docker compose -p spinet-deploy ps -a'`,
`test -s notes/change-plan.md`, `nc -z -w5 95.217.201.11 3456`; blocks
in CC Safety Net's kind (force push, `reset --hard`, `checkout --`,
`rm -rf` outside, `.env`, `~/.ssh`, `~/.aws`), dcg's categories as
ideas (containers, cloud, databases, Kubernetes, Terraform, deploys),
hidden in lists, wrappers, subshells, `sh -c` and the far side of ssh;
`docker compose -p misahaty down -v` blocked unless the task names it;
an AWS key or GitHub token sent with curl; the judge's and production's
share; layer 1 under 5 ms per command on average and a plain read under
1 ms), `judge.test.ts` (a fake brain: allow, block with its category
from stage 2, stage 2 overturning, the cache by normalised command and
task, a timeout and a failure as BLOCK and not cached, the template
reasoning-blind; the stuck rule at three in a row and once at twenty;
shapes). `packages/core` — the policy with layer 1's verdict (a block
above my allow rules, full skipping the judge in the folder and on
non-production servers, never automatic at every level, `deploy` as a
word only, credentials refused to file tools). `claude-code` adapter —
auto mode's options and its two hooks (deny with the reason, ask, no
opinion, Claude Code's denials as events); the contract kit's deny path
for every adapter. Daemon — `eye.test.ts` (the judge's verdicts cached
and its block told to the agent with the layer in the audit, the job
report's "Blocked" count, stuck on blocks asking me, never automatic
asking at Auto, careful's approvals), `server-jobs.test.ts` (a server
job at Auto: one approval, the plan's, every read over ssh and port
check settled by the rules; production still asks at Full),
`project-links.test.ts` (a push to someone else's repo blocked by the
judge), `entities.test.ts` (old autonomy names parse). Not tested
against real models or a real Claude Code session.

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
