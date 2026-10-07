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

## As built (stage 1, 2026-10-07)
Behaviour pinned, the map's bugs fixed one commit each; nothing moved yet.
- **Scenario tests**: `apps/daemon/src/harness/scenarios.test.ts` replays
  my real jobs with stand-in agents through `testing/harness-rig.ts` (a
  whole daemon, scripted Legs of any kind with Claude Code's PreToolUse
  and Stop hooks, a scripted Eye, the stand-in SSH server), asserting what
  each job ends as and what I was asked, how often and in which words.
  `harness/stage1.test.ts` holds each bug's test.
- **Precedence at a turn's end**, as the code has it now (`attempt.ts`),
  until `decideOutcome` takes it: not-the-task's-fault (quota, provider,
  deprecated model) first; a turn cut short (interrupted) is not judged,
  the agent goes on; my messages to it; the checks (what the Stop hook ran as it let
  the turn end stands when the work is the same); what the agent says it
  needs of me (and being stuck on its own auto mode's refusals) asked
  before any ladder; then **security and scope — D7, D8, D1 — go to the
  drift ladder before any climb**; then a failed check climbs a rung
  (not for a turn stopped at the agent's limit of steps, which goes on
  in its session); then the other drifts (D2–D6) on the rung where it
  is; then self-prompting with the failure.
- **Counting**: only `failed` and `reassigned` attempts spend the task's
  limit; my "try again" ends an attempt `redirected`; none of my choices
  is learned as the model's failure; `unavailable` isn't either.
- **Kept per task across a restart** until the task settles
  (`eye/task-memory.ts`, a setting per task; the attempt log replaces it
  in stage 3): the untrusted mark, "allow once", refused actions (D8),
  the stuck counts, and the inbox items the running attempt raised (a
  job that starts again withdraws them, as it does a Leg's requests).
  The judge's verdict cache and the stuck counts in memory go when the
  task settles, and with its job.
- **Every block counted**: Claude Code's own classifier's refusals count
  toward the stuck rule; they can't be held for my answer, so I'm asked
  at the agent's next action that comes through Oraknid, or as what it
  needs at the turn's end when a check fails.
- **One runner for a task's checks outside its attempt**: the merge
  re-check uses the task's runners (servers, Oraknid's GitHub checks,
  the policy) and the job's stop; three merges that fail stop the job.
  "Stop the job" stops the job's other tasks and starts none.
- **Capabilities from the probe**: a Leg's probed `features` are kept with
  it (`registry.features`); resume reads them, not a list of kinds. A
  task's checks reach every session (`StartRequest.checks`).
- **One list each** of credential files and lockfiles
  (`@oraknid/contracts` → `sensitive.ts`), read by the rules, the policy
  and The Eye.

## As built (stage 2, 2026-10-07)
The Gate extracted; code moved, behaviour kept, except where one path
diverged from the others (below, a commit and a test each).
- **`gateStep`** (`packages/core/src/harness/gate.ts`), pure: the facts
  (source, the rules' verdict, whether it is layer 1's own block, the
  grants that apply, the judge's verdict once asked, the autonomy) to
  `allow | deny | ask | judge`, with `by` (rule, grant, judge, owner,
  leg), the grant's scope, the audit line, and whether and on which
  layer it counts toward the stuck rule. Table-tested.
- **`createGate`** (`apps/daemon/src/harness/gate.ts`), one per attempt:
  `decide({source: prompt|hook|mcp, request})`, and `check(command,
  local|server)` for a check's command (synchronous: the verifier's
  refusal; no layer 1, which reads an agent's commands; never asked,
  never counted). It reads the facts (the rules once per action; the
  plan for a removal it names; a `shape:` rule at Careful; the judge),
  writes the audit log, counts blocks, and asks me. `asPermission` and
  `asPreTool` translate its decision for the Leg's prompt and Claude
  Code's hook; `attempt.ts` keeps only those adapters (2,973 → 2,165
  lines, a ceiling in `harness/architecture.test.ts`).
- **Grants** are first-class (`Grant{kind, scope, match, reason, at}`):
  what I let run once is a `once` grant kept in the task's memory until
  it is used (old "allow once" rows are read as grants); "all like this"
  stays with the job (its waivers and `shape:` rules, read by the
  rules); a removal the plan names makes layer 1's own block mine to
  allow, once. Refusals (D8) are kept with the task.
- **The stuck count lives in the Gate**: rules, judge, the Leg's own
  classifier and my refusals in one row. A block that can't be held for
  my answer is a pending stuck question, raised by the Gate at the
  agent's next action (or taken at the turn's end).
- **One `askOwner(kind, item)`** opens every question of an attempt
  (plan change, stuck, approval, what the agent needs, keeps going
  wrong), records it in the task's memory for withdrawal and counts the
  attempt as waiting on me. The hook's deferral to the permission prompt
  is the Gate's own.
- **Changed where paths diverged**, each with its test:
  1. The hook's third block in a row on a file tool reset the row and
     asked nothing; the prompt asked. Now asked at the next action
     (`harness/gate.test.ts`).
  2. A refused call of a job's tool was keyed `tool:null`: one Deny
     refused every later call of that tool, each counted as a gate
     bypass. Keyed by its arguments now (`gate.test.ts`, core).
  3. My refusals didn't count toward the stuck rule. They do, asked at
     the next action (`gate.test.ts`).
  4. A job that ended left its cancelled tasks' memory for ever. Cleared
     when the job completes or is cancelled (`harness/stage2.test.ts`).
  And the rules run once per action: the prompt ran layer 1 twice when
  a once-grant was waiting.
- **Limits**: the hook's "allow" leaves the action to Claude Code's
  classifier and doesn't end the stuck row (an action that ran is only
  seen in its result; stage 3's log); a check's command isn't read by
  layer 1; "all like this" is kept on the job row, not as a grant row;
  the judge's verdict cache and the stuck counts in memory are still
  module-level (keyed per task, cleared with it).

## Consequences
- More files, each small, each with its own tests; the bugs of the last
  two days become cases in a table.
- The attempt log is a new table; the UI's job and session views can read
  it later instead of piecing events together.
- Stage 1 changes behaviour where the old behaviour was a bug (listed in
  the Phase 15 notes as each is fixed).
