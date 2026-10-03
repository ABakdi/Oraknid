# Phase 11 — Workspace

Touches [[Web-UI]], [[The-Nest]], [[Security]].
Written 2026-10-03, from my list after using Oraknid on my phone and PC.

## Why

Pages pile everything up and make me scroll; a conversation with The
Eye is a strip; the terminal is one shell behind a dropdown; my phone
can't use what I use at home; and The Nest should serve other people.

## Milestones

### M11.1 — Pages that use their space
- [x] The overview's charts and legends fit a phone (nothing past the right edge): the tokens chart has its own legend, a Leg per line
- [x] Job page in tabs in the address, The Eye as a full conversation, no jump when changing tabs (each tab scrolls inside itself)
- [x] Every other page with several concerns in tabs: Servers and Projects (a list beside the open one, its tabs in the address; on a phone, one then the other); Legs keep their folding cards
- [x] The sidebar folds, by hand (`[`) and by itself on Chats, Terminal, Mail and a job
- [x] Keyboard shortcuts and their list (`?`)

### M11.2 — Terminal workspace
- [x] Tabs, side by side and grid; picking a target from cards; shortcuts; copy on select

### M11.3 — Full rights for a device ([[ADR-030-Device-Rights]])
- [x] Chosen at pairing and on the device's row, at home, with the PIN
- [x] Away from home with full rights: terminal through the tunnel (its own channel), servers and the rest; tested end to end

### M11.4 — A public Nest ([[ADR-031-Public-Nest]])
- [x] Public mode with self-registration and its limits; private stays the default
- [x] "Use a public Nest" in Settings registers in one click
- [x] `oraknid.abakdi.com` public; `private.oraknid.abakdi.com` mine, on the same server (deployed 2026-10-03 with `install.sh`: the old install moved over keeping its secret and port, the private one beside it; my daemon stays on the public one until I re-pair my phone)

### M11.5 — Polish, from using it (2026-10-03, as built)
- [x] A way back from everything I drill into, history-aware; a job's task drawer is a step of its own ([[Web-UI]] → Going back)
- [x] Touch targets of 44 px on any touch screen; the phone's More menu closes on a tap outside, Esc and navigation
- [x] Set up in place: a Leg, a skill's tools, GitHub, a server, the terminal, a skill file, each in a dialog with the Settings card
- [x] A second step, naming what happens, before what can't be taken back
- [x] Missing options: rename and remove a Leg, edit a server, a skill's earlier versions, a copy of a built-in, New work from a project, older log pages
- [x] Controls that did nothing taken out (a made-up money tile showing $0.00 among them)
- [x] New work on an ended job: talking to The Eye on a finished job (my piano project) did nothing; it now starts a follow-up job in the same project, from where the last one ended ([[Jobs-and-Projects]] → Follow-up jobs)
- [x] The mark: an octopus eye on eight spider legs, violet and amber, with icons for a phone's home screen ([[Web-UI]] → Look)

### M11.6 — A look of its own, and a site (2026-10-03)
- [x] The app's own look, following the mark, in place of the stock component look: ink surfaces, violet, IBM Plex Sans and JetBrains Mono ([[Web-UI]] → Look)
- [x] A product site at The Nest's root: what Oraknid is and how it works, install, a guide, the sources, my contact; real screenshots of the app; the loader moved to `/app/` ([[ADR-033-Product-Site]]); deployed on both Nests 2026-10-03
- [x] A command in an inbox title shows as code, not between backticks
- [ ] A new mark: a big octopus eye, spider legs from its edges all pointing down, two at the top meeting in a V; three concepts drawn (`docs/assets/logo-concepts/`), mine to choose; then its kit (sizes, lockups with the name) in the app, the loader and the site

Tested: the back navigation's history counting (`apps/web/src/lib/nav.test.tsx`). The rest has no automated test.

## Exit criterion

On my phone, The Eye's conversation fills the screen and nothing runs
off its edge; at home I open four terminals in a grid; from my phone
with full rights I open a terminal on my server; someone else's daemon
registers on `oraknid.abakdi.com` and I use mine through my private Nest;
`oraknid.abakdi.com` tells a newcomer what Oraknid is and how to install it.

Related: [[Roadmap]] · [[Phase-10-Lockdown]]
