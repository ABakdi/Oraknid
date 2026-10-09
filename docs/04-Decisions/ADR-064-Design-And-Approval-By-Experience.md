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

## As built (M16.2 and M16.4, 2026-10-09)
- **Evaluation nodes** (§1): a task kind `evaluation` with its
  `evaluation` (`design` | `app` | `checkpoint`, `why`, an app's `run`);
  `review` stays an agent's code review. Core's `validateWeb` checks one
  (what it shows, after the work it shows; no scope or verify needed),
  `shapeEvaluations` (called by `shapeWeb`) keeps the kinds the job's
  setting allows and, on a first plan with UI work, adds a design review
  after the design tasks and a final app review, the features built on
  the design depending on its review; `evaluationRules` is what the
  planner is told. A node's own state (round, review, port, when it
  passes by itself, how it ended) is the setting `task.evaluation.<task>`.
- **Running a node** (§1–§3): `eye/evaluations.ts` (`advanceEvaluation`)
  from the job's loop: the review opened once per round through the
  **`ReviewPort`** (`harness/reviews.ts`), the app started for an app
  review (`eye/run-app.ts`: the plan's command, the dev script, the
  README, a static server; in the sandbox on a free port; stopped after),
  the job `waiting` on it when nothing else can go on ("Waiting for your
  review of the design — Open …"), resumed by `review.notes-sent` /
  `review.approved` or its time to pass by itself; notes become tasks
  before the node (keep-notes Silk decisions), then round 2.
- **The seam** to the review page (M16.1): `ReviewPort.open({jobId,
  stepTaskId, projectId, kind, target, round, title}) → {reviewId, url}`,
  `outcome(reviewId)`, `waitForOutcome(reviewId, signal)`; the target is
  `{kind: "folder", path}` or `{kind: "port", port}`; the page's events
  must carry the job's id. The daemon takes a `ReviewPortFactory`
  (`startDaemon({ reviews })`); until the page is wired, `inboxReviews`
  asks in the inbox; tests use `standInReviews`.
- **Settings**: the project's `ProjectWorkSettings` (`evaluations`
  all/some/none with kinds, `autoPassMinutes`, `merge`), API
  `projects.workSettings` / `setWorkSettings`; a job's own
  `jobs.evaluations` / `setEvaluations` (New work's **Reviews**); the chat's
  "add a review after X" / "skip reviews" (`editReviews`, the triage's
  `reviews`, `reviewEditOf`).
- **The ladder** (§7): `route.ts` and `harness/ladder.ts` (ADR-052 §3's note).
- **The end** (§8): `ending.ts` merges by the project's setting (default
  merge) or asks; a failed merge asks; `answerMerge` acts on my answer.
  What was there before: a job merged only when I asked in words, so the
  Keys job's branch stayed unmerged.
- **Limits**: the review page itself, its proxy and overlay are M16.1's;
  until then a review is an inbox question with notes in words. The app is
  found by convention (no monorepo workspace picking); a checkpoint shows
  the app when it runs, else the job's folder. "Add a review after X"
  finds X by its title's words. Merging is a merge commit, as the Merge
  button's (no fast-forward).

## As built (M16.3, 2026-10-09)
- **Skills** (`skills/`): `ui-design.md` (a page per screen and device in
  `design/`, `design/tokens.css`, sample content, the product's own
  controls, `design/index.html`; verify `test -f design/index.html` and
  `oraknid visual-check --target design`), `logo-design.md` (`design/brand/`:
  mark, wordmark, lockup, dark variants, favicon, `palette.css`, a brand
  page; plain SVG), `ux-review.md` (a note's kind, element, device,
  screenshot; keep notes into `design/KEEP.md`; a precise change per
  note; an answer for each). Each has a `## Checks` section. Seeded with
  the others: six built-ins.
- **What the work needs** (`apps/daemon/src/eye/needs.ts`): after the
  method is picked and before the interview, only for a job with no plan
  yet and not a server's own: the brain's `proposeNeeds` (a planning
  call; optional, without it nothing changes) proposes skills from the
  library, tools set up, the project's servers and Legs, each with why,
  and `missingSkills`; names not listed are sent back once. What is new
  to the job becomes one inbox question, **What this job needs**: a
  `multi` question whose options are all ticked (`Question.preselected`,
  new in the contracts and the questions component), a `single`
  question per missing skill (**Make it** recommended, **Go on
  without**), and an **Approve all** button. Applied: the skills kept go
  to the setting `job.needs.<id>` (`skills`, `ui`), tools are added to
  the job, a Leg I untick is left out of `allowedLegIds`, a single server
  becomes the job's server; Silk keeps **What this job uses**. Nothing
  new: no question. The job's own skills reach the plan
  ("This job's other skills", each one's short version) and every task
  (first among the other skills' guidance, ADR-034's mechanism): the
  controller is not changed.
- **Make it**: the brain's `draftSkill` (optional; the canon-driven
  skill as the template, checked to parse with the name asked and a
  `## Checks` section), else a plain template; written to
  `<project>/.oraknid/skills/<name>.md`, then an approval **Add the
  skill "<name>"?** (**Add it to Oraknid's skills** · **Go on without**).
  Added, the file as it is then (my edits kept) is uploaded, joins the
  project's set and the job's skills.
- **Experience** (`eye/experience.ts`, contracts `experience.ts`): a job
  has a UI when the proposal said so, else by core's `hasUi(goal)`. Its
  interview rounds (in the inbox and the draft's conversation) get
  `experience: true` and the prompt asks for, or proposes, the section;
  `InterviewRound.experience` (feel, layouts per device, controls,
  references, criteria) is kept in the setting `job.experience.<id>` and
  in Silk as **Experience** (a new version supersedes the last), with
  what the plan must do: a design first, the criteria in UI tasks'
  acceptance criteria, `oraknid visual-check` among their checks. The
  plan reads it with the other decisions; the plan prompt is unchanged.
- **The visual check** (`apps/daemon/src/harness/visual.ts`,
  `eye/visual-judge.ts`): `oraknid visual-check [--target design|app]
  [--devices …] [--dir design] [--url http://localhost:<port>/]`, answered
  by the Verifier before the server and GitHub checks. Devices: phone
  390×844, phone-landscape, tablet 820×1180, tablet-landscape, laptop
  1366×768, desktop 1440×900; by default the experience's, else phone
  and desktop. A design's `index.html` is rendered at every device, a
  page named for a device (`player.phone.html`) at its own, 12 shots at
  most; an app only at a localhost address. Rendering: playwright-core
  (now a daemon dependency, loaded when first needed) with the system's
  Chromium (`ORAKNID_CHROMIUM`, `/usr/bin/chromium`, Chrome…); none →
  skipped. Screenshots: `<job folder>/.oraknid/visual/<task id>/`
  (`job/` for job-level checks). Seen without a model: a page that
  didn't load, a page wider than the screen. Judged by the brain's
  `judgeVisual` on a Leg model with the new capability **vision**
  (Claude, Gemini and Codex's frontier models by default; set in a
  model's profile), the screenshots named for it to open; else a local
  vision model with the OCR role (`LocalModels.look`); else skipped.
  Without experience criteria, three base criteria. Verdicts per
  criterion; the same pixels and criteria are not judged twice; a skip
  is said once a job. Event `task.visual-check`; The Eye's report kind
  `visual-check` (each criterion, the screenshots, shown on request
  through `jobs.visualShot`).
- **Limits**: whether the plan puts the design task first and a review
  after it is M16.2's; the proposal is asked only through the inbox
  (the draft's conversation still picks one skill); a tool proposed that
  isn't set up is not offered; the judge's screenshots are the visible
  screen, not the full page; the app target needs the app already
  running at its address.

## Consequences
- A UI job takes a little longer to start (the design round) and much
  less time to get right.
- The review page is a new surface: served by the daemon, home only
  (and through the Nest with full rights); the proxy only serves the
  job's own local port.
- Vision-capable models are needed for the visual check; without one
  it is skipped and says so.
