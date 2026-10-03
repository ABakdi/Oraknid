# Phase 10 — Lockdown

Touches [[Security]], [[Web-UI]], [[The-Nest]], [[Sandboxing]].
Written 2026-10-02.

## Why

Oraknid runs anything on my computer, and since Phase 4 it can be
reached from the internet. Nobody but me may drive it: not someone with
my phone, not someone who broke into The Nest, not a job gone wrong.
And the settings had grown into one long page, with pairing my phone
lost at its bottom.

## Milestones

### M10.1 — A PIN on every device
- [x] [[ADR-029-App-Lock]]: the PIN checked by the daemon, a session per device, idle lock, ten wrong tries unpair
- [x] PIN pad (thumb-sized, a keyboard too), first PIN on this computer, change it, lock every device, `oraknid pin reset`
- [x] Away from home: what opens a new way in is refused; alerts on wrong PINs, past quiet hours

### M10.2 — Audit 2
- [x] Four hostile reviews (remote, local, containment, web): [[Audit-2]]
- [x] Every critical and high finding fixed, tested where it can be
- [x] Its own network namespace for every sandbox (`pasta`, package `passt`), S2-21, done 2026-10-03: the internet, none of this computer's services except the ports a project lists (Projects → Network) and a Leg's own local model; OpenCode's server port forwarded in; a Leg's sign-in keeps the host network while it lasts ([[Sandboxing]]). Without `passt`, the host network is shared and `oraknid doctor` says so
- [ ] The loader's code pinned on the phone, or a native app (S2-02)

### M10.3 — Settings and pairing
- [x] Settings in tabs, each one concern, in sections; the tab in the address
- [x] Pair my phone in one step: what's missing first, then a big code to scan, and the card says when the phone used it

Tested: the lock, its tries, idle and away rules, live socket and Nest
tunnel ending on a lock or revocation (unit and end-to-end tests); a
host abstract socket refused from the sandbox; a replayed stream header
refused; pairing, the first PIN, the PIN pad and the tabs in Chrome.
The network namespace (2026-10-03): a test reaches a listed port and
is refused an unlisted one.

## Exit criterion

From my phone I open Oraknid with my PIN, and nobody without it can;
a job can't reach anything on my computer outside its sandbox.

Related: [[Roadmap]] · [[Audit-2]]
