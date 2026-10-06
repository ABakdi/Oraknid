# Skills

**Is:** a markdown file describing a methodology. The Eye follows it
to plan and run a job. I upload my own or pick a built-in.
**Is not:** code. A skill can't run anything by itself. It only
shapes plans, prompts and verification.

## Format

Markdown with optional YAML front matter:

```yaml
---
name: canon-driven-development
description: One line, shown in the picker.
interview: true                 # the job opens with an interview
requires:
  tools: []                     # e.g. [email, calendar] — set up in Settings → Tools
verify:                         # default job-level checks, overridable per project
  - "pnpm -r typecheck"
  - "pnpm -r test"
---
```

Front matter that is missing or invalid doesn't block the upload. The
skill is saved with defaults, and the UI says which fields were ignored
and why.

## Skills per project

A project has a **set of skills** (its settings; the canon-driven skill
by default). For each job, The Eye picks the one that fits the goal,
unless I chose one on the New work page; it says which and why in the
job's activity. A task may also get the guidance of another skill of
the set when it fits that task better (a docs task in a code job). A
skill can be added to the set from the project's settings, by picking
from the library or uploading a `.md` file.

## Tools

`requires.tools` names the tools a skill's jobs use. A tool is an MCP
server I set up once in **Settings → Tools**: its command, its secrets
(keychain), which of its calls only read and which send, and whether
what it returns is untrusted ([[ADR-021-Tools-Broker]]). A job gets its
skill's tools when it is created; the job form shows each one, marks
those not set up, and the job can't start until they are.

## Checks for results that aren't code

A task with no verify command (a draft, a summary, research) is
reviewed by The Eye before it is done. A skill can give that review its
own criteria in a `## Checks` section: The Eye applies every one, and
sends back what fails, like a failed check.

## Library

- **Built-in:** the canon-driven skill (`docs/skill.md`, shipped as `skills/canon-driven-development.md` with front matter), as
  the first built-in and the default; `email-triage` (Phase 6): read,
  sort, draft, send what I approve, log, with the email tool;
  `server-work` (2026-10-04, [[ADR-049-Server-Chat-And-Server-Jobs]]):
  a server job's method, no interview: look first, say what will
  change, change carefully (a copy of a configuration before editing
  it, tested before it is loaded), check on the server, list what
  changed.
- **Uploaded:** mine, pasted or from a `.md` file. I can view, edit (in
  the UI, with preview), version and delete them. A job pins the version it started with.
  Editing a skill never changes a running job.

## The interview

Some skills, the canon-driven one first among them, must understand
the goal from me before any autonomous work. When `interview: true`:

1. The job enters `interviewing`.
2. The Eye asks for the first round of questions on its strongest model
   ([[The-Eye]] → The Eye Leg), using the skill's own interview
   guidance, the goal and the inputs.
3. The questions go to the inbox as one **interview round**: only what
   truly blocks planning, at most five, each shaped `single`, `multi`,
   `text` or `confirm`, with options and a recommended one so most can
   be answered with one click ([[ADR-037-Questions-With-Options]]).
   Everything else The Eye decides itself as a sensible default: an
   **assumption**, said in its playback.
4. I answer them one at a time in the UI ([[Web-UI]] → Questions), or in
   the conversation ([[The-Eye]] → Talking while a question is open). My
   answers are stored in Silk as `interview-answer` entries: the
   questions, then my answers as a short list, word for word (and
   typed answers verbatim).
5. The Eye plays back a summary and asks "is this right?". Then it asks
   the next round, until nothing left blocks planning.
6. **A few rounds.** An interview takes at most **3 rounds** by default
   (Settings → The Eye → Interview, 1 to 12; the draft's rounds count).
   When they are used up, one last call writes the playback and what
   it assumes, and asks nothing.
7. **Never the same question twice.** Each round is given every question
   asked before with my answer (a question I left unanswered is left to
   The Eye: it decides and says so), and what is already decided (my
   answers, my instructions, its assumptions). Before a round is
   opened, Oraknid drops any question that means the same as one asked
   before (the same words in other order, a reworded prompt, the same
   telling id like `visual_direction`) or another in the round; a round
   with nothing new left isn't asked, and the interview ends.
8. **I can end it any way, at once:** **Enough, start**; an answer in my
   words like "enough, start", "start now", "that's all"; or the same
   said in the conversation. Planning starts with what is known. A
   question of the round with a recommended answer is assumed with it;
   one without is recorded as an open question.
9. The job moves to `planning`. The playback, with **What I assumed**,
   is kept as "What I want (interview)", and each assumption as a
   decision of The Eye's ("Assumed: …") that I can correct in the
   conversation; open points as open questions.

Notifications tell me when a round is waiting. The interview survives
pause, reboot and crash like every other stage.

## Skills and The Eye

The Eye passes the relevant parts of the skill into planning and into
each context pack, not the whole file every time. For the canon-driven
skill this means the plan follows its cycle: canon → phase → tests →
by-hand check (asked of me as an inbox item when a person is needed) →
checkpoint → audit.

Related: [[The-Eye]] · [[Silk]] · [[Approvals-and-Autonomy]] · [[Web-UI]]
