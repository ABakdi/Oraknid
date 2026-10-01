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
  tools: []                     # e.g. [email, calendar, browser] — MCP servers (non-coding phase)
verify:                         # default job-level checks, overridable per project
  - "pnpm -r typecheck"
  - "pnpm -r test"
---
```

Front matter that is missing or invalid doesn't block the upload. The
skill is saved with defaults, and the UI says which fields were ignored
and why.

## Library

- **Built-in:** the canon-driven skill (`docs/skill.md`), shipped as
  the first built-in. More built-ins arrive with non-coding skills.
- **Uploaded:** mine. I can view, edit (in the UI, with preview),
  version and delete them. A job pins the version it started with.
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
