# Skills

A **skill** is a method, written in Markdown: how The Eye should plan a kind of work, what to check before calling it done, and which tools its jobs need. A skill runs nothing by itself; it only shapes plans, prompts and checks.

## The library

**Skills** (`g k`) lists them: the built-ins and yours. Open one to read it rendered; the tools it uses, and whether it interviews you first, are shown on top.

- **Built-in** skills are read-only: the canon-driven method (the default), email triage, and server work. **Make a copy to change** opens one as a new skill of yours.
- **Yours**: **New or upload** takes a `.md` file (drop it on the box, or pick it) or text you paste or write. **Edit** opens it with a preview; every save is a new version, and **Edit from this version** starts from an earlier one. **Delete** removes it with all its versions, after asking.

A job keeps the version of the skill it started with: editing a skill never changes a job already running.

## Writing one

A skill is plain Markdown, with optional front matter on top:

```yaml
---
name: my-method
description: One line, shown in the picker.
interview: true      # The Eye asks you questions before it plans
requires:
  tools: [email]     # set up in Settings → Connections → Tools
verify:
  - "pnpm test"      # the job's checks
---
```

Front matter that is missing or wrong doesn't stop the upload: the skill is saved with the defaults, and the page says which fields were ignored and why. For work that isn't code (a draft, a summary, research), a `## Checks` section lists what The Eye checks before a task counts as done.

## Skills and projects

Each project has its own set of skills (its **Skills** tab), the canon-driven one by default. For each job The Eye picks the skill that fits the goal, unless you chose one in **New work**, and says which and why. Add a skill to a project from the library, or by uploading a `.md` file there.

## Tools

A skill's tools are MCP servers you set up once in **Settings → Connections → Tools**. A job shows each tool its skill needs, marks those not set up yet (with a way to set them up right there), and can't start until they are.
