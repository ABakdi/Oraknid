# ADR-068 — Limits are where the provider puts them: the model first, the models I use first, a short limit is a wait

**Status:** Accepted · 2026-10-11 · extends [[ADR-052-A-Harness-For-Any-Model]] §4, [[ADR-066-Token-Economy]], [[ADR-009-Multiple-Accounts-Per-Provider]], [[ADR-013-Model-Aware-Routing]]

## Context
On 2026-10-11 my Keys job was blocked "out of quota" on OpenCode, while
`opencode` in my terminal works and has never run out for me. What the
records showed:

- In my terminal I use only `big-pickle` (9,116 assistant messages in
  OpenCode's own database, all of them big-pickle).
- Oraknid ran the task on `longcat-2.5-preview-free`, one of the sixteen
  free OpenCode Zen models the Leg lists. Preview free models have tight
  per-model rate limits. The session ran 17 minutes with many tool calls
  (each one a request), then: "Rate limit exceeded. Please try again
  later."
- The harness then marked the **whole Leg** rate-limited for 15 minutes
  (no reset given): all sixteen models, big-pickle with them, which was
  fine. Each run again did the same.
- The fallbacks failed too: Groq's `openai/gpt-oss-20b` ended in one
  second with an **empty** error and no reason in the attempt's outcome;
  the request was likely larger than its free tier's 8,000 tokens a
  minute (the context was about 15,000 tokens), but the provider's words
  were lost, so it was never seen as too large. Codex's 30-day window
  was full, Antigravity out until the 16th, Claude paused by me.
- The job showed **blocked**, for what was a 15-minute wait.

## Decision

### 1. A limit first limits the model that hit it
A usage limit limits the **model** whose request was refused, until its
reset (15 minutes when its words give none), kept across restarts (the
setting `models.limited`, by Leg model). Its Leg stays healthy and its
other models go on. The whole Leg is limited only when:

- the provider's words say the **account** is out ("Individual quota
  reached", "upgrade your subscription", credits, billing, a plan, an
  account's or organisation's quota: core's `accountWide`); or
- a **second, different model** of the same Leg hits a limit while the
  first is still limited: the limit is evidently the account's.

What a Leg's limits turned out to cover is a fact learned, like a
model's largest request ([[ADR-066-Token-Economy]] §1), and kept (the
setting `legs.limitScope`): `account` after either case above, and from
then on one model's limit limits the Leg at once; `model` when another
of its models works while one is limited, and from then on a second
model's limit stays that model's. A rate-limit report from a session
says it is a model's (`QuotaReport.scope: "model"`: OpenCode's provider
rate limit, a 429 to Oraknid's agent or a plain OpenAI-compatible
server); a plan's window reported as the account's (Claude's five-hour
window) still limits the Leg, as before. ADR-009's rule against another
account of the same provider applies to an account's limit, not to one
model's.

Routing leaves a limited model out ("OpenCode · longcat-2.5-preview-free:
rate-limited until 07:32 today (Rate limit exceeded.)"). After a model's
limit on a task, the **same Leg's other models** go first (+2) when one
fits the task: the Leg was fine, only that model wasn't. The Eye's own
calls read and set limits the same way.

### 2. The models I use go first
A CLI Leg whose tool keeps its own config or history says which models
I use with it, read only from my home folder (`LegAdapter.preferredModels`):

- **OpenCode**: the `model` of its config (`~/.config/opencode/opencode.json`
  or `.jsonc`), and the models of the assistant messages in its database
  (`~/.local/share/opencode/opencode.db`, `message.data.modelID`), most
  used first; a model with under a tenth of the most used one's messages
  isn't counted as mine.
- **Codex**: the top-level `model` of its `config.toml` (`~/.codex` or
  `$CODEX_HOME`).

Read at each health check, kept per Leg (`legs.preferredModels`). Only
the model ids leave the reading; nothing is written there or sent
anywhere. A model I use ranks first among its Leg's otherwise equal
models (+1.5, "you use this one"); a preview or experimental free model
I don't use ("preview", "alpha", "beta", "experimental", "contributor",
a "-free" variant: core's `previewModel`) ranks lower for agent work, any
task but a mechanical one (−1, "a preview model: tight limits for long
agent work"). The Legs page shows "you use this one" on the model's row,
and a model's own limit until when.

### 3. A short limit is a wait, not a block
When no model can take a task and the earliest reset (a model's or a
Leg's limit, a provider failure's rest, a window past the job's share)
is within **30 minutes**, the task waits for it inside its attempt and
goes on by itself: it says "Waiting for OpenCode · big-pickle until 07:32
(rate limit), or another model sooner; it goes on by itself." on the
task (`waitingReason`) and in the job's events (`task.waiting-for-leg`),
looks again every second, and takes any model that frees up sooner. The
job stays running, never `blocked`. Only a longer wait with nothing else
to run blocks the job, with the plain line and the time, and a timer
resumes it then, as before.

### 4. Paced, not hammered
A model refused for its pace (a rate limit whose words don't say the
account is out) gets a learned pace, kept a day (`models.pace`): 20
requests a minute the first time, half of it at each limit after,
never under 2. Where Oraknid makes the requests (its own agent), the
next request waits for its turn (`SessionStart.spacingMs`); elsewhere a
paced model runs one session at a time.

### 5. The provider's words are never lost
- Oraknid's agent says a failure in the provider's words, never empty:
  the HTTP status and the start of the body, the error the SDK wrapped,
  an error object's message or its JSON, "with no body" when there was
  none; a 429 keeps its body and its retry-after; an answer the server
  ended on an error without words says so. A plain OpenAI-compatible
  server's refusal keeps its status and its message (600 characters),
  and an error sent inside its stream ends the turn with it.
- OpenCode's provider rate limit keeps its words as the turn's error
  even when the turn ends by the interruption Oraknid sends.
- The attempt log's `AgentText` keeps the turn's `error` when it ended on
  an error or a limit, and the attempt's `Outcome` has its reason (the
  limit, the provider's failure), never null for an end that isn't the
  task's.
- An error with no words at all is its provider's, not the task's: the
  model rests two minutes and the attempt doesn't count.

So Groq's 413 body, kept, reads as too large ([[ADR-066-Token-Economy]]
§1) and the request goes to a model with room.

### 6. The line says what happened
The attempt that hit the limit says "OpenCode's longcat-2.5-preview-free
is rate-limited until 07:32; another model takes the work", and the
next routing records it first among its reasons with the model that
took it: "OpenCode's longcat-2.5-preview-free is rate-limited until
07:32; big-pickle takes the work." (`task.limit-goes-on`).

## Consequences
- One free model's rate limit no longer takes its Leg's other models
  away; a job that hit one goes on with another model of the same Leg
  at once, usually the one I use myself.
- A job no longer shows `blocked` for a limit that ends within half an
  hour; it shows what it waits for and until when.
- A preview model with tight limits is no longer the first choice for a
  long agent task when the Leg has a model I use.
- Learned facts (`models.limited`, `legs.limitScope`, `models.pace`,
  `legs.preferredModels`) are settings rows; no migration.

## Limits
- The scope is learned from what happens, so the first time a Leg whose
  limits are the account's hits one on a single model, its other models
  are tried once more before the second limit tells.
- The pace is applied inside the loop only for Oraknid's own agent; a
  CLI agent (OpenCode, Codex) makes its own requests, so a paced model
  there only runs one session at a time.
- Preferred models are read from the tool's files in my home folder: a
  tool that keeps its history elsewhere (another `XDG_DATA_HOME`, a
  remote machine) says nothing, and the Leg ranks as before.
- OpenCode's database is read with Node's built-in SQLite (Node 22.12 or
  later), which prints an experimental-feature warning once.

Related: [[Legs-and-Capability-Profiles]] · [[Budgets-and-Quotas]] · [[The-Eye]] · [[Leg-Adapters]] · [[Jobs-and-Projects]]
