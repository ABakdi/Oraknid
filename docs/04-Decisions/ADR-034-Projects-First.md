# ADR-034 — The project is the place; jobs are its history

**Status:** Accepted · 2026-10-03

## Context
I think in projects: "add features to the piano" is the same project to
me. But each request became a job with its own page, its own Web, its
own conversation with The Eye and its own Silk, and the Jobs page listed
them again cut another way. Asking for more on the piano project once
did nothing visible: the work went to a follow-up job I wasn't looking
at. The job page looked like a project page, and I couldn't tell why
both existed.

A job is still the right unit underneath: one request has its own
branch, merged when it ends; its own budget, approvals and autonomy;
its own checkpoints, so it rolls back without undoing other work; and
two requests can run side by side, each cancelled alone.

## Decision
The project is where I work; jobs stay as the unit underneath, shown as
the project's history, never as a place of their own.

- **One project page**, in tabs, in the address:
  - **The Eye**: one conversation per project. I ask for work there;
    The Eye answers, starts a job for new work (or adds it to the one
    running, as today), and each reply links the job it touched.
  - **The Web**: the project's tasks across its jobs. The job running
    now is laid out in full; earlier jobs are folded to one node each
    (title, state, tasks done), opened on a click.
  - **Work**: the jobs as a timeline, newest first, with their state,
    branch and cost. Opening one shows it in place: its tasks and
    checks, the result (branch, merge, folder), rollback, its own
    controls (pause, resume, redirect, autonomy, priority, cancel) and
    its settings.
  - **Inbox**, **Silk**, **Activity**, **Budget & stats**, **Settings**,
    and the tabs a project has today (Skills, Servers, Network).
- **No job page.** `/jobs/<id>` and `/jobs/<id>/<tab>` open the job's
  project at Work with that job open, so every link and notification
  keeps working.
- **No Jobs page.** "Running now" (every running and queued job across
  projects, with pause and resume) is a section of the Overview;
  `/jobs` goes there.
- **New work starts in a project.** From a project, its Eye tab is the
  way; New work keeps its form for a first request, a new project or
  a draft, and lands in the project's Eye tab once started.
- **The Eye's conversation per project.** Its messages carry the
  project; the conversation is the project's messages in order, from
  every job. Talking routes as today (the running job, or a follow-up
  job when none runs).
- **Silk per project, kept by job.** The Silk tab shows the project's
  entries grouped by job, newest job first. A new job's context packs
  take the project's standing decisions, facts and architecture from
  earlier jobs, not only from the branch it starts on.
- **A project budget**: an optional limit on tokens and on money across
  all of a project's jobs, and the default budget a new job in it
  starts with. A job that would go past the project's limit pauses and
  asks, like a job's own limit.

## Consequences
- Migration: `eye_messages` gains `project_id`, filled from each
  message's job; the project budget is a setting per project.
- The job page's parts move into the project page's Work tab; nothing
  a job could do is lost.
- Pages, specs and the API that named the job page or the Jobs page
  change with it ([[Web-UI]], [[Jobs-and-Projects]], [[The-Eye]],
  [[Silk]], [[Budgets-and-Quotas]]).

Related: [[Jobs-and-Projects]] · [[Web-UI]] · [[The-Eye]] · [[Silk]] · [[Phase-13-Projects-First]]
