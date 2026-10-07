# Legs and Capability Profiles

**Is:** how agents, accounts and models plug into Oraknid, and how
Oraknid knows what each one is good for.
**Is not:** the adapter internals (see [[Leg-Adapters]]).

## The pool

I add as many Legs as I want, all optional (BR-4):

- several Claude Code accounts, each with its own config directory
- several local models on one or more OpenAI-compatible servers
- OpenCode, Antigravity and Codex accounts, and anything else with an adapter

A Leg is one account (or one local server). Each Leg has a name I choose.

Legs are my data, not built in: what is in the code is the **kinds**
(an adapter and its capability profile each), and I add, rename or
remove Legs of those kinds at any time. On another computer, a fresh
Oraknid starts with no Legs and nothing is copied over, logins
included: I add them there with **Find agents** and log each one in
from its card.

### Models within a Leg

Most agents offer several models, often with effort or thinking levels.
Claude Code, for example, offers Opus, Sonnet and Haiku. The stronger
ones perform better but use more tokens, and they may draw on their own,
tighter hourly, daily or weekly limits. So a Leg lists its **Leg
models**, and each one has its own capability profile, cost and quota
windows:

| Leg | Leg models (examples) |
| :-- | :-- |
| Claude — personal | Opus (effort low/medium/high), Sonnet, Haiku |
| Ollama on localhost | qwen3-coder:30b, llama3.2:3b, … (each installed model) |
| Antigravity (Phase 5) | each model `agy --model` offers, with `--effort` |
| Codex | each model Codex's catalog lists (`codex debug models`), with its reasoning levels (low … ultra) |

- `probe` discovers the available models (from the agent or `/v1/models`
  / `/api/tags`). I can hide any of them.
- **The Eye routes to a Leg model and an effort level, not just to a Leg**
  ([[The-Eye]], [[ADR-013-Model-Aware-Routing]]).
- Quota is tracked at the level the provider limits it. Some windows are
  shared by the whole account (e.g. Claude's 5-hour window), and some
  apply to one model (e.g. Claude's weekly Opus or Sonnet windows). A
  Leg model is only eligible while **all** the windows that apply to it
  have room.

### Plan usage in view ([[ADR-039-Plan-Usage-In-View]], 2026-10-03)

For each Claude Code Leg I see every window of its plan: how full (a
bar and a percentage), when it resets, how old the figure is, and
Oraknid's own tokens in that window by model.

- **Where it comes from.** The official CLI's own `/usage` data, read
  through the Agent SDK's usage request on a session that is never sent
  a message, inside the Leg's sandbox, like the health check: no
  tokens, and Oraknid never touches the login. When that reading isn't
  there (an older CLI; the SDK marks it experimental), the windows come
  from the sessions' rate-limit events, refreshed by a one-word prompt
  on the Leg's cheapest model.
- **Only while I look.** The Overview and a Leg's details ask for fresh
  figures every minute while open; the daemon reads a Leg at most every
  5 minutes, and prompts at most every 15, never while the Leg is busy
  or a session has reported in those 15 minutes.
- **Kept with their time.** Each window is stored with when it was
  seen and where from (`usage` or `session`). A reading that didn't
  change only moves its time; a change is a `leg.quota` event, so its
  history (when it filled and reset) is kept in the event log. A
  model's window (weekly Opus, Sonnet, or one the server names) goes to
  that model's rows, as routing reads it.
- **Shown**: on the Overview, a **Plan usage** card, a row per Leg, the
  Leg closest to a limit first, each Leg's fullest window first; near
  (80%) and at (100%) the limit say so in words. In the Leg's details,
  the same windows larger, the models' share of Oraknid's tokens, and
  the last eight days as a line with each fill and reset.
- **Codex** (ChatGPT plan, [[ADR-057-Codex-Adapter]]): its five-hour
  and weekly windows from Codex's own app server
  (`account/rateLimits/read`), read the same way: no prompt, no tokens,
  inside the sandbox, at most every 5 minutes while I look; never the
  prompt fallback. A usage-limit error in a session ("Try again at
  3:45 PM") rests the Leg until then. With an API key, no windows.
- **Other kinds** say what they have: OpenCode's free models no window,
  Antigravity its quota errors when they come, a local model nothing.

### Finding agents on this machine

**Find agents on this machine** (Legs page) lists what Oraknid can
drive here, so I don't type paths and ports (added 2026-10-02):

- the `claude`, `opencode`, `agy` and `codex` programs, on my `PATH` or
  where their installers put them, with their versions;
- model servers answering on their usual local ports: Ollama (11434),
  LM Studio (1234), llama.cpp (8080) and vLLM (8000), with their
  models.

Each comes with a suggested name and **Create**; **Create all** adds
every one not yet a Leg. One already used by a Leg is marked so, and
can still be created again (another account). Nothing is added without
my click, and nothing of mine is borrowed: a created Claude Code,
Antigravity or Codex Leg still logs in from its own card. Oraknid only looks; it
installs nothing.

### Adding a Leg

1. Pick the kind.
2. Fill in the kind's fields (binary path, config directory, endpoint,
   model). Secrets go to the keychain (BR-13). For Claude Code, an empty
   config directory is created under Oraknid's data, and I log it in from
   its card: **Log in** opens Claude's own sign-in page, and I paste the
   code it shows back into the page (Claude may first email me a
   link to sign in; the code to paste appears after I follow it). Oraknid runs the official
   `claude auth login` for that folder and never sees the password. A Leg is one
   account: one login covers all its models, and it lasts. My own
   `~/.claude` is never a Leg's config directory: the sandbox can write
   there ([[Audit-1]] S1-02). For OpenCode: nothing by default:
   it uses OpenCode's own free models, with no account or key; or a
   provider id, its endpoint, the models and the API key. The Leg keeps
   its own OpenCode data under its home ([[ADR-015-OpenCode-Adapter]]).
   For Antigravity: the `agy` binary, installed by me from Google's
   own installer; **Log in** on its card opens Google's sign-in page
   and I paste the code back, as for Claude Code
   ([[ADR-020-Antigravity-Adapter]]). For Codex: the `codex` binary,
   installed by me from OpenAI's installer, and a CODEX_HOME of the
   Leg's own created under Oraknid's data (never my `~/.codex`); **Log
   in** on its card runs `codex login --device-auth` there and shows
   OpenAI's link and a one-time code I enter on that page, nothing to
   paste back; where device codes are off for my ChatGPT account, its
   browser sign-in, which only completes in a browser on this computer.
   Or an OpenAI API key instead, kept in the keychain
   ([[ADR-057-Codex-Adapter]]).
3. **Test.** Oraknid runs a tiny health prompt, reads the model and
   context window, and reports usage support. A failed test says
   exactly what failed and saves nothing until it passes, or until I
   save it as disabled (2026-10-07: tested before it is saved, "The test
   failed, so nothing was saved: …", with **Save it disabled** in the
   dialog. A Claude Code, Antigravity or Codex Leg signs in, or keeps
   its key, in a home of its own made when it is saved: it is saved,
   and tested at once and again after its sign-in.)
4. A default capability profile for that kind and model is attached. I
   can edit it.

## Health

| State | Meaning | Routing |
| :-- | :-- | :-- |
| `healthy` | Last check and last session fine. | Eligible. |
| `degraded` | Recent errors or slow. | Eligible with a penalty. |
| `rate-limited` | Hit a limit. Reset time known or estimated. | Not eligible until the reset. |
| `unavailable` | Binary missing, server down, auth failed. | Not eligible. Rechecked every 60 s. |
| `disabled` | By me. | Never. |

## Capability profile

Every **Leg model** has one. Its fields are filled from defaults for
that agent and model, from my edits, and from observation.

| Field | Example |
| :-- | :-- |
| `strengths` | `planning`, `architecture`, `implementation`, `debugging`, `refactor`, `tests`, `review`, `docs`, `mechanical`, `summarize`, `classify`, `ui` (each scored 0–5) |
| `contextWindow` | 200000 |
| `costModel` | `subscription` · `free` · `local` · `per-token` (with prices) |
| `quotaWeight` | How fast this model burns the shared window relative to the Leg's cheapest model (e.g. Opus ≈ 5× Haiku). Starts from defaults, then learned from observed window movement. |
| `effortLevels` | Supported effort or thinking levels, and the observed token multiplier of each. |
| `windowLimits` | My estimate of each window's token allowance, used only when the provider reports no utilization. |
| `maxDifficulty` | The hardest task (`low` · `medium` · `high`) this model should take on its own. |
| `quotaModel` | Rolling windows (lengths), or tokens per minute, or none. |
| `rateLimits` | Known limits. |
| `speed` | Observed tokens/s and first-token latency. |
| `tools` | Whether it can edit files, run shell, use MCP, browse. |
| `knownFailures` | Free-text patterns plus detectors, e.g. "claims tests pass without running them". |
| `prior` | `known`, or `unproven` for a free or unknown model: routing starts it low until it proves itself (below). |
| `observed` | Per task kind and effort: attempts, success rate, average tokens and time, escalations. |

**Learning.** `observed` is updated after every attempt. Strength
scores are adjusted slowly from observed success: at most ±0.5 per 20
attempts, so one bad day doesn't rewrite a profile. My manual edits are
kept as overrides and always win over learned values. The UI shows both.

### Known and unproven models (M13.22, 2026-10-04)

A profile's `prior` says whether Oraknid knows the model. A known family
(Claude's Opus, Sonnet and Haiku; Gemini's Pro and Flash; GPT-5 and its
mini; Sonnet or GPT-5 reached through OpenCode's providers, recognised by
name) starts from its default strengths. An **unproven** model, a free
or trial one (OpenCode Zen's `-free` models and `big-pickle`, an
OpenRouter `:free` one) or a name Oraknid doesn't know, starts low:
strengths of 2, `costModel` `free` for the free ones, `maxDifficulty`
`medium`. My override can vouch for one (`prior: known`).

Routing trusts each model from its prior and its record on that kind of
task (on every kind while it has none on this one), as a success rate
with the prior counted as earlier attempts: a known model as three at
70%, so one failure moves it a little; an unproven one as a single
attempt at 40%, so every outcome moves it fast. Two tasks done and an
unproven model counts as proven; one failed and it falls further. Its
`score` term is `(rate − 0.7) × 5`, and the routing record says it in
words ("unproven: no task seen done yet", "4 of 4 research tasks done",
"0 of 1 research tasks done (still unproven)").

Seen 2026-10-04: OpenCode's fourteen free models had a default profile
of 3 everywhere and no cost, and scored above Claude Sonnet on a Claude
Max subscription whose week was at 67% ("right size for the task,
capability 3.0/5, quota cost ×1.0"). Now the same pool gives a medium
research or implementation task to Sonnet; the free models take work
when Claude's windows are kept for hard tasks, or once they have proven
themselves.

### Provider failures (M13.22)

A session that ends on its provider's error is not the task failing.
`providerFailure` reads the error: a model gone at its provider ("Model
is unavailable", "model not found") rests that model 30 min; a 5xx,
"Internal server error", an overloaded or unreachable provider rests the
model 5 min; the account (401/403, a bad key, signed out, no credit, a
usage limit said as an error) rests the whole Leg 15 min; the Leg's own
program breaking under it (OpenCode's database, a crash) rests the Leg
2 min. Each failure in a row doubles the rest, up to four hours. An
error that is none of these is the task's, as before.

The attempt ends `unavailable`: it isn't counted in the task's attempts
(the job blocks after eight failed ones), the model's `observed` record
isn't touched, and the task isn't told to avoid the model for good.
`task.provider-failed` and `leg.cooldown` say what rests, why and until
when; routing leaves a resting model out ("resting until 12:05 UTC after
a provider failure (Internal server error)"). A turn that goes through
ends the rest and the count. When every allowed model rests, the job is
blocked until the first one is back.

The next try goes elsewhere: after one provider failure on a Leg, its
unproven models are not the next try (−1.5); after two in a row, every
model of that Leg gives way to another Leg (−3). A usage limit
(`rate-limited`) isn't counted against the task either; it keeps its
handoff and its rule on other accounts of the same provider (ADR-009).

Rests are kept in memory: a restart forgets them, and a model that
still fails rests again at its next failure.

### Unusable agents, from their own words (M15.1, 2026-10-07)

What sank two jobs on 2026-10-06: Antigravity out of quota for 51 hours
was routed to four times, a model OpenCode had deprecated was chosen, and
a paused Claude was reported as "out of quota". An agent is never routed
to while it is unusable, and the reason is read from its own words and
kept until it clears ([[ADR-052-A-Harness-For-Any-Model]] §4):

| Its words | What Oraknid does |
| :-- | :-- |
| A quota or usage limit with its reset ("Individual quota reached … Resets in 51h49m11s", "try again in 2 hours", "resets at 2026-10-09T14:00Z", a `reset_at`) | The Leg is `rate-limited` until that moment (`usageLimitOf`, `resetsAtFrom`), kept in its row across restarts; without a time, 15 minutes. Antigravity's own reading of its errors reads the same durations. |
| A deprecated model ("Model mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead.") | The model is hidden for good (`deprecateModel`) and the one its provider names is offered in its place: a new row the next probe fills in, or its row shown again (`leg.model-deprecated`, `task.model-deprecated`). |
| A session that can't start | The Leg rests 2 minutes, as a program that broke (above). |
| Paused by me | Never routed to; a blocked job says it is paused and to unpause it. |

None of these counts against the task or the model's record. A job with
nothing usable for a task says, per Leg, the real reason and what to do:
"Claude A is paused in Oraknid: unpause it on its card (Legs) to go on",
"Antigravity is out of quota until Thursday 14:00", "Opencode can't be
used: not logged in", and when it goes on by itself.

### The ladder (M15.3, 2026-10-07)

Every model has a **rung per kind of work**: code, server, research,
docs, review, planning (`rungOf`, `workKindOf`). The first order comes
from its profile: the hardest work it is made for first, then its
strength at what that work needs (code: implementation, debugging,
tests; research: summarize, docs, review; planning: planning,
architecture…), moved by its trust on that kind of task. Until a model
has outcomes the order is its profile's, an estimate.

A task starts on the cheapest model likely to do it (routing above).
When a model fails it (a real failure: its checks fail after it ended
its turn, the review says it's wrong, drift that reassigns or kills),
the task's next route leaves out every model on that rung or below
(`not above the model that failed this task (the ladder goes up)`), and
the next one up takes it with a handoff saying what failed. At the top
of the ladder, the strongest allowed model takes it again, and corrects
in its own session. Its failure is recorded in the model's `observed`
record, so a model that needed help on a kind of work starts it lower in
trust next time, and one that succeeds is trusted more. A pause, a
restart, a quota or a provider failure is never recorded against it.

**A job's Claude share** (budget `claudeShare`, else Settings → Eye & jobs → Jobs at once,
`work.claudeShare`; unset: as needed) is the most of its attempts that
may run on Claude: past it, Claude takes a task only when nothing else
can.

## Leg adapter contract

Every Leg kind implements the same operations (detailed in
[[Leg-Adapters]]): `start`, `send`, `stream`, `interrupt`, `resume`,
`kill`, `usage`, and permission handling. Adding a Leg kind means
writing an adapter and a default capability profile. Nothing else in
Oraknid changes.

## Leg kinds and phases

| Kind | Phase | Notes |
| :-- | :-- | :-- |
| `claude-code` | MVP | Subscription accounts. |
| `openai-compatible` | MVP | Ollama, LM Studio, llama.cpp, vLLM. Tested on Ollama + NVIDIA. |
| `opencode` | Phase 2 | |
| `antigravity` | Phase 5 | Runs unattended; a real job passed on 2026-10-02 ([[Leg-Adapters]]). |
| `codex` | 2026-10-07 | OpenAI's Codex CLI, headless ([[ADR-057-Codex-Adapter]]): a ChatGPT plan or an API key. Built against a stand-in following codex-cli 0.161.0; not yet run on a real job. Default profile: GPT's frontier models (Sol, Astra, Terra, GPT-5.x) at 4–5 with implementation, debugging, refactoring, tests and review at 5, hard tasks, `subscription`, quota weight 3; mini, nano and luna models at 3–4, medium. Estimated, like every default, until outcomes move them; routing gives them rungs from the profile, and a job's Claude share doesn't count them. |
| `oraknid-agent` | Phase 15 | Oraknid's own tool loop over any OpenAI-compatible model ([[ADR-052-A-Harness-For-Any-Model]] §6); the **Local** Leg of [[ADR-054-Local-Models]] is one, kept by the Models page. Built 2026-10-07 against stand-ins; not yet run on a real model. |

### Oraknid's own agent and the Local Leg (2026-10-07)

An `oraknid-agent` Leg is added by hand (an endpoint such as OpenRouter,
its models, a key) or made by the Models page as **Local** with the first
loaded chat model; the Local Leg's models are exactly the loaded ones, and
it runs one session per loaded model at once. Its probe tests each
model's **tool calling** with one tiny request (native, through a JSON
grammar, or none) and keeps the answer on the model's profile (`probed`):
a model that can't call tools gets strengths only for `summarize` and
`classify`, no file or shell tools, and the known failure "doesn't call
tools: text work only". Its default profile follows the model's family
like OpenCode's: a known middle model starts at 3 (medium), an unknown
local one at 2, unproven, low difficulty; `costModel` `local`. A Leg
whose every address is on this computer, or the Local Leg, isn't remote.
The OpenAI-compatible kind's probe tests tool calling the same way.

A task whose Legs are all local models waits while every GPU is 90% full
([[ADR-050-Parallel-By-Default]], the check of [[ADR-016-Parallel-Work]]).

Related: [[The-Eye]] · [[Leg-Adapters]] · [[Budgets-and-Quotas]] · [[ADR-009-Multiple-Accounts-Per-Provider]]
