---
name: ui-design
description: Design the screens before building them — a clickable HTML and CSS design in design/, one page per screen and per device the spec names (phone portrait and landscape, tablet, desktop), with sample content, a small design system and the controls the product needs, linked from design/index.html, for the owner to open and annotate. Use when the work has a UI someone will see or use (an app, a site, an instrument, a dashboard) and before its feature code.
interview: false
requires:
  tools: []
verify:
  - "test -f design/index.html"
  - "oraknid visual-check --target design"
---

# UI design

The design is how the owner sees the work before it is built: a set of
plain HTML and CSS pages they open in a browser, click through on each
device and annotate on Oraknid's review page. It is decided before any
feature code, and once approved it is part of the canon: feature tasks
build to it.

The short version:

1. **Read the experience section first.** The spec's **Experience**
   (its feel, the layout per device, the controls, the references, the
   experience acceptance criteria) and every **keep** note from earlier
   reviews. They are the brief; nothing in the design contradicts them.
2. **One page per screen and per device.** `design/<screen>.<device>.html`
   for each screen the spec describes, at each device it names.
3. **Sample content, real controls.** Realistic text and numbers, never
   lorem ipsum; the controls the product needs, drawn as what they are.
4. **A small design system.** Tokens, type and spacing in one stylesheet,
   used everywhere.
5. **An index.** `design/index.html` links every screen on every device.
6. **No backend.** It renders from files: no server, no build, no fetch.

## Where it goes

```
design/
  index.html              every screen, per device, linked
  tokens.css              the design system: colours, type, spacing, radii, shadows
  <screen>.phone.html     e.g. player.phone.html
  <screen>.phone-landscape.html
  <screen>.tablet.html
  <screen>.desktop.html
  assets/                 icons and images the pages use (SVG first)
```

Only the devices the spec names. When it names none, phone (portrait)
and desktop. A screen the spec names once is one page per device; two
states of one screen that look different (empty and full, playing and
stopped) are two pages, named `<screen>-<state>.<device>.html`.

Each page sets its viewport (`<meta name="viewport"
content="width=device-width, initial-scale=1">`) and is laid out for its
device's size: phone 390×844, phone landscape 844×390, tablet 820×1180,
desktop 1440×900. Nothing scrolls sideways at that width.

## The design system

`design/tokens.css` holds custom properties and nothing else that a
page could inline:

- **Colour:** a background, a surface, text and muted text, a primary
  and an accent, success, warning and danger; each with its dark-mode
  value under `@media (prefers-color-scheme: dark)` when the product has
  a dark mode. Contrast meets WCAG AA for text.
- **Type:** one or two families (system stacks, or a font from the
  product's brand), a scale of five or six sizes, line heights.
- **Spacing:** a scale (4, 8, 12, 16, 24, 32, 48), used for every gap.
- **Shape:** radii, borders, shadows, the size of a touch target (44 px
  at least on a phone).

Every page links `tokens.css` and uses its variables; a colour or a size
written into a page is a token missing.

## Controls the product needs

Draw each control as what it is for the product, not the nearest form
field:

- An instrument or a mixer: **knobs, faders, sliders, pads, a keyboard**,
  with their value shown; never number fields and dropdowns for what a
  hand turns.
- A media player: transport buttons, a scrubber, a volume control.
- A dashboard: charts with axes and labels, figures with their unit.
- A form: labels above fields, the right input types, errors shown.

Controls in the design can move (CSS `:hover`, `:active`, `<input
type="range">` styled, a few lines of JavaScript for a knob that turns)
but do nothing real: no audio, no network, no storage.

## Sample content

Content that looks like the product in use: real names, plausible
numbers, the longest label it will have, an empty state when the
screen has one. It tells the owner whether the layout holds.

## The index

`design/index.html` lists every screen with a link to each of its
devices, the design system's swatches and type scale, and one line per
screen saying what it is for. It is the page the review opens first.

## Acting on review notes

The owner's notes come back through the review page (see the
**ux-review** skill): **keep** notes are constraints, **change** and
**problem** notes are the work of the next round. Change only what the
notes and the spec ask; a round never redesigns what was kept.

## Checks

- `design/index.html` exists and links a page for every screen the spec describes, at every device it names.
- Every page renders from files alone: no server, no build step, no request to the network.
- Every page links `design/tokens.css` and takes its colours, type and spacing from its variables.
- Each page is laid out for its device: nothing scrolls sideways at that width, and touch targets on a phone are at least 44 px.
- The controls are the ones the experience section names (knobs, sliders, pads…), not number fields or dropdowns standing in for them.
- The content is realistic sample content, never lorem ipsum.
- Nothing in the design contradicts a **keep** note or the experience section.
