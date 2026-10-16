# ADR-067 — Self-recovery: a clean repository, commits that take only what belongs, and a recovery before any block

**Status:** Accepted · 2026-10-11 · extends [[ADR-056-The-Harness]], [[ADR-016-Parallel-Work]], [[ADR-050-Parallel-By-Default]], [[ADR-052-A-Harness-For-Any-Model]], [[ADR-066-Token-Economy]]

## Context
On 2026-10-11 I wrote: "my Keys project is once again blocked for
reasons I don't understand, and this keeps happening; I can't expect
every single problem that might happen; why did The Eye do nothing even
after I told it to fix it?"

The job said:

> "Construct the main application routing and viewports" passed its
> checks alone but couldn't be merged with the other work 9 times: it
> conflicted with work merged meanwhile (). Look at it, then resume.

What really happened, read from the project and the database:

1. **Oraknid committed the dependencies.** The project's first commit,
   7db0e7d ("feat: scaffold the Keys frontend…", 24,382 files, 4.4
   million lines, under my name), was made by Oraknid's own "commit the
   task's verified work" step. The agent only ran `pnpm install`;
   `stageAll` ran `git add -A` over everything on disk. The project had
   no .gitignore, so `node_modules` (24,141 files) and `dist` (46) went
   in. v0.4.4 added a fixed list of folders to the repository's exclude
   file; the blind `add -A` stayed.
2. **A test run rewrote tracked files.** Vite rewrites
   `node_modules/.vite/…` when tests run. Merge-time checks run in
   Oraknid's own checkout of the job branch, so that checkout had local
   changes to tracked files, and `git merge` refused: "Your local changes
   to the following files would be overwritten by merge". That is not a
   conflict, and no file conflicted, hence the empty list "()".
3. **The retries were blind.** A merge that failed was counted and the
   task redone on top; each redo failed the same way; at three the job
   blocked, and each resume added one more, nine in all. Nothing ever
   looked at why.
4. **"Fix it" did nothing.** I wrote "fix the merge conflicts and
   continue". The Eye answered "I'll resolve the merge conflicts and
   resume the work" and added a task, "Fix the merge conflicts blocking
   the app build", which waited behind the stuck task while the job
   stayed blocked: nothing ran it, and nothing said so.
5. **"I couldn't think about it just now (No Leg can think for The Eye
   right now: Claude · … paused …)"**: when I asked what was blocking,
   the chat showed the routing's list of fifteen paused models.

I can't list every failure ahead of time, and neither can Oraknid. Two
things follow: the specific cause is fixed at its root (Oraknid never
commits what doesn't belong, and cleans what it finds), and the general
one is answered by a rule: before a job blocks for anything that isn't
mine to decide, an agent looks at the failure and tries to fix it.

## The principle: the repository steward
**Code alone can never handle git for every kind of project. An agent
is involved whenever there is doubt or a problem.** Git is handled by
one role, the repository steward, in three tiers:

1. **Rules first, fast.** The conventions table and the fixed
   exclusions settle the obvious cases with no model call: what a known
   tool writes, lockfiles, secrets by name, artifacts, sizes.
2. **A light model for every commit the rules don't settle**, not only
   huge ones: an ecosystem the table doesn't know, new top-level
   folders, new kinds of files, binaries, a file over 256 KB, or a commit
   that is unusual (§5). It reads a summary (folders, counts, sizes,
   extensions, the task's goal, the .gitignore) and answers include or
   exclude per folder and the .gitignore lines the project's tools need;
   for a kind of project the table doesn't know, it writes them. What it
   decided is remembered per project (`project.steward.<id>`: by folder,
   and its ignore lines), so the same question is never asked twice.
3. **An agent session for problems.** Every merge that fails, whatever
   git said (a real conflict, local changes it won't overwrite, files in
   the way, a lock, an unfinished merge, checks failing on the merged
   tree), starts a steward session in the job's own tree (§3, §7), with
   git's words, both sides and the tasks' goals; it resolves the
   problem, Oraknid re-runs the checks, and only a verified result is
   kept. Two tries at most, the second a rung higher on the ladder; then
   one plain question for me, with what was tried.

Code never silently gives up and never blindly retries: every git
failure path goes through the steward before a job blocks.

## Decision

### 1. Generated folders a repository tracks are untracked
Each time a job starts or resumes, and on a task's branch before it is
merged, Oraknid lists what the repository tracks (`git ls-files`) and
core's `trackedGenerated` finds the generated folders among them, from
the conventions table (`packages/core/src/harness/conventions.ts`):

- **installed dependencies and caches** (`NEVER_TRACKED`: node_modules,
  .pnpm-store, .next, .vite, .turbo, __pycache__, .venv, .pytest_cache,
  .gradle, .dart_tool, .terraform, .cache, …) always;
- **build output** (`BUILD_OUTPUT`: dist, build, coverage, target, bin
  and obj for .NET, …) only when the repository has no .gitignore of its
  own: some repositories commit theirs on purpose (a GitHub Action's
  `dist/`), and one with an ignore file chose what it tracks.

The project's ecosystems are read from its own files, outside what it
installed (every package in node_modules has a package.json). Found,
they are untracked with `git rm -r --cached` (every file stays on
disk), their lines added to .gitignore, and one commit is made on the
branch: **"chore: stop tracking generated files"**, its body naming the
folders and their file counts. Silk says so ("Stopped tracking generated
files"), and the job's events carry `job.untracked-generated`. It never
stops the work: a failure is an event, and the work goes on. Both sides
of a merge untrack the same folders, so a task's branch made before the
cleanup merges without a conflict.

*Since 2026-10-16 ([[ADR-072-Oraknids-State-Is-Not-My-Edit]]): Oraknid's
own `.oraknid/` folder is untracked at the same moments, first and
whatever the hygiene setting, in a commit of its own ("chore: stop
tracking Oraknid's own files"); a commit's plan never takes it.*

### 2. A merge says git's real reason, and generated files never stop it
`mergeTaskBranch` reads what git said (`readMergeFailure`) and returns
its kind with the files:

| Kind | Git said | In words |
|---|---|---|
| `conflict` | CONFLICT, unmerged files | it conflicted with work merged meanwhile (the files) |
| `local-changes` | Your local changes … would be overwritten | the job's folder had uncommitted changes git won't overwrite (the files); nothing conflicted |
| `untracked` | untracked working tree files would be overwritten | files git doesn't track would be overwritten (the files) |
| `locked` | index.lock: File exists | another git command held the repository's lock |
| `unfinished` | MERGE_HEAD exists | an earlier merge was never finished |
| `not-a-branch` | not something we can merge | the task's branch wasn't there |
| `other` | anything else | git refused to merge: what it said |

Never "conflicted ()". Before merging, Oraknid's own checkout of the job
branch is cleaned of what the project's tools rewrote (`discardGenerated`:
tracked files the conventions explain, put back as the commit has them;
nothing else is touched). When git still refuses over files git won't
overwrite and every one of them is generated, they are restored (or,
untracked, moved to the trash) and the merge is tried once more. Two
tasks that both added to .gitignore are merged by keeping both sides'
lines.

### 3. A recovery before any block
Before a job blocks for anything that is not mine to decide, The Eye
runs a **recovery**. Mine to decide, and never recovered: an approval or
a question waiting for me, a denial, my stop or pause, tasks I took
over, quota or a paused Leg with no model free (the job waits for its
Legs as before), a recovery that already failed, a journal that no
longer matches its program.

A recovery is a task in the job's own tree, run like any attempt
(`runController`): routed as a hard debugging task, so to the strongest
model allowed; every action through the Gate; the attempt log, the
checkpoint and the commit of what it changed as for any task. Its title
starts with "Recover: ", it has no planKey (it is never part of the
plan), and its instructions are the exact failure:

- the step that failed, and the error as it was said;
- `git status` and the last commits of the job's folder;
- the last events of the work that failed (the agent's words, the
  checks, the outcome, the signals, what a commit left out);
- what earlier recoveries found ("try another approach");
- my words, when I asked for it.

Its goal: make it possible for the work to continue without losing
work: diagnose, fix the cause (environment, repository state,
configuration, tooling), verify by doing again what failed. It may
untrack generated folders, restore generated files, move a file aside;
it never switches branches, merges, rebases, pushes or resets. If it
can't fix it, it ends with "FOR THE OWNER:" and the one thing I must
decide or do.

Then Oraknid **does the failed step again**: the merge and its checks
for a merge; for anything else the job's work itself, whose finished
steps replay from the journal and whose failed one runs again. Up to
**two recoveries**, the second told what the first found. Each is a
step of the job, so a pause or a restart neither loses nor repeats one;
each is in Silk ("Recovered", or "Recovery N didn't fix it", with what
it found), and the job's events carry `job.recovery`.

Only then the job blocks, in plain words: what failed, "I tried to fix
it twice and couldn't: first, …; then, …", and the one thing I must do
(the agent's "FOR THE OWNER" line, or: tell me here what should change,
or say "fix it"). A task that had used its attempts gets two more after
a recovery, not a whole new count; my resume gives the whole count back.

### 4. "Fix it" starts a recovery now
On a blocked job, my message "fix it", "unblock", "continue", "resume",
"resolve this", "try again", "go on" (`GO_ON` in talk.ts) needs no
model to understand: the job resumes into a recovery at once, given my
words and the block, and the reply says so plainly ("I'm looking into
what blocked the job now (…): an agent is diagnosing and fixing it in
the job's folder, then the work goes on from where it stopped"). When
the recovery ends, The Eye says in the conversation what it found and
did. A job blocked for its Legs (quota, a paused Leg) is resumed and
waits for them, said so; a queued job says it will recover when it
starts.

**No promise without the work.** A reply may say "I'll …", "I will …",
"Let me …" only when that work runs now: the job is running, or the
message started something (a recovery, a resume, a follow-up job, a
pause, the agents told). Otherwise the reply is replaced by what was
done and what makes it run ("The job is blocked (…), so nothing runs
until it goes on: say “fix it” to start a recovery now, or resume it").
`honestReply` in talk.ts; a test holds it.

### 5. A commit takes only what belongs
The root of the Keys commit: `stageAll` no longer commits whatever is
on disk. It stages what changed, then core's `planCommit` reads the
staged files (new ones with their size; changes and deletions of files
the repository has are always kept) and leaves out:

- **generated files**: what the conventions say a tool writes, in every
  ecosystem (node_modules, dist, .vite, coverage, __pycache__, target,
  …), lockfiles excepted (a project commits them); a build folder the
  repository already tracks keeps taking its new files;
- **build artifacts and archives**: .exe, .dll, .so, .o, .class, .jar,
  .pyc, .whl, .zip, .tar.gz, .dmg, .apk, …;
- **secrets**: `.env` files and the other credential paths the Gate
  knows, keys and certificates by name (.pem, .key, .p12, …), and new
  files whose content the guard's secret patterns match;
- **files too large**: a new file over 2 MB, unless it is a picture, a
  font, sound or video in an assets folder (public, assets, static,
  media, images, fonts, …), within 20 MB for the commit.

What is left out stays on disk and out of the next commit: generated
patterns go to .gitignore, the rest to the repository's own exclude
file. The attempt log has a `CommitFiltered` event (the repo, how many,
in words, the ignore file, the judge), and the task's "Done" entry in
Silk says what was left out and why.

A commit is **unusual** when it would add more than 300 new files, more
than 20 MB, or new top-level folders outside the task's scope. A commit
the rules don't settle (`planCommit`'s `review`: the unusual, a kind of
project the conventions don't know, new top-level folders, new kinds of
files, binaries, a new file over 256 KB) is looked at by the steward's
light model (`judgeCommit`, drift-judge style): it sees the new files by
folder (count, size, extensions; never their content, never the agent's
reasoning), the task's goal and the .gitignore, on a light model first
and the strongest allowed when it can't answer, and answers include or
exclude per folder plus .gitignore lines. A line from a model is taken
only when it is a plain pattern (never a negation, a comment, or one
that ignores everything). Its decisions are remembered per project, so
a folder decided before is never asked about again. Excluded folders
stay on disk. The steward's model never blocks: when it fails, the rules
stand.

### 6. The ignore file
A project with no .gitignore gets one at the first commit Oraknid makes
in it, committed in that same commit: a template from the conventions
of its ecosystems (what their tools write, lockfiles kept), local
secrets (`.env`, `.env.*` except the examples, keys), and the editors'
and operating system's files. An existing .gitignore is extended, never
replaced: generated folders found in the tree that it misses are added
under "# Added by Oraknid", in any spelling it already has them
(`node_modules`, `/node_modules/`, `**/node_modules`). A build folder
the repository tracks is never added. A shadow repo's folder (a project
that isn't a git repository) never gets one.

The agents are told too (the context pack's Git section): Oraknid
commits verified work for you, so don't commit; keep the project's
.gitignore correct; dependencies, build output, caches, .env files and
keys never belong in the repository.

### 7. Retries aren't blind: every failed merge goes to the steward
A task's work that fails to merge, or whose checks fail on the merged
tree, is never redone blindly. The task's branch is kept and the
steward session starts at once, in the job's own tree, given git's
words, both sides (the work merged meanwhile and the task's, their logs
and diff stats) and the task's goal:

- **a conflict**: Oraknid begins the merge (`git merge --no-commit`) and
  leaves the conflicts in place; the agent resolves each file so it
  does what both sides meant, never by dropping one side; a lockfile in
  conflict is never merged by hand: one side is taken, then its package
  manager writes it again (`pnpm install --lockfile-only`, `npm install
  --package-lock-only`, `cargo generate-lockfile`, `uv lock`, …);
- **checks failing once merged**: the merge is begun, uncommitted, and
  the agent fixes what the two sides broke together;
- **anything git refused for the folder's sake** (local changes, files
  in the way, a lock, an unfinished merge): the agent fixes the folder,
  then Oraknid merges again.

The agent's session commits the merge like any task's work. Then
Oraknid checks it: the merge finished, no conflict marker left in the
files it changed, and the checks of this task and of every task merged
before it pass on the merged tree. Anything else is taken back (`git
reset --hard` to before) and the second try, a rung higher on the
ladder and told what the first found, is set up for whatever failed
last (a conflict found once the folder was fixed gets its merge begun).
Two failed tries: the job blocks with one plain question (§3).

Limit: across several repos one merge can't be held open in each, so a
content failure there is redone once on top of the newer work, and a
second goes to the steward, which can fix the folders but not hold the
merge.

### 8. "I can't think" in plain words
When no model can think for The Eye, the reason is said by Leg, with
what to do, never the routing's list of every model: "every agent that
can think is paused or out of quota (Claude is paused). Unpause Claude
on the Legs page, or add a model." In the chat: "I can't think about
this right now: … I kept your message as your decision; the agents will
read it." (`noThinkerSaid` in brain.ts, `cantThinkSaid` in talk.ts.)

## Consequences
- The Keys job resumes, untracks node_modules and dist on its branch in
  one commit, and merges; its later commits never take generated files.
- A failure nobody foresaw gets two looks by the strongest agent
  allowed before I'm asked, and when I'm asked, I'm told what is wrong
  and what was tried, not a counter.
- A recovery costs a session or two of the strongest model. It runs
  only where a block would have been, at most twice per block.
- A repository that commits build output on purpose keeps doing so:
  build output is untracked only without an ignore file, and a tracked
  build folder keeps taking new files.
- Limits: the commit judge sees names and sizes only; a secret with no
  known pattern in a file of an ordinary name can still be committed
  (the Gate's secret rules and my review remain). A recovery runs in the
  job's own folder; one that needs my machine changed (a tool to
  install with my rights) ends with "FOR THE OWNER".
