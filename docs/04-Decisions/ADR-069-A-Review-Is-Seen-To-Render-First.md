# ADR-069 — A review is never shown before Oraknid has seen it render

**Status:** Accepted · 2026-10-12 · extends [[ADR-064-Design-And-Approval-By-Experience]] §3, [[ADR-067-Self-Recovery]], [[ADR-065-Pluggable-Review-Surfaces]]

## Context
My review pages kept showing a blank page, and each time one case was
fixed: black device frames, "No page /", "Not in the design". On
2026-10-12 the Keys job's final review, "Owner testing of the
interactive final app", opened as a design review of the project's root
folder. Silk said: "The app didn't start (the plan: `pnpm dev` didn't
answer on port 41103 in time:); the review shows the job's folder." The
project is Vite and React (`"dev": "vite"`, its index.html loads
`/src/main.tsx`), so the folder served raw TSX: a blank page, always.

What the code did:

1. **The plan's command was used as it was.** `detectRun` added the port
   flags (`--port $PORT --strictPort --host 127.0.0.1` for Vite and the
   like, `-p` for Next) only to a command it found in package.json. The
   plan said `pnpm dev`: Vite ignores `PORT`, started on 5173, and
   Oraknid waited on 41103. Even the flags it did add went after `--`,
   which pnpm passes on to the script, where Vite ignores what follows.
2. **The output was empty.** In the sandbox the app's pipes said nothing,
   so the reason after "in time:" was blank.
3. **The fallback was a folder of source code.** When the app didn't
   start, `openRound` opened `{kind: "folder", path: <job folder>}`: a
   review that can never render.
4. **Nothing looked at what I was shown.** Every blank page so far was
   the same class: shown before anyone saw it render.

## Decision
A review is shown only once Oraknid has loaded it itself and seen it
render; until then the code runs the app every way it knows, then an
agent tries (the steward principle of [[ADR-067-Self-Recovery]]: code
handles the obvious, an agent handles problems); if nothing renders, the
review says so plainly instead of showing a blank.

### 1. The port is always given
- The plan's command gets the port as a detected one does
  (`withPort`): `$PORT` already in it, as it is; a port written in it
  (`--port 3000`), Oraknid's instead; a known dev server run directly
  (`vite`, `npx vite`, `next dev`, `astro`, `nuxi`, `ng serve`,
  `webpack serve`) or through a package manager's script (`pnpm dev`,
  `npm run dev`, `cd web && pnpm dev`: the script it calls is read), its
  flags added. npm takes them after `--`; pnpm, yarn and bun directly
  (they pass `--` on to the script). Vite gets `--strictPort`, so a
  taken port fails loudly instead of moving.
- **The port the app announces** is read from what it prints ("Local:
  http://localhost:5173/", "listening on port 3000", "ready on
  0.0.0.0:3001") and used when it answers there. In the sandbox (its
  own network, only the given port reachable) the app is started once
  more with the announced port reachable too, when it is free on this
  computer.
- **The output is always kept**: the command runs as
  `exec >>"<its home>/output.log" 2>&1; <command>`, written inside the
  sandbox too, and read with what the pipes said; a reason is never
  empty ("it printed nothing" when it printed nothing, with its exit
  code).

### 2. A ladder of ways to run, before giving up
`waysToRun` lists them, first to try first; `bringUp` tries each on a
free port and keeps every try in words:

1. the command the recovery agent gave (§3), when there is one;
2. the plan's command, with the port;
3. the project's dev (or start, serve, preview) script, with the port;
4. its README's command;
5. its `build` script, then the build's output served as it is
   (`dist/`, `build/`, `out/`, `.output/public`, whichever has an
   index.html);
6. a build already there;
7. a plain static site (an index.html at the top), served as it is.

Builds and the output are served by Oraknid itself
(`serveStatic`: read-only, no dot files, nothing outside the folder; a
path that is no file gives index.html, as a single-page app's server
does). Each way that starts is checked (§4) before it counts.

### 3. An agent when every way fails
A recovery session in the job's tree (ADR-067 §3's `recover`, twice at
most, the second a rung higher), given each way tried with what it
printed, is asked to make the app start the way Oraknid runs it (fix the
configuration, install what is missing, use the port it is given, add a
dev script) and to end with `RUN: <command>`. After each, the ladder
runs again with its command first. A design that doesn't render gets
the same: an agent asked to make its pages render as they are.

### 4. The render check before showing
After a target is ready (an app's port or a design's folder), Oraknid
loads it through **the same frame the review page uses**: the Reviews
service makes a preview frame (`Reviews.preview`, a key of its own,
served by the same `reviews/frame.ts` code, overlay included, forgotten
after), so what is checked is what I would see. At the review's devices
(phone 390×844 and desktop 1440×900) it rendered when:

- the page answered (not 4xx or 5xx, not "No page /", "Not in the
  design", "Cannot GET /");
- it is not a raw source file (`.tsx`, `.ts`, `.jsx`, `.vue`, `.svelte`
  served as text, or text that reads as imports and exports) and not a
  directory listing;
- nothing threw (an uncaught page error);
- the body shows text or painted elements beyond its background (an
  image, a canvas, a control, a background or border), given a few
  seconds after load to draw (a single-page app renders from its
  scripts); a blank body names its broken script ("its script
  /src/main.tsx came as application/octet-stream, not JavaScript: the
  source code is served as it is, not built or run by a dev server").

In headless Chromium through playwright-core (found as the visual check
finds it, `findChromium`; `*.localhost` mapped to 127.0.0.1). Without
Chromium or playwright-core, a cheaper look over HTTP stands in: 200,
HTML (or plain text that isn't source code), every script it loads
served with a JavaScript type, and a body with something in it once its
scripts are taken out, unless its scripts make it. A design is checked
page by page: its index.html, else each page at its top (six at most).
A check that fails is a failed way: the ladder goes on.

### 5. Never a folder of source code
The folder fallback is only for a design folder (a design review, or a
checkpoint whose app doesn't run but which has a design). When nothing
renders after the ladder and the agent, the review **opens on why**:
`ReviewTarget {kind: "none"}` with `problem {reason, tried}`. The review
page shows a panel instead of a frame: "The app didn't start: <reason>",
"Oraknid tried" with each way and what it said, and **Try again** (Approve
and notes in words stay). My "try again" (or "retry", "run it again") in
the project's chat does the same while such a review is open. The job
waits on it, saying "The app didn't start for your review: <reason>";
the inbox tells me once ("The app didn't start for your review"), and
when it shows later, once more that it is ready.

### 6. Open reviews heal
At start, once the frame answers, a waiting job with an open review
that shows an app's folder (opened before this ADR), or whose app
stopped with the last Oraknid and won't run again the way it ran on its
port, is resumed, and its step prepares the review again: the same
review, pointed at what renders now. Try again does the same at any
time. So the Keys review comes right after updating, with nothing for
me to do.

### 7. Recorded
Each try is a `task.review-try` event (`{taskId, way, ok, reason}`);
Silk says how it ended: "Review of the running app: renders on phone,
desktop" with the way it runs and what was tried on the way, or an
issue with every try. The review page's top bar says "checked: renders
on phone, desktop".

## As built (2026-10-12)
- `eye/run-app.ts`: `withPort`, `toolOf`, `waysToRun`, `announcedPorts`,
  `startApp` (output to a log in its home, the announced port, its
  reachable second start), `runBuild`, `serveStatic`, `runWay`,
  `bringUp`; `detectRun` stays as the ladder's first command.
- `eye/render-check.ts`: `RenderChecker`, `httpRenderChecker`,
  `browserRenderChecker` (falls back to the HTTP look);
  `startDaemon({renderCheck})` for tests, headless Chromium by default.
- `eye/evaluations.ts`: `openRound` → `prepareShown` (the design
  checked, or the ladder, the recovery agent through `RecoverShown`,
  which `program.ts` gives as `recoverInJob(…, tries 2)`), then the
  port's `open` with `problem` and `checked`. The step's state
  (`task.evaluation.<task>`) adds `shows` (app, design, nothing; null
  before this ADR), `way`, `checked`, `problem`, `tried`, `prepared`
  (each preparation is its own journal step,
  `evaluation:<task>:<round>:prepare:<n>`) and `retry`. `needsPreparing`,
  `askRetry`, `reviewsToHeal`. `recover`'s `retry` is given the recovery
  task's id, to read its `RUN:` line.
- `harness/reviews.ts`: `ReviewTarget` `{kind: "none"}`,
  `ReviewRequest.problem` and `.checked`, `ReviewPort.preview`; the
  stand-in's `retry`.
- `reviews/service.ts`: `open` with `problem` (no target, no frame) and
  `checked`; asked again while open it updates the same review, and when
  what it shows changed, its inbox item is withdrawn and a new one opened
  (`review.updated` on the job's topic); `retry` (`review.retry` on the
  job's topic; the problem marked `retrying`); `preview`. Migration 0045:
  `reviews.problem`, `reviews.checked`.
- API: `reviews.retry({id})` (home only, as Approve); a review's view
  adds `problem {reason, tried, retrying}` (null when it shows) and
  `checked`; `reviews.open` takes `problem` in place of `target`, and
  `checked`; `reviews.frame` refuses a review with a problem.
- `daemon.ts`: `review.retry` sets the step's retry and resumes its
  waiting job; at start, `reviewsToHeal` resumes the jobs to heal. The
  job's loop wakes on `review.retry` while other tasks run.
- `eye/talk.ts`: "try again" with a review that couldn't show is its Try
  again.
- Web `pages/review.tsx`: the panel (`NotShown`), and the top bar's
  "checked: renders on …".

## Consequences
- A review I open shows something that rendered on a phone and a
  desktop, or says why not; a blank frame from a source folder can't
  happen any more.
- An app review costs a headless browser load per device before it
  opens (a few seconds), and a build when the dev server fails.
- A recovery agent may run before a review opens, as before a block.

## Limits
- The check sees that something drew, not that it is right: the visual
  check ([[ADR-064-Design-And-Approval-By-Experience]] §5) and I judge
  that.
- A page that draws only after a click, or later than a few seconds
  after load, is seen as blank.
- In the sandbox an app that ignores its port and flags is reached only
  when the port it announces is free on this computer.
- The build is served as static files: an app that needs its own server
  side (an API, server rendering) shows what its static build shows.
- The HTTP look can't run scripts: a single-page app whose scripts load
  as JavaScript but fail when run passes it; Chromium catches that.

Related: [[Jobs-and-Projects]] · [[The-Eye]] · [[Phase-16-Approval-By-Experience]] · [[API-Contract]] · [[Data-Map]]
