# Audits

The index and status board for every audit. An audit stops feature
work to review what exists. It is finished when every finding is fixed
or documented.

| Audit | Before | Opened | Findings | Fixed | Documented | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| [[Audit-1]] | `v0.1.0` | 2026-10-01 | 61 | 56 | 5 | Closed 2026-10-01 |
| [[Audit-2]] | the phone away from home | 2026-10-02 | 23 | 19 (+3 in part: S2-02, S2-13, S2-15) | 1 open (S2-22) | Open: every critical and high finding fixed; S2-21, S2-08 and S2-23 fixed 2026-10-03; the loader pinned (S2-02) next |

**Planned angles for the first audit:** security (`S1-`: sandbox
escapes, command filter bypasses, prompt injection, API auth),
durability (`D1-`: fault injection, power-cut simulation), code quality
(`Q1-`), performance (`P1-`: daemon CPU while idle and with Legs
running, UI on a phone), by hand (`U1-`: every screen, dark/light,
phone width).

Related: [[Roadmap]] · [[Phase-1-MVP]]
