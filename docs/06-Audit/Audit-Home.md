# Audits

The index and status board for every audit. An audit stops feature
work to review what exists. It is finished when every finding is fixed
or documented.

| Audit | Before | Opened | Findings | Fixed | Documented | Status |
| :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| [[Audit-1]] | `v0.1.0` | 2026-10-01 | 61 | 54 | 5 | 2 open: S1-02 (my decision), U1-04 (my check) |

**Planned angles for the first audit:** security (`S1-`: sandbox
escapes, command filter bypasses, prompt injection, API auth),
durability (`D1-`: fault injection, power-cut simulation), code quality
(`Q1-`), performance (`P1-`: daemon CPU while idle and with Legs
running, UI on a phone), by hand (`U1-`: every screen, dark/light,
phone width).

Related: [[Roadmap]] · [[Phase-1-MVP]]
