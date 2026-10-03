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

## As built (2026-10-03, M13.8)

**The source: the official tooling's own reading.** I looked for a
supported way first. The CLI (2.1.287) has no usage or status
subcommand (`claude --help`: `auth status` only says who is signed in).
The Agent SDK (0.3.286) does: its query has a usage request, the data
behind `/usage`, answering the plan's windows (`five_hour`,
`seven_day`, `seven_day_opus`, `seven_day_sonnet`, `seven_day_oauth_apps`
and any per-model window the server names) with how full each is and
when it resets, and `rate_limits_available: false` for an API key. It
is a control request, answered without a message, so Oraknid runs it
like the health check: a session pointed at the Leg's own config
folder, inside its sandbox, never sent a prompt, closed at once. No
tokens; Oraknid never reads the login. That is why I chose it.

The SDK names it experimental (it may change or go). So a missing
method, an error or no answer in 30 seconds gives no reading rather
than a failure, and from then on that Leg falls back to the second
source: the latest rate-limit event of its sessions, refreshed by a
one-word prompt on its cheapest model (Haiku, else Sonnet), counted as
a session like any other.

- **Throttle**: the Overview and a Leg's details call
  `legs.refreshPlanUsage` every minute while open. A Leg is read at
  most every 5 minutes (it costs nothing); the fallback prompt runs at
  most every 15, only when the Leg is healthy and idle and no session
  has reported a window in those 15 minutes.
- **Stored**: in the `quota` JSON the windows already had (the Leg's
  for the account, a model's rows for its window, matched by name:
  `seven_day_opus` to every Opus model), with `observedAt` and a
  `source` (`usage` or `session`); no migration. A reading that didn't
  change only moves its time; a change publishes `leg.quota`, so the
  event log is the history (`legs.planHistory`: every reading, and
  when a window filled, reached 100%, and reset, its reset time moving
  on as it emptied).
- **Oraknid's share**: its sessions' tokens (in and out) since the
  window began (reset time minus the window's length), by Leg model; a
  model's window counts that model only.
- **Shown**: Overview → Plan usage; Legs → an opened Leg (see
  [[Web-UI]]).
- **Not done**: a reading from the CLI itself, should it gain one; the
  SDK's request when it stops being experimental (rename the call).
  Nothing was run against a real account but `claude --help`: the
  reading is tested against the SDK's types and a scripted CLI, and by
  hand on a sample daemon with scripted Legs.

## Consequences
- Routing already reads these windows ([[ADR-013-Model-Aware-Routing]]);
  this shows them.

Related: [[Legs-and-Capability-Profiles]] · [[Budgets-and-Quotas]] · [[Web-UI]] · [[ADR-011-Claude-Code-Adapter]]
