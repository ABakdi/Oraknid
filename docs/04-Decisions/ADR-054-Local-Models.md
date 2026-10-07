# ADR-054 — Local models: download, run and manage them in Oraknid

**Status:** Accepted · 2026-10-07 · [[Phase-15-Agents-That-Deliver]] · uses [[ADR-050-Parallel-By-Default]], [[ADR-052-A-Harness-For-Any-Model]]

## Context
I want models on my own machine for specialised work: translation, OCR,
speech to text, embeddings, summarising and sorting mail, and simple
coding steps, so Oraknid doesn't lean on Claude for everything, while
Claude is still there when needed. Today a local model is a Leg I set
up myself outside Oraknid (an OpenAI-compatible URL).

## Decision
- **A Models page** (and `/models` in the terminal, [[ADR-055-Terminal-App]]):
  - **Find**: search Hugging Face GGUF repositories and the Ollama
    library, filtered by what fits this machine (VRAM, RAM, disk),
    with each model's size, quantisation, context, licence and what
    it is good at (its card's tags: text, vision, speech, embedding).
  - **Download**: resumable, with progress; into
    `<data>/models` (or a folder I choose); checksum checked.
  - **Run**: through **llama.cpp's `llama-server`** (default; installed
    by `install.sh` when I ask for local models, prebuilt for CUDA,
    Vulkan, ROCm or CPU) or an **Ollama** already on the machine. One
    server per loaded model, on a local port, OpenAI-compatible.
  - **Manage**: load / unload, keep loaded or unload after N idle
    minutes, context size and GPU layers (automatic by default), speed
    (tokens/s, measured), memory and VRAM used, delete.
- **Admitted like any work** (ADR-050): a model loads only when the
  machine has room (VRAM under 90% after it, memory kept free); under
  danger an idle model is the first thing unloaded.
- **Roles**: I give models roles: *translate*, *OCR / vision*,
  *speech to text* (whisper.cpp), *embeddings* (Silk search), *mail*
  (sort, summarise), *simple code*, *general*. Each role has a default
  model when one is installed, suggested once for this machine.
- **Used everywhere**:
  - each loaded chat model is a model of the **local** Leg
    (oraknid-agent, ADR-052) that The Eye routes to by its rung;
  - roles are **tools** every agent may call (`translate`, `ocr`,
    `transcribe`, `embed`), so Claude can hand OCR to a local model;
  - Chats can talk to any loaded model.
- Nothing leaves the machine; a model's licence is shown before download.

## Consequences
- `install.sh --local-models` adds llama.cpp (and whisper.cpp); off by
  default on a machine without a GPU, suggested on one with.
- Model files are large: the page shows the disk they use and warns
  under the disk floor of ADR-050.
