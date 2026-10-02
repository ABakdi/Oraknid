# ADR-029 — A PIN unlocks Oraknid on every device, enforced by the daemon

**Status:** Accepted · 2026-10-02 · [[Phase-10-Lockdown]]

## Context
Oraknid runs agents with a shell on my computer: whoever drives its UI
drives my computer. A paired device keeps a long-lived token, so a
phone left unlocked, stolen, or a browser profile copied is enough
today. I want a PIN to open Oraknid, on my phone and on my PC, and a
lock that holds even if the device's storage is read.

## Options
1. **A lock screen in the UI only**: easy, and worthless: the token in
   storage still works against the API.
2. **The PIN encrypts the device's token at rest**: protects a copied
   storage, but a 6-digit PIN is brute-forced offline in seconds.
3. **The daemon enforces it (chosen)**: the device token alone opens
   nothing but the lock. The PIN is checked by the daemon, which counts
   wrong tries; guessing is online only, and capped.

## Decision
- **One PIN for me**, 6 to 12 digits (or a longer passphrase), stored by
  the daemon as a scrypt hash with its own salt; compared in constant
  time. Required: until it is set, this computer's browser shows only
  "Set your PIN", and a phone can't be paired for away.
- **Unlocking makes a session for that device**: a random token kept
  by the daemon as a hash, in memory only (a daemon restart locks
  everything), sent as `x-oraknid-unlock` (in the live and terminal
  sockets' address, which only those accept). The browser keeps it in
  session storage: closing the tab or the browser locks.
- **Every API call, live socket and terminal from a device needs its
  device token and an unlocked session.** Only `lock.status` and
  `lock.unlock` (and setting the first PIN, on this computer) pass
  without. A locked call gets 423 and the UI shows the PIN pad.
- **Idle lock**: no call for 15 minutes (5, 15, 60 or 240, my choice)
  locks the session; it lives 12 hours at most. "Lock now" locks every
  device. Revoking a device ends its sessions, sockets included; the
  live socket and the terminal re-check at every heartbeat.
- **Wrong PINs**: from the 5th wrong try on a device, a wait that
  doubles (30 s, 1 min, 2 min…); the 10th revokes that device, which
  must be paired again. More than 20 wrong tries in an hour across all
  devices stops unlocking away from home for an hour. Each wrong try is
  in the audit log and the 5th notifies me.
- **Changing or removing the PIN** needs the current one, and only from
  this computer. Forgotten: `oraknid pin reset` in a terminal on this
  computer (my user only).
- **The CLI** (its token is new each start, in a 0600 file) is not
  locked: anyone who can read that file is already me on this computer.

## Consequences
- A stolen phone, a copied browser profile, a leaked pairing link or a
  screenshot of its QR code give at most ten PIN guesses, then nothing.
- A daemon restart asks every device for the PIN again.
- Software running as my user on this computer is out of reach of any
  PIN (it could read the database); the sandbox keeps Legs from being
  that software ([[Sandboxing]]).

Related: [[Security]] · [[The-Nest]] · [[ADR-017-Nest-E2E-Protocol]]
