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
   it. If I say no, a shadow repo in Oraknid's data folder is used for
   checkpoints only, out of every Leg's reach, and my folder stays
   untouched ([[Sandboxing]]).
3. Detects the release and work branches (BR-14).
4. Adds `.oraknid/` to `.git/info/exclude`, except `.oraknid/silk/`,
   which I may choose to commit.

## Starting work (the New work page, Phase 8)

One page, two sides ([[Phase-8-Daily-Use]]):

**Left, the options:**

| Option | Default | Notes |
| :-- | :-- | :-- |
| Project | last used | An existing project, or a **new** one: an existing folder (a repo or not), a new empty folder (with a new git repo), a **new GitHub repo** (created, then cloned), an **existing GitHub repo** (cloned), or any public **git URL** (cloned) — [[ADR-023-GitHub-By-Token]]. |
| Skills | the project's | The skills The Eye may use; it picks the one that fits ([[Skills]]). |
| Legs | all healthy Legs | Any subset. |
| Autonomy | Standard | See [[Approvals-and-Autonomy]]. |
| Budget | no money; tokens unlimited; time alarm 8 h | See [[Budgets-and-Quotas]]. |
| Inputs, verification | none; from the skill and the project | Inputs: a repo, a folder or documents, each can be marked untrusted. Verification: commands that must pass, on top of the skill's and the project's. |

**Right, the prompt and the conversation:** I write what I want; The
Eye answers in the same place. When the skill interviews, the interview
happens here, round by round, with my answers kept in Silk verbatim
(so the started job doesn't ask again); otherwise what I add is kept as
context. I can go on talking until I'm happy.

**The draft:** the job exists as a `draft` from my first word, saved as
I go. I can leave and come back to it from Jobs, **Start** it (then it
plans, or interviews further if the interview isn't over), or **Delete**
it. A draft costs nothing until it starts, except The Eye's replies.

## Servers

A project's settings list my servers; I tick the ones its jobs may use.
Their jobs get each server's state document and a way in ([[Servers]]).

## This computer's services

A job's sandbox reaches the internet, but none of the services running
on this computer (a local database, a dev server, a model server),
except the ports I list in the project's **Network** tab; a Leg's own
local model, named in its settings, is always reachable by it
([[Sandboxing]]). A change applies to the next sessions.

## Repositories

A project can come from GitHub ([[ADR-023-GitHub-By-Token]]): a new
repo created on my account, or one of mine, cloned into the folder I
choose. The token is mine, in the keychain, used by Oraknid for
creating and cloning, and for a push only when I approve it. Other
remotes (GitLab, any git URL) come last; a public clone URL works
meanwhile.

## Following a job

The job page shows The Web live, the activity stream, Silk, the inbox
items for this job, budgets and their burn, and every problem. See
[[Web-UI]].

## Controls

| Control | Effect |
| :-- | :-- |
| Pause job | Every running task reaches a safe point (BR-7), then the job is `paused`. The UI shows "Pausing…" until then, and names any Leg it is waiting for. |
| Resume job | Continues from the recorded point. Sessions restart from a Silk context pack, never from a Leg's native session (BR-2). |
| Cancel job | Pauses first, then marks the job `cancelled`. The worktree and checkpoints are kept until I delete them. |
| Pause/resume a Leg | Stops new assignments to that Leg; a session it is running goes on to its end (pausing it in place is not built yet, [[Phase-1-MVP]] → Left from the brief). Other Legs continue. |
| Redirect | A new instruction for The Eye. It is written to Silk as an `owner` decision, and The Eye replans. |
| Edit the plan | Add, remove, reorder or rewrite tasks in The Web. Running tasks I change are paused first. |
| Take over a task | The task becomes `owner`-held. Oraknid stops touching its scope until I mark it done or hand it back; handed back, it starts with its escalation reset ([[Drift-Control]]). |
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


### Follow-up jobs (2026-10-03)

A job that has ended stays as it is: its result, branch and merge. New
work I ask The Eye for there ("add volume control", "go on") starts a
**follow-up job** in the same project: the same skill, autonomy, Legs
and budget, its goal my message and the tasks The Eye proposes, its
branch made from the ended job's branch so it continues from what that
built. It starts at once; the conversation links to it. While it runs,
more new work I write to the ended job goes to it, not to a third job.

Related: [[Core-Entities]] · [[The-Eye]] · [[Web-UI]] · [[Durability]]
