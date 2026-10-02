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

- **Built-in:** the canon-driven skill (`docs/skill.md`), shipped as
  the first built-in and the default; `email-triage` (Phase 6): read,
  sort, draft, send what I approve, log, with the email tool.
- **Uploaded:** mine, pasted or from a `.md` file. I can view, edit (in
  the UI, with preview), version and delete them. A job pins the version it started with.
  Editing a skill never changes a running job.

## The interview

Some skills, the canon-driven one first among them, must understand
the goal from me before any autonomous work. When `interview: true`:

1. The job enters `interviewing`.
2. The Eye asks the Eye Leg for the first round of questions, using the
   skill's own interview guidance, the goal and the inputs.
3. The questions go to the inbox as one **interview round**: a few
   questions, with options and a recommendation where useful (the same
   style as the skill asks for).
4. I answer in the UI. My answers are stored in Silk as
   `interview-answer` entries, verbatim.
5. The Eye plays back a summary and asks "is this right?". Then it asks
   the next round, until the Eye Leg judges every point the skill lists
   as answered or recorded as "decide later".
6. I can end the interview early with **Enough, start**. Open points
   are recorded in Silk as open questions.
7. The job moves to `planning`.

Notifications tell me when a round is waiting. The interview survives
pause, reboot and crash like every other stage.

## Skills and The Eye

The Eye passes the relevant parts of the skill into planning and into
each context pack, not the whole file every time. For the canon-driven
skill this means the plan follows its cycle: canon → phase → tests →
by-hand check (asked of me as an inbox item when a person is needed) →
checkpoint → audit.

Related: [[The-Eye]] · [[Silk]] · [[Approvals-and-Autonomy]] · [[Web-UI]]
