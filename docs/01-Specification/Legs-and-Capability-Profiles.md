# Legs and Capability Profiles

**Is:** how agents, accounts and models plug into Oraknid, and how
Oraknid knows what each one is good for.
**Is not:** the adapter internals (see [[Leg-Adapters]]).

## The pool

I add as many Legs as I want, all optional (BR-4):

- several Claude Code accounts, each with its own config directory
- several local models on one or more OpenAI-compatible servers
- later: OpenCode, Antigravity, and anything else with an adapter

A Leg is one account (or one local server). Each Leg has a name I choose.

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

- `probe` discovers the available models (from the agent or `/v1/models`
  / `/api/tags`). I can hide any of them.
- **The Eye routes to a Leg model and an effort level, not just to a Leg**
  ([[The-Eye]], [[ADR-013-Model-Aware-Routing]]).
- Quota is tracked at the level the provider limits it. Some windows are
  shared by the whole account (e.g. Claude's 5-hour window), and some
  apply to one model (e.g. Claude's weekly Opus or Sonnet windows). A
  Leg model is only eligible while **all** the windows that apply to it
  have room.

### Adding a Leg

1. Pick the kind.
2. Fill in the kind's fields (binary path, config directory, endpoint,
   model). Secrets go to the keychain (BR-13). For Claude Code, an empty
   config directory is created under Oraknid's data, and the Leg shows
   the one command to log it in with the official binary. A Leg is one
   account: one login covers all its models, and it lasts. My own
   `~/.claude` is never a Leg's config directory: the sandbox can write
   there ([[Audit-1]] S1-02).
3. **Test.** Oraknid runs a tiny health prompt, reads the model and
   context window, and reports usage support. A failed test says
   exactly what failed and saves nothing until it passes, or until I
   save it as disabled.
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
| `observed` | Per task kind and effort: attempts, success rate, average tokens and time, escalations. |

**Learning.** `observed` is updated after every attempt. Strength
scores are adjusted slowly from observed success: at most ±0.5 per 20
attempts, so one bad day doesn't rewrite a profile. My manual edits are
kept as overrides and always win over learned values. The UI shows both.

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
| `antigravity` | Phase 5 | Depends on whether it can run unattended (see [[Leg-Adapters]]). |

Related: [[The-Eye]] · [[Leg-Adapters]] · [[Budgets-and-Quotas]] · [[ADR-009-Multiple-Accounts-Per-Provider]]
