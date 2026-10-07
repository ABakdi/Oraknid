# Legs

A **Leg** is an agent or model Oraknid hands tasks to. You can have as many as you like; The Eye uses them side by side.

| Kind | What it is | How it signs in |
| :-- | :-- | :-- |
| Claude Code | Anthropic's coding agent, through its official binary | Its own sign-in, from the Leg's card |
| OpenCode | The open coding agent, with any provider it supports | A key, or its free models |
| Antigravity | Google's agent CLI | Google sign-in, from the Leg's card |
| OpenAI-compatible | Any API that speaks it: Ollama, llama.cpp, a hosted model | An address and, if needed, a key |
| Oraknid's own agent | Oraknid's tool loop over any model behind an OpenAI-compatible API (OpenRouter, a provider's free endpoint, your local models) | An address and, if needed, a key |

## Adding Legs

**Legs → Find agents on this computer** lists what is installed and adds it. You can also add one by hand. Each Leg gets a folder of its own: your personal agent settings are never used or changed.

## Oraknid's own agent

**Oraknid's own agent** works like Claude Code with any model: it reads, searches and edits files, runs commands in the sandbox, keeps a todo list and fetches pages, calling tools until the task is done, and summarises its earlier work when the model's context fills up. It uses your job's tools (GitHub, mail, the local models' roles) like the other agents, and its sessions are kept, so a retry goes on from where it was.

Add one with **Add a Leg → Oraknid's own agent**: the endpoint (for example `https://openrouter.ai/api/v1`), the models (empty: every model it lists) and a key if it needs one. Its test asks each model to call a tool with one tiny request: a model with native tool calls uses them; one without uses a JSON format the server enforces (llama.cpp and Ollama do); one that can do neither gets only text work (summarising, sorting, translating). Your [local models](models.html) get a Leg of this kind by themselves, called **Local**.

## Models, strengths and quotas

Each Leg lists its models. You can hide the ones you don't want used, and give each Leg its strengths (planning, implementation, review, docs). Oraknid follows each account's usage windows: when one runs out, the work moves to another Leg with a handoff, and nothing is lost. **Plan usage** on the Overview, and each Leg's details, show how full each window is, when it resets, and Oraknid's share of it.

## Which model gets a task

The Eye gives each task the smallest model that will reliably do it, and the task's page says why. Models it knows (Claude's Opus, Sonnet and Haiku, Gemini, GPT) start from what they are known to do well. Free models (OpenCode's `-free` ones and `big-pickle`) and names it doesn't know start **unproven**: they get work when the known models' windows are kept for hard tasks, and earn their place by getting tasks done; a failure costs them quickly. You can vouch for one in its profile.

## When a provider fails

An error from the model's provider ("Internal server error", "Model is unavailable", a bad key, a usage limit) isn't counted as the task failing. The model rests for a while (its whole Leg, for an account's error), longer each time it fails again, and the next try goes to another model; after two such failures in a row on one Leg, to another Leg. The task's page shows the rest and its reason, and a job whose every model rests waits for the first one back.

## The Eye's own models

The Eye borrows a Leg for its reasoning. In **Settings → Eye & jobs** you can pin a model per kind of decision: planning, judging, quick calls, and a shadow planner that plans every job too, for comparison only.
