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

## As built (2026-10-07)
- **The daemon's `models` module** (`apps/daemon/src/models`): `catalog.ts`
  searches Hugging Face's API (`/api/models?filter=gguf`, each repository's
  files with sizes and SHA-256 from `?blobs=true`; split GGUFs grouped;
  a vision repository's `mmproj` projector kept apart and downloaded with
  it; whisper.cpp's `ggml-*.bin` as speech models) and Ollama's library
  (ollama.com's search page read by its `x-test-*` markers: there is no
  public search API; each size's manifest and licence from
  `registry.ollama.ai`). `fit.ts` says *fits the GPU*, *GPU and memory*,
  *CPU* or *too big* from the GPUs (nvidia-smi through the metrics), the
  memory and the models folder's disk, and plans the GPU layers and
  context (whole on the GPU: all layers and up to 32k context; split:
  layers by the room, read from the file's GGUF header, `gguf.ts`).
- **Downloads** (`download.ts`) go to `<data>/models/<id>/` as a `.part`
  resumed with a Range request, checked against the source's SHA-256
  (Hugging Face's LFS hash, Ollama's layer digest) before taking its
  name; a mismatch deletes it and marks the model failed. A download cut
  by a restart waits as paused. Refused below the disk floor (ADR-050).
- **Running**: `llama-server --model … --alias <name> --host 127.0.0.1
  --port <free> --ctx-size … --n-gpu-layers … --jinja [--mmproj …]
  [--embeddings]`, one per model, its libraries' folder on
  `LD_LIBRARY_PATH`, ready on `/health`; found on the PATH or in
  `<data>/bin/llama.cpp`. Without llama-server but with an Ollama
  (`OLLAMA_HOST` or 127.0.0.1:11434), downloads are pulled into Ollama
  (`hf.co/<repo>:<quant>` for Hugging Face files) and loaded with
  `keep_alive`; Ollama's own models show in the list. Loading measures
  tokens a second (llama.cpp's `timings`, else counted) and tests tool
  calling (ADR-052 §6).
- **Admission**: `admitModel` in `@oraknid/core` — not under danger, the
  model's GPU under 90% after it, memory above its floor; when the answer
  is no, idle models are unloaded and it asks again. The GPU check lost
  from ADR-016 is back in `admit()`: a task only local models may do
  waits while every GPU is 90% full (`gpu`). The guard's `relieve` hook
  unloads idle models before it pauses any task; idle models also go
  after their idle minutes (15 by default, or kept loaded).
- **The Local Leg**: an `oraknid-agent` Leg with `local: true` made with
  the first loaded chat model; its `endpoints` (each model's address,
  context and tool calling) follow what is loaded, so each loaded chat
  model is one of its models, one session per model at once.
- **Roles** in the setting `models.roles`, else suggested (loaded first,
  then the fastest, then the smallest of the right kind). The built-in
  tool `local-models` (`translate`, `summarize`, `ocr`, `transcribe`,
  `embed`) appears once a model is downloaded and is given to every job,
  like the github tool; a role's model loads on demand; `ocr` and
  `transcribe` read only files of the job's project.
- **API** `models.*` (status, list, search, details, download, pause,
  resume, remove, load, unload, settings, setRole) for the Models page and
  the terminal's `/models`. **install.sh `--local-models`**: llama.cpp's
  latest release, the build for this GPU (CUDA, ROCm, Vulkan, then CPU
  when a build doesn't run), checked against GitHub's digest, into
  `<data>/bin/llama.cpp`. whisper.cpp has no Linux release: it is found
  when installed (`whisper-cli`), not installed.
- **Not yet**: choosing another folder for models; Silk search on the
  embeddings role; Chats' own model picker for loaded models beyond the
  Local Leg's; a GPU reading for AMD and Intel (nvidia-smi only), so on
  those the fit counts memory alone.

## Consequences
- `install.sh --local-models` adds llama.cpp (and whisper.cpp); off by
  default on a machine without a GPU, suggested on one with.
- Model files are large: the page shows the disk they use and warns
  under the disk floor of ADR-050.
