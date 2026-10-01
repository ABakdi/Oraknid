# Checkpoint 1 — the first real job

Opened 2026-10-01, after the first job run by hand on `dev` (no version
yet): a small web piano, built by Oraknid with the canon-driven skill,
interview to verified completion. The result was good. What it was like
to use it is below. Ships with the end of Phase 1 (`v0.1.0`).

## Bugs

### B1-01 — "It asked me for approval 14 times on a tiny project" (inbox)

**Seen:** 12 permission requests for one small job (plus the two
interview rounds), on `dev` at `caaacfd`. Every one was a harmless
command: a `for` loop over docs, a `sed`, a `node` check, a heredoc
writing `index.html`, a `python3` heredoc editing a markdown file.
**Why:** the command parser split on separators without understanding
the shell. It read the *contents* of heredocs, quoted strings and loops
as commands, so `for`, `do`, `done`, `.read`, `assert.equal` and
hundreds of other words became "programs not on the allow list".
Nothing in the policy was wrong; the parsing was.
**Fix:** a real shell lexer in `packages/core`: quotes, escapes,
heredoc bodies, comments, command substitution (parsed recursively),
reserved words and `for … in …` lists. Then an automatic classifier
for what is still unknown ([[ADR-014-Auto-Approval]]).
**Tests:** the twelve real commands from this job are fixtures: none may
ask. Dangerous ones still do.

### B1-02 — A paused task still said "running"

**Seen:** pausing a real job mid-task (a scratch job, 2026-10-01): the
job was `paused`, its Leg process gone, the attempt `abandoned`, but
the task still showed `running` until the job resumed.
**Why:** only the resume put a cut-short task back to `ready`.
**Fix:** the attempt's stop path sets it to `ready` at once, with the
reason. **Test:** the pause test checks the task's state while paused.

### B1-03 — An attempt cut short by `kill -9` stayed open

**Seen:** after `kill -9` of the daemon mid-task and a restart, the job
completed, with every step done once and its Leg process gone with the
daemon; but the cut-short attempt had no end and no outcome.
**Why:** recovery closed orphaned sessions (`crashed`), not attempts.
**Fix:** recovery closes them as `abandoned`. **Test:** recovery of
orphans.

## Features

| # | What | Where |
| :-- | :-- | :-- |
| F1-1 | **Auto approval**: ask me only about what really needs me; a classifier decides the rest, like Claude Code's auto mode | [[Approvals-and-Autonomy]], [[ADR-014-Auto-Approval]] |
| F1-2 | Filter and search the inbox by project, job, kind and text, for several projects at once | [[Web-UI]] → Inbox |
| F1-3 | See each agent's output and what it is doing, live and afterwards | [[Web-UI]] → Job, Overview |
| F1-4 | **Talk to The Eye**: a prompt per job to instruct it, add tasks or context, stop something or keep a thought for later; The Eye decides what to do with it | [[The-Eye]] → Talking to The Eye |
| F1-5 | Show where a finished job's result is (folder, branch, commits), open it, and merge it into the work branch | [[Jobs-and-Projects]] → Ending a job |

## Where it stands (2026-10-01)

- [x] B1-01 — shell lexer and auto approval
- [x] F1-1 — auto approval
- [x] F1-2 — inbox filters
- [x] F1-3 — agent output
- [x] F1-4 — talking to The Eye
- [x] F1-5 — the result and merging it

All six are on `dev`, each with tests (the twelve real commands, the
classifier's cache and its "ask", inbox filters across two projects,
session logs read from an offset, every kind of message to The Eye and
its fail-safe, merging with a conflict and with a dirty checkout).
Still to do: my hands-on check with a second real job, then
Audit 1 before `v0.1.0`.

- [x] B1-02 — paused task state
- [x] B1-03 — attempts left open by a crash

Related: [[Checkpoints-Home]] · [[Phase-1-MVP]] · [[ADR-014-Auto-Approval]]
