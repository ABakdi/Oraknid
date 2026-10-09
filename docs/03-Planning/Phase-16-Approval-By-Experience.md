# Phase 16 — Design and approval by experience

Touches [[The-Eye]], [[Jobs-and-Projects]], [[Web-UI]], [[Skills]],
[[ADR-064-Design-And-Approval-By-Experience]]. Written 2026-10-09.

## Why
The Keys job passed every test and missed what I meant (ADR-064 →
Context). Verification by the person the work is for, inside the work.

## Milestones

### M16.1 — The review page
- [ ] A review opens in a new browser tab: the design or the running app in a frame, a device switcher (presets, orientation, custom size)
- [ ] Select-and-note: click a part, outline, capture element and text, write keep / change / problem; general notes; pins per device; edit and delete
- [ ] Approve and Send notes; rounds; notes stored per review with their device, element and screenshot
- [ ] The running app through Oraknid's proxy with an injected overlay (console errors and failed requests captured with a note); nothing written into the project

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
the keyboard"). The review page itself is M16.1's; until it is wired a
review is asked in the inbox (ADR-064 → As built).

### M16.3 — Designs, skills and the visual check
- [ ] The design task: clickable HTML/CSS of the screens per device in `design/`, logo and palette when there's a brand
- [ ] Built-in skills ui-design, logo-design, ux-review; The Eye proposes skills, tools, servers and Legs from the description for one approval, and offers to make a missing skill
- [ ] An experience section asked for in the interview; experience acceptance criteria
- [ ] The visual check: headless screenshots per device, judged by a vision model against the experience criteria, shown in the report

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
