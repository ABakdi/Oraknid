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
- [ ] `oraknid.abakdi.com` public; `private.oraknid.abakdi.com` mine, on the same server
  (`install.sh` is ready for it: `--public`, one Nest per domain, the old install moved over; not deployed yet)

## Exit criterion

On my phone, The Eye's conversation fills the screen and nothing runs
off its edge; at home I open four terminals in a grid; from my phone
with full rights I open a terminal on my server; someone else's daemon
registers on `oraknid.abakdi.com` and I use mine through my private Nest.

Related: [[Roadmap]] · [[Phase-10-Lockdown]]
