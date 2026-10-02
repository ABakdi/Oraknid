# ADR-025 — Chats are Leg sessions that only read and research

**Status:** Accepted · 2026-10-02 · [[Phase-8-Daily-Use]]

## Context
I want a ChatGPT-style page to talk to any of my models: mostly talk and
research, sometimes about a project of mine, which it should then be
able to read. My Legs are agents (Claude Code, OpenCode, Antigravity)
or bare models (OpenAI-compatible).

## Decision
- **A chat is a Leg session** on the Leg and model I pick, through the
  same adapters and supervisor as a task, so logins, quotas, usage and
  limits work as everywhere else. Its native session is resumed when I
  come back, where the adapter supports it.
- **It runs in a folder of its own** under Oraknid's data, inside the
  sandbox. Projects I attach to the chat are added **read-only**.
- **What it may do**: read, list and search files (its folder and the
  attached projects), and research the web (fetch, search). Everything
  else (writing, editing, commands, MCP) is refused with the reason, by
  a fixed chat policy, not the job policy. Web content is untrusted
  (BR-15), so it can't change what the chat may do.
- A chat isn't a job: no plan, no checks, no Silk. It is kept with its
  messages, named from its first message (renamable), and deletable.
- Usage is counted per Leg like any session, under "chats".

## Consequences
- Every Leg kind can chat, with the tools its agent has.
- Attaching a project gives the model its files to read, nothing more:
  to change a project I start a job.

Related: [[Chats-and-Helper]] · [[Sandboxing]] · [[Leg-Adapters]]
