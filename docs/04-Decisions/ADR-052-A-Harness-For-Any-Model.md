# ADR-052 — A harness for any model: whole goals, checks in the loop, a ladder up

**Status:** Accepted · 2026-10-07 · [[Phase-15-Agents-That-Deliver]] · changes [[ADR-008-Eye-Brain]], [[ADR-013-Model-Aware-Routing]], [[ADR-016-Parallel-Work]], [[ADR-050-Parallel-By-Default]]

## Context
OpenCode on its own and Antigravity on its own do simple work: a small
web app, a change on a server. Inside Oraknid the same models failed
the simplest jobs. The logs of two of my jobs (2026-10-06, the piano
app and "remove the misahaty compose project") say why, and it was
Oraknid, not the models:

- **Work cut into crumbs.** One `docker compose down` became 8 tasks, 32
  sessions and 2.5 million tokens; each task a fresh session that found
  the server again. Anthropic's guidance and the way Claude Code works
  say the opposite: one agent, the whole goal, its own plan, its own
  context ([Building effective agents](https://www.anthropic.com/research/building-effective-agents),
  [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)).
- **Checks outside the loop, and broken.** The agent verified the
  removal correctly ("the removal is actually complete … Oraknid's
  automated check #1 fails due to a quoting issue"); The Eye's own
  check, written on a free model, could never pass, and the right work
  was failed seven times.
- **The Eye on whatever was free.** Planning, checks and judging ran on
  free models; a bad plan or a bad check sinks every task under it.
- **Unusable agents chosen.** Antigravity out of quota for 51 hours was
  routed to four times; a deprecated model was picked; a paused Claude
  was reported as "out of quota".
- **Retries on the same model.** Seven attempts on one free model
  before anyone stronger saw the task.
- **Oraknid's own handoff note** counted as an edit outside the scope.
- **Approvals per command** (22 in one session): see
  [[ADR-053-Auto-Mode]].

I want a harness that takes any set of models and gets quality work
out of them: the better the models, the better the work, but the
simple things always done, fast. Claude stays the strongest rung, there
when needed.

## Decision

### 1. One session per substantial goal
- The Eye splits a goal only where pieces are **substantial and truly
  independent** (a backend and a frontend against an agreed contract;
  two services). A goal one agent can do in one session is **one
  task**: "remove the compose project, keep a backup, verify" is one
  task, not eight. The planner is told this, with examples, and a plan
  of crumbs is merged back (`shapeWeb` joins chains of small tasks on
  the same scope into one).
- The agent **plans inside its session** (its own todo list), keeps its
  context, and is handed: the goal, the acceptance criteria, the check
  commands, the scope, Silk's notes, and what earlier attempts learned.
- A retry **resumes the same session** (`--resume` for Claude Code,
  `--session` for OpenCode, the history for Oraknid's own agent) with
  what failed; a fresh session only after two failed corrections, or
  when the task moves up the ladder (§3), with a handoff.

### 2. Checks inside the loop
- The agent gets the check commands in its prompt and runs them itself
  until they pass; for Claude Code also as a Stop hook (the session
  can't end while they fail, three tries).
- The Eye runs the same checks once more after (trust, but verify):
  unchanged from ADR-008.
- **A check is tested before it judges.** Each check The Eye writes is
  run once before the task (a check that errors on syntax, quoting or a
  missing tool, rather than failing on the work, is a broken check) and
  repaired, by the strongest allowed model, before any agent is failed
  by it. During the task, an agent that reports a check as broken with
  evidence gets that check reviewed, not another attempt.
- Checks are few and meaningful: the build, the tests, the behaviour
  the goal asked for. Not `test -s notes.md`.

### 3. The ladder: a failing model hands over at once
- Every model (each Leg's model, each local model) has a **rung per kind
  of work** (code, server, research, docs, review, planning), learned
  from outcomes; the first order comes from its capability profile and
  public benchmarks.
- A task starts on the **cheapest rung likely to do it** (ADR-013), and
  **one failure moves it up**: a failed check, a review that says
  wrong, a session that ends without the work, a drift stop, a loop.
  Not seven attempts on the same model. The next model gets a handoff
  (what was tried, what failed, the session's notes).
- Before moving up, one exception: a failure that isn't the model's (a
  broken check, the machine, a network error, a quota stop) doesn't
  count against it.
- **The top rung is the strongest model I allow** (Claude Opus by
  default). A job's **Claude share** caps how much of it a job may use
  when it climbs (Settings → Work; default: as needed, within the
  plan's quota rules of ADR-013).
- What climbed is learned: a model that needed help on a kind of work
  starts that kind lower in trust next time; one that succeeds is tried
  on harder work.

### 4. Only usable agents are chosen
- An agent **out of quota, rate-limited, paused, failing to start, or
  on a deprecated model** is never routed to; the reason is read from
  its own words ("Individual quota reached … Resets in 51h", "has been
  deprecated. Use …") and kept until it clears. A deprecated model
  is replaced by the one its provider names, and the list refreshed.
- A blocked job says the real reason: "Claude is paused in Oraknid",
  "Antigravity is out of quota until Thursday 14:00", never "out of
  quota" for a paused Leg.
- With nothing usable for a task, the job waits **and tells me which
  agent to unpause or when the first frees up**; it never hands a task
  to a model below what its kind needs.

### 5. The Eye thinks on the strongest model allowed
Planning, writing and repairing checks, judging a failure, reviewing a
result and the interview run on the strongest model I allow for The
Eye (Settings → The Eye; default: the best Claude model, falling back
down the ladder). These calls are few and short; they decide
everything else, so they are the last place to save.

### 6. Oraknid's own agent
A new Leg kind, **oraknid-agent**: our own loop over any model behind
an OpenAI-compatible API (local llama.cpp or Ollama through
[[ADR-054-Local-Models]], OpenRouter, a provider's free endpoint).
- Tools like Claude Code's: read, edit (exact replace), write, glob,
  grep, bash (in the sandbox), a todo list, a web fetch; results short
  and clear, errors that say what to do next
  ([Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)).
- The loop: the model calls tools until it ends its turn; context
  compacted near the window; the checks of §2 run on its "done".
- Tool calls parsed from the model's native format; for a model
  without one, a grammar-constrained JSON format (llama.cpp grammars).
  The probe tests tool calling; a model that can't call tools does
  only summarise / classify / translate / OCR work.
- Safety by [[ADR-053-Auto-Mode]], in the same sandbox as every Leg.
- Built on an open-source loop if one fits a Node daemon (the Vercel AI
  SDK's tool loop, `@openai/agents`), our own only where none does.

**As built (2026-10-07, M15.4).** `packages/legs/oraknid-agent`, on the
Vercel AI SDK's loop (`ai` 7: `streamText` with tools, a step limit and
`prepareStep`; `@ai-sdk/openai-compatible`; `@ai-sdk/mcp` for the job's
tools). Oraknid's tools run in the daemon: `read` (line numbers, pages),
`edit` (exact and unique, or `replace_all`), `write`, `glob`, `grep`
(ripgrep when there is one) and `bash` inside the job's sandbox like any
Leg's commands, `todo_write`, `web_fetch` (marked as data). Writes,
edits, commands and fetches ask the policy by Claude Code's names
(Write, Edit, Bash, WebFetch); file tools stay inside the worktree by
real path. The job's MCP bridges (github, email, local-models) are its
tools too. Near 80% of the window the earlier work is summarised by the
same model (a list of the calls if it can't), the task kept word for
word. A session's messages are kept in
`<data>/legs/oraknid-agent-sessions` and resumed. The daemon gives it the task's
checks (`SessionStart.checks`, named in its prompt) and the same
`onStop` hook as Claude Code's Stop hook: when a turn ends done, Oraknid
runs the checks and a failure is handed back, up to three rounds, a
broken check told apart as for every Leg (§2). Without a hook (the
adapter on its own) it runs `checks` itself in the sandbox. The probe sends one tiny request per model (the first eight,
once a day): native tool calls, else a JSON grammar
(`response_format: json_schema`, which llama.cpp and Ollama enforce),
else none; the result is stored on the model's profile (`probed`) and a
model without tool calls is kept to summarising and sorting. The
OpenAI-compatible adapter's probe tests tool calling the same way
instead of claiming it.

### 7. Fast
The criterion: **my piano project (React, every feature of its spec)
built in under 30 minutes** from the spec, with free models doing the
simple parts and climbing when they fail. Things that made jobs slow
go: approvals per command (ADR-053), crumbs (§1), retries on the same
model (§3), waiting on an unusable agent (§4), a 12-round interview
(it is one round by default when the spec is complete, the M13.21
cap of 3 otherwise).

## Consequences
- Fewer, larger tasks: the Workflow diagram shows milestones, and each
  task's own todo list inside it (from the session).
- The drift ladder (ADR-008/Drift-Control) applies inside a longer
  session; scope drift ignores Oraknid's own files (`notes/handoff.md`,
  `.oraknid/`).
- Learned rungs need outcomes; until then the profile's order is used
  and labelled "estimated".
- A job may use more of a strong model when it climbs; the Claude share
  and the plan's quota rules bound it.
