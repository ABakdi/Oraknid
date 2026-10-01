# Budgets and Quotas

**Is:** the limits I set on a job, a task or a Leg, and how Oraknid
tracks every Leg's quota.
**Is not:** billing. Oraknid never charges anything. It only measures.

## Principle

By default no money is spent (BR-10). Most Legs are prepaid
subscriptions or free (local models, some free tiers). Their real limits
are **tokens, quota windows and context windows**. Time is mine to set,
as an alarm that tells me to come and look.

## Budget dimensions

| Dimension | Applies to | Default | When reached |
| :-- | :-- | :-- | :-- |
| Tokens (in + out) | job, task, Leg | unlimited | Stop new work, ask me (hard). |
| Quota-window share | Leg, per job | 100% | Stop routing this job to that Leg until reset. |
| Context per session | Leg | 60% of window | Rotate the session (BR-3). |
| Wall-clock time | job, task | job: 8 h alarm | Notify me (soft). Hard only if I set it. |
| Money | job, Leg | 0 | Only paid Legs need it. Stop and ask (hard). |

The quota-window share is how full this job may make any window of a
Leg: at a hard 50%, a Leg whose `seven_day` window is at 62% is not
routed this job's next task, and the routing record says so. When no
Leg is left, the job is `blocked` until the earliest such reset.

Each budget is marked **hard** (stop and ask) or **soft** (notify and
continue). Every budget can be changed while the job runs or is paused
(`jobs.setBudget`); a changed dimension starts its warnings afresh, and
a job paused at a limit resumes when I say so. At 80% of any hard budget I get a warning notification,
once. At a hard limit the job pauses at a safe point and the inbox asks:
raise it by half, double it, or keep it paused. A job's tokens are what
went in and out plus what was written to cache; cache reads are not
counted.

## Quota tracking per Leg

- **Windows have a scope.** Some apply to the whole account, and some to
  one model (e.g. Claude reports `five_hour`, `seven_day`,
  `seven_day_opus`, `seven_day_sonnet`). Each is tracked separately, and
  a model needs room in every window that applies to it.
- **Subscription Legs** (e.g. Claude Code): Oraknid reads whatever
  usage and rate-limit information the agent reports (see
  [[Leg-Adapters]]) and records each window's used share and reset
  time. When the agent reports nothing more precise, Oraknid estimates
  the share from its own token counts against limits I enter in the
  capability profile, and labels the number **estimated** in the UI.
- **Local Legs**: tokens are counted from the server's usage fields.
  There's no quota window. Speed and VRAM are tracked instead.
- **Per-token Legs**: tokens × prices from the profile.

## What the UI shows

- Per Leg: the model and effort in use now, tokens used in the current
  window, remaining share of each window (account-wide and per model,
  exact or estimated), the reset times, and context used by the current
  session.
- Per Leg model: tokens and tasks over time, and success rate, so I can
  see which model does what for how much.
- Totals: tokens today, this job, this project. Money if any.
- Burn charts: tokens over time by Leg, and against each budget line.

## When everything runs out

When no allowed Leg has quota, the job goes `blocked` with the earliest
reset time. A timer resumes it at the reset, and I'm notified both
times.

Related: [[The-Eye]] · [[Legs-and-Capability-Profiles]] · [[Business-Rules]] · [[Web-UI]]
