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

## As built (2026-10-03)
- The rights are kept in the setting `devices.fullRights` (the ids of
  the devices that have them); `devices.list` names each device's
  rights, `lock.status` says whether this device has them.
- `devices.setRights` takes the PIN and is refused away from home;
  `nest.pairAway` takes `full` and the PIN to give them at pairing.
- Home only whatever the rights: `secrets.*`, `nest.configure`,
  `nest.register`, `nest.pairAway`, `devices.pairStart`,
  `devices.revoke`, `devices.setRights`, `lock.setPin`, `lock.setIdle`.
  Everything else the daemon keeps home only for a standard device
  (policies, projects, servers, GitHub, mail accounts, tools, skills,
  Legs, The Eye's models, notifications, pruning, a job's waivers and
  rules, the terminal) is open to a device with full rights.
- The helper's Confirm on creating a project or adding a Leg works away
  from home only on a device with full rights.
- The terminal goes through the tunnel as `term-open` / `term-in` /
  `term` / `term-close` ([[Nest-Protocol]]); the daemon opens its own
  `/term` for it, marked as from away.

## As built (2026-10-07)
- **The badge.** The header shows "Full rights" on a device that has
  them ("Full rights, away" through The Nest), and the Terminal shows it
  away from home, each with what it allows (`full-rights.tsx`, from
  `lock.status`). A standard device shows nothing.
- **Every use away from home audited.** A call through the tunnel that
  only full rights allow (home only for a standard device, not home only
  for all: `needsFullRights` in `auth/lock.ts`) publishes
  `device.awayUse` `{device, path}` (actor owner) before it runs; the
  helper does the same for its actions (`via: "helper"`), the terminal
  already logged `terminal.opened` with `away`. Reads, and calls refused,
  log nothing. The Overview's activity names it "Used away from home".

## Consequences
- A phone with full rights is as powerful as my keyboard: the PIN and
  ten tries are what stand between a thief and my computer. The pairing
  card says so before I tick the box.
- A broken-into Nest that catches my PIN (Audit-2 S2-02) gets full
  rights on such a device: one more reason to keep my own private relay.

Related: [[ADR-029-App-Lock]] · [[Security]] · [[ADR-028-Terminal]]
