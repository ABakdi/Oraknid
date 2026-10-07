# ADR-056 — The harness: one log, one gate, one verifier, one decision, a controller

**Status:** Accepted · 2026-10-07 · [[Phase-15-Agents-That-Deliver]] (M15.8) · restructures [[ADR-052-A-Harness-For-Any-Model]], [[ADR-053-Auto-Mode]], [[ADR-008-Eye-Brain]] (the task part), [[ADR-003-Job-Execution-Engine]] (inside a task)

## Context
The job pipeline is a clean sequence of recorded steps (skill, workspace,
interview, plan, tasks, merge, verify, servers, replan, report). Inside it,
a task attempt is one function, `runAttempt`, of about 2,300 lines: routing,
permissions, the rules and the judge, Claude Code's hook, the stuck rule,
plan-approved removals, the owner's questions, tools, servers, checks, the
stop hook, broken-check repair, sessions, handoffs, drift, the escalation
ladder and the ending, all as closures sharing mutable state. Each fix
landed where its symptom was. The bugs of 2026-10-06/07 were interactions
between pieces that were each tested alone. A read-only map of the code
(2026-10-07) found more of the same:

- Five paths decide an agent's action (the Leg's permission prompt, Claude
  Code's PreToolUse hook, the MCP broker, ssh to a server, checks), with
  duplicated and diverging logic: layer 1 run twice, hook blocks not
  counted, Claude Code's own denials not counted, two different lists of
  sensitive paths, two of lockfiles.
- Checks are wired five times (task, stop hook, after each turn, merge,
  job); on Claude Code they run twice per turn end; the merge re-check
  runs server and GitHub checks without their runners, so a parallel task
  with such checks can loop.
- The end of an attempt is decided in several places in an order nobody
  chose: a failed check climbs the ladder before drift is looked at; an
  owner's "try again" counts against the attempt cap; "stop the job"
  returns a value nobody reads, so other tasks go on starting.
- State that should survive a restart doesn't: the stuck counts, an
  owner's "allow once", refused actions (D8), the "read untrusted web
  content" mark (a security gap: a resumed session is trusted again);
  module-level caches never cleared; questions The Eye raised not
  withdrawn after a restart.
- Leg-specific branches inside The Eye (`RESUMES`, tool names, the hook
  bridge), defaults by `else`.

Open-source harnesses studied (2026-10-07): openharness (autonomous-ai,
MIT: vendor CLIs supervised in tmux, a normalized event stream, "reserve,
then act", an Engine interface whose facets are optional with declared
fallbacks, its own 5,200-line function being taken apart step by step);
OpenHands' agent SDK (the event log is the state; Action/Observation
pairs; an explicit execution status; risk scoring separate from the
confirmation policy; a pure stuck detector over events; a stop hook and a
critic); mini-swe-agent (a 190-line loop; termination as typed values; an
explicit finish); the Claude Agent SDK's canUseTool, PreToolUse and Stop
hooks; Codex CLI (approval policy orthogonal to sandbox; decisions with a
scope, "approved for session"); LangGraph (checkpoint per step; an
interrupted node re-runs, so its side effects must be recorded).

## Decision
The task harness becomes a set of small modules with one owner per
decision, under `apps/daemon/src/harness/` (pure parts in
`packages/core/src/harness/`).

### 1. The attempt log — the single source of truth
An append-only, typed log per attempt, kept in the database and fed to
the live bus:
`SessionOpened`, `AgentText`, `ActionRequested{id, tool, input}`,
`GateDecision{actionId, by: rule|plan|judge|owner|leg, verdict, reason, scope}`,
`ActionResult{actionId, ok}`, `QuestionAsked`, `QuestionAnswered`,
`StopRequested{text}`, `ChecksRan{report}`, `Signal{stuck|drift|budget|stall}`,
`Outcome{kind}`, `HandoffWritten`, `AttemptEnded{reason}`.
Monitors, the outcome decision, handoffs, the owner's questions and the
UI read it; nothing keeps a second copy in a closure. An action with no
result after a restart is *uncertain*: reconciled (look at the session,
the tree, the server), never re-run blindly.

### 2. `AgentSession` — one adapter per agent kind
`open(spec, resume?)`, `send(text)`, `events()`, `interrupt()`, `close()`,
`capabilities {inlineGate, preToolHook, stopHook, resume, steer}` (from
the probe, not from a list in The Eye). Adapters translate to log
events and call the Gate and the controller through their hooks; they
decide nothing. A capability an agent lacks has a declared fallback
(no inline gate → its actions are audited after the fact and feed drift;
no stop hook → checks after the turn ends), never an `else`.

### 3. `Gate` — every action, one path
`decide(action, ctx) → {verdict: allow|deny|ask, by, reason, scope}`
for every action from every source (permission prompt, pre-tool hook,
MCP broker, ssh to a server, a check's command). In order: the rules
(ADR-053 layer 1; one list of sensitive paths, one of lockfiles) → the
**grants** (scoped allowances: an approved plan's own removals, an
owner's "allow once" or "all like this for this job", the autonomy
level) → the judge (risk only; an error is high risk) → a policy that
turns risk into allow or ask → the owner. Blocks of every kind (rules,
judge, the Leg's own classifier) go into the same stuck count. Grants,
denials and counts live in the attempt log, so they survive a restart.

### 4. `Verifier` — one runner for checks
`run(checks, where) → CheckReport {passed, failures[], broken[], guards[]}`,
built once per job with its sandbox, servers and built-in checks, used by
the task, the stop hook, the merge and the job. A broken check (it can't
run: syntax, missing tool, ssh setup) is a different result from a
failing one; guards must pass before the work. Repair is its own outcome.

### 5. Monitors — pure functions over the log
Stuck (OpenHands' patterns: the same action and the same result
repeated, the same error repeated, talk without actions, two actions
alternating; nudge once, then stuck), drift D1–D8, budget, stall. They
emit `Signal`s; they never act.

### 6. `decideOutcome` — the only place an attempt's end is decided
A pure function, table-tested:
`(stop reason, check report, signals, what the agent said it needs, rung,
history, policy) → Outcome`:
`Done | Continue{feedback} | RepairChecks | AskOwner{question} |
Retry{same session} | Climb{next rung, handoff} | Unavailable{until} |
Fail{reason} | CancelJob`.
Precedence is written once: not-the-task's-fault (quota, provider,
broken check) first; then what the agent says it needs from me; then
checks with feedback within the session; then drift's ladder; then the
climb. Counting is written once: what spends the attempt cap and what
doesn't (an owner's "try again" doesn't).

### 7. `EscalationPolicy` — pure
`next(rung, history) → rung | top`; attempts numbered; a result from a
stale attempt is dropped. A new rung is a fresh session with a handoff
built from the log (what was tried, what the Gate refused, the check
report), not from the model's memory.

### 8. `TaskController` — a state machine, no policy
`Preparing → Running ⇄ AwaitingOwner → Verifying → Deciding →
{Running | Repairing | HandingOff → next attempt | Done | Failed |
Cancelled}`. Each transition is a recorded step with an idempotency key
(ADR-003). It runs the session, routes events to the log, calls the
Verifier and `decideOutcome`, and applies the outcome. `runAttempt`
becomes this controller; `runTask` applies its result from a table.

### 9. Ratchets
- An architecture test fails if the controller imports policy modules,
  if Leg-specific names appear in the harness, or if `attempt.ts` grows.
- Scenario tests replay my real failed jobs (the piano run, the misahaty
  jobs, an agent out of quota, a broken check, a plan-approved removal
  through Claude Code's hook) end to end with stand-in agents.

### How we get there
openharness's rule: a step moves code; it doesn't change behaviour; bugs
found on the way are fixed in their own commits, each with a test.
1. Pin today's behaviour with the scenario tests; fix the bugs the map
   found, one commit each.
2. Extract the Gate (one path for every action; durable grants and counts).
3. Extract the Verifier (five call sites to one) and the attempt log.
4. Monitors and `decideOutcome` (pure, table-tested), `EscalationPolicy`.
5. `AgentSession` capabilities; the `TaskController`; `runAttempt` gone.

## Consequences
- More files, each small, each with its own tests; the bugs of the last
  two days become cases in a table.
- The attempt log is a new table; the UI's job and session views can read
  it later instead of piecing events together.
- Stage 1 changes behaviour where the old behaviour was a bug (listed in
  the Phase 15 notes as each is fixed).
