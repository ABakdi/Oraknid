# ADR-039 — A Leg's plan usage in front of me

**Status:** Accepted · 2026-10-03

## Context
A Claude Code Leg runs on my subscription, whose limits are rolling
windows (five hours, a week, a week per model). Oraknid learns how
full they are only from rate-limit events in its sessions, and shows it
deep in a Leg's card. I want to see it on the Overview and in the Leg's
details, as Claude's own usage page shows it.

## Decision
- **For each Claude Code Leg**: every window with how full it is (a
  bar and a percentage), when it resets, and since when that's known;
  Oraknid's own tokens in that window beside it, by model.
- **Where it comes from**, best first: a supported way of the official
  tooling to read the plan's usage for that Leg's config folder (the
  CLI or the Agent SDK, run like the health check, inside the Leg's
  sandbox, Oraknid never reading the token itself); otherwise the
  latest rate-limit event of any session of that Leg, refreshed by a
  tiny health prompt at most every 15 minutes while the Overview is
  open, never more than the Leg's own use costs. What's shown says how
  old it is.
- **Overview**: a "Plan usage" card, a row per Leg with windows, the
  fullest window first; a Leg near or at its limit is marked. **Leg
  details**: the same windows larger, with their history (when each
  filled and reset) and the models' share.
- Other kinds show what they have: OpenCode's free models no window,
  Antigravity its quota errors, a local model nothing.

## Consequences
- Routing already reads these windows ([[ADR-013-Model-Aware-Routing]]);
  this shows them.

Related: [[Legs-and-Capability-Profiles]] · [[Budgets-and-Quotas]] · [[Web-UI]] · [[ADR-011-Claude-Code-Adapter]]
