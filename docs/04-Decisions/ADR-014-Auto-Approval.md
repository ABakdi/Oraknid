# ADR-014 — Auto approval: rules first, then a classifier; I'm asked only when it matters

**Status:** Accepted · 2026-10-01 · [[Checkpoint-1]] · **partly superseded 2026-10-07 by [[ADR-053-Auto-Mode]]**

> Superseded: the classifier's "allow or ask" is now the judge's "allow
> or block" (reasoning-blind, two stages, 10 s), the allow list is the
> guard's (tree-sitter-bash, CC Safety Net, the read-only list), the
> levels are Auto, Careful and Full, and I'm asked only for plans of
> servers, production, what is never automatic and an agent stuck on
> blocks. Still in force: the never-allowed list first, my rules, the
> fixed program lists as the fallback when the guard can't run, and
> the audit of every decision.

## Context
The first real job asked for my approval twelve times, all for harmless
commands (B1-01). Half the cause was a parser that didn't understand the
shell. The other half is the policy itself: at Standard autonomy, any
program not on a fixed allow list asks me. For autonomous work that is
far too often. Claude Code solves the same problem with an "auto" mode:
a model classifier approves or refuses each action and only asks when
it can't decide.

## Decision
A command's verdict comes from four layers, in order:

1. **Never-allowed list** (shipped, absolute) → deny, drift D7.
2. **Gated actions** (push, merge, deploy, publish, send, install,
   delete outside the workspace, spend) → ask me, unless waived; always
   ask when the task read untrusted content (BR-15). These are the
   approvals that are "absolutely needed".
3. **My rules** and the **allow list** (now parsed by a real shell
   lexer, so heredocs, loops and quoted scripts count as one program)
   → allow.
4. **Auto approval** for everything else (Standard and Full): a
   classifier decides *allow* or *ask*.
   - Deterministic first: a program that only reads or writes inside
     the sandbox (interpreters, build tools, test runners, file tools)
     is allowed; anything that reaches the network on its own (`curl`,
     `wget`, `ssh`, `scp`, `rsync`, `nc`…) or touches credentials goes
     to the model.
   - The model: the cheapest healthy Leg with the `classify` strength
     is asked, with the task, the command and the sandbox's limits, for
     `{ decision: "allow" | "ask", reason }`. Its "allow" is cached per
     job for that exact command ([[Audit-1]] S1-07: per set of programs
     was too wide). The command reaches it as JSON data, and it reads no
     files.
   - Fetching and running code, or running inline code, is always
     classified at Standard, even with every program on the allow list.
   - If no Leg can classify, the command asks me (fail safe).

Supervised keeps asking about every unknown program (no auto approval).
Every auto decision is recorded in the audit log with its reason, and
shown on the task.

## Consequences
- A small job should need no approvals beyond the plan (Supervised)
  and real gated actions.
- A classifier can be wrong. The sandbox remains the second wall: an
  approved command still cannot see outside the worktree.
- A few classification calls per job cost tokens; caching keeps them
  rare.

## Why not a longer allow list only
It never ends, and it can't judge a command by what it does (`node -e`
can do anything; it's harmless here only because of the sandbox).

Related: [[Approvals-and-Autonomy]] · [[Security]] · [[ADR-006-Sandbox]] · [[Checkpoint-1]]
