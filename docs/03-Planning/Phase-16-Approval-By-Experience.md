# Phase 16 — Design and approval by experience

Touches [[The-Eye]], [[Jobs-and-Projects]], [[Web-UI]], [[Skills]],
[[ADR-064-Design-And-Approval-By-Experience]]. Written 2026-10-09.

## Why
The Keys job passed every test and missed what I meant (ADR-064 →
Context). Verification by the person the work is for, inside the work.

## Milestones

### M16.1 — The review page
- [x] A review opens in a new browser tab: the design or the running app in a frame, a device switcher (presets, orientation, custom size)
  Tested: daemon `reviews/reviews.test.ts` → `reviews.open` makes the review, its inbox item (`reviewId`) and `review.opened` on `inbox` with `/review/<id>`; the frame URL is `http://rv-<key>.localhost:<port>/`; opened again while open it is the same review. Web `lib/review.test.tsx` → the presets, turning, a custom size within 120–8000, fit never above 100%; `review.opened` opens one tab (`window.open`, once across tabs), a blocked tab gets a toast with Open, a replayed old event opens nothing. `pages/review.test.tsx` → the frame on the review's own origin, sandboxed without top navigation, 1440×900 then Phone 390×844, turned 844×390, a custom 1000×700. `scripts/review-check.mjs` (headless Chromium against `apps/daemon/scripts/review-daemon.ts`, its own folder and port) at 1440 and 390 px: the frame on its rv- origin, the design and the overlay in it, no sideways scroll.
- [x] Select-and-note: click a part, outline, capture element and text, write keep / change / problem; general notes; pins per device; edit and delete
  Tested: `pages/review.test.tsx` → Select turns select mode on in the frame; the overlay's selection opens the composer naming `<div> Cutoff`; Keep and my words save a note with the selector, tag, device, page and picture; the overlay is sent this device's pins, numbered as listed; a pin clicked marks its note; a note of another device switches to it. `lib/review.test.tsx` → pins only for this round, device and page; notes grouped by device, general ones last. `review-check.mjs` → a real click on the design's button at 1440 and 390 px: the composer says `<button> Play` with a picture, Problem and Save make the note, its pin is drawn in the frame, the note is listed (a bottom sheet on the phone). Daemon: add (with a screenshot under `<data>/reviews/<id>/`), edit, delete (its file goes), `review.note-*` events.
- [x] Approve and Send notes; rounds; notes stored per review with their device, element and screenshot
  Tested: `reviews.test.ts` → Send notes ends round 1 with `review.notes-sent` on the job's topic carrying the notes ("Phone 390×844"), the inbox item withdrawn; the ended round's notes can't change; `reviews.open` again opens round 2 (no notes yet, Send refused); Approve makes `review.approved`; an approved review stays approved; a job's end withdraws its reviews. `pages/review.test.tsx` → Send notes (n), Approve at once with only keep-notes, asked first with others; an ended round can't be noted, sent or approved. Away from home (ADR-030): reading works, notes, Approve and the frame need full rights; the frame comes inlined.
- [x] The running app through Oraknid's proxy with an injected overlay (console errors and failed requests captured with a note); nothing written into the project
  Tested: `reviews.test.ts` → the design served read-only (POST 405), the overlay first in `<head>` of HTML only (CSS as it is), nothing outside its folder (`..` plain or encoded, dot files, a symlink out, `\`), another key or port nothing, withdrawn nothing, the API never on a review's origin; the app proxied to its port only (an absolute-form request naming another port still reaches the app's), Host and Origin rewritten, `X-Frame-Options` dropped and `frame-ancestors` added, gzip HTML decoded and injected, JSON untouched, its websocket (HMR) through; the app down: a page that says so and retries. Oraknid's own port and ports below 1024 refused. `review-check.mjs` → the stand-in app's `console.error` and failed fetch counted on the page. The feedback in the chat: "The knobs are too small on the phone" in the project's chat with one review open is a general note from the chat, and The Eye says so.

### M16.2 — Evaluation steps in the plan
- [x] The planner adds design and final reviews for work I'll see, and reviews after features when worth it, with why
- [x] Review nodes in the graph: dependants wait, independent work goes on
- [x] Project settings and New work: all / some / none; "add a review after X" and "skip reviews" in the chat edit the plan
- [x] Notes become tasks; keep-notes become constraints; the next round opens by itself

*Tested:* core `evaluations.test.ts` (a node validated; dependants wait,
independent work goes on; reviews added for UI work and not for a pure
backend; none and some honoured; never a crumb); daemon
`eye/evaluations.test.ts` with the scripted brain and Leg and the
stand-in ReviewPort (a design review: notes, a task, round 2, approval,
then the features; settings none adds none; a review passing by itself;
an app review starts the dev server on a free port and stops it after;
the dev command found; "skip reviews" while waiting; "add a review after
the keyboard"). The review page itself is M16.1's, and the daemon's
default port since (`reviews/port.test.ts`: a design review opened by the
program on the page, a note added and sent through the API, the notes'
task with the note's device and element in its prompt, round 2 on the
same review, Approve, the features, the job completed).

### M16.3 — Designs, skills and the visual check
- [x] The design task: clickable HTML/CSS of the screens per device in `design/`, logo and palette when there's a brand
  Tested: core `skills.test.ts` (ui-design and logo-design parse with no field ignored, their checks: a page per screen and device, `design/tokens.css`, plain SVG, light and dark); `needs.test.ts`: approved, they reach the plan as "This job's other skills" (ui-design, logo-design) and each task as another skill's guidance. Where the design task sits in the graph (a design review before feature code) is M16.2's.
- [x] Built-in skills ui-design, logo-design, ux-review; The Eye proposes skills, tools, servers and Legs from the description for one approval, and offers to make a missing skill
  Tested: `needs.test.ts` with a scripted brain: the piano spec → canon-driven (the method) + ui-design + logo-design proposed as one inbox question, ticked, each with why; Approve all → the job has both, "What this job uses" in Silk, the job completes; unticking logo-design leaves it out; a missing level-design skill → Make it → the draft written to `.oraknid/skills/level-design.md`, an approval; my edit to the file kept; added to Oraknid's skills, the project's set and the job; Go on without drafts nothing; a job that needs only its method is asked nothing. `brain.test.ts`: a proposal naming a skill not in the library is sent back once. `layer2.test.ts`: six built-ins seeded.
- [x] An experience section asked for in the interview; experience acceptance criteria
  Tested: core `experience.test.ts` (`hasUi`: a piano, a dashboard, a landing page, a logo yes; a REST endpoint, a cron script, fail2ban, a migration no); contracts `experience.test.ts`; `needs.test.ts`: the piano's interview is asked for the experience, its section kept on the job (`job.experience.<id>`) and in Silk as "Experience" with its criteria and the visual check to use, read by the plan; a backend job is asked none and keeps none even if a round gives one.
- [x] The visual check: headless screenshots per device, judged by a vision model against the experience criteria, shown in the report
  Tested: `visual.test.ts` with a stand-in renderer and judge: passes on every criterion (screenshots in `.oraknid/visual/<task>/`, an event with them), the same pixels not judged twice; fails with a reason per criterion and on a page that scrolls sideways; skipped, not failed, without Chromium (said once) or without a model that reads images; a local vision model with the OCR role when no Leg reads images; the base criteria without an experience section; through the Verifier like `oraknid github-…`; in the real headless Chromium when the machine has one (phone 390×844 sees a 600 px page scroll sideways, desktop doesn't). `brain.test.ts`: the judge runs on a model with the vision capability, the screenshots named for it to open; none → "No Leg reads images".

Done 2026-10-09 (ADR-064 → As built (M16.3); Skills → Library and Picking what a job needs;
The-Eye → What the work needs and The experience section; ADR-056 → The visual check).

### M16.4 — From the Keys job
- [x] The ladder's top is the strongest available model; never blocked waiting for a paused agent; asked once after a failed climb
- [x] A completed job is merged into the project's work branch, or I'm asked

*Tested:* daemon `eye/evaluations.test.ts` (Claude paused: the task runs
on the model available and I'm asked once; my "Unpause" unpauses it and
the task climbs to it; a completed job merged by default; "ask" asks and
merges on my answer), `eye/eye.test.ts` (a Leg paused under its task:
the other Leg goes on from the handoff; with no other, it waits and goes
on when resumed; the job's summary says it was merged).

## Exit criterion
The Keys spec, with an experience section, run again: a design opens in
a tab for me to annotate on phone and desktop; my notes come back as
work; the built app opens for review the same way; it ships with knobs I
can hear, a hardware-synth layout and a phone layout, without me
leaving Oraknid.
