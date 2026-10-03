# Silk

**Is:** a job's persistent memory and its only source of continuity
(BR-2). It holds decisions, architecture, progress, issues, handoffs,
facts and interview answers. It lives outside every Leg's session.
**Is not:** a transcript store. Raw Leg output is kept in the event log
for the audit trail and debugging, and is never fed back to a Leg.

## Why

Long sessions waste tokens and degrade. A Leg taking over from another
Leg shouldn't need that Leg's history, and neither should a Leg
continuing its own work after a rotation. Silk makes every session
start clean, with only what it needs.

## What it holds

| Kind | Written by | Example |
| :-- | :-- | :-- |
| `decision` | Eye, Leg, owner | "Use SQLite with WAL; see ADR-002." |
| `architecture` | Eye, Leg | "API routes live in apps/daemon/src/http/routes." |
| `progress` | Eye | "T7 done: login form, verified by `pnpm test auth`." |
| `issue` | Eye, Leg | "Flaky test `sync.spec.ts`; passes on rerun 2/3." |
| `handoff` | Leg (asked by Eye) | The structured summary below. |
| `fact` | Eye, Leg | "Node 24 is installed; pnpm 10." |
| `interview-answer` | owner | The interview's answers, verbatim. |
| `later` | owner (through The Eye) | "Some day, a dark theme." Kept, not acted on, and not in a context pack. Mirrored to `later.md`. |

Entries are short: a title and a body under ~300 words. Longer content
goes into a workspace file, and the entry links to it.

## Handoff

When a session rotates (BR-3), is interrupted, or the task moves to
another Leg, The Eye asks the outgoing Leg for a handoff. If the Leg
can't answer (it crashed, was killed, or is rate-limited), The Eye
builds one from the event log and the git diff, using the cheapest
capable Leg.

```markdown
## Goal of the task
## Done so far        (files touched, commits/checkpoints)
## Current state      (what compiles, what fails, exact errors)
## Next steps         (ordered)
## Open questions
## Traps              (what was tried and did not work)
```

## Context pack

Every session starts with a context pack. The Eye assembles it for the
specific task:

1. The task's instructions, scope and verify commands.
2. The job's goal and the skill's relevant section.
3. The current `decision` and `architecture` entries (not superseded).
4. The latest handoff for this task, if any.
5. `issue` entries touching the task's scope.
6. **From earlier jobs in this project** ([[ADR-034-Projects-First]]):
   the current `decision`, `architecture` and `fact` entries of the
   project's jobs that started before this one, the newest 40; not their
   progress, issues, handoffs or notes for later. An entry this job has
   its own word on (the same title) is left out.
7. A small workspace digest of the files in scope.

The pack has a token cap: by default 15% of the receiving Leg's context
window. If it goes over, the earlier jobs' entries are cut to their
titles first (mine too), then this job's least important and oldest
(entries I wrote in this job stay whole), then the digest is
trimmed. The task itself is never cut. Shortened entries are then
summarised in the background by a cheap Leg, one summary per kind (two
entries or more), stored as a new entry whose `covers` lists the
entries it replaces; they leave the current Silk together. My entries,
handoffs and interview answers are never summarised, and an earlier
job's entries are never summarised into this job's Silk.

## Per project, kept by job

Each job keeps its own Silk (and its own mirror in its worktree). A
project's Silk tab shows its entries grouped by job, newest job first,
the newest open (`silk.byProject`). A decision I add there goes to the
job The Eye talks to now. A new job reads the earlier jobs' standing
entries through its context packs (above), not by copying them.

## Storage and mirror

The database is the source of truth ([[ADR-007-Silk-Storage]]). After
every change, a readable markdown mirror is written to
`.oraknid/silk/` in the workspace:

```
.oraknid/silk/
  README.md          the current summary
  decisions.md
  architecture.md
  progress.md
  issues.md
  facts.md
  handoffs/<task-id>.md
  interview.md
```

Each entry is a `## Title` section followed by a marker
`<!-- silk:<id> by:<author> -->`, so Oraknid can tell which entry a
section is.

Legs can read the mirror like any file. I can read it, and I can
commit it if I want it in the repo's history. If I edit the mirror by
hand, Oraknid notices within 30 s and asks once, in the inbox, whether
to import it. A changed section supersedes its entry, and a new section
becomes a new entry, all marked `owner`. A removed section deletes
nothing: Silk only grows. Until I answer, that file is not rewritten;
if I discard, Oraknid's version is put back. The mirror never changes
the database without my confirmation.

## Editing

In the UI I can add, edit or supersede any entry. Editing writes a new
entry of mine that supersedes the old one. My entries are marked
`owner`, and only I can supersede them.

Related: [[The-Eye]] · [[Budgets-and-Quotas]] · [[ADR-007-Silk-Storage]] · [[Business-Rules]]
