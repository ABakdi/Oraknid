import { z } from "zod";
import { Id, Timestamp } from "./common.ts";
import { ToolCalling } from "./legs.ts";

// Local models (ADR-054): found on Hugging Face or in Ollama's library,
// downloaded into the data folder, run by llama.cpp's llama-server (or an
// Ollama already on the machine), given roles, and used everywhere: each
// loaded chat model a model of the Local Leg (oraknid-agent, ADR-052 §6),
// each role a tool every agent may call.

export const ModelSource = z.enum(["huggingface", "ollama"]);
export type ModelSource = z.infer<typeof ModelSource>;

/** What a model is good at, from its card's tags. */
export const ModelKind = z.enum(["text", "vision", "speech", "embedding"]);
export type ModelKind = z.infer<typeof ModelKind>;

/** What I give a model to do (ADR-054 → Roles). */
export const ModelRole = z.enum([
  "translate",
  "ocr",
  "transcribe",
  "embed",
  "mail",
  "code",
  "general",
]);
export type ModelRole = z.infer<typeof ModelRole>;

/** Whether a file fits this computer: on the GPU, split with the CPU, on the CPU, or not. */
export const ModelFit = z.object({
  fits: z.enum(["yes", "tight", "no", "unknown"]),
  runsOn: z.enum(["gpu", "split", "cpu"]).nullable(),
  /** In words: "fits the GPU (8.0 GB of 12 GB)", "too big: needs 40 GB, 31 GB of memory". */
  note: z.string(),
});
export type ModelFit = z.infer<typeof ModelFit>;

/** One downloadable file (or set of split parts) of a model. */
export const CatalogFile = z.object({
  /** The file in the repository (the first part when split), or Ollama's tag. */
  name: z.string(),
  /** Every part to download, the first being `name`. */
  parts: z.array(z.string()),
  sizeBytes: z.number().int().nonnegative().nullable(),
  /** Q4_K_M, Q8_0, F16…; null when not in the name. */
  quant: z.string().nullable(),
  /** The checksum the source gives, when it gives one. */
  sha256: z.string().nullable(),
  fit: ModelFit,
});
export type CatalogFile = z.infer<typeof CatalogFile>;

/** A model as a source lists it. */
export const CatalogEntry = z.object({
  source: ModelSource,
  /** "bartowski/Qwen2.5-7B-Instruct-GGUF", or Ollama's "qwen2.5". */
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  downloads: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  kinds: z.array(ModelKind),
  /** Shown before download (ADR-054). */
  license: z.string().nullable(),
  url: z.string(),
  updatedAt: Timestamp.nullable(),
  /** Files with sizes and fit; empty until looked at (`models.files`). */
  files: z.array(CatalogFile),
  /** A vision model's projector file, downloaded with it (llama.cpp's --mmproj). */
  projector: z.string().nullable(),
});
export type CatalogEntry = z.infer<typeof CatalogEntry>;

export const ModelSearch = z.object({
  query: z.string().max(200).default(""),
  source: z.enum(["all", "huggingface", "ollama"]).default("all"),
  kind: ModelKind.optional(),
  /** Only what fits this computer. */
  fitsOnly: z.boolean().default(false),
  /** Results from each source (both when "all"). */
  limit: z.number().int().min(1).max(50).default(20),
  /** Asks the sources again instead of the few minutes' cache (Refresh). */
  fresh: z.boolean().default(false),
});
export type ModelSearch = z.infer<typeof ModelSearch>;

/**
 * What a search found: with "all", both sources interleaved by relevance
 * (a model named as asked first, then each source's best in turn), so
 * neither fills the list; how many each gave; what failed.
 */
export const ModelSearchResult = z.object({
  entries: z.array(CatalogEntry),
  counts: z.object({
    huggingface: z.number().int().nonnegative(),
    ollama: z.number().int().nonnegative(),
  }),
  problems: z.array(z.string()),
});
export type ModelSearchResult = z.infer<typeof ModelSearchResult>;

export const ModelDownload = z.object({
  source: ModelSource,
  /** The repository, or Ollama's model name. */
  repo: z.string().min(1).max(200),
  /** The file (the first part when split), or Ollama's tag. */
  file: z.string().min(1).max(300),
});
export type ModelDownload = z.infer<typeof ModelDownload>;

export const ModelRunner = z.enum(["llama.cpp", "ollama"]);
export type ModelRunner = z.infer<typeof ModelRunner>;

export const ModelState = z.enum(["downloading", "paused", "ready", "loading", "loaded", "failed"]);
export type ModelState = z.infer<typeof ModelState>;

/** How a model runs: automatic unless I set them. */
export const ModelRunSettings = z.object({
  keepLoaded: z.boolean().default(false),
  /** Unloaded after this many minutes unused (0: never). */
  idleMinutes: z
    .number()
    .int()
    .min(0)
    .max(24 * 60)
    .default(15),
  contextSize: z
    .union([z.literal("auto"), z.number().int().min(512).max(1_048_576)])
    .default("auto"),
  gpuLayers: z.union([z.literal("auto"), z.number().int().min(0).max(999)]).default("auto"),
});
export type ModelRunSettings = z.infer<typeof ModelRunSettings>;

export const LocalModelView = z.object({
  id: Id,
  source: ModelSource,
  repo: z.string(),
  file: z.string(),
  /** Its name as a model of the Local Leg. */
  name: z.string(),
  runner: ModelRunner,
  state: ModelState,
  error: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  quant: z.string().nullable(),
  kinds: z.array(ModelKind),
  license: z.string().nullable(),
  /** From the file itself (GGUF metadata), when read. */
  contextLength: z.number().int().positive().nullable(),
  download: z
    .object({
      doneBytes: z.number().int().nonnegative(),
      totalBytes: z.number().int().nonnegative(),
      bytesPerSec: z.number().nonnegative(),
    })
    .nullable(),
  /** While loaded: where it answers and what it holds. */
  loaded: z
    .object({
      baseUrl: z.string(),
      port: z.number().int().nullable(),
      pid: z.number().int().nullable(),
      contextSize: z.number().int().nullable(),
      gpuLayers: z.number().int().nullable(),
      vramBytes: z.number().int().nonnegative().nullable(),
      rssBytes: z.number().int().nonnegative().nullable(),
      since: Timestamp,
    })
    .nullable(),
  /** Measured once loaded. */
  tokensPerSec: z.number().nonnegative().nullable(),
  toolCalls: ToolCalling.nullable(),
  settings: ModelRunSettings,
  /** The roles I gave it (a role is one model's at a time). */
  roles: z.array(ModelRole),
  /** Roles nobody was given that fall to it, as suggested for this computer. */
  suggestedRoles: z.array(ModelRole).default([]),
  lastUsedAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type LocalModelView = z.infer<typeof LocalModelView>;

export const ModelSettingsPatch = ModelRunSettings.partial().extend({ id: Id });
export type ModelSettingsPatch = z.infer<typeof ModelSettingsPatch>;

export const ModelsStatus = z.object({
  /** Where models are kept. */
  dir: z.string(),
  diskFreeBytes: z.number().int().nonnegative().nullable(),
  /** What the downloaded models take together. */
  usedBytes: z.number().int().nonnegative(),
  /** Below the disk floor (ADR-050): downloads wait. */
  diskLow: z.boolean(),
  runtimes: z.object({
    llamaServer: z.string().nullable(),
    ollama: z.string().nullable(),
    whisper: z.string().nullable(),
  }),
  machine: z.object({
    gpus: z.array(
      z.object({
        name: z.string(),
        totalBytes: z.number().int().nonnegative(),
        usedBytes: z.number().int().nonnegative(),
      }),
    ),
    memoryTotalBytes: z.number().int().nonnegative(),
    memoryAvailableBytes: z.number().int().nonnegative(),
  }),
  /** Each role's model, by id; null when none. */
  roles: z.record(ModelRole, Id.nullable()),
  /** The Local Leg that offers the loaded chat models, once there is one. */
  legId: Id.nullable(),
});
export type ModelsStatus = z.infer<typeof ModelsStatus>;
