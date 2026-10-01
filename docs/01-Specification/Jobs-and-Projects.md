# Jobs and Projects

**Is:** how I give Oraknid work and follow it from start to finish.
**Is not:** the planning logic (see [[The-Eye]]) or the screens (see [[Web-UI]]).

## Projects

A project is a workspace: an existing folder or repo, or a new empty
folder Oraknid creates. I create a project once, then run many jobs
against it over time. Per-project stats (history, tokens, time, tasks,
failures, breakdown by Leg) roll up from its jobs.

On creation Oraknid:

1. Checks the path exists and is writable. If not, it says so and
   creates nothing.
2. Detects git. If the folder has no repo, it asks whether to `git init`
   it. If I say no, a shadow repo under `.oraknid/shadow.git` is used
   for checkpoints only, and my folder stays untouched.
3. Detects the release and work branches (BR-14).
4. Adds `.oraknid/` to `.git/info/exclude`, except `.oraknid/silk/`,
   which I may choose to commit.

## Creating a job

One form, everything on it:

| Field | Default | Notes |
| :-- | :-- | :-- |
| Project | last used | Or "new project". |
| Goal | — | Required. Free text. |
| Inputs | none | Files, folders, links. Copied or linked into the job's context. |
| Skill | the canon-driven skill | Picked from the [[Skills]] library. |
| Legs | all healthy Legs | Any subset. |
| Autonomy | Standard | See [[Approvals-and-Autonomy]]. |
| Budget | no money; tokens unlimited; time alarm 8 h | See [[Budgets-and-Quotas]]. |
| Verification | from the skill and the project | Commands The Eye runs at the job level. Editable. |

**Start** puts the job in `interviewing` (if the skill asks for one) or
`planning`. While another job is running (MVP, BR-19), the job is queued
and says so.

## Following a job

The job page shows The Web live, the activity stream, Silk, the inbox
items for this job, budgets and their burn, and every problem. See
[[Web-UI]].

## Controls

| Control | Effect |
| :-- | :-- |
| Pause job | Every running task reaches a safe point (BR-7), then the job is `paused`. The UI shows "Pausing…" until then, and names any Leg it is waiting for. |
| Resume job | Continues from the recorded point. Sessions restart from a Silk context pack, using the Leg's native resume when it is still valid. |
| Cancel job | Pauses first, then marks the job `cancelled`. The worktree and checkpoints are kept until I delete them. |
| Pause/resume a Leg | Stops new assignments to that Leg and pauses its running task. Other Legs continue. |
| Redirect | A new instruction for The Eye. It is written to Silk as an `owner` decision, and The Eye replans. |
| Edit the plan | Add, remove, reorder or rewrite tasks in The Web. Running tasks I change are paused first. |
| Take over a task | The task becomes `owner`-held. Oraknid stops touching its scope until I mark it done or hand it back. |
| Answer | Inline in the inbox or on the task. |

## Several jobs (Phase 3)

At most the set number of jobs run at once (Settings → Jobs at once,
2 by default). Starting or resuming one past the limit queues it: its
state stays, a badge says it waits, and it starts when a running job
ends, pauses or waits for me. Queued jobs go by priority (high, normal,
low), then by age. A Leg runs one task session at a time unless I allow
more on its card; a task whose Legs are all busy waits for one, its job
still running ([[ADR-016-Parallel-Work]]).

Inside a job, tasks run one at a time unless I allow more (Settings →
Tasks at once in a job). Then tasks that touch different files run
together, each in a worktree of its own, and each is merged into the
job branch when verified and checked again there; one that conflicts or
fails once merged is redone on top of the newer work.

## Ending a job

- **Completed**: job-level verification passed. Oraknid writes a final
  Silk summary, shows the result, notifies me, and offers the work
  branch for review. The job page shows **the result**: the worktree
  folder, the job branch and its commits, with a button to open the
  folder and one to merge the branch into the work branch. Merging is
  my action, so pressing it is the approval; a conflict is reported and
  nothing is merged.
- **Blocked**: it can't continue. The reason is shown in plain words
  ("All Legs are out of quota until 14:05" / "The tests fail the same
  way after 3 Legs tried"). It resumes on its own when the reason clears
  (a quota reset) or when I act.
- **Cancelled**: by me.

Related: [[Core-Entities]] · [[The-Eye]] · [[Web-UI]] · [[Durability]]
