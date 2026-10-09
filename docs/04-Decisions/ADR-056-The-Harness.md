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

## As built (stage 3, 2026-10-07)
The Verifier and the attempt log extracted; code moved, behaviour kept,
except where the check paths diverged (below, a commit and a test each).
- **`createVerifier(deps, job, where)`** (`apps/daemon/src/harness/verifier.ts`),
  built once per job and tree: its sandbox plan, its servers (a check
  `ssh <alias> …` runs on the server over Oraknid's connection, in its
  plain form), Oraknid's own checks (`oraknid github-…`, the repo named
  with `--repo` the same way everywhere), the Gate's refusal of a check's
  command (`checkRefusal`, the Gate's own `check()` outside an attempt),
  the stop signal, the attempt log. `run(checks, {before, why}) →
  CheckReport {passed, results, failures, broken[{command, hint}],
  guards}`: broken is what can't run (syntax, a missing program, ssh
  setup) or a guard failing before the work; a refused check is a
  failure, never broken. Every run is a `ChecksRan` in the log. The five
  call sites use it: the task's turn end, Claude Code's Stop hook, the
  checks tried before the work, the merge's re-check and the job's own
  (its GitHub checks after the ending, each run on its own as before).
  Repairing a broken check stays the attempt's outcome: `repairBroken`
  reads the report's `broken`.
- **The attempt log** (`harness/log.ts`, table `attempt_events`, migration
  0040): `AttemptLog.append(place, kind, data)`, typed per kind;
  `attempt(id, {kinds, limit})` (the last N, in order), `task(id, {kinds,
  afterId, limit})`, `lastOf`, `unmatched`. Kinds: `SessionOpened`,
  `AgentText` (once per turn, not every delta), `ActionRequested`,
  `GateDecision{actionId, source, tool, action, by, verdict, reason,
  scope, counts, endsRow, grant, spent, refusal}`, `ActionResult`,
  `ActionUncertain`, `QuestionAsked`, `QuestionAnswered`,
  `StopRequested`, `ChecksRan`, `Signal{stuck|drift|untrusted}`,
  `Outcome`, `HandoffWritten`, `AttemptEnded`, and `Forgotten` (the task
  settled or its job ended). Deleted with the job. Not fed to the live
  bus (the job's events already carry what the UI shows).
- **Who writes**: the Gate every decision, question, answer, grant,
  refusal and untrusted mark; the attempt (`harness/record.ts`) the
  agent's tool calls, their results and its words at each turn's end,
  the sessions it opens, the Stop hook's requests, drift, the outcome and
  the end; the Verifier each report; the handoff its `HandoffWritten`.
- **The log is the source of truth for what a task remembers**:
  `eye/task-memory.ts` is a view that folds the task's Gate decisions,
  results, signals and questions since its last `Forgotten` (the grants
  given and used, what I refused, the stuck count replayed as it was
  counted, the untrusted mark, the questions open). Read when a Gate
  starts and when the job starts again, never per action; an older
  Oraknid's setting is read first, as where the log goes on from.
- **Handoffs from the log**: every handoff adds what the attempt tried
  (its last actions), what the Gate refused, the last check report and
  what is uncertain, before why it was handed over.
- **Uncertain actions**: a task's next attempt marks each action the one
  before asked for and never saw the result of `ActionUncertain`, says it
  in the job's events (`task.actions-uncertain`) and to the next model
  (the crash's handoff, or a Silk issue); nothing re-runs it. The
  controller reconciles them in stage 5.
- **Moved out of `attempt.ts`**: the checks' runners (the Verifier), the
  servers' setup for a Leg (`servers/for-leg.ts`), the crash's takeover
  (`harness/record.ts`): 2,165 → 2,100 lines with the log wired in, the
  new ceiling. A ratchet: only the Verifier imports a check's runner, and
  `program.ts` runs no check nor reads the policy itself.
- **Changed where paths diverged**, each with its test:
  1. The job's own checks on a server weren't read by the rules (a task's
     were): `ssh <alias> 'npm publish'` ran there. Refused now, as a
     task's is (`harness/stage3.test.ts`).
  2. The merge's and the job's GitHub checks read `--repo <name>`
     another way than the task's: a name the project doesn't have said
     "has no GitHub repo linked". Now the same words everywhere
     (`stage3.test.ts`).
  3. Stage 2's limit: when Claude Code's hook left an action to its own
     classifier and it ran, the stuck row went on, three blocks around it
     asked me. An action's result that says it ran ends the row
     (`harness/gate.test.ts`, live and read back from the log).
- **Limits**: a `GateDecision`'s `actionId` is the Gate's own, not the
  Leg's tool call id (a permission request carries none), so decisions
  and results are paired by order, not by id; the memory's fold reads a
  task's last 5,000 such events; the job's checks outside an attempt
  (merge, job) have no attempt and aren't logged; the log isn't on the
  live bus yet; uncertain actions are recorded and said, not reconciled.

## As built (stage 4, 2026-10-07)
The turn's end taken out of `runAttempt`: gathered, decided once, applied.
Code moved, behaviour kept, except the two changes below (a commit and a
test each).
- **Monitors** (`packages/core/src/harness/monitors.ts`), pure, to
  `Signal{kind: drift|stall|budget|stuck, code, evidence}`: `drift` (D1–D4,
  D7, D8), `stall` (D5), `budget` (D6, and the attempt's turns at their
  limit), `stuck` (OpenHands' patterns over the log's actions, results and
  words: the same action and result 4 times, the same action failing 3
  times, 3 turns of words with no action, two actions taking turns 3
  times). `detect` reads drift, stall and budget as before. An action's
  result keeps a fingerprint of its output (`ActionResult.out`). Each new
  signal is a `Signal` in the attempt log, once until the ladder acts.
- **`decideOutcome`** (`packages/core/src/harness/outcome.ts`), pure:
  `{stop, strayed, unusable, ownerWaiting, guidance, verdict, repair,
  agentNeeds, signals, rung, history, policy, usage} → Outcome`:
  `Done | Continue{why, feedback, rotate?, grant?, nudge?} | Verify |
  RepairChecks | AskOwner{agent-needs | keeps-going-wrong} |
  Retry{same session | new, by me} | Climb{to, failure} |
  Escalate{correct|reset|step-up|reassign|kill} | Unavailable{limit|error}
  | Fail{strayed|error} | OwnerTakes | LeaveOut | CancelJob`. `Verify` and
  `RepairChecks` ask for more facts: the attempt verifies or repairs and
  decides again. My answers are outcomes too (`agentNeedsAnswer`,
  `keepsGoingWrongAnswer`). Its helpers: `unusableOf` (what isn't the
  task's, from the agent's words), `verdictOf` (the checks' first failure
  or The Eye's review, the failure on record for D3 and D4),
  `repairHintOf`.
- **The precedence**, written once (stage 1's order, with stage 4's fix):

  | # | At a turn's end | Outcome |
  | :-- | :-- | :-- |
  | 1 | the job's folder left the project | Fail (counted), put back |
  | 2 | a usage limit | Unavailable |
  | 3 | the agent's error, its words saying it isn't the task's (deprecated, quota, provider) | Unavailable; else Fail |
  | 4 | interrupted | Retry in its session; its turns spent: the ladder (D6) |
  | 5 | my messages to the work | Continue with them |
  | 6 | not verified yet | Verify (its checks, once per turn end, or The Eye's review) |
  | 7 | the first failing check looks broken | RepairChecks |
  | 8 | what the agent says it needs of me, not asked yet (not at its limit of steps) | AskOwner |
  | 9 | security and scope: D7, D8, D1 | the drift ladder (whether the checks pass or not) |
  | 10 | verified | Done |
  | 11 | a real failure, a higher rung (not at its limit of steps) | Climb |
  | 12 | D2–D6, and stuck after a nudge (D2) | the drift ladder |
  | 13 | its turns spent | the ladder (D6) |
  | 14 | otherwise | Continue: the failure back, a nudge once if stuck, rotated when the context is full |

  With no turn's end: waiting on me is no stall; any drift goes to the
  ladder. The ladder's last step asks me ("keeps going wrong").
- **Counting**, written once (`countOf`, `SPENDS_ATTEMPT`, read by `runTask`):

  | End | Recorded | Spends an attempt | Learned of the model |
  | :-- | :-- | :-- | :-- |
  | Done | succeeded | no | yes |
  | Fail, Climb | failed | yes | yes |
  | Escalate's step-up, reassign, kill | reassigned | yes | yes |
  | Unavailable, a session that couldn't start | unavailable | no | no |
  | my "try again" (advice, another Leg) | redirected | no | no |
  | "I'll do it", "Leave it out", "Stop the job" | abandoned | no | no |
  | stopped by its Leg / by me or its job | abandoned | no | yes / no |
- **`EscalationPolicy`** (`packages/core/src/harness/escalation.ts`):
  `next(rung, ranked, held) → route | "top"` (a task I pinned or gave to
  a Leg doesn't climb), `step(level, drift)` (the drift ladder), and
  `stale(attemptNo, task)`: `runTask` drops the result of an attempt
  that isn't the task's latest or was already applied.
- **Applied** (`apps/daemon/src/harness/apply.ts`): `applyOutcome` does
  the side effects — feedback sent, checks repaired, my questions through
  the Gate's `askOwner`, the climb with its handoff, a ladder step, the
  commit, the end (`EndAttempt` with its counted ending). The facts
  (`harness/facts.ts`): `beginTurn`, `factsOf` (the monitors run there).
  `attempt.ts`'s loop is: the turn's end → `beginTurn` → `decideOutcome(
  factsOf(…))` → `applyOutcome`, until it waits for the next turn.
  `runTask` applies an attempt's outcome from a table (`APPLY`).
- **Ratchets**: `attempt.ts` at most 1,420 lines (2,100 before); it
  imports `decideOutcome` and `applyOutcome` and none of the decision's
  parts (detect, the ladder, the agent's words, my answers, the monitors),
  reads no turn's end reason and counts nothing; `program.ts` has no
  switch on an outcome and reads its counting from core.
- **Changed**, each with its test:
  1. Stage 1's gap: D7 and D8 were looked at only when the checks failed;
     a forbidden action or a refused gate tried again, then passing
     checks, was done. Now the ladder first: D7 is corrected in its
     session, D8 kills and rolls back (`harness/stage4.test.ts`; core
     `harness/outcome.test.ts`).
  2. The stuck monitor acts: going round in circles is nudged once, then
     it is D2 on the ladder (`stage4.test.ts`: an agent that only talks;
     `outcome.test.ts`).
- **Limits**: the drift monitor still reads the attempt's observations
  (commands with their output's fingerprint, the checks' failures) kept
  beside the log, not the log alone; stuck runs at a turn's end only (a
  loop inside one long turn is D2's); the repair loop, `tryChecksFirst`
  and the sessions stay in `attempt.ts` until the controller (stage 5);
  my answers are read by core but asked in `apply.ts`.

## As built (stage 5, 2026-10-08)
`runAttempt` is gone: an attempt is the TaskController, its sessions are
opened by the Leg's capabilities, and what a restart left uncertain is
reconciled. Code moved, behaviour kept, except the changes below (a
commit and a test each).
- **`AgentSession` by capability** (`harness/sessions.ts`, the
  SessionManager): opens, resumes, hands off, rotates, closes and stops an
  attempt's sessions for every kind of Leg through the supervisor, from the
  Leg's probed `Capabilities {inlineGate, preToolHook, stopHook, resume,
  steer}` (`@oraknid/leg-sdk`; each adapter's probe reports them; a Leg
  never probed has none). Each one a Leg lacks has its declared fallback:
  no inline gate → what it ran is audited after the fact (the Gate's
  `afterTheFact`: the same rules, never the judge, never asked or counted,
  an `audit` decision in the log) and what the rules refuse or would ask is
  a forbidden action for drift (D7); no pre-tool hook → every prompt is
  Oraknid's (`ask`); no stop hook → the session gets none and the checks
  run after the turn; no resume → a fresh session with a handoff from the
  log; no steer → my messages wait for the turn's end (steer isn't used
  yet). The session's events go to the attempt log, the Gate (results end
  the stuck row; the Leg's own refusals count) and the drift observations.
- **Leg-specific names out of the harness**: tool names (`Bash`,
  `run_command`, the reads) are each adapter's vocabulary in the Leg SDK
  (`tools.ts`: `toolClass`, `asRequest`, `SHELL_TOOL`); the Claude share's
  kind check is the routing layer's provider family (core's
  `providerFamily`); Claude Code's hook bridge stays the Gate's `asPreTool`.
- **The TaskController** (`harness/controller.ts`): `Preparing → Running ⇄
  AwaitingOwner → Verifying → Deciding → {Running | Repairing | HandingOff
  → next attempt | Done | Failed | Cancelled}` (`TRANSITIONS`, `stateOf`:
  the state each outcome leads to). Preparing routes (`harness/route.ts`:
  `pickRoute`, the paused Leg waited for, the busy Leg or machine, why none
  can take it, the next rung), checkpoints, takes over from the attempt
  before and reconciles it, tries the checks (`harness/checks.ts`: the
  Stop hook's run, the repair loop, the checks tried first) and opens the
  session. Running waits for the turn's end; the Gate holding the Leg's
  prompt for my answer is AwaitingOwner. Deciding is stage 4's loop:
  `decideOutcome(factsOf(…))` → `applyOutcome`, which tells the controller
  each outcome it applies (`enter`) — my answers too. Each move is a
  `Transition{from, to, why, key}` in the attempt log, the key
  `attempt:n:state`; Done carries the checkpoint its commit is measured
  from, written before the commit. The rest of the old function went to
  `pack.ts` (the context pack), `tools.ts` (the job's tools through the
  broker), `types.ts`. `eye/attempt.ts` is deleted (1,419 lines); the
  controller is 622.
- **Reconciled** (`harness/reconcile.ts`, §1): as the next attempt
  prepares, each `ActionUncertain` the one before left is looked at, never
  run: a file tool's write by the tree since that attempt's checkpoint
  (happened / didn't); an agent's `git commit` by whether the branch moved;
  a command on a server, or any command whose effect isn't a file, is asked
  of the agent. A `Reconciled` event each, said in the job's events and a
  Silk issue. `decideOutcome` sees what is open (`uncertain`): rule 7b,
  after security and scope, before done or a climb, asks the agent once to
  look without running it again (`Continue{why: reconcile}`); its words at
  that turn's end are the finding.
- **Ratchets** (`harness/architecture.test.ts`): `eye/attempt.ts` gone (or
  a thin export under 150 lines); nothing calls `runAttempt`; the job's
  program runs `runController`; the controller at most 625 lines, importing
  no guard, judge, policy or task-memory module, none of the Gate's names,
  none of the decision's parts (drift, the ladder, the monitors, the
  agent's words, my answers), reading no turn's end reason and counting
  nothing; no Leg kind (`LegKind`'s values) and no agent's tool name (the
  SDK's vocabulary) anywhere under `harness/`, no Leg's kind compared there;
  the sessions read capabilities from the probe.
- **Changed** (a commit and a test each):
  1. A Leg with no inline gate (Antigravity: headless agy runs what its
     settings allow) ran actions Oraknid never read: recorded, never judged.
     Audited after the fact now, and what the rules refuse is D7
     (`harness/stage5.test.ts`, `harness/gate.test.ts`).
  2. Uncertain actions were only said. Reconciled now: the tree looked at,
     the agent asked once to look (`stage5.test.ts`, `reconcile.test.ts`,
     core `outcome.test.ts`). Stage 3's crash test now lets the session
     name the action once, in that question.
  3. Oraknid stopping between its commit and the job's step ran the task
     again on work already committed. The commit is found and the task is
     done (`reconcile.test.ts`).
  And the hooks follow the probe: a Leg whose probe has no pre-tool hook
  runs in `ask` mode, one with no stop hook isn't given one (only Claude
  Code and Codex honoured them before; a Leg whose stored probe predates
  stage 5 is in `ask` mode until its next probe, a minute at most).
- **Limits**: `steer` is declared, not used; the audit after the fact
  reads a tool call's input by the SDK's field names (a call it can't read
  is not audited); the Done reconciliation needs a single repo (a project
  of several repos runs the task again, finds its work and is done); the
  agent's words about a server action are recorded, not parsed; core's
  policy still lists the asks' tool names itself (core doesn't depend on the
  Leg SDK); transitions are steps in the attempt log, not rows of the job's
  step journal (the attempt is one journal step, as before).

## Monitors suspect, a model confirms (2026-10-08)
**Context.** My "keys" job: a scaffold task ran `pnpm install` and
`pnpm build`, and D1 saw `dist/` and `node_modules/` as edits outside
its scope `src/**`. The ladder acted four times on an agent that was
right (correct → reset → reassign → kill and roll back); the rollback
then failed and the job blocked. A hard-coded list of what builds write
fixed that case, but no list covers every tool, and "is this a
by-product of doing the task?" is a judgement, which is what a model is
for. My words: "we hardcode obvious cases for known programming
languages and libraries, then we add an agent to the mix; all of this
should happen seamlessly without the user ever noticing anything wrong."

**Decision.**
1. **Known conventions, hard-coded and broad: the fast path**
   (`packages/core/src/harness/conventions.ts`). A table of what each
   common ecosystem writes by itself: JS/TS (npm, pnpm, yarn, bun; Vite,
   Next, Nuxt, SvelteKit, Astro, Remix, Angular, Turbo, Parcel; Jest,
   Vitest, Playwright reports; Storybook), Python (pip, uv, poetry, venvs,
   caches, pytest, mypy, ruff, wheels, egg-info), Rust, Go, Java/Kotlin
   (Gradle, Maven), .NET, Ruby, PHP, Elixir, Dart/Flutter, Swift, C/C++
   (CMake), Terraform, and for every project coverage, IDE folders and OS
   junk. An ecosystem applies when its marker files are in the project
   (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `*.csproj`…:
   at its top, two folders down, or among the changed files), so a Go
   project's `build/` that isn't Go's output is still its own source.
   What the project's own ignore rules ignore (`git check-ignore
   --no-index`) counts too, and so do the by-products learned before (4).
   Such paths are never a suspicion, and no model is called for them.
2. **Monitors suspect.** The signals of D1–D6 and the stuck patterns are
   *suspicions*: written to the attempt log, never acted on directly.
   D7 (a forbidden action) and D8 (a refused action tried again) stay hard
   rules and act at once (security); so does the attempt's turn limit.
3. **A drift judge confirms** (`EyeBrain.judgeDrift`; core's
   `driftJudgePrompt`). When `decideOutcome` reaches a rule that would act
   on a suspicion not judged yet, it returns `Confirm{signals}`; the
   attempt asks the judge and decides again, so a suspicion that wouldn't
   act (a verified turn's loop, a failure that climbs) costs no call. The
   judge sees the task's goal, title, instructions, kind and scope; the
   suspicion (its code, evidence and paths); what the agent ran,
   condensed; its last message, as data; the project's conventions and
   what was learned. Stage 1, on the quick model, answers `expected` (a
   by-product of doing the task, or legitimate), `drift` (with a reason)
   or `unsure`; `drift` and `unsure` go to stage 2 on the strongest model
   allowed, whose answer stands. Verdicts are cached per task (by the
   suspicion's code and evidence). Only `drift` reaches the ladder.
   `unsure` asks the agent once, in its session, a neutral question ("you
   changed X outside the task's listed scope: is it part of the task?");
   its answer goes to the judge for the final verdict (unsure still: acted
   on gently). A judge that fails or doesn't answer in time (30 s) falls
   back to the old rule at its gentlest: the suspicion is corrected (step
   1) at the level the task stands at, never reset, reassigned or killed.
   With no judge (no brain) the monitors act as before.
   Not a security boundary: the judge reads the agent's words (as JSON
   strings, data), so it could be talked round; what it can let through is
   scope, a loop or a stall, never a forbidden action or a refused one,
   and the checks still judge the work.
4. **Learned, seamless.** The judge names the by-products it saw (globs of
   what tools write by themselves, never files written by hand); each is
   kept for the project (setting `project.byProducts.<project>`) and is
   fast path from then on, for every job of the project. A pattern that
   matches everything (`**`, `*`), climbs out (`..`) or is absolute is
   not kept. Nothing of this is shown to me as a problem: no chat line,
   no inbox item, no notification for a suspicion or an expected verdict;
   only the attempt log (`Judged`, `SuspicionAsked`) and a
   `task.suspicion` line in the job's activity. I hear of drift only when
   a confirmed drift escalates, as before.
5. **Precedence kept.** §6's rules are unchanged; at each rule that acts
   on drift its suspicions are resolved first (judged, or asked of the
   agent), and only the confirmed ones, with D7 and D8, go to the ladder.
   Counting is unchanged: an expected suspicion costs nothing. The D1
   step puts back what is outside the scope minus the same by-products
   (conventions, ignored, learned), never a build's output.

**As built (2026-10-08).** Core: `harness/conventions.ts` (the table,
`ecosystemsOf`, `byProductOf`, `conventionsSaid`; `generatedFile` reads
the whole table), `harness/monitors.ts` (`Observed`'s `ecosystems`,
`ignored`, `learned`; `outsideScope`, what D1 suspects and a D1 step puts
back; D1's signal carries its paths; `isSuspicion`, `signalKey`),
`harness/drift-judge.ts` (`driftJudgePrompt`, `readDriftAnswer`,
`learnable`, `suspicionQuestion`, `condensed`), `harness/outcome.ts`
(`OutcomeInput.confirm`, the `Confirm` outcome, `Continue{why: confirm}`,
`Escalate{gentle}`; the suspicions sifted at rule 7, rule 10, the nudge
and with no turn's end; a hard rule in the same pool acts first). Daemon:
`harness/confirm.ts` (the fast path's facts after each turn: marker files
at the top and two folders down and among the changes, `git check-ignore
--no-index`, the project's learned by-products; the judge's two stages
within one 30 s limit, cached per task and forgotten when it settles; the
agent's answer heard at its next turn's end), `apply.ts` (`Confirm`
applied, the question asked, the D1 put-back), `facts.ts`, the
controller's `Confirm → Deciding`, `eye/brain.ts` (`judgeDrift` on the
quick and the judging model, reading nothing), the attempt log's
`Judged`, `SuspicionAsked`, `SuspicionAnswered`. Tests: core
`conventions.test.ts`, `confirm.test.ts`; daemon `harness/confirm.test.ts`
(Phase 15 → M15.10).
**Limits.** Ignore rules are read in the job's folder alone (a project of
several repos has its conventions and learned by-products only); the
judge sees the commands the attempt observed (shell commands, not file
tools); D1's paths are judged together, one verdict; a learned by-product
stays until its setting is cleared; a stall or a token burn the judge
found expected is judged again when its evidence changes (the minutes, the
tokens), from the task's cache when it is the same.

### The visual check (2026-10-09, [[ADR-064-Design-And-Approval-By-Experience]] §5)
`oraknid visual-check` is one of the Verifier's own checks, like
`oraknid github-…`: answered before the server checks and the sandbox,
with the task it runs for (`VerifierWhere.task`, given by the controller)
so its screenshots go to `.oraknid/visual/<task id>/`. It needs a renderer
and a judge (`VerifierDeps.visual`, the daemon's: headless Chromium and a
model that reads images); without either it passes as **skipped**, saying
why, never a failure. A failing criterion is a failing check with the
signature `visual:<criteria>`, so the ladder and the monitors treat it
like any other.

### The harness's shape (after stage 5)
One attempt is a state machine that decides nothing (`controller.ts`). It
routes through `route.ts`, runs the agent through a session opened by
capability (`sessions.ts`), every action through one Gate (`gate.ts`,
core's `gateStep`), every check through one Verifier (`verifier.ts`,
`checks.ts`), every fact into one attempt log (`log.ts`, `record.ts`,
`reconcile.ts`). At a turn's end the facts are gathered (`facts.ts`, the
monitors), one pure function decides (core's `decideOutcome`, with
counting and the escalation policy), and `apply.ts` does what it says.
`runTask` applies the attempt's result from a table. Policy lives in core
and the Gate; Leg specifics live in the adapters and the Leg SDK.

## Consequences
- More files, each small, each with its own tests; the bugs of the last
  two days become cases in a table.
- The attempt log is a new table; the UI's job and session views can read
  it later instead of piecing events together.
- Stage 1 changes behaviour where the old behaviour was a bug (listed in
  the Phase 15 notes as each is fixed).
