# ADR-066 — The token economy: size is not quota, light calls without an agent, a lean pack, paced windows

**Status:** Accepted · 2026-10-10 · extends [[ADR-013-Model-Aware-Routing]], [[ADR-052-A-Harness-For-Any-Model]] §4, [[ADR-056-The-Harness]], [[ADR-022-Eye-Decision-Models]]

## Context
On 2026-10-10 I wrote: "Groq immediately hit its limit (free Groq has a
generous token limit); this keeps happening with Antigravity, OpenCode
and Codex too: they hit limits way faster than if I use them myself."
Measured on my database over the last three days:

- **Groq**: The Eye's call failed with `413 Request too large for model
  openai/gpt-oss-20b … service tier … on tokens per minute (TPM): Limit
  8000, Requested …`. One request was larger than the free tier's
  tokens a minute. Groq calls it `rate_limit_exceeded`, so Oraknid read
  it as a usage limit and marked Groq "Out of quota" for 15 minutes,
  although nothing was used up and every smaller request would have gone
  through.
- **Per task session**, input plus cache-read tokens averaged:
  Antigravity ~4.8M, OpenCode ~2.0M, Claude ~1.5M, Codex ~0.3M. Agents
  read their whole context again at every step, so what Oraknid puts in
  front of them (the context pack, a whole goal per session) is paid for
  once per step.
- **The Eye's calls**: name-job 43 (!), repair-check 12, triage 4, plan
  3, interview 2… OpenCode ran 82 Eye sessions. Every Eye call started a
  full agent CLI session, with its own large system prompt and tool list,
  even to write one sentence.

Why name-job ran 43 times, read from `eye/naming.ts`:

1. **A draft was named as I typed.** New work saves the draft 600 ms
   after each keystroke; every goal change reset its name to the first
   line and scheduled a naming 15 s later. Each pause in my typing was a
   naming, each one an agent session, and a call still running when the
   goal changed again was thrown away.
2. **Every block was an "ending".** A `blocked` report on a job with work
   done asked for its description as an ending. A job blocked by quota
   blocks again and again (its reason names a new time each time), and
   each block asked once more: more calls on the Legs that were short of
   quota.
3. **The backfill at every start.** Each daemon start (each release I
   install) queued every job still named by its first line, and every
   job whose naming had failed was asked again at the next start.

## Decision

### 1. Size is not quota
A provider refusing a request for its **size** is not a usage limit.
Core's `tooLargeOf` reads it: a 413, "Request too large", "context
length exceeded", "maximum context length", "prompt is too long", or a
tokens-per-minute limit smaller than what one request asked for (Groq:
"Limit 8000, Requested 12446"). When the minute's earlier use made it
too small ("Limit 8000, Used 6100, Requested 2950. Please try again in
7.6s") it stays a rate limit, with its reset. `usageLimitOf` returns
nothing for a request too large, and `unusableOf` says `too-large` with
the provider's numbers.

The model's **largest request** is remembered (the setting
`models.maxRequest`, by Leg model): the limit it named, else a little
under what was refused. Routing leaves out a model whose known largest
request is smaller than the request at hand ("it takes at most 8000
tokens in one request, and this one needs about 9600"): a task's first
request is estimated at its agent's own prompt and tools plus the pack
(9,000 tokens) plus its instructions; one of The Eye's calls at the
agent's 6,000 plus its prompt, or for a direct call (§3) its prompt and
its answer's cap. The task's attempt ends `unavailable`, not counted;
the next model with room takes it, and the Leg stays healthy, never
"Out of quota" for it.

### 2. A job is named once
- Named when it is made. While it is a draft, a goal I change only puts
  its first line back; it is named again **once, as it starts**, and
  only if its goal changed.
- Described once when it is **completed**, or stopped with work done. A
  block is no ending.
- The backfill leaves drafts alone and tries a job at most once a week
  (the setting `eye.namingTried`), however many times the daemon starts.

### 3. Light calls don't need an agent
The Eye's text-in, JSON-out calls that need no tools (naming a job, a
message's triage while the job has a plan, the auto-mode judge's and
the drift judge's first stage, summaries, a job's summary, fixing my
wording, picking a skill) go to a **direct model**: a model behind an
OpenAI-compatible API (an `oraknid-agent` Leg: Groq, OpenRouter, xAI, a
loaded local model; or an `openai-compatible` Leg) asked in one plain
chat completion. One line of system prompt, the call's prompt, its JSON
Schema; no tools, no CLI, no session process. Routed like small work:
healthy, with room, free and local first. Its answer is checked like a
session's (one correction), its tokens recorded as a session of the job
(`attempt_id` `eye:<call>:direct`), so quotas, budgets and reports count
them. A model that refuses the size is remembered (§1) and the next one
asked; a per-minute limit is waited for (§5); a quota marks the Leg as
before. With no direct model, or when all fail, the call goes to an
agent session as before. Calls that read the workspace (a check
repaired, a review of work, plans, the interview) stay agent sessions.

A light call's prompt aims under 2,000 tokens: the job's goal is cut to
1,500 characters for its name, its ending to 2,400; the triage gets its
context cut short (the goal, Silk's latest, the conversation's last
lines). Measured: a name, 604 tokens with its schema; the judge's first
stage, 106; a triage with 200 Silk entries and a long conversation,
2,255. The same name through an agent CLI was the prompt (up to 4,000
characters of goal and 5,000 of ending) on top of the CLI's own system
prompt and tool list, several thousand tokens, read again at each of
its steps.

**Settings → The Eye → Light calls** (`eye.lightCalls`): "A direct model
when there is one" (`auto`, the default), "Always an agent session"
(`agent`), or one direct model, asked first. A quick-call model I chose
that is a direct model is asked first too; one that is an agent Leg is
used when no direct model can answer.

### 4. The context diet
What a session is told before its first message is measured: the
attempt log's **`ContextSize`** event, in tokens: Oraknid's whole system
prompt, the pack, each part of it (task, checks, goal, skill, Silk,
handoff, digest), the rest (repos, git, servers, GitHub) and the opening
message. The agent's own prompt and tools come on top.

The pack aims under **4,000 tokens** (or 15% of a small model's window):

- **Silk as a digest**, under 1,500 tokens: my words in this job whole,
  then decisions and architecture, issues near the task, facts, earlier
  jobs' entries; past its share the least important and oldest go to
  their titles, and the pack says the whole entries are in
  `.oraknid/silk/` for the agent to read. What was cut is summarised in
  the background for the next pack, as before.
- **The handoff**, under 1,200 tokens: its start (the goal, what was
  done) and its end (the state, the traps).
- **The skill**: its short version and the section for the task, under
  2,400 characters; another skill's section under 1,200; the whole
  method written to `.oraknid/skill.md` (out of git) and named: "read the
  section you need there".
- **The checks**: one line each, as before.

On a Keys-like task (a long goal, the canon-driven method, an interview,
twelve decisions, facts, issues, earlier jobs' Silk, a long handoff):
**7,643 tokens before, 3,519 after** (task 88, checks 97, goal 243,
skill 620, Silk 1,382, handoff 1,001).

### 5. Pacing
- **Windows at the pace of their time.** For a window whose length
  Oraknid knows (five hours, a day, a week), how far its use runs ahead
  of its time is its share used minus the share of its time gone by.
  Past a little (0.15), routing scores the Leg lower by that much
  ("its five_hour window is 70% used with 20% of its time gone: spared
  to keep its pace"), so another Leg takes the task. A job I put ahead
  (priority above 0) is urgent and may spend ahead.
- **Per-minute limits are spaced, not hit.** For each direct model,
  Oraknid keeps what it sent in the last minute and its tokens a minute
  (its `x-ratelimit-limit-tokens` header, or a refusal's "Limit N"). A
  call that would overrun it waits for room; a 429 that says to try
  again within a minute is waited out once; past a minute, the next
  model.
- **Scarce Legs compact earlier.** A session on a Leg with a window
  more than 75% used, or used ahead of its pace, compacts its history at
  half its window instead of 80% (`SessionStart.compactAt`, where the
  adapter compacts itself: Oraknid's own agent).

### 6. The report says what each Leg spent
A job's report when it is done or stopped lists, per Leg, the tokens in,
from cache and out (`Tokens · Claude A: 1.2M in · 3.4M from cache · 18k
out`), The Eye's calls and the agents' sessions alike.

## Consequences
- Groq's free tier is used for what fits it: light calls, small
  requests. A task too large for it goes to a model with room, and
  Groq is never shown as out of quota for it.
- The Eye's quick calls no longer spend an agent's quota when a direct
  model is there; with none, nothing changes.
- A job is named at most twice (made, then started with a new goal) and
  described once at its end.
- Limits: the size of a request is estimated (four characters a token);
  the CLIs' own system prompts and tools aren't measured, only Oraknid's
  part; Claude Code, Codex, OpenCode and Antigravity compact on their
  own terms (`compactAt` reaches only Oraknid's agent); pacing knows a
  window's length only for the windows it names (five hours, a day, a
  week); per-minute spacing applies to direct calls, an agent's own
  requests are paced by its CLI.

Related: [[Budgets-and-Quotas]] · [[The-Eye]] · [[Leg-Adapters]] · [[Silk]] · [[Data-Map]]
