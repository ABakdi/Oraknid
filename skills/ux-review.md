---
name: ux-review
description: Act on the owner's review notes — keep, change and problem notes left on a design or the running app, each with the element it points at, the device and a screenshot — by turning each into a precise change, keeping what the owner liked as constraints, and saying what was done for each note. Use for the round after a design review or an app review.
interview: false
requires:
  tools: []
verify: []
---

# UX review

On Oraknid's review page the owner opens the design or the running app,
switches devices, clicks a part and leaves a note. A round of notes comes
back as work: this skill is how to read them and act on them. The notes
are the owner's words: follow them, never argue with them, and never do
more than they ask.

The short version:

1. **Read every note with its context:** its kind, the element, the
   device, the screenshot, the page.
2. **Keep notes are constraints.** Write them down; nothing in this
   round or a later one may break them.
3. **Change and problem notes become precise changes:** which file,
   which element, which property, on which device.
4. **Do them, check them on the device they were made on.**
5. **Answer each note:** what was done, or why it couldn't be.

## Reading a note

Each note carries:

- **kind**: `keep` (I like this, don't lose it), `change` (a
  suggestion), `problem` (something is wrong), or a general note on the
  whole page.
- **element**: a CSS selector of what was clicked (`#transport >
  button.play`), its tag and its text. Find it in the source by that
  selector first, then by its text; a selector in a running app may
  name generated classes, so match the text and the structure.
- **device**: the size it was seen at (phone, phone landscape, tablet,
  laptop, desktop, or a custom width × height). A note made on the
  phone is about the phone unless it says otherwise: fix it there, and
  don't change the desktop to do it.
- **screenshot**: what the owner saw. Look at it before changing
  anything: it shows the state (a menu open, a value set) the note is
  about.
- **page** (the design's file or the app's path) and, from the running
  app, the console errors and failed requests captured with the note: a
  problem note with an error beside it is usually that error.

## Keep notes

Each keep note becomes one line in `design/KEEP.md` (or the job's
notes when there is no `design/`): the element, the device, what is
kept, in the owner's words. Before finishing any change, read that file
again and check nothing in it moved, changed colour, size or wording.

## Turning a note into a change

Write the change before making it, one line per note:

- "change, phone: *the knobs are too small*" → `.knob` on the phone
  layout: 44 px → 64 px, the row wraps to two lines.
- "problem, desktop: *the sound designer is a list of number fields*" →
  replace the fields in `sound-designer.desktop.html` with knobs for
  attack, decay, sustain and release, values shown under each.

A note that changes the scope (a new screen, a feature the spec doesn't
have) is not done here: say so in the answer; The Eye takes it to the
plan.

## Checking

Open the changed page at the note's device (the visual check does:
`oraknid visual-check --target design --devices phone`) and look at it
against the note and its screenshot. A change that fixes the note and
breaks a keep note is not done.

## Answering

The task's last words list each note with what was done: "done:
knobs 64 px on the phone", "kept: the transport bar", "not done: a
playlist screen is new scope, sent to the plan". Every note has an
answer; none is left silent.

## Checks

- Every note of the round has an answer: done, kept, or not done with why.
- Every keep note is written down and still true after the changes.
- Each change was made on the device its note names, and nothing else changed on the other devices unless the note asked.
- No change goes beyond what a note or the spec asks.
