# Legs

A **Leg** is an agent or model Oraknid hands tasks to. You can have as many as you like; The Eye uses them side by side.

| Kind | What it is | How it signs in |
| :-- | :-- | :-- |
| Claude Code | Anthropic's coding agent, through its official binary | Its own sign-in, from the Leg's card |
| OpenCode | The open coding agent, with any provider it supports | A key, or its free models |
| Antigravity | Google's agent CLI | Google sign-in, from the Leg's card |
| OpenAI-compatible | Any API that speaks it: Ollama, llama.cpp, a hosted model | An address and, if needed, a key |

## Adding Legs

**Legs → Find agents on this computer** lists what is installed and adds it. You can also add one by hand. Each Leg gets a folder of its own: your personal agent settings are never used or changed.

## Models, strengths and quotas

Each Leg lists its models. You can hide the ones you don't want used, and give each Leg its strengths (planning, implementation, review, docs). Oraknid follows each account's usage windows: when one runs out, the work moves to another Leg with a handoff, and nothing is lost. **Plan usage** on the Overview, and each Leg's details, show how full each window is, when it resets, and Oraknid's share of it.

## The Eye's own models

The Eye borrows a Leg for its reasoning. In **Settings → Eye & jobs** you can pin a model per kind of decision: planning, judging, quick calls, and a shadow planner that plans every job too, for comparison only.
