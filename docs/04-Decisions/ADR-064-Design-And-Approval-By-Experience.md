# ADR-064 — Design and approval by experience

**Status:** Accepted · 2026-10-09 · [[Phase-16-Approval-By-Experience]] · extends [[ADR-034-Projects-First]], [[ADR-052-A-Harness-For-Any-Model]], [[ADR-056-The-Harness]], the canon-driven skill

## Context
The Keys job (2026-10-08) passed every check (154 tests, a clean build)
and still missed what I wanted: a page of stacked sections instead of an
instrument, no phone layout, a sound designer of number fields and
dropdowns instead of knobs I can hear. Nothing in the work ever showed
me the app, nor looked at it; "done" meant the tests passed. The layout
was decided in the last task, in 26 minutes, by whichever model got it.

Coding agents verify code. What they can't verify is whether the result
is what I meant. Oraknid can: it runs on my machine, it can open a page
in front of me, collect what I say about each part, and hand it back to
the agents as work. That is the edge over a bare agent: verification by
the person the work is for, as part of the work.

## Decision

### 1. Evaluation steps are part of the plan
- The planner puts **evaluation steps** into the task graph, decided in
  planning before work starts: for anything I will see or use, at least
  a **design review** (before feature code) and a **final review**; for
  bigger work, a review after each feature the plan names (its own
  judgement, said in the plan with why).
- An evaluation step is a node in the graph: the tasks after it wait
  for it; tasks that don't depend on what it reviews (an audio engine
  under a UI review) go on in parallel.
- In the project's settings (and per job on New work): **all**,
  **some** (I pick), or **none**; I can ask in the chat "add a review
  after the sound designer" or "skip reviews this time", and The Eye
  edits the plan.
- An evaluation step with no notes from me after a time I set (default:
  none, it waits) can be set to pass by itself, for jobs I don't watch.

### 2. The design review: a design I can open, point at and annotate
- The design task makes a **clickable design**: HTML and CSS (no
  backend) of the screens the spec describes, at the devices it names,
  in the project (`design/`), with sample content; for a product with
  a brand it includes the **logo** and the palette.
- Oraknid **opens a new browser tab** on the review page: the design in
  a frame, a **device switcher** (phone, tablet, laptop, desktop, and
  landscape/portrait; custom size), and **select-and-note**: I click any
  part (it is outlined, its element and text captured) and write a note
  marked **keep** ("I like this"), **change** (a suggestion) or
  **problem**; or a general note. Notes show as pins on the design; I
  can edit, delete, and see them per device.
- **Approve** ends the step; **Send notes** ends the round: The Eye
  turns the notes into work (on the design, or on the plan if a note
  changes the scope) and opens the next round when it's ready. "Keep"
  notes are kept as constraints for later tasks.
- The design, once approved, is part of the canon (`design/` and the
  spec's experience section reference it); feature tasks build to it.

### 3. Reviewing the running app the same way
- When the project can run, an evaluation step **runs it** (its dev
  server, in the job's sandbox, on a local port) and opens the review
  page on it, with the same device switcher and select-and-note.
- Oraknid **joins the running app without changing its code**: the
  review page serves the app through Oraknid's own proxy, which adds a
  small overlay script to its pages (select, note, pins, and the app's
  console errors and failed requests captured with each note). Nothing
  is written into the project.
- Notes go back as work exactly as for the design; I can also write in
  the chat ("the knobs are too small on the phone"), and The Eye
  attaches it to the open review.

### 4. Experience in the spec
- The interview and the planner ask for (or propose) an **experience**
  section when the work has a UI: how it should feel, the layout on
  each device, the kinds of controls, references. Acceptance criteria
  include experience criteria, not only tests.

### 5. Looking at its own work
- A built-in **visual check**: render the design or the app headless at
  the devices the spec names, take screenshots, and have a vision-
  capable model judge them against the experience criteria; the
  screenshots go in the task's report. A failing visual check is a
  failing check like any other (ADR-052 §2). It doesn't replace my
  review: it keeps obvious misses from reaching me.

### 6. The Eye picks what the work needs
- From the description, The Eye proposes the job's **skills, tools,
  servers and Legs**: a UI → a design skill; a brand → logo design; a
  deploy → the project's servers; with why, for one approval. When
  Oraknid lacks a skill the work needs, it says so and offers to make
  it (a skill drafted from the canon-driven template) or to go on
  without.
- Built-in skills added: **ui-design** (screens, layout per device,
  controls, a design system), **logo-design** (marks and palette as
  SVG), **ux-review** (how to read and act on my notes).

### 7. The ladder never stalls (from the Keys job)
- A paused or out-of-quota agent is not the top of the ladder: the
  strongest **available** model is, for now; a task never blocks
  waiting for a paused agent. After one failed climb I'm asked once:
  "Claude would help here: unpause it, or go on with Codex?".

### 8. A job ends in my project
- A completed job's branch is merged into the project's work branch (as
  ADR-034's ending says), or I am asked, so the result is in my folder.

## Consequences
- A UI job takes a little longer to start (the design round) and much
  less time to get right.
- The review page is a new surface: served by the daemon, home only
  (and through the Nest with full rights); the proxy only serves the
  job's own local port.
- Vision-capable models are needed for the visual check; without one
  it is skipped and says so.
