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

### Making a project (2026-10-04, M13.19)

**New project** (Projects) asks two things, in this order, and says
what it will do before it does it:

1. **Its name.**
2. **Where it comes from**, three choices, **New** the default:
   - **New**: Oraknid makes the project's folder, named after the
     project (lower case, dashes; I can change it), **in a folder I
     choose** (the last one I used is offered), and makes it a git repo.
     When GitHub is connected, **Also a new GitHub repo** makes one on
     the account I pick (private unless I say otherwise), clones it
     there and links the project to it ([[ADR-038-Project-Accounts]]).
   - **A folder on this computer**: the folder I choose *is* the
     project, a repo or a folder holding several ([[ADR-042-Several-Repos-And-Servers]]).
     A folder that isn't a repo is asked about, as above.
   - **From GitHub**: with GitHub connected, one of my repos from a
     list I can search (of every account, or one), cloned through the
     account that lists it and linked to the project; or a link, of any
     git host, cloned as it is. Without an account only a link works,
     and only for a public repo: the form says so. The clone goes in a
     folder named after the repo, in a folder I choose.
3. **The sentence**: one line under the form says what will happen,
   with the real paths, before anything does: "Creates
   /home/me/code/piano and makes it a git repo." · "Uses
   /home/me/code/app as the project. Nothing in it changes until a job
   runs, and then only in a worktree." · "Clones ABakdi/piano into
   /home/me/code/piano and links the project to it." While something is
   missing it says what, and **Create project** waits.

Every folder is chosen with **the folder picker** ([[Web-UI]] → The
folder picker), from this computer or from a phone, or typed. The form
is New work's too (Starting work, below): there a folder I have that
isn't a repo is made one without asking. All of it is
`projects.createFrom` ([[API-Contract]]).

### Archiving and deleting a project (2026-10-04, M13.23)

Both are in the project's **…** menu (its header and its card in the
list) and on its Settings tab, each a dialog where I tick what goes.
Before it opens Oraknid reads what they would touch
(`projects.removalPreview`): the folder and its size, the jobs still
going, each repo with its GitHub repo (owned by its account or not,
archived or not, the token's scopes when GitHub says them), and what
deleting the folder would lose.

**Delete** says it can't be undone. What goes:

- **Always**: the project and its jobs leave Oraknid with their history
  (tasks, sessions, Silk, inbox, events, logs). A job still going
  refuses it; the dialog offers to cancel it first.
- **The project folder**, when I tick it: the whole folder, its
  worktrees (`.oraknid/`) and job branches with it, its path and size
  shown. Oraknid refuses a folder that is a symbolic link, the root or
  a top-level folder, my home folder or one holding it, one holding
  Oraknid's own data, and one that holds or sits in another project's
  folder; deleting never follows a symbolic link out (a link is removed
  as a link).
- **Each linked GitHub repo**, when I tick it, deleted on GitHub with
  its account's token, only when that account owns it (its own, or an
  organisation it administers). A token without the `delete_repo`
  permission is refused by GitHub: said plainly, with where to grant it.
- **Typed confirmation**: with a folder or a GitHub repo ticked, I type
  the project's name (the repo's full name when one GitHub repo is all
  that goes) before **Delete** is enabled; with only Oraknid's records,
  the dialog is the confirmation.

The order is GitHub, then the folder, then the records. A step on GitHub
that fails keeps the project and its folder, so I can grant the
permission and try again (a repo already deleted loses its link, so
trying again doesn't ask for it); a folder that can't be deleted keeps
the project too. The result lists every step, done, not done (and why)
or skipped. `project.deleted` (or `project.delete-stopped`) records
what went, never a token.

**Archive** is reversible: the project moves to **Archived projects**
(its own section at the bottom of the list), hidden from New work,
everything kept. Jobs still going are cancelled first if I say so. I may
also tick:

- **Archive the GitHub repo**, for each linked repo its account owns:
  read-only on GitHub (`archived: true`), nothing deleted.
- **Delete the project folder** to free space, offered only when
  nothing would be lost: every repo linked to a GitHub repo that exists,
  no file changed and not committed (in the repo or its worktrees), no
  commit on a branch that isn't on that GitHub repo (compared with its
  branches as GitHub has them), no stash, and in a project of several
  no file outside its repos. Otherwise the option is disabled with each
  reason ("site: commits not on GitHub, on dev (2)."). I type the
  project's name to confirm it.

Each step is said; a GitHub step that fails doesn't stop the rest. The
project records what archiving did (`archivedWith`: the GitHub repos it
archived, whether it deleted the folder), so **Unarchive** knows: it
offers to unarchive those repos on GitHub (ticked), and if the folder
was deleted it clones each repo back from GitHub with its account, to
the same path in the same layout (`apps/web` back in `apps/web`), its
release and work branches made again from GitHub's, saying each repo as
it goes. A clone that fails leaves the project archived, the repos
already back kept, to try again.

## A job's name and description (2026-10-04)

A job is named by what it is, not by the first words I typed ("now you
shoudl take a look and make sure everything is im…" helped nobody):
- **When it's made**, The Eye gives it a **name** (a few words, like a
  commit's subject: "Ship Phase 2 to GitHub") and a **description** (one
  or two sentences: what it's for). A name I typed myself is kept.
  The quick model does it, from the goal and the project; without a
  model, the first line stays until one can.
- **When it ends**, the description becomes **what it did**: what was
  built or changed, where it is (branch, pushed where), what's left to
  me; from The Eye's job summary (ADR-045).
- Both show wherever the job does: Work, Running now, the Inbox, the
  Workflow's boxes, the job's header, notifications; my goal stays as I
  wrote it, under the description. I can rename a job.

**As built (2026-10-04, M13.17):**
- **Stored**: `jobs.named_by` (`me` for a name I typed or gave it,
  `eye`, null while it is its goal's first line), `jobs.description`,
  `jobs.described_as` (`purpose`, `outcome`, `mine`), migration 0035.
  A name I type when making a job sets `me`; The Eye never changes a
  name or description of mine.
- **Naming** (`eye/naming.ts`): listening to the event stream, one call
  at a time, never holding up the job. A job made (from my message, a
  follow-up, New work, a draft, the helper) asks `nameJob` on the quick
  model (ADR-022; three minutes at most): a title of at most 60
  characters, no end punctuation, no markdown, and one or two plain
  sentences. An answer that breaks those rules is sent back once with
  what's wrong, then dropped (the first line stays). A draft's goal
  changed brings its first line back and names it again once I've
  stopped typing for 15 s. Without a model ("No Leg can think…") the
  call waits and is tried again when a Leg is added, changed or healthy
  again, when The Eye's models change, and every 10 minutes.
- **What it did**: when The Eye reports the job done, or stopped or
  blocked with at least one task done (ADR-045), the same call gets that
  report (its summary, facts such as the branch, the merge and the
  pushes, what's left to me) and the tasks done, and the description
  becomes what it did (`outcome`). A job not named yet gets its name in
  the same call.
- **Rename**: `jobs.rename` (name, description or both); an empty
  description clears it. Allowed away from home, like the job's other
  edits (autonomy, priority). Every change publishes `job.named`.
- **Older jobs**: 30 s after the start, each job still named by its
  goal's first line is named (an ended one with what it did, from The
  Eye's last report, else its Silk), five seconds apart, on the quick
  model I chose only (none chosen: they wait for one). A job whose title
  isn't its first line was named by me: marked so, nothing asked.
- **Shown**: Work's rows (two lines), the opened job's header (pencil,
  description, **What I asked** folded), Running now, the Workflow's
  boxes (a line, in full on hover), the Inbox's job line (on hover),
  the command palette (and found by it). Notifications name the job in
  a question's text and add its description to "Done".
- **Tested**: `naming.test.ts` (a job from my message named, then what
  it did from the report; a typed name kept and described; rename, and
  mine kept through the end; no model: the first line, then named once
  a model is back; a draft named again; the backfill on the quick model
  only, ended jobs with what they did, a typed one left), `brain.test.ts`
  (the quick model's call, a markdown answer sent back, the outcome
  prompt, the backfill refused without a quick model), the web's
  `job-heading.test.tsx` (rename, only what changed sent, the folded
  goal, Work's row and the Workflow's box). By hand on a sample daemon
  (fake OS, a scripted Leg, a stand-in brain; its own data folder and
  port) at 1440 px and 390 px: Running now, Work, the header with the
  goal opened, a rename shown live, the Workflow's boxes, the Inbox's
  job line, the palette, and a job made without a model named once one
  came back.

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
| Project | last used | An existing project, or a **new** one, with New project's form (Projects → Making a project): its name, then **New** (a new folder made a git repo, and a **new GitHub repo** too if I ask), **a folder on this computer** (a repo or not; one that isn't is made one), or **from GitHub** (one of my repos, or any public **git URL**, cloned) — [[ADR-023-GitHub-By-Token]]. |
| Skills | the project's | The skills The Eye may use; it picks the one that fits ([[Skills]]). |
| Legs | all healthy Legs | Any subset. |
| Autonomy | Auto | See [[Approvals-and-Autonomy]] ([[ADR-053-Auto-Mode]]). |
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
commit across them. Planning reads the project's own folders. Tasks side
by side (Several jobs, below) work there too: each task gets a folder
of its own with a worktree per repo it touches, from the job branch's
tips, and is merged into every repo it changed, or into none when one
conflicts or its checks fail once merged (then it is redone on top of
the newer work). The job's result lists each repo's branch and commits;
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
| Pause/resume a Leg | No new sessions on that Leg, and each session it runs is paused in place: it stops at a safe point (BR-7: its work kept on a checkpoint, a handoff in Silk), the attempt doesn't count as a failure, and its task waits for that Leg ("It waits for Claude A, paused"), the job still running. Resumed, the task goes on on that Leg from the handoff; **Reassign** on the task sends it to another Leg instead. Other Legs continue. With one task at a time, the job waits with it. |
| Stop a Leg's work in a job | On the job (per Leg working in it) or on a task: that Leg's sessions there end at a safe point (BR-7), their tasks go back to ready and don't use that Leg again in this job (that task). The Leg itself isn't paused; other jobs keep it. When no other Leg can take a task, the job blocks and says so. |
| Redirect | A new instruction for The Eye. It is written to Silk as an `owner` decision, and The Eye replans. |
| Edit the plan | Add, remove, reorder or rewrite tasks in The Web. Running tasks I change are paused first. |
| Take over a task | The task becomes `owner`-held. Oraknid stops touching its scope until I mark it done or hand it back; handed back, it starts with its escalation reset ([[Drift-Control]]). |
| Answer | Inline in the inbox or on the task. |

## Several jobs (Phase 3)

At most the set number of jobs run at once (Settings → Jobs at once,
4 by default). Starting or resuming one past the limit queues it: its
state stays, a badge says it waits, and it starts when a running job
ends, pauses or waits for me. Queued jobs go by priority (high, normal,
low), then by age. A Leg runs its own number of task sessions at once
(3 for Claude Code, 2 for OpenCode and Antigravity, 1 for a local model
server, changeable on its card); a task whose Legs are all busy waits
for one, its job still running ([[ADR-016-Parallel-Work]]).

**Parallel by default** (2026-10-04, [[ADR-050-Parallel-By-Default]]).
Every ready task starts at once whose dependencies are done and whose
scope can't tightly overlap a running task's, while the computer has
room, its Legs have sessions free and I allow it (Settings → Work at
once: *Automatic*, what this computer takes, or a number across all
jobs; a limit for one job is optional). Tasks that could run side by
side each work in a worktree of their own, and each is merged into the
job branch when verified and checked again there; one that conflicts
or fails once merged is redone on top of the newer work. Two tasks that
name the same file, or the same folder two levels down, wait for each
other; tasks that meet only through a broad scope (`src/**`) run side
by side. A plan that is a chain works in the job's own folder, one task
after another. A ready task that waits says why, on its box and in the
job's header ("4 tasks running at once · 2 waiting: waiting for
memory: 2.1 GB free, it may need 2.6 GB"; "Claude busy with 3
sessions"; "overlaps “Write the login page”: both change src/auth").

**The computer comes first.** Before each task starts, Oraknid checks
the machine: memory left after what the task may need (15% kept free),
memory pressure, CPU (no further task above 85%), disk (2 GB free on
the data folder and the project), and a heavy task (a build, an
install, a test suite) never beside another heavy one. While tasks run
it watches for danger: memory nearly gone while swapping, thrashing,
an overloaded CPU, a full disk, the OOM killer, heat, one of its own
sessions running away (memory growing without end, a fork bomb, a CPU
pegged for minutes with nothing said, zombies). In danger nothing new
starts and it pauses its newest or heaviest task at a safe point,
which starts again by itself once there is room; it tells me once per
incident what is happening and what it did, and never touches my own
processes. With **Pause work when the computer is busy with my own
things** on, my own load holds and pauses its work too.

## Ending a job

- **Completed**: job-level verification passed. Oraknid writes a final
  Silk summary, shows the result, notifies me, and offers the work
  branch for review. The job, opened in its project's Work tab, shows **the result**: the worktree
  folder, the job branch and its commits, with a button to open the
  folder and one to merge the branch into the work branch. Merging is
  my action, so pressing it is the approval; a conflict is reported and
  nothing is merged.
- **The repo's part is Oraknid's** (2026-10-03, after the piano job):
  merging the job into the work branch and pushing the work branch to
  the project's linked repo are Oraknid's own steps when the job ends
  (the merge as above; the push with the github tool, ADR-038), never
  tasks for a Leg. A job's folder stays a worktree of the project: a
  command that would re-create, move or delete a `.git`, or write under
  `.git/worktrees`, is refused, never asked; after every session Oraknid
  checks the folder still belongs to the project and puts it right if
  not. Checks that Oraknid runs itself (`oraknid github-…`) are named to
  the Leg as Oraknid's, and a Leg trying to run one is told so, never
  asks me.
  *As built (2026-10-04):* the plan and The Eye's triage carry the
  job's **ending** (`merge`, `push`; the setting `job.ending.<job>`), never
  a task; `merge` only when I asked in so many words ("commit it into
  dev", "merge it", "push dev"), which is then my approval. When the job
  is verified: with a push wanted and no link, The Eye asks for it as
  for a task (ADR-038; the job waits, `verifying` → `waiting` →
  `verifying`); then it merges as the Merge button does (Oraknid's
  action in the events), creates the linked repo if it doesn't exist
  yet and pushes the work branch once the job is in it, else the job's
  branch (each touched repo to its link in a project of several),
  through the github tool's own logic; then the job's `oraknid github-…`
  checks run, against the project's own branches; what failed is said
  in the job's summary as left to me. Asked once the job has ended, it
  is done at once and said in the reply. The folder check is in
  [[Drift-Control]]; the refused commands in [[Approvals-and-Autonomy]].
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
