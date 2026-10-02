# Phase 11 — Workspace

Touches [[Web-UI]], [[The-Nest]], [[Security]].
Written 2026-10-03, from my list after using Oraknid on my phone and PC.

## Why

Pages pile everything up and make me scroll; a conversation with The
Eye is a strip; the terminal is one shell behind a dropdown; my phone
can't use what I use at home; and The Nest should serve other people.

## Milestones

### M11.1 — Pages that use their space
- [ ] The overview's charts and legends fit a phone (nothing past the right edge)
- [ ] Job page in tabs in the address, The Eye as a full conversation, no jump when changing tabs
- [ ] Every other page with several concerns in tabs (Servers, Legs, Projects)
- [ ] The sidebar folds, by hand and by itself on pages with their own panel
- [ ] Keyboard shortcuts and their list (`?`)

### M11.2 — Terminal workspace
- [ ] Tabs, side by side and grid; picking a target from cards; shortcuts

### M11.3 — Full rights for a device ([[ADR-030-Device-Rights]])
- [ ] Chosen at pairing and on the device's row, at home, with the PIN
- [ ] Away from home with full rights: terminal through the tunnel, servers and the rest

### M11.4 — A public Nest ([[ADR-031-Public-Nest]])
- [x] Public mode with self-registration and its limits; private stays the default
- [x] "Use a public Nest" in Settings registers in one click
- [ ] `oraknid.abakdi.com` public; `private.oraknid.abakdi.com` mine, on the same server
  (`install.sh` is ready for it: `--public`, one Nest per domain, the old install moved over; not deployed yet)

## Exit criterion

On my phone, The Eye's conversation fills the screen and nothing runs
off its edge; at home I open four terminals in a grid; from my phone
with full rights I open a terminal on my server; someone else's daemon
registers on `oraknid.abakdi.com` and I use mine through my private Nest.

Related: [[Roadmap]] · [[Phase-10-Lockdown]]
