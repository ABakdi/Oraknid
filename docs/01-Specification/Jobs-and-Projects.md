# Jobs and Projects

**Is:** how I give Oraknid work and follow it from start to finish.
**Is not:** the planning logic (see [[The-Eye]]) or the screens (see [[Web-UI]]).

## Projects

A project is a workspace: an existing folder or repo, or a new empty
folder Oraknid creates. I create a project once, then run many jobs
against it over time. Per-project stats (history, tokens, time, tasks,
failures, breakdown by Leg) roll up from its jobs.

**The project is the place; jobs are its history**
([[ADR-034-Projects-First]], 2026-10-03). I work in a project: I ask its
Eye for work, follow The Web across its jobs (its Workflow tab), and open a job in its
Work tab. A job stays the unit underneath (one request: its own branch,
budget, approvals, autonomy and checkpoints, cancelled alone), but it
has no page of its own and there is no list of jobs apart from their
projects. A project has one conversation with The Eye ([[The-Eye]] →
Talking to The Eye), its Silk kept by job ([[Silk]]) and an optional
budget across its jobs ([[Budgets-and-Quotas]] → A project's budget).

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

In a project I already have, new work starts in its Eye tab: I write
what I want, and The Eye starts a job for it, adds it to the one
running, or starts a follow-up ([[The-Eye]] → Talking to The Eye). The
project's **New work** button opens that tab. The New work page stays
for a first request, a new project, a draft, or options I want to set
before the start; once started, it lands in the project's Eye tab.

One page, two sides ([[Phase-8-Daily-Use]]):

**Left, the options:**

| Option | Default | Notes |
| :-- | :-- | :-- |
| Project | last used | An existing project, or a **new** one: an existing folder (a repo or not), a new empty folder (with a new git repo), a **new GitHub repo** (created, then cloned), an **existing GitHub repo** (cloned), or any public **git URL** (cloned) — [[ADR-023-GitHub-By-Token]]. |
| Skills | the project's | The skills The Eye may use; it picks the one that fits ([[Skills]]). |
| Legs | all healthy Legs | Any subset. |
| Autonomy | Standard | See [[Approvals-and-Autonomy]]. |
| Budget | the project's budget, else no money and tokens unlimited; time alarm 8 h | See [[Budgets-and-Quotas]]. |
| Inputs, verification | none; from the skill and the project | Inputs: a repo, a folder or documents, each can be marked untrusted. Verification: commands that must pass, on top of the skill's and the project's. |

**Right, the prompt and the conversation:** I write what I want; The
Eye answers in the same place. When the skill interviews, the interview
happens here, round by round, its questions answered with options one
at a time ([[ADR-037-Questions-With-Options]]), with my answers kept in Silk verbatim
(so the started job doesn't ask again); otherwise what I add is kept as
context. I can go on talking until I'm happy.

**The draft:** the job exists as a `draft` from my first word, saved as
I go. I can leave and come back to it from New work's list of drafts, **Start** it (then it
plans, or interviews further if the interview isn't over), or **Delete**
it. A draft costs nothing until it starts, except The Eye's replies.

## Servers

A project's settings list my servers; I tick the ones its jobs may use.
Their jobs get each server's state document and a way in ([[Servers]]).
When a task needs a server and the project has none, The Eye gives it
my only one, or asks which, once ([[ADR-038-Project-Accounts]],
[[The-Eye]] → A project's GitHub repo and servers).

## This computer's services

A job's sandbox reaches the internet, but none of the services running
on this computer (a local database, a dev server, a model server),
except the ports I list in the project's **Network** tab; a Leg's own
local model, named in its settings, is always reachable by it
([[Sandboxing]]). A change applies to the next sessions.

## Repositories

A project can come from GitHub ([[ADR-023-GitHub-By-Token]]): a new
repo created on one of my accounts, or one of mine, cloned into the
folder I choose. Other remotes (GitLab, any git URL) come last; a public
clone URL works meanwhile.

**A project's GitHub link** (2026-10-03, [[ADR-038-Project-Accounts]]):
an account (one of my GitHub tokens, each named by its account) and a
repository: owner/name, its visibility, new (Oraknid creates it) or
existing. It's shown and changed in the project's Settings, beside its
servers. A project made from a GitHub repo is linked to it; otherwise
The Eye asks once, when a task first needs GitHub. Oraknid does the
GitHub work itself with the link's account, through its `github` tool:
creating the repo, pushing a branch, opening a pull request, without
asking; pushing anywhere else or rewriting history still asks
([[Approvals-and-Autonomy]] → Linked work). The token never reaches a
Leg.

**Several repos** (2026-10-03, [[ADR-042-Several-Repos-And-Servers]]).
A project is one repo (its folder is the repository) or several: its
folder holds git repositories in its folders (`web/`, `api/`, two folders
down at most, never one inside another, a submodule being its parent's).
A folder that isn't a repo but holds some becomes a project of several
when I add it; a folder that is a repo stays a project of one, and the
repos inside it are added when I ask (the Repo tab's **Find repos in its
folder**, or **Add a repo**: a folder of it that is a repo, a new empty
one made a repo, a clone of one of my GitHub repos or of a git URL); the
project's own repo is then one of them, named after its folder. Each repo
has its name in the project (its folder's last part by default, unique),
its branches (BR-14) and its own GitHub link. A repo can be taken out
of the project; its folder stays. The repos don't change while one of
the project's jobs runs.

**A job across several repos.** The job's folder
(`.oraknid/worktrees/<job>` in the project) mirrors the project's: each
repo the job works in is a worktree on the job branch (one name, the
same in every repo) at that repo's folder, so a task's paths, scope and
checks read as in the project (`web/src/**`, `cd web && npm test`). When
the project's folder is itself one of the repos, the job's folder is its
worktree and the others sit inside it, never part of its commits. A
repo is opened when the plan's tasks or a task about to run name it in
their scope, or when a Leg writes in its folder (what it wrote is kept
and becomes that worktree's). Checkpoints, D1, rollback and a task's
diff are per repo, its paths shown under its folder; a repo opened after
a checkpoint counts from where its worktree started. A task's verified
work is one commit in each repo it changed, each with its own message
(`feat(web): …` and `feat(api): …` when it changed both), never one
commit across them. Planning reads the project's own folders; tasks of
such a job run one at a time (side by side needs a worktree per task per
repo: not built). The job's result lists each repo's branch and commits;
**Merge** computes every repo's merge first and merges each job branch
into its repo's work branch, or none when one conflicts. A project of
one repo works as before.

## Following a job

A job is followed in its project ([[Web-UI]] → Projects): The Web live (the Workflow tab: a box per job, or every job framed)
across the project's jobs, and the job opened in the Work tab with its
tasks, result, agents' output, activity, Silk, inbox items, budget and
its burn, settings and every problem. What runs now, across projects,
is on the Overview. An old `/jobs/<id>` link opens the job there.

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
  branch for review. The job, opened in its project's Work tab, shows **the result**: the worktree
  folder, the job branch and its commits, with a button to open the
  folder and one to merge the branch into the work branch. Merging is
  my action, so pressing it is the approval; a conflict is reported and
  nothing is merged.
- **Blocked**: it can't continue. The reason is shown in plain words
  ("All Legs are out of quota until 14:05" / "The tests fail the same
  way after 3 Legs tried"). It resumes on its own when the reason clears
  (a quota reset) or when I act. A task that failed eight attempts
  blocks its job ("Look at it, then resume"); resuming it gives its tasks
  eight more, counted from then (they used to count from the start, so
  the job blocked again at once, 2026-10-03).
- **Cancelled**: by me.


### Follow-up jobs (2026-10-03)

A job that has ended stays as it is: its result, branch and merge. New
work I ask The Eye for there ("add volume control", "go on") starts a
**follow-up job** in the same project: the same skill, autonomy, Legs
and budget, its goal my message and the tasks The Eye proposes, its
branch made from the ended job's branch so it continues from what that
built. It starts at once; the conversation links to it. While it runs,
more new work I write to the ended job goes to it, not to a third job.
Since the project's Eye tab talks to its newest job (ADR-034), "more
on the piano" from the project goes to the running follow-up on its
own, and to a new follow-up once that one has ended.

Related: [[Core-Entities]] · [[The-Eye]] · [[Web-UI]] · [[Durability]]
