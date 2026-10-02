# Audits

The index and status board for every audit. An audit stops feature
work to review what exists. It is finished when every finding is fixed
or documented.

| Audit | Before | Opened | Findings | Fixed | Documented | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| [[Audit-1]] | `v0.1.0` | 2026-10-01 | 61 | 56 | 5 | Closed 2026-10-01 |
| [[Audit-2]] | the phone away from home | 2026-10-02 | 23 | 15 (+3 in part) | 5 open | Open: S2-21 needs `passt` |

**Planned angles for the first audit:** security (`S1-`: sandbox
escapes, command filter bypasses, prompt injection, API auth),
durability (`D1-`: fault injection, power-cut simulation), code quality
(`Q1-`), performance (`P1-`: daemon CPU while idle and with Legs
running, UI on a phone), by hand (`U1-`: every screen, dark/light,
phone width).

Related: [[Roadmap]] · [[Phase-1-MVP]]
