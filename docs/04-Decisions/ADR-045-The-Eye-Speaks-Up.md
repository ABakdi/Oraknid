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

Related: [[The-Eye]] · [[Approvals-and-Autonomy]] · [[Drift-Control]] · [[ADR-037-Questions-With-Options]] · [[Web-UI]]
