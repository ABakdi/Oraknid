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
- [x] A check is run once before it judges; a broken check (syntax, quoting, a missing tool) is repaired, never counted against an agent; an agent's evidence that a check is broken gets it reviewed
  Tested: core `harness.test.ts` (`brokenCheckHint`: a `test` broken by its quoting, an unterminated quote, a missing tool, a program refusing its options, against a missing file or a failing test that are the work's; `saysCheckBroken` on the misahaty agent's words); `eye.test.ts` → agents that deliver: a check with an unterminated quote is repaired before the first session starts (`task.checks-tried`, `task.check-reviewed` with `before`), one attempt, one turn; an agent saying "Oraknid's check is wrong" gets it repaired, no climb, one attempt.
- [x] Unusable agents never routed to (out of quota, rate-limited, paused, failing to start, deprecated model), the reason read from their own words and kept until it clears; a deprecated model replaced by the one named
  Tested: core `harness.test.ts` (`usageLimitOf`/`resetsAtFrom`: "Resets in 51h49m11s", "try again in 2 hours and 5 minutes", an ISO time, a `reset_at`; `deprecationOf`); Antigravity's `quotaError` keeps the 51 hours; `simple-work.test.ts`: an agent saying "Individual quota reached … Resets in 51h49m11s" is rate-limited until then, its attempt `unavailable`, the next route says so; "Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead." hides it and adds mimo-v2.6-flash-free, never chosen again. A Leg that fails to start rests 2 min (`notTheTask`), not tested end to end.
- [x] A blocked job says the real reason and what to do ("Claude is paused in Oraknid: unpause it", "Antigravity is out of quota until …")
  Tested: `eye.test.ts` → a paused Leg: "No Leg can take "Write hello.sh": Claude A is paused in Oraknid: unpause it on its card (Legs) to go on. Unpause one to go on.", no "quota", and the conversation says to unpause it; the quota block still says "out of quota until …".
- [x] Scope drift ignores Oraknid's own files (`notes/handoff.md`, `.oraknid/`)
  Tested: core `harness.test.ts` (`oraknidOwn`, `detect` sees only README.md); `eye.test.ts`: a task that writes `notes/handoff.md` beside its work has no drift, one attempt.

### M15.2 — Auto mode ([[ADR-053-Auto-Mode]])
- [x] The rule layer from open-source parts: allow at once, block at once, judge the rest; read-only commands over ssh recognised
- [x] The judge: a fast model, then a stronger one on doubt, reasoning-blind; I am asked only when it says no on something I might want, or for production
- [x] Claude Code runs in its own auto mode in the sandbox; its denials come back as events
- [x] Approvals per command gone from the default autonomy; one approval of a server job's plan, production per change

Done 2026-10-07 (ADR-053 → As built; Approvals-and-Autonomy → Auto mode;
ADR-014 partly superseded). The new package `@oraknid/guard`; autonomy
is Auto (default), Careful or Full, old jobs moved by migration 0039.
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
- [x] The planner makes substantial, independent tasks; chains of crumbs merged; a goal one agent can do is one task
  Tested: core `harness.test.ts` → whole goals: the misahaty removal's five crumbs become one task (steps numbered, checks and scopes joined, said in the notes); an API, a web app and e2e tests stay apart; two small steps stay two; what came after the chain depends on the merged task. The planner's rules say it with examples (prompt only, not testable without a model).
- [x] The agent gets the goal, the acceptance criteria and the check commands, runs them itself; Claude Code's Stop hook
  Tested: `claude-code/adapter.test.ts`: the Stop hook blocks the end with the failing check three times, then lets it end; no hook without checks. The context pack and the first message ask the agent to run its checks itself (`eye.test.ts` → resumed session's message). Other Legs: prompt only.
- [x] Retries resume the session with what failed
  Tested: `eye.test.ts` → a task paused mid-turn and resumed continues the same model's native session (`resumeFrom`), told why it stopped; a pause is no longer recorded against the model. Climbing to another model starts fresh with the handoff and what failed (`eye.test.ts` → the ladder).
- [x] The ladder: rungs per kind of work, one failure moves the task up with a handoff, the top rung the strongest allowed, a Claude share per job
  Tested: core `harness.test.ts` → the ladder (rungs per kind; after a failure only higher rungs; at the top the strongest again; the Claude share); `eye.test.ts`: a failing first turn climbs Haiku → Sonnet → Opus (`task.climbing`), each told what failed, then Opus corrects in its session; a check The Eye keeps is reviewed on each rung. Settings → Jobs at once → Claude share (`settings.claudeShare`), and a job's `budget.claudeShare`.
- [x] The Eye's own calls on the strongest model allowed for it
  Tested: `brain.test.ts`: a check repaired and a review go to Opus, not Sonnet; planning and the interview already did. Resting models are left out of The Eye's choice.
- [x] One interview round when the spec is complete
  Tested: core `specComplete`; `eye.test.ts`: a goal with a feature list is asked one round, then only played back (rounds 1, final), one inbox round.

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

### M15.8 — The harness taken apart ([[ADR-056-The-Harness]])
- [x] Today's behaviour pinned by scenario tests from my real jobs; the bugs the code map found fixed, one commit each (stop the job stops the job; merge re-checks with their runners; checks reach every agent; resume by the agent's capability; untrusted mark, allow-once, refused actions and stuck counts survive a restart; per-task caches cleared; questions The Eye raised withdrawn after a restart; checks run once per turn end)
  Tested: daemon `harness/scenarios.test.ts`, end to end with stand-in agents (`testing/harness-rig.ts`: a whole daemon, scripted Legs of any kind, Claude Code's PreToolUse hook and Stop hook, a scripted Eye, the stand-in SSH server), each asserting the outcome and what I was asked, how many times and in which words: the misahaty removal (one plan approval, the removal its plan names blocked by layer 1 through the hook, asked specifically, allowed, done in one attempt); a check written with the job's private `-F`/`HOME=` ssh setup run in its plain form on the server; a plan of five crumbs made one task, one approval, one session; an agent out of quota ("Resets in 51h49m11s") kept out, never routed to again, not counted; a deprecated model hidden and replaced; a broken check repaired before any agent, nobody charged; a piano-like web app of four independent parts side by side, all merged, nothing asked.
  Fixed (each with its test in `harness/stage1.test.ts`, which failed before):
  1. "Stop the job" from one task returned a value nobody read: the job's other tasks ran on and new ones started. Now they are stopped and none starts.
  2. A parallel task's re-check at its merge ran without the server and GitHub runners or the job's stop: an `ssh <alias>` check ran locally, failed, and the task was redone for ever. Now the task's own runners; a task that passes alone and never merges stops the job after three tries, saying why.
  3. The supervisor dropped a task's checks (`checks` wasn't in `StartRequest`): Oraknid's own agent never saw them. Passed on, typed.
  4. Resume came from a list of Leg kinds in The Eye that left out Oraknid's own agent. Now the Leg's probe (`features.resume`), kept with the Leg; never probed, a fresh session with the handoff.
  5. On Claude Code the checks ran twice per turn end (Stop hook, then after the turn). What the Stop hook ran as it let the turn end stands when the work is the same.
  6. The judge's verdict cache and the stuck counts were never cleared. Gone when the task settles, every task's when its job ends.
  7. Claude Code's own classifier's refusals didn't count toward the stuck rule. They do: asked at the agent's next action, or as what it needs at the turn's end when a check fails.
  8. The untrusted mark (security: a resumed session was trusted again), "allow once", refused actions (D8) and stuck counts were lost on a restart. Kept per task (`eye/task-memory.ts`) until it settles.
  9. Questions The Eye raised for an attempt cut short by a crash stayed in my inbox. Withdrawn when the job starts again, as a Leg's requests are.
  10. "Try again with my advice" or "another Leg" spent the task's attempt limit. The attempt ends `redirected`, not counted.
  11. My choices (leave it out, I'll do it, stop the job) recorded a failure of the model. Not learned from.
  12. My own words to what the agent needs left that turn's failed check counted toward D3 (Allow didn't). Both the same now.
  13. A failed check climbed the ladder before a scope or security drift was looked at, carrying out-of-scope edits up a rung. D7, D8 and D1 go first (precedence written in the code and ADR-056, As built).
  14. An interrupted turn was verified as finished; one stopped at the agent's limit of steps was judged as a claim. Interrupted: told to go on; at the limit: checked, its words not a claim, no climb, it goes on in its session.
  15. Two lists of credential files (the rules', the policy's) and two of lockfiles. One each, in contracts (`sensitive.ts`); the job's own ssh config and pinned host keys readable, its keys not.
- [x] The Gate: one path for every action (permission prompt, pre-tool hook, MCP broker, ssh, checks), grants with a scope, every block counted
  Tested: core `harness/gate.test.ts`, the decision as a table (source × the rules' verdict × grants × the judge × autonomy, a production change as the rules' ask → allow/deny/ask/judge, by whom, the grant's scope, the audit line, what counts toward the stuck rule); daemon `harness/gate.test.ts`, the Gate alone on a real database: a prompt's block, the hook's and Claude Code's own refusal in one stuck row, asked at the next action; a command the hook refused held for the stuck question at the permission prompt; the count and a once-grant kept across a restart (a new Gate on the reopened database), the grant used once; an older "allow once" read as a grant; a judge that fails is a block; my question recorded and withdrawn; what I refused refused at once (D8); a check's command refused when never allowed or gated, nothing counted; `harness/architecture.test.ts`, `attempt.ts` imports no guard, judge, policy or task-memory module nor any of the decision's names, and stays under its line ceiling (2,165; 2,973 before); `harness/stage2.test.ts`, end to end: what I allowed once runs once after a restart, nothing asked again. Stage 1's scenarios and every other test unchanged (two import `isBrokered` and `ownRepoPage` from the Gate now).
  Changed where one path diverged from the others (a commit and a test each): the hook's third block in a row on a file tool asked nothing (now at the next action); refusing one call of a job's tool refused every call of it (now keyed by its arguments); my refusals didn't count toward the stuck rule (they do, as "you"); a cancelled task's memory outlived its job (cleared when the job ends).
- [x] The Verifier: one runner, a report that tells broken from failing; the attempt log
  Tested: daemon `harness/verifier.test.ts`, the Verifier alone on a real database: a local check in the folder, stopping at the first failure, its report in the log; a check on one of the job's servers run there in its plain form (`-F …` taken off), never locally; a change on a production server refused, a check only reads there; Oraknid's own GitHub check answered by Oraknid; a command the rules refuse a failed check, never run, not broken; a missing program broken, a failing test not; a guard failing before the work broken, after it a failure like any; stopped with its job. `harness/log.test.ts`: typed events appended in order, each attempt its own sequence; bounded reads (an attempt's last N, a task's by kind after a mark); the actions without a result found; kept across a restart (a reopened database); deleted with its job. `harness/stage3.test.ts`, end to end with stand-in agents: an attempt's log holds its session, the agent's actions and results, the Gate's refusal, the checks before the work and at the turn's end, its words, the outcome and the end; the handoff written when the job is stopped says what was tried, what the Gate refused (`sudo ls`, by the rules) and the last check report; an action a crash left without a result marked uncertain after the restart, said once in the job's events and in Silk, not run again. `harness/gate.test.ts`: the stuck row ended by an action's result when Claude Code's classifier let it run, live and read back from the log. `harness/architecture.test.ts`: only the Verifier imports a check's runner; `program.ts` runs no check nor reads the policy; `attempt.ts` at most 2,100 lines (2,165 before). Every earlier test unchanged but `stage2.test.ts`, which reads the task's memory from the log now instead of a setting.
  Changed where the check paths diverged (a commit and a test each): the job's own checks on a server weren't read by the rules (`ssh <alias> 'npm publish'` ran; refused now); the merge's and the job's GitHub checks named a missing `--repo` in other words than the task's (the same now); stage 2's limit, a hook's action Claude Code's classifier let run didn't end the stuck row (its result ends it now).
- [ ] Monitors and `decideOutcome`, pure and table-tested; the escalation policy
- [ ] Agent sessions by capability; the task controller; `runAttempt` gone; ratchet tests

### M15.7 — The proof
- [ ] My piano project (React, every feature of its spec) built in under 30 minutes from the spec, verified by its checks, with free models doing the simple parts and climbing when they fail
- [ ] The misahaty-style server job done in one session, one approval of its plan, in minutes

## Exit criterion
The piano project, from its spec to a running, verified React app with
every specified feature, in under 30 minutes, without me answering
anything but the plan; a server job like the misahaty removal in
minutes with one approval; the same from the terminal app on a
machine installed without the web UI.
