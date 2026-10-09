---
name: logo-design
description: Make a product's brand marks as SVG — a logo mark, a wordmark, the palette, a favicon, and light and dark variants — in design/brand/, with a page showing them all. Use when the work names a product with a brand, a name to show, or asks for a logo, an icon or a palette.
interview: false
requires:
  tools: []
verify:
  - "test -f design/brand/index.html"
---

# Logo design

A brand is the few marks every screen of the product shows: its logo,
its name set in type, its colours. They are made once, as SVG, before
the screens that use them, and shown on one page for the owner to
review with the design.

The short version:

1. **Read the brief.** The spec's **Experience** (the feel, the
   references) and what the owner said about the name and the product.
   A **keep** note from an earlier review is a constraint.
2. **Two or three directions, then one.** Sketch two or three marks,
   each with a sentence of why; the owner picks on the review page, and
   the chosen one is finished.
3. **SVG only.** Hand-written, small, readable SVG: shapes and paths,
   no embedded bitmaps, no fonts loaded from the network.
4. **Light and dark.** Every mark works on both.

## What it makes

```
design/brand/
  index.html            every mark below on light and dark, with the palette
  logo.svg              the mark and the name together (horizontal lockup)
  mark.svg              the mark alone, square (app icon, avatar)
  wordmark.svg          the name alone, set in type converted to paths
  logo-dark.svg         the lockup for dark backgrounds (and mark-dark.svg, wordmark-dark.svg)
  favicon.svg           the mark simplified to read at 16×16 and 32×32
  palette.css           the brand's colours as custom properties
```

When the product already has a design (`design/tokens.css`), the
palette's colours become its tokens; the brand and the screens never
disagree.

## The mark

- Simple enough to read at 16 px: one idea, few shapes, no fine detail
  that disappears when small.
- Built on a grid (a 24- or 32-unit `viewBox`), with round numbers.
- Says something true about the product (a piano: a key, a waveform),
  never a generic swoosh.
- Each direction's sentence says what it shows and why it fits.

## The wordmark

The product's name in a typeface that fits its feel, converted to
paths so it renders the same everywhere; letter spacing adjusted by
eye. Its height matches the mark's in the lockup.

## The palette

A primary, a secondary or accent, and neutrals (background, surface,
text), each with its dark-mode value, written in `palette.css` and
shown as swatches with their values on the brand page. Text colours on
their backgrounds meet WCAG AA contrast.

## The favicon

`favicon.svg` is the mark, simplified when needed, on a square that
reads on a browser tab in both themes (a `prefers-color-scheme` media
query inside the SVG when the mark's colour must change).

## Checks

- `design/brand/` has `logo.svg`, `mark.svg`, `wordmark.svg`, `favicon.svg`, dark variants and `palette.css`.
- Every file is plain SVG: no embedded bitmaps, no fonts or images loaded from the network.
- The mark reads at 16×16 (the favicon) and on light and dark backgrounds.
- `design/brand/index.html` shows every mark on light and dark, and the palette with its values.
- The palette's text colours meet WCAG AA contrast on their backgrounds.
- Nothing contradicts a **keep** note or the experience section.
