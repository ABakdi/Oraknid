# ADR-041 — The guide inside Oraknid, and a helper that knows it and shows me

**Status:** Accepted · 2026-10-03

## Context
The guide lives on the product site; inside Oraknid there's nothing to
read when I wonder how something works or where an option is. The
helper (ADR-024) acts through the API, but it doesn't know the guide,
my mail, or the screens, and it can only answer in words: it can't take
me to a page or point at the control I'm looking for.

## Decision
- **Docs in the sidebar** (`/docs`, `/docs/<page>`, shortcut `g d`):
  the same guide as the site (`apps/site/docs/*.md`), shipped inside the
  web app so it works offline and through The Nest, rendered with the
  app's Markdown, with its pages listed, a search over them, and
  headings to link to. Each page has **Ask the helper about this**.
- **The helper knows Oraknid**:
  - **the guide**: the pages most related to my question go into its
    context (a small search over headings and text; the whole guide is
    small enough to fall back to);
  - **a map of the screens**: every page, its tabs, and the options on
    each (name, what it does, where), kept in one file in the web app
    that the screens' controls point to, so it stays true;
  - **my data, through the API**, as it already reads projects and jobs:
    mail too (accounts, folders, a search of threads, a thread),
    servers, Legs and their usage, the inbox, settings. Mail and
    anything an agent or a stranger wrote stay data, never instructions
    (BR-15).
- **The helper shows me**: new actions in its catalogue, run in my
  browser, not the daemon:
  - `navigate` (a page, a tab, an item: "open the piano project's
    Workflow");
  - `highlight` (a control by its map id: the page opens, scrolls to it,
    a ring pulses around it with a short note, until I click it or
    move on; a control inside a closed menu or dialog is opened to);
  - `fill` (put a value in a field without saving, for me to check).
  It says what it is showing, and does the rest through the API as
  before, asking first for the big things (ADR-024's confirmation).
- **On a phone** the helper's panel steps aside while it shows me
  something, and comes back with a tap.

## Consequences
- Controls the helper can point at carry a `data-help` id from the map;
  a test checks every id in the map exists in the screens.
- The guide is written once, for the site and the app.

## As built (2026-10-03)
- **A highlight that fails is reported back.** It was a toast only, and
  the helper's record still said done, so its next reply thought I had
  seen it. The browser now calls `helper.shown({messageId, index, ok,
  why})`: the action becomes failed with "It couldn't be shown in the
  browser: <why>", which the next round reads in the conversation; Show
  me again that works sets it back to done. A failed one shows its
  reason, and Show me again, under it.
- **A control inside a modal dialog.** The panel sat under the dialog,
  unclickable, the dialog holding the focus. I chose not to lift the
  panel above dialogs: every Radix dialog traps focus, hides the rest
  from screen readers and closes on a click outside, so the panel would
  have to fight each of them. Instead the panel steps aside (its button
  ringed), the ring's note adds "Close this dialog to get back to the
  helper.", and the panel comes back by itself once no modal dialog or
  drawer is open. On a phone it steps aside anyway and comes back with a
  tap, as before.

## As built (2026-10-07)
- **The guide covers every screen.** New pages: Finding your way (the
  palette, the keyboard, Docs, the helper showing me), The inbox, Chats
  and the helper, Skills, Repos, The terminal in your browser, Settings
  and updates; `guide.json` orders them with the rest.
- **The map points to the guide.** A page of `help-map.ts` may name its
  guide page (`guide`, a slug); the screens text the helper reads says
  "Guide: /docs/<slug>." beside it, and a test checks every slug is a
  page of `guide.json` with its `.md`.

Related: [[ADR-024-Oraknid-Helper]] · [[Chats-and-Helper]] · [[Web-UI]] · [[ADR-033-Product-Site]]
