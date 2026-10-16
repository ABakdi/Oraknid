# ADR-072 — Oraknid's own state is never the project's, and never my edit

**Status:** Accepted · 2026-10-16 · amends [[ADR-007-Silk-Storage]], extends [[ADR-067-Self-Recovery]], [[Silk]]

## Context
On 2026-10-16 the inbox asked "Import my edits to Silk (issues.md)?"
seven times on one job. I answered "Discard them" each time and it came
back. I had edited nothing. What the job's folder and its data showed:

1. **The mirror was in the project's history.** The repository's exclude
   file let `.oraknid/silk/` in (`!/.oraknid/silk/`, "which I may
   commit"), so `git add -A` took it: the commits "feat: recover: The
   job's work" and "feat: recover: Merging … into the job's branch" have
   `.oraknid/silk/*.md` and `.oraknid/silk/handoffs/*.md` in them.
2. **The tree was never clean.** Oraknid rewrites the mirror after every
   Silk change, so a task's check `test -z "$(git status --porcelain)"`
   failed on every merge, and on every steward's merge after it
   ("Recovery 1 didn't fix it: … failed on the steward's merge"); each
   merge was taken back with `git reset --hard`, at the exact second of
   each question.
3. **The reset put an older mirror back.** Its hash wasn't the one
   Oraknid wrote last, so its sections were read as my edits: Oraknid's
   own entries ("Changed: Uncertain after a restart: Construct the main
   application routing and viewports", "New: Uncertain after a
   restart", "Changed: Reconciled after a restart: …").
4. **The mirror didn't read back as written.** Those entries' bodies
   begin with a heading of their own (`## Uncertain after a restart`), so
   the reader cut each in two: a "Changed" entry with no body and a
   "New" one.
5. **Discarding settled nothing.** The next merge failed the same check,
   the reset put the same files back, and the same question was asked
   again, each round an agent session spent.

## Decision
**`.oraknid/` is Oraknid's, never the project's: never committed, never
counted by a gate, and what git puts back there is never my edit.**

### 1. Never in a project's history
- The repository's exclude file has `/.oraknid/*` without exception; the
  `!/.oraknid/silk/` line an older version wrote is taken out when
  Oraknid next opens a worktree or starts the job.
- A commit's plan (core `planCommit`) leaves out every path in a
  `.oraknid` folder, tracked or not (`why: "oraknid"`, ignore line
  `.oraknid/`); staging (`stageAll`) unstages a branch's tracked
  `.oraknid/` changes, so a task's commit never carries them; checkpoints
  never did.
- The .gitignore Oraknid writes has `.oraknid/`, and so does every
  extension of one it makes.
- On a job's start or resume, where generated folders are untracked
  (ADR-067 §1), and on a task's branch before its merge, a branch that
  tracks `.oraknid/` stops: `git rm -r --cached` (the files stay on disk;
  Legs read the mirror there as before), `.oraknid/` added to .gitignore,
  one commit Oraknid owns, **"chore: stop tracking Oraknid's own
  files"**, and the job's events carry `job.untracked-oraknid`. It runs
  whatever the hygiene setting says: this is Oraknid's state, not the
  project's care.

### 2. Gates judge the project
The clean-tree check that failed was written by the planner, in the
task's checks. Oraknid doesn't rewrite checks: with its folder ignored
and untracked, `git status --porcelain` no longer counts it, so such a
check judges the project only. The recovery and the steward are told,
in their rules, that `.oraknid/` is Oraknid's, that they never stage,
commit, edit or delete anything in it, and that a clean-tree check
doesn't count it. A `git add` Oraknid runs never names `.oraknid` when a
project ignores it whole (git refuses a pathspec that names an ignored
folder).

### 3. What git put back is not my edit
- **Every version Oraknid wrote is remembered**: `silk_mirror.written`,
  the hashes of the last 50 versions of each file. A file whose content
  is one of them is written again, unasked.
- **A section that says what an entry of Oraknid's says** (title and
  body, the entry current or superseded) is not an edit. My own entries
  are mine: going back to a version of mine I superseded is still an
  edit.
- **After a git operation Oraknid does in the job's folder** (a merge,
  the reset that takes one back, the steward's put-back, the untracking
  commit) the mirror is written again without asking. A difference that
  is no version of Oraknid's and no entry of Oraknid's can't have come
  from git (the mirror is out of git now): it is asked about once, like
  any hand edit, and never overwritten silently (ADR-007).

### 4. The mirror reads back as it was written
Each entry ends with `<!-- /silk:<id> -->` after its body, so a body's
own `## ` headings stay in it: an entry is read between its two markers.
Sections outside them are read by heading as before (my new sections).
An entry written before this (no end marker) whose body a heading cut
in two is put back together when its pieces make its body again.
Titles are one line. A property test renders random entries of every
kind (headings, fences, marker-like comments in their bodies) into
every mirror file and reads back no edit.

### 5. Asked once
An answered question remembers its set of edits (`silk_mirror.answered`,
a hash of the edits whatever their order, the last 50 per file;
`pending_edits` the open question's). The same edits again, put back by
a reset, an undo or a sync tool, are written over without asking,
whether I imported or discarded them. Other edits are asked about.

### 6. Existing jobs heal
- A job's branch that tracks `.oraknid/` is untracked as in §1 the next
  time it starts or resumes.
- On the daemon's start, an open "Import my edits" question whose edits
  are now all Oraknid's (or that I answered before, or whose question
  is no longer open) is withdrawn and its file written again.

## As built (2026-10-16)
- `packages/core/src/harness/commit-plan.ts`: `isOraknidPath`,
  `ORAKNID_DIR`, `planCommit` leaves them out (`why: "oraknid"`).
  `conventions.ts`: `ignoreTemplate` has `.oraknid/`.
- `packages/core/src/silk.ts`: `renderMirror` writes the end marker;
  `parseMirrorEdits` reads entries between their markers, puts a
  pre-072 entry back together, and leaves out Oraknid's own entries.
- `apps/daemon/src/workspace/git.ts`: `excludeOraknid` (no exception,
  the old one taken out), `stageAll` (the branch's tracked `.oraknid/`
  unstaged; `.oraknid/` in an extended .gitignore), `untrackOraknid`,
  `notOraknid` for the checkpoints' pathspec.
- `apps/daemon/src/eye/program.ts`: `keepClean` untracks Oraknid's
  folder first (`stopTrackingOraknid`); `refreshMirror` after a task's
  merge, after a merge taken back, and in the steward's put-back.
  `eye/recovery.ts`: the rule about `.oraknid/`.
- `apps/daemon/src/silk/store.ts`: `written`, `answered`,
  `pendingEdits`; `refreshMirror`, `healMirror` (run on the daemon's
  start for jobs with an open question). Migration 0047 adds the three
  columns; a file's last hash starts its `written`.
- Tests: `silk.test.ts` (daemon) reproduces the loop: a mirror committed
  in a real repository, Silk moves on, `git reset --hard` puts the old
  mirror back: nothing asked, the mirror written as Silk has it; the
  same with a mirror written before this (no end markers, no history);
  a real edit asked once, never again once discarded, other edits
  asked; a pre-072 question withdrawn on start. `recovery.test.ts`: a
  repository whose branch tracks the mirror, two tasks side by side
  each checked with a clean-tree check: the job completes with no
  steward, the branch has "chore: stop tracking Oraknid's own files"
  and no `.oraknid/` file, nothing asked (without §1 it blocks with
  the owner's very words). `hygiene.test.ts`: the untracking commit in
  a real repository, the files kept, `git status` clean after the
  mirror is rewritten; a task's commit never stages a tracked mirror.
  Core: the round-trip property test, the pre-072 entry put back,
  Oraknid's own sections no edit, `.oraknid/` left out of a commit and
  in the ignore template.

## Consequences
- I can't keep Silk in a project's history by committing the mirror any
  more; the database is its home, and the mirror a readable copy in the
  job's folder. A project that wants a record of decisions keeps its own
  docs.
- A project's first job after this makes one more small commit on its
  branch when the branch tracked the mirror.
- The mirror files carry one more comment line per entry.
- An edit I make that happens to say exactly what an entry of Oraknid's
  said is not offered for import: it says nothing new.

Related: [[ADR-007-Silk-Storage]] · [[ADR-067-Self-Recovery]] · [[Silk]] · [[Jobs-and-Projects]] · [[Persistence-and-Recovery]]
