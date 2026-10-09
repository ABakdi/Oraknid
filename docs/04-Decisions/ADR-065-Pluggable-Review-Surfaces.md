# ADR-065 — Review surfaces: one review, an adapter per kind of app

**Status:** Accepted, not built · 2026-10-09 · [[Phase-16-Approval-By-Experience]] (M16.5) · extends [[ADR-064-Design-And-Approval-By-Experience]]

## Context
ADR-064's review works for what runs in a browser: a design folder
served statically, a web app through Oraknid's proxy with an injected
overlay. Two layers came out of building it:

- **General** already: review steps in the plan, rounds, approval,
  notes turned into tasks, keep-notes as constraints, chat notes, the
  harness's `ReviewPort` (open, outcome, wait), notes typed in words.
- **Web only**, and wired in rather than plugged in (about 1,000 lines
  in `apps/daemon/src/reviews/`: `frame.ts`, `overlay.ts`,
  `snapshot.ts`, and the service choosing between a folder and a port):
  how the target is shown, how I point at a part (a CSS selector and a
  box), how the part is captured, what a "device" is (a screen size).

I build more than web apps: desktop programs, Android and iOS apps,
games, command-line tools and terminal apps, APIs, documents, sounds. A
review should work for each, and a new kind should be an adapter, not a
change to the review.

## Decision

### The review stays one thing
Rounds, notes, approval, the plan's review steps, the review page's
frame of controls (top bar, notes list, Approve, Send notes) and the
`ReviewPort` the harness calls are the same for every kind. What
differs is a **surface**.

### A surface is an adapter
`ReviewSurface` (apps/daemon/src/reviews/surfaces/), registered by
kind, each declaring what it can do:

- `kind`, `label`, `detect(project, step) → fit (0–1) and why`: which
  surfaces suit a project (a `package.json` with Vite → web app; an
  `AndroidManifest.xml` → Android; a `Cargo.toml` with a binary and no
  UI → terminal; an OpenAPI file → API).
- `prepare(target, job) → handle`: get it ready (serve a folder, start
  the dev server, boot an emulator, build and launch the program, run
  the command in a pseudo-terminal), in the job's sandbox where it can
  run there, and `stop(handle)`.
- `view(handle)`: what the review page shows and how it talks to it:
  an inline frame with the surface's own overlay (web), a stream of
  frames (an emulator, a desktop window, a game), a terminal recording
  or a live terminal, a request explorer, a document viewer, a
  waveform.
- `profiles`: the surface's "devices": screen sizes and orientation
  for the web; device models for Android/iOS; window sizes for desktop;
  terminal sizes and themes for a terminal; none for an API.
- `point`: how I point at a part, as an **anchor** (below), and what is
  captured with it (`capture(handle, anchor) → picture, text, extras`).
- `signals(handle)`: what goes with a note besides my words: console
  errors and failed requests (web), logcat lines (Android), stderr and
  exit codes (a program), the response (an API), the time (a recording).
- `interact`: whether I can use the target in the review (click, type,
  tap, play) or only look at it, and whether pointing pauses it.

A surface that can't run on this machine says why (no emulator, no
display, no build tool) and the review falls back to the next surface
that fits, down to **text only** (notes in words), never to nothing.

### Anchors: where a note points, for any kind
A note's `element` (today a CSS selector and a box) becomes an
**anchor**, one of:

- `css`: a selector, its text and box on the page (web).
- `region`: a rectangle on a captured picture, with the picture
  (anything with pixels: native windows, emulators, games, images).
- `accessibility`: a node in the platform's accessibility tree, its
  role, name and bounds (Android's uiautomator, iOS's XCUITest, desktop
  accessibility), when the surface can read it: as exact as a selector.
- `time`: a moment or a span in a recording (a terminal session, audio,
  video, an animation).
- `text`: a file, a line or a range (documents, code, configuration, a
  terminal's output).
- `request`: a method and path, with the request and response (APIs).

A note keeps its anchor, its profile (the "device"), its picture when
there is one, and the surface's signals. The agent receives them the
same way for every kind (the ux-review skill reads anchors by kind).

### The first surfaces
1. **web-design** and **web-app**: today's code moved behind the
   interface, unchanged in behaviour (the first proof of it).
2. **screen**: any program with pixels, through screenshots or a
   stream: a native desktop app (an X11/Wayland window, captured; a
   virtual display in the sandbox when there is none), an Android
   emulator (`adb`, `scrcpy`, `emulator`), the iOS simulator on a Mac,
   a game. Pointing is a `region` on the picture; taps and keys are
   forwarded when the surface can (`interact`). With a platform's
   accessibility tree, pointing becomes an `accessibility` anchor.
3. **terminal**: a command-line tool or a terminal app, run in a
   pseudo-terminal (the web terminal's xterm), live or recorded;
   pointing is a `time` and a `text` range of the output.
4. **api**: an API from its OpenAPI file or its routes, a request
   explorer with example calls; pointing is a `request`.
5. **document**: Markdown, PDF, images, generated files; pointing is a
   `text` range or a `region`.
6. **audio**: a sound's waveform and playback; pointing is a `time`.

Later surfaces (Electron through its devtools for exact elements, a
Unity/Godot game through its editor, a hardware device's camera) are
adapters too.

### The plan and the step
- The planner's review step names its surface, chosen by `detect`
  (with why), and I can change it on the step or in the chat ("review
  it on Android").
- Visual checks (ADR-064 §5) use the same surface to take their
  pictures, so the screenshots of an Android app come from the
  emulator, not a browser.

## Consequences
- The review page becomes a host for a surface's view; the web overlay,
  the screen stream and the terminal are its first three views.
- Emulators, virtual displays and builds are heavy: a surface's
  `prepare` is admitted like any work (ADR-050), and a review step
  waits for room instead of starving the machine.
- Some surfaces need tools Oraknid doesn't install (the Android SDK,
  Xcode on a Mac): `detect` says so and the guide says how.
- The migration of notes: today's `element` becomes a `css` anchor,
  nothing lost.
