# Skills

A **skill** is a method, written in Markdown: how The Eye should plan a kind of work, what to check before calling it done, and which tools its jobs need. A skill runs nothing by itself; it only shapes plans, prompts and checks.

## The library

**Skills** (`g k`) lists them: the built-ins and yours. Open one to read it rendered; the tools it uses, and whether it interviews you first, are shown on top.

- **Built-in** skills are read-only: the canon-driven method (the default), email triage, server work, and three for work you will see: **ui-design** (a clickable design in `design/`, a page per screen and device, with its design system), **logo-design** (logo, palette and favicon as SVG in `design/brand/`) and **ux-review** (acting on your review notes). **Make a copy to change** opens one as a new skill of yours.
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

## What a job needs

Before it plans, The Eye reads your goal and proposes what the job uses besides its method: other skills (a design for an app, a logo for a product with a name), tools, servers and Legs, each with a line of why. It is one question in the inbox, **What this job needs**, everything ticked: **Approve all**, or untick what it shouldn't use. When nothing beyond the method is needed, nothing is asked.

When the work needs a method Oraknid doesn't have, the same question says so: **Make it** drafts one in your project's `.oraknid/skills/` folder, which you can read and edit, then approve to add it to your skills; **Go on without** goes on.

## The experience, and the visual check

For work with a screen, the interview asks how it should feel, its layout on each device, its controls and references, and writes **experience acceptance criteria** (things you can see on a screenshot, on a named device). The plan builds to them, and a task can check them with `oraknid visual-check --target design` (or `--target app --url http://localhost:<port>/`): Oraknid opens the design or the running app in a headless Chromium at each device's size, keeps the screenshots in the job's folder (`.oraknid/visual/`), and has a model that reads images judge them against the criteria. The task's report says each criterion's verdict and shows the screenshots. Without Chromium, or without a model that reads images (a Leg model with the **vision** capability, or a local vision model with the OCR role), the check is skipped and says why.

## Tools

A skill's tools are MCP servers you set up once in **Settings → Connections → Tools**. A job shows each tool its skill needs, marks those not set up yet (with a way to set them up right there), and can't start until they are.
