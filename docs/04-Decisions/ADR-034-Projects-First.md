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

## Changed (2026-10-03): The Web is shown as Workflow
- The tab is named **Workflow** (the canon's word for a job's task graph
  stays The Web; the UI says workflow).
- It is only the diagram, so it fills the whole tab: no header block,
  no side panels, controls floating over it.
- **Compact** (the default): one box per job, in order, the running
  one highlighted. Selecting a job's box goes inside it: that job's
  own workflow, with a way back to the project's.
- **Expanded**: every job's own workflow drawn in full, each in a
  frame named by its job, one after another.
- The choice is kept per project.
- As built (M13.5): the highlighted box is the job the project is about
  now (the newest going, else the newest), the one The Eye talks to; a
  job opened from it is in the address (`/projects/<id>/workflow/<job>`)
  with **All jobs** back; the choice is kept per project on each device
  (the browser's storage); `/projects/<id>/web` opens the new tab. The
  row of earlier jobs and the folding of ADR-034's first Web are gone.

## Changed (2026-10-04): A new project says what it does
If the project is the place, making one must be clear. New project
asked for "a folder" and a typed path: is it the project, where it
goes, a clone? Now (M13.19):
- **The name first, then where it comes from**: **New** (the default:
  a folder Oraknid makes, named after the project, in a folder I
  choose, made a git repo, a new GitHub repo too if I ask), **a folder
  on this computer** (it is the project), or **from GitHub** (one of my
  repos from a list, or a link; a link without an account only for a
  public repo). One form, New project's and New work's.
- **A sentence says what will happen**, with the real paths, before
  anything does.
- **Folders are chosen, not typed**: the daemon lists this computer's
  folders by name (`files.folders`) for a picker that works from a
  phone too; typing a path stays.
- As built: `components/new-project.tsx` (the form, `projectSource`,
  `whatHappens`), `components/folder-picker.tsx`,
  `workspace/folders.ts`; the API was already `projects.createFrom`.
  `files.folders` and `files.makeFolder` are home only for a standard
  device, like `createFrom`.

## Consequences
- Migration: `eye_messages` gains `project_id`, filled from each
  message's job; the project budget is a setting per project.
- The job page's parts move into the project page's Work tab; nothing
  a job could do is lost.
- Pages, specs and the API that named the job page or the Jobs page
  change with it ([[Web-UI]], [[Jobs-and-Projects]], [[The-Eye]],
  [[Silk]], [[Budgets-and-Quotas]]).

Related: [[Jobs-and-Projects]] · [[Web-UI]] · [[The-Eye]] · [[Silk]] · [[Phase-13-Projects-First]]
