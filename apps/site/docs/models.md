# Local models

**Models** (in the sidebar, or `g e`) runs models on your own computer: for translating, reading text in images, turning speech into text, embeddings, sorting mail and simple coding steps, so not everything goes to a hosted agent. Nothing leaves the machine; Claude is still there when the work needs it.

## Getting llama.cpp

Oraknid runs models with [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`. Install it with:

```sh
sh install.sh --local-models
```

It takes llama.cpp's latest release from GitHub, the build for your GPU (CUDA, ROCm or Vulkan, falling back to the CPU when that build doesn't run here), checks it against its digest, and puts it in Oraknid's data folder (`~/.local/share/oraknid/bin/llama.cpp`). A `llama-server` already on your `PATH` is used as it is. On a computer with a GPU, `install.sh` without the option says you can.

An **Ollama** already running on this computer works too: its models show up on the page, and when `llama-server` isn't installed, downloads are pulled into Ollama instead.

Speech to text uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which has no ready-made Linux build: install it from your distribution or build it, and put `whisper-cli` on your `PATH` (or in `~/.local/share/oraknid/bin/whisper.cpp`).

## Finding a model

**Find a model** searches Hugging Face's GGUF models and Ollama's library. Each result shows what it is good at (text, vision, speech, embedding), its licence and how often it is downloaded, and each of its files with its quantisation (Q4_K_M, Q8_0 …), its size, and whether it **fits this computer**:

- **fits the GPU**: the whole model on your graphics card, the fastest;
- **GPU and memory**: part on the GPU, the rest in memory, slower;
- **CPU, slow**: in memory only;
- **too big**: more than this computer has free, or more than the disk can take.

**Fits this computer** keeps only the files that do.

## Downloading

**Download** shows the licence, the size and the fit first. The file goes to `~/.local/share/oraknid/models`; a vision model's projector comes with it. The download shows its progress; **Pause** keeps what is there and **Resume download** goes on from it, also after a restart. Every file is checked against the checksum its source gives; one that doesn't match is deleted and the model marked failed. A download is refused when the disk would fall under its floor (set in Settings, 2 GB by default).

## Running a model

**Load** starts the model on a port of this computer only (one `llama-server` per model), or loads it in Ollama. It loads only when there is room: the GPU stays under 90% and memory keeps its floor; idle models are unloaded first to make room. Once loaded it shows its measured speed (tokens a second), the VRAM and memory it holds, its context and how many of its layers are on the GPU. **Settings** keeps it loaded, or unloads it after some idle minutes (15 by default), and sets its context and GPU layers (automatic unless you set them). When the computer is short of memory, an idle model is the first thing Oraknid unloads, before pausing any work.

## The Local Leg

Each loaded chat model becomes a model of the **Local** Leg, Oraknid's own agent: The Eye can hand it tasks like any other Leg, and Chats can talk to it. Loading tests whether the model calls tools; one that can't does only text work (summarising, sorting, translating). See [Legs](legs.html#oraknids-own-agent).

## Roles

**Roles** says which model does what: *translate*, *OCR / vision*, *speech to text*, *embeddings*, *mail*, *simple code* and *general*. Until you choose, Oraknid suggests one for each among your models. Every agent, Claude included, can then call them through the **local-models** tool: `translate`, `summarize`, `ocr` (an image in the job's project), `transcribe` (an audio file in the job's project) and `embed`. A role's model loads by itself when the tool needs it.

## Removing a model

**Remove** unloads it and deletes its files. A model in Ollama leaves Oraknid's list but stays in Ollama (`ollama rm` removes it there).
