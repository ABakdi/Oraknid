# ADR-045 — The Eye speaks up, and every question says what each answer does

**Status:** Accepted · 2026-10-03

## Context
Running the piano job, The Eye said nothing in the project's
conversation while tasks finished, while the job ended, or when a
request it needed was denied; I learned things from the inbox or not at
all. And when a task "keeps going wrong", the question offered
**Retry · Take it over · Skip it · Cancel the job** with no word on what
each does (what "take it over" hands me, whether "skip" leaves the job
broken, what a denial leads to).

## Decision
- **The Eye reports in the project's conversation, moderately**:
  - a task done: one line (what changed, its checks);
  - a task given up or skipped: one line, and what it means for the job;
  - the job done: a short summary — what was built, where it is
    (branch, commits, the repo it was pushed to), what's left to me
    (merge, a check by hand), with a link to the result;
  - blocked or waiting: why, and what it needs from me, with the
    question there (ADR-037) as well as in the inbox;
  - a request I denied that the task needed: what that means (the task
    will try another way, or can't be done, or the job stops) and what
    I can do instead.
  Never more than one message per event, no narration of every step;
  quiet while things go to plan. Routine approvals stay in the inbox.
- **Every question says what each answer does**, as options with a
  detail line (ADR-037), the recommended one marked. The "keeps going
  wrong" question becomes, in plain words:
  - **Try again with my advice** (a text answer; the Leg gets it),
  - **Give it to another Leg** (which one, if I want to pick),
  - **I'll do it myself** (the task is mine: its folder opens, the job
    waits until I mark it done),
  - **Leave it out** (the task is dropped; the tasks that need it are
    dropped too — they're listed — and the job goes on without them),
  - **Stop the job** (cancels it; work done so far stays on its branch).
- **A denied request** gets its consequence before I deny (the
  approval's detail says what happens if I say no), and after: the Leg
  is told, The Eye says in the conversation what happens next.

## Consequences
- The inbox keeps what needs me; the conversation tells the story.
- The words "take it over", "skip", "cancel" alone disappear from
  questions.

## As built (2026-10-04)
- **The messages** are Eye messages with `action.intent` "report" and a
  report (kind, facts, what's left to me), kept in the `action` column,
  so no migration. `eye/reports.ts` listens to the event stream: a task
  `done` (not one I finished myself), `skipped` (not the ones left out
  with another), `task.folder-restored`, and the job `blocked`,
  `waiting`, `cancelled`, `completed`. A task done names the files its
  commits changed (read from git, `.oraknid/` left out; "changed 4
  files" past three) and up to two checks. The job's summary asks
  `summarizeJob` (the quick model, three minutes at most), falling back
  to "N tasks done: …"; its facts come from the job's result and its
  ending. Waiting posts the open items that have no message yet, an
  item with plain options as a question with them. A denial is said
  where it happens (`attempt.ts`), as is the "keeps going wrong"
  question. Seen in a sample: a job of two tasks says three things.
- **Questions**: `choiceQuestion` makes an item's own options a
  `single` question (`id` "choice") with a detail each; answered through
  it (the inbox or the conversation) the item takes the option itself,
  so the plan approval, budgets, Silk edits, "did it happen?" and mail
  approvals read the same words as before. The Leg's approval adds the
  third answer's detail by what it waives (the gate, or the programs).
  "Keeps going wrong" is three questions (what, my advice, which Leg;
  the last only with another Leg allowed and not paused); its answers
  map to the old outcomes (owner-held, skipped, cancel-job, retry), with
  "Give it to another Leg" adding the Leg to the task's avoided ones and,
  when picked, sending the task to that Leg (`giveToLeg`). "Leave it
  out" skips the dependants (`dependentsOf`, every task that needs it,
  directly or not). Old answers are read as before.
- **The web**: `eye-report.tsx` (the line, the card, the notes),
  `option-choices.tsx` (an approval's buttons with their lines).
- **The repo's part**: see Jobs-and-Projects → Ending a job (As built),
  Approvals-and-Autonomy → Leg permission prompts, Drift-Control → The
  job's folder after every turn.
- **Tested**: `eye.test.ts` (a Leg's `oraknid github-…` answered with no
  inbox item; `.git`-moving commands refused at Full with no inbox item;
  a folder turned into a separate repo found and put back, the work on
  the job's branch; three messages for a job of two tasks; one blocked
  message for the same reason twice; a denial's detail before and its
  message after; "keeps going wrong" with its options, answered in the
  conversation, leaving out the dependant), `questions.test.ts` (the
  options and the mapping, old answers), `brain.test.ts` (no commit,
  merge or push tasks in the prompts; the ending read from a plan and
  from triage; the summary call), `project-links.test.ts` (the link
  asked at the end, the merge into dev and the push of dev to the
  stand-in GitHub's bare repo, the built-in branch check after it, the
  summary card's facts, a push asked once ended done at once),
  `git.test.ts` (the check and both ways of putting back), the policy's
  tests, and the web's (`eye-report.test.tsx`). By hand on a sample
  daemon at desktop width and at 390 px.

Related: [[The-Eye]] · [[Approvals-and-Autonomy]] · [[Drift-Control]] · [[ADR-037-Questions-With-Options]] · [[Web-UI]]
