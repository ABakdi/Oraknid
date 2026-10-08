# Drift Control

**Is:** how The Eye notices a Leg going off course and what it does
about it.
**Is not:** verification. Drift is about how a Leg behaves while it
works. Verification judges the result.

## Detectors

Each detector runs on the session's event stream, the workspace diff
and usage samples. Thresholds are defaults, editable in Settings.

| #   | Drift                           | Detected when                                                                                                                                                                               | Default threshold                                 |
| :-- | :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------ |
| D1  | **Out-of-scope edit**           | A changed path is outside the task's scope (its `scope` globs and what its checks name, below).                                                                                             | Any file.                                         |
| D2  | **Loop / oscillation**          | The same file region is edited back and forth, or the same command runs with the same result repeatedly; or the stuck monitor sees it going round in circles again after one nudge (below). | 3 repeats in 10 turns.                            |
| D3  | **Repeated failure**            | Verification fails with the same error signature.                                                                                                                                           | 3 times.                                          |
| D4  | **Fake progress claim**         | The Leg says "done", "tests pass" or similar, but verification fails, or the claimed command never ran in the stream.                                                                       | 1 time.                                           |
| D5  | **Stall**                       | No output, no file change and no tool call.                                                                                                                                                 | 5 min (local: 10 min).                            |
| D6  | **Token burn without progress** | Tokens spent since the last verified progress (a passing verify, a new passing test, a checkpoint) exceed the limit.                                                                        | 30% of the task budget, or 150k tokens.           |
| D7  | **Forbidden command**           | A command matches the deny list, or isn't on the allow list.                                                                                                                                | Any. Always blocked first, then counted as drift. |
| D8  | **Gate bypass attempt**         | The Leg tries again a gated action I refused (e.g. `git push`).                                                                                                                             | Any. Blocked, then escalated straight to step 4.  |

The thresholds stay deterministic; whether what they caught is really
drift is a model's call (below).

**Monitors suspect, a model confirms** ([[ADR-056-The-Harness]],
2026-10-08, after the "keys" job: a scaffold's own `pnpm install` and
`pnpm build` read as edits out of scope, and the ladder corrected, reset,
reassigned and killed a correct agent):

1. **Known conventions first, no model.** What the project's tools write
   by themselves is never a suspicion: a table of each common ecosystem's
   by-products (`packages/core/src/harness/conventions.ts`: JS/TS and
   their bundlers and test runners, Python, Rust, Go, Java/Kotlin, .NET,
   Ruby, PHP, Elixir, Dart/Flutter, Swift, C/C++, Haskell, Zig,
   Terraform, Nix; and for every project caches, IDE folders, OS files),
   each applied when its marker files (`package.json`, `pyproject.toml`,
   `Cargo.toml`, `go.mod`, `*.csproj`…) are in the project or among the
   changed files; what the project's own ignore rules ignore; and the
   by-products learned for the project before.
2. **D1–D6 and the stuck patterns are suspicions.** Written to the
   attempt log, never acted on by themselves. **D7 and D8 are hard
   rules** and act at once, as does the attempt's turn limit.
3. **The drift judge confirms**, only when the decision would act on a
   suspicion: the task (goal, instructions, kind, scope), the suspicion
   and its paths, what the agent ran and its last words, the project's
   conventions. `expected` (a by-product of doing the task, or a change
   it legitimately needs) drops it; `drift` sends it to the ladder below;
   `unsure` asks the agent once, in its session, a neutral question, and
   the judge decides on its answer. Stage 1 on the quick model, stage 2
   on the strongest on drift or unsure; cached per task. A judge that
   fails or takes over 30 s: the suspicion is corrected (step 1), never
   more. No judge at all: the detectors act as before.
4. **Learned.** By-products the judge names (globs of what tools wrote by
   themselves) are kept for the project and are fast path from then on.
5. **Seamless.** Suspicions and expected verdicts are never said to me:
   no chat line, inbox item or notification, only the attempt log and a
   `task.suspicion` line in the job's activity. I hear of drift when a
   confirmed one escalates.

**The detectors are monitors** ([[ADR-056-The-Harness]] stage 4,
2026-10-07): pure functions (`packages/core/src/harness/monitors.ts`)
that return signals — drift (D1–D4, D7, D8), stall (D5), budget (D6 and
the attempt's turns) and stuck — written to the attempt log; they never
act. `decideOutcome` alone acts on them. **Stuck** reads the attempt
log after OpenHands' patterns: the same action with the same result 4
times in a row, the same action failing 3 times in a row, 3 turns that
end in words with no action, two actions taking turns 3 times. Seen at
a turn's end the agent is nudged once (the words go with the failure it
is told); seen again after the nudge, it is D2 on the ladder. Nudge and
ladder steps start the patterns afresh.

**A task's scope** (M13.22, 2026-10-04). What D1 measures against, what
the context pack says the Leg may change, and what a D1 step puts back
are the task's scope taken whole (`taskScope`):

- its `scope` globs, as the plan gave them;
- every relative path its own checks name (`test -s docs/x.md`, an awk
  over a file, `test -f dist/index.js`; quoted patterns, programs,
  options, URLs and paths that climb out with `..` are not paths), read
  again when a check is corrected;
- every file its instructions say it writes ("write the comparison to
  `docs/audio.md`", "create notes/latency.csv");
- `docs/**` for a `research` or `plan` task, whose deliverable is a
  document.

**Oraknid's own files are never out of scope** (M15.1, 2026-10-07,
`oraknidOwn`): its `.oraknid/` folder and the handoff note an agent
leaves when it hands over (`notes/handoff.md`, `handoff.md`,
`handoffs/…`). Seen 2026-10-06: the misahaty job's handoff note was
flagged as an edit outside the scope. Nor is what the project's tools
write by themselves (the known conventions above, its ignore rules,
what was learned for it): a D1 step never puts back a build's output.

What a check reads is what the task must leave behind. Seen 2026-10-04:
a research task whose plan gave it the scope `["research",
"documentation"]` wrote `docs/audio-libraries-recommendation.md`, the
very file its check tested, and D1 flagged it, put it back, reset the
session and reassigned the task.

## The escalation ladder

Each confirmed drift (above: the judge's `drift`, or D7, D8) raises the
task's escalation level by one step; one the judge couldn't judge is
corrected without raising it further. A
step that works (verified progress follows) resets the counter, and so
does a task I took over and hand back: it starts fresh. D1's edits outside
the scope are put back at every step, asking me included, so the next
attempt doesn't start out of scope and trip D1 again (seen 2026-10-03).

| Step | Action |
| :-- | :-- |
| 1. **Corrective prompt** | A short, specific prompt: what was detected, the evidence, the expected behaviour, and the failing check's output when there is one. For D1: the out-of-scope files are put back to the checkpoint first; in-scope work is kept. |
| 2. **Context reset** | End the session with a handoff, then start a fresh session on the same Leg from a new context pack. |
| 3. **Step up or reassign** | Move the task to the next-best candidate: a higher effort or stronger model on the same Leg first, when the drift looks like the task is too hard for it (D3, D4, D6), otherwise another Leg. With the handoff and a Silk `issue` describing the drift. |
| 4. **Kill** | Terminate the Leg's process tree. Roll the task's changes back to its last checkpoint. |
| 5. **Ask me** | Inbox question with the evidence, also asked in the project's conversation, each answer saying what it does ([[ADR-045-The-Eye-Speaks-Up]], The-Eye → Questions that say what each answer does): try again with my advice, give it to another Leg (one may be picked), I'll do it myself, leave it out (with the tasks that need it, listed), stop the job (the work stays on its branch). The task waits. |

**The job's folder after every turn** (after the piano job, 2026-10-03):
when a Leg's turn ends Oraknid checks that the job's folder, and each
repo's worktree in a job of several, still belongs to the project (its
`.git` a link to a worktree record of the project that points back; a
repository made at the top of a several-repo job's folder counts too).
If not, the session is ended, whatever stood in for the `.git` goes to
the project's trash, the link is written again (the record made again,
without a checkout, when git lost it), the index is reset to the job's
branch so the files' content shows as changes, and the attempt fails
with the reason, kept in Silk as an issue and said in the conversation;
the next attempt starts from the files as they were. If it can't be put
back, the job blocks.

**The work ladder comes first** (M15.3, [[ADR-052-A-Harness-For-Any-Model]] §3).
Before this drift ladder, a turn that ends without the work done (its
checks fail, the review says it's wrong) moves the task up a rung of the
model ladder at once, with a handoff, while a stronger model is allowed
(The-Eye → The ladder). The drift ladder above runs on the top rung, and
for drift that isn't a failed result (a loop, a stall, a forbidden
action). A pause, a restart, a quota or a provider's failure is never
counted against the model. One exception to "the work ladder first"
(2026-10-07, [[ADR-056-The-Harness]] stage 1): a forbidden action (D7),
a gate bypass (D8) or edits out of scope (D1) at the same turn's end
are corrected in the same session before any climb, so out-of-scope
edits are never carried up a rung; and since stage 4, before the task
is done: checks that pass don't make a forbidden action or a refused
gate tried again done (D7 is corrected, D8 kills). An interrupted turn is told to go on,
not checked as finished; one stopped at the agent's limit of steps is
checked, its words not taken as a claim.

Steps can be skipped when the evidence calls for it (D8 goes straight
to step 4). Every step is an event in the activity stream and the audit
log, with the evidence attached.

## Checkpoints and rollback

- Before each attempt at a task, The Eye records a git checkpoint: a
  commit on a private ref `refs/oraknid/<job>/<task>/<attempt>`, made
  through a temporary index, so my branch, HEAD and index are never
  touched. Oraknid's own `.oraknid/` folder is never in a checkpoint, and
  neither are installed dependencies and caches (`node_modules/`,
  `.pnpm-store/`, `__pycache__/`, `.venv/`, `.tox/`, `.gradle/`), even
  before the project has a `.gitignore`; Oraknid never commits them
  either. pnpm's store lives in the job's home, not the project
  (2026-10-08).
- A verified task becomes a commit on the job branch
  (`<kind prefix>: <task title>`).
- Rolling back restores the worktree to a checkpoint. Untracked files
  created since then are moved to `.oraknid/trash/<timestamp>/`, not
  deleted. Any number of paths is restored (they go to git on stdin,
  never on a command line); a failure is said in a line, never the
  command's arguments (2026-10-08: a rollback of a scaffold's
  `node_modules` overflowed the command line and its 3 MB error became
  the job's blocked reason).
- I can roll back any task to any of its checkpoints from the UI.

Related: [[The-Eye]] · [[Silk]] · [[Sandboxing]] · [[Business-Rules]]
