# Drift Control

**Is:** how The Eye notices a Leg going off course and what it does
about it.
**Is not:** verification. Drift is about how a Leg behaves while it
works. Verification judges the result.

## Detectors

Each detector runs on the session's event stream, the workspace diff
and usage samples. Thresholds are defaults, editable in Settings.

| #   | Drift                           | Detected when                                                                                                         | Default threshold                                 |
| :-- | :------------------------------ | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------ |
| D1  | **Out-of-scope edit**           | A changed path is outside the task's `scope` globs.                                                                   | Any file.                                         |
| D2  | **Loop / oscillation**          | The same file region is edited back and forth, or the same command runs with the same result repeatedly.              | 3 repeats in 10 turns.                            |
| D3  | **Repeated failure**            | Verification fails with the same error signature.                                                                     | 3 times.                                          |
| D4  | **Fake progress claim**         | The Leg says "done", "tests pass" or similar, but verification fails, or the claimed command never ran in the stream. | 1 time.                                           |
| D5  | **Stall**                       | No output, no file change and no tool call.                                                                           | 5 min (local: 10 min).                            |
| D6  | **Token burn without progress** | Tokens spent since the last verified progress (a passing verify, a new passing test, a checkpoint) exceed the limit.  | 30% of the task budget, or 150k tokens.           |
| D7  | **Forbidden command**           | A command matches the deny list, or isn't on the allow list.                                                          | Any. Always blocked first, then counted as drift. |
| D8  | **Gate bypass attempt**         | The Leg tries again a gated action I refused (e.g. `git push`).                                                       | Any. Blocked, then escalated straight to step 4.  |

Cheap Legs can help with classification (e.g. "is this message a done
claim?"). The thresholds and the final decision stay deterministic.

## The escalation ladder

Each drift event raises the task's escalation level by one step. A
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

Steps can be skipped when the evidence calls for it (D8 goes straight
to step 4). Every step is an event in the activity stream and the audit
log, with the evidence attached.

## Checkpoints and rollback

- Before each attempt at a task, The Eye records a git checkpoint: a
  commit on a private ref `refs/oraknid/<job>/<task>/<attempt>`, made
  through a temporary index, so my branch, HEAD and index are never
  touched. Oraknid's own `.oraknid/` folder is never in a checkpoint.
- A verified task becomes a commit on the job branch
  (`<kind prefix>: <task title>`).
- Rolling back restores the worktree to a checkpoint. Untracked files
  created since then are moved to `.oraknid/trash/<timestamp>/`, not
  deleted.
- I can roll back any task to any of its checkpoints from the UI.

Related: [[The-Eye]] · [[Silk]] · [[Sandboxing]] · [[Business-Rules]]
