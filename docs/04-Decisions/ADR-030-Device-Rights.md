# ADR-030 — A device can be given full rights, away from home too

**Status:** Accepted · 2026-10-03 · [[Phase-11-Workspace]] · amends [[ADR-029-App-Lock]]

## Context
ADR-029 keeps, away from home, everything that opens a new way in: the
terminal, servers, pairing, policies, projects, Legs, tools. I want to
use the terminal and my servers from my own phone too, and choose that
per device.

## Decision
- Each device has **rights**: `standard` (ADR-029's rules away from
  home) or `full` (away from home, what it may do at home).
- Chosen when I pair it ("Full rights from this device"), changed later
  on the device's row; giving or taking full rights is done **at home
  only** and asks for the PIN again.
- A device with full rights away from home: the terminal opens through
  the tunnel too (its own channel, end to end like the rest), and
  servers, projects, Legs, tools and policies can be changed.
- Still home only, whatever the rights: the PIN itself, pairing new
  devices, giving rights, The Nest's configuration. A device can't
  widen itself or mint others.
- Full rights is shown on the device everywhere it matters (a badge),
  and every use away from home is in the audit log.

## Consequences
- A phone with full rights is as powerful as my keyboard: the PIN and
  ten tries are what stand between a thief and my computer. The pairing
  card says so before I tick the box.
- A broken-into Nest that catches my PIN (Audit-2 S2-02) gets full
  rights on such a device: one more reason to keep my own private relay.

Related: [[ADR-029-App-Lock]] · [[Security]] · [[ADR-028-Terminal]]
