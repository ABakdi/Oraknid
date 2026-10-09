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

## As built (M16.1, 2026-10-09)
- **Where**: `apps/daemon/src/reviews/` — `service.ts` (the `Reviews`
  service: open, rounds, notes, Send notes, Approve, withdraw, the chat's
  notes), `frame.ts` (the frame's origin: the design served, the app
  proxied, the overlay added), `overlay.ts` (the script in the frame),
  `snapshot.ts` (a page inlined for away from home), `feedback.ts` (does
  a chat message read as feedback); `api/reviews.ts`; the review page
  `apps/web/src/pages/review.tsx` with `lib/review.ts`. Migration
  `0044_reviews.sql`: `reviews`, `review_notes`.
- **The frame's own origin, not a path.** A review's frame is served at
  `http://rv-<key>.localhost:<port>/` — the daemon's port, a name every
  browser resolves to this computer, `<key>` 32 random hex characters
  per review. Decided over `/review/<id>/frame/` (the plan's first
  idea) for two reasons: an app's absolute paths (`/@vite/client`,
  `/src/main.tsx`, `/api/...`) work as they do on its own port, which a
  path prefix breaks; and the pages under review (written by agents)
  run on an origin of their own, so they can't read Oraknid's storage
  (the device token, the unlocked session) nor call its API as me. The
  review page and the frame talk only by `postMessage`. Only the review
  page may frame it (`frame-ancestors`), the key is the only way in, a
  withdrawn review serves nothing, nothing of Oraknid's is served there
  but the overlay (`/__oraknid/overlay.js`).
- **The design**: the folder the harness names (absolute, or relative
  to the job's worktree), inside the project's folder or the job's
  worktree, symlinks resolved — checked when opened and again at every
  request; GET and HEAD only; no `..`, no dot files; a folder gives its
  `index.html`. Its pages' policy: their own files, inline styles and
  scripts, nothing from elsewhere (a design is self-contained).
- **The app**: its port on 127.0.0.1 only, never Oraknid's own nor one
  below 1024; HTTP (Host and Origin rewritten to the app's, gzip,
  deflate or brotli HTML decoded to add the overlay) and websockets (its
  HMR). The app's `X-Frame-Options` is dropped and a `frame-ancestors`
  policy added; its own policy stays. Down, the frame says so and
  retries every 3 s.
- **The overlay** (added first in `<head>` of HTML responses only):
  select mode (hover outlines, a click selects; the app's own clicks
  are held back meanwhile), a selector that finds the element again
  (id, `data-testid`, or a path of `:nth-of-type`), its text, tag and
  box, a picture of the part drawn in the page itself (its styles
  inlined into an SVG, onto a canvas, JPEG; best effort: fonts and CSS
  background images may not show, a failure leaves the note without a
  picture), the pins drawn in the frame on a layer of their own, the
  app's console errors and warnings and failed fetch/XHR (the last 50),
  an app's route changes.
- **Opening a tab**: `review.opened` on `inbox` (with the URL); every
  page of mine listens and one opens `/review/<id>` (`window.open`,
  claimed across tabs in local storage, only within a minute of the
  event). A browser blocks a tab not opened by a click: then a toast
  with **Open**, and the project's page shows "A design is ready for
  your review — Open" above its tabs; the inbox item has **Open the
  review**; the desktop notification (a question, `review-<id>`) opens
  it too.
- **Rounds**: `reviews.open` for the same step (task) after Send notes
  opens the next round of the same review; while it is open, the same
  review comes back (its target updated). A job's end withdraws its
  reviews.
- **The chat**: in `talkInProject`, a message with words about how it
  looks or feels (`readsAsFeedback`), no order to the job, while
  exactly one review is open in the project, becomes a general note
  (`source: "chat"`) and The Eye says so; nothing else of triage
  changed. An answer to the review's inbox item in words is a general
  note too.
- **Away from home**: reading works for any device; notes, Send notes,
  Approve and the frame need full rights (ADR-030). The frame can't load
  from this computer through The Nest, so `reviews.frame` returns the
  page inlined (its stylesheets, scripts and images as data, the
  overlay in it), shown in a sandboxed frame; a link asks for the next
  page. A module script that imports others can't run so: a Vite app
  under development shows its HTML only, said in the page's footer.
- **The API the harness calls** (M16.2): `reviews.open({jobId, taskId?,
  kind, target, entry?, title?})` → `{id, url, round}` (or the service's
  `open` in-process, `EyeDeps.reviews`); then wait for
  `review.notes-sent` (payload `{reviewId, taskId, round, notes}`) or
  `review.approved` on `job:<id>`; `Reviews.notes(id, round?)` reads a
  round's notes whole; `withdraw(id)` when the step is dropped.
