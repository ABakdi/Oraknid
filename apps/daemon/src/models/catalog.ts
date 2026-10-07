import type { CatalogEntry, CatalogFile, ModelKind, ModelSearch } from "@oraknid/contracts";
import { fitOf, type MachineRoom } from "./fit.ts";

// Finding models (ADR-054): Hugging Face's GGUF repositories through its
// public API, and Ollama's library through its site and registry. Every
// file says its size, quantisation and whether it fits this computer.

export interface CatalogSources {
  fetch?: typeof fetch;
  huggingface?: string;
  ollamaWeb?: string;
  ollamaRegistry?: string;
}

export const SOURCES = {
  huggingface: "https://huggingface.co",
  ollamaWeb: "https://ollama.com",
  ollamaRegistry: "https://registry.ollama.ai",
};

const SPLIT = /-(\d{5})-of-(\d{5})\.gguf$/i;
const PROJECTOR = /mmproj/i;

/** Q4_K_M, IQ3_XS, Q8_0, F16, BF16…, from a file's name. */
export function quantOf(name: string): string | null {
  const m = /(?:^|[-_.])(I?Q\d(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i.exec(
    name.replace(SPLIT, ".gguf").replace(/\.gguf$/i, ""),
  );
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** What a model is good at, from its pipeline and tags. */
export function kindsOf(pipeline: string | null | undefined, tags: string[]): ModelKind[] {
  const t = new Set(tags.map((x) => x.toLowerCase()));
  const kinds = new Set<ModelKind>();
  if (pipeline === "automatic-speech-recognition" || t.has("speech") || t.has("audio"))
    kinds.add("speech");
  if (
    pipeline === "feature-extraction" ||
    pipeline === "sentence-similarity" ||
    t.has("embedding") ||
    t.has("embeddings") ||
    t.has("sentence-transformers")
  )
    kinds.add("embedding");
  if (pipeline === "image-text-to-text" || t.has("vision") || t.has("multimodal")) {
    kinds.add("vision");
    kinds.add("text");
  }
  if (!kinds.size || pipeline === "text-generation" || t.has("conversational")) kinds.add("text");
  return [...kinds];
}

const licenseOf = (tags: string[]) =>
  tags.find((t) => t.startsWith("license:"))?.slice("license:".length) ?? null;

interface HfModel {
  id: string;
  author?: string;
  downloads?: number;
  likes?: number;
  tags?: string[];
  pipeline_tag?: string;
  lastModified?: string;
  cardData?: { license?: string };
  siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } }[];
}

/** A repository's GGUF files grouped (split parts as one), its projector apart. */
export function hfFiles(
  siblings: NonNullable<HfModel["siblings"]>,
  room: MachineRoom,
): { files: CatalogFile[]; projector: string | null } {
  // GGUF files for llama.cpp; whisper.cpp's ggml-*.bin for speech.
  const ggufs = siblings.filter(
    (s) => /\.gguf$/i.test(s.rfilename) || /(^|\/)ggml-[\w.-]+\.bin$/i.test(s.rfilename),
  );
  const projectors = ggufs.filter((s) => PROJECTOR.test(s.rfilename));
  const groups = new Map<string, typeof ggufs>();
  for (const s of ggufs) {
    if (PROJECTOR.test(s.rfilename)) continue;
    const key = s.rfilename.replace(SPLIT, "");
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const files: CatalogFile[] = [...groups.values()].map((parts) => {
    const sorted = [...parts].sort((a, b) => a.rfilename.localeCompare(b.rfilename));
    const first = sorted[0] as (typeof parts)[number];
    const sizes = sorted.map((p) => p.lfs?.size ?? p.size ?? null);
    const size = sizes.every((x) => x !== null)
      ? (sizes as number[]).reduce((a, b) => a + b, 0)
      : null;
    return {
      name: first.rfilename,
      parts: sorted.map((p) => p.rfilename),
      sizeBytes: size,
      quant: quantOf(first.rfilename),
      sha256: sorted.length === 1 ? (first.lfs?.sha256 ?? null) : null,
      fit: fitOf(size, room),
    };
  });
  files.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0));
  // The F16 projector when there is one: the most faithful, and small.
  const projector =
    projectors.find((p) => /f16/i.test(p.rfilename))?.rfilename ?? projectors[0]?.rfilename ?? null;
  return { files, projector };
}

export class Catalog {
  readonly #http: typeof fetch;
  readonly #hf: string;
  readonly #web: string;
  readonly #registry: string;

  constructor(o: CatalogSources = {}) {
    this.#http = o.fetch ?? fetch;
    this.#hf = (o.huggingface ?? SOURCES.huggingface).replace(/\/+$/, "");
    this.#web = (o.ollamaWeb ?? SOURCES.ollamaWeb).replace(/\/+$/, "");
    this.#registry = (o.ollamaRegistry ?? SOURCES.ollamaRegistry).replace(/\/+$/, "");
  }

  async #json<T>(url: string): Promise<T> {
    const res = await this.#http(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "user-agent": "Oraknid" },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /** Both sources at once; one failing still gives the other's (with what failed). */
  async search(
    q: ModelSearch,
    room: MachineRoom,
  ): Promise<{ entries: CatalogEntry[]; problems: string[] }> {
    const problems: string[] = [];
    const tasks: Promise<CatalogEntry[]>[] = [];
    if (q.source !== "ollama")
      tasks.push(
        this.searchHf(q, room).catch((e: Error) => {
          problems.push(`Hugging Face: ${e.message}`);
          return [];
        }),
      );
    if (q.source !== "huggingface")
      tasks.push(
        this.searchOllama(q, room).catch((e: Error) => {
          problems.push(`Ollama: ${e.message}`);
          return [];
        }),
      );
    let entries = (await Promise.all(tasks)).flat();
    if (q.kind) entries = entries.filter((e) => e.kinds.includes(q.kind as ModelKind));
    if (q.fitsOnly)
      entries = entries
        .map((e) => ({
          ...e,
          files: e.files.filter((f) => f.fit.fits === "yes" || f.fit.fits === "tight"),
        }))
        .filter((e) => e.files.length > 0);
    return { entries, problems };
  }

  async searchHf(q: ModelSearch, room: MachineRoom): Promise<CatalogEntry[]> {
    const params = new URLSearchParams({
      filter: "gguf",
      sort: "downloads",
      direction: "-1",
      limit: String(q.limit),
      full: "true",
    });
    if (q.query.trim()) params.set("search", q.query.trim());
    const found = await this.#json<HfModel[]>(`${this.#hf}/api/models?${params}`);
    return Promise.all(
      found.map(async (m) => {
        // Sizes and checksums come with the repository's own record.
        const full = await this.#json<HfModel>(`${this.#hf}/api/models/${m.id}?blobs=true`).catch(
          () => m,
        );
        return this.#hfEntry(full, room);
      }),
    );
  }

  /** One repository's files, for the page's file list and before a download. */
  async hfRepo(repo: string, room: MachineRoom): Promise<CatalogEntry> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`${repo} isn't a Hugging Face repository.`);
    return this.#hfEntry(
      await this.#json<HfModel>(`${this.#hf}/api/models/${repo}?blobs=true`),
      room,
    );
  }

  #hfEntry(m: HfModel, room: MachineRoom): CatalogEntry {
    const tags = m.tags ?? [];
    const { files, projector } = hfFiles(m.siblings ?? [], room);
    const kinds = kindsOf(m.pipeline_tag, tags);
    if (projector && !kinds.includes("vision")) kinds.push("vision");
    return {
      source: "huggingface",
      id: m.id,
      name: m.id.split("/").at(-1) ?? m.id,
      description: m.pipeline_tag ?? null,
      downloads: m.downloads ?? null,
      likes: m.likes ?? null,
      kinds,
      license: m.cardData?.license ?? licenseOf(tags),
      url: `${this.#hf}/${m.id}`,
      updatedAt: m.lastModified ? Date.parse(m.lastModified) || null : null,
      files,
      projector,
    };
  }

  /** The URL a Hugging Face file downloads from. */
  hfUrl(repo: string, file: string): string {
    return `${this.#hf}/${repo}/resolve/main/${file.split("/").map(encodeURIComponent).join("/")}`;
  }

  async searchOllama(q: ModelSearch, room: MachineRoom): Promise<CatalogEntry[]> {
    const res = await this.#http(`${this.#web}/search?q=${encodeURIComponent(q.query.trim())}`, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "text/html", "user-agent": "Oraknid" },
    });
    if (!res.ok) throw new Error(`ollama.com answered ${res.status}`);
    const listed = parseOllamaSearch(await res.text()).slice(0, q.limit);
    return Promise.all(listed.map((m) => this.#ollamaEntry(m, room)));
  }

  async ollamaModel(name: string, room: MachineRoom): Promise<CatalogEntry> {
    const res = await this.#http(`${this.#web}/search?q=${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(20_000),
    });
    const listed = res.ok ? parseOllamaSearch(await res.text()) : [];
    const m = listed.find((x) => x.name === name) ?? {
      name,
      description: null,
      capabilities: [],
      sizes: [],
      pulls: null,
    };
    return this.#ollamaEntry(m, room);
  }

  async #ollamaEntry(m: OllamaListing, room: MachineRoom): Promise<CatalogEntry> {
    const tags = m.sizes.length ? m.sizes : ["latest"];
    const files = await Promise.all(
      tags.map(async (tag): Promise<CatalogFile> => {
        const layers = await this.ollamaLayers(m.name, tag).catch(() => null);
        const model = layers?.find((l) => l.mediaType.endsWith(".model"));
        const size = model?.size ?? null;
        return {
          name: tag,
          parts: [tag],
          sizeBytes: size,
          quant: null,
          sha256: model ? model.digest.replace(/^sha256:/, "") : null,
          fit: fitOf(size, room),
        };
      }),
    );
    const kinds = new Set<ModelKind>(["text"]);
    if (m.capabilities.includes("vision")) kinds.add("vision");
    if (m.capabilities.includes("embedding")) {
      kinds.add("embedding");
      kinds.delete("text");
    }
    return {
      source: "ollama",
      id: m.name,
      name: m.name,
      description: m.description,
      downloads: m.pulls,
      likes: null,
      kinds: [...kinds],
      license: null,
      url: `${this.#web}/library/${m.name}`,
      updatedAt: null,
      files,
      projector: null,
    };
  }

  /** An Ollama model's layers (its GGUF, projector, licence) from the registry's manifest. */
  async ollamaLayers(
    name: string,
    tag: string,
  ): Promise<{ mediaType: string; digest: string; size: number }[]> {
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name) || !/^[\w.-]+$/.test(tag))
      throw new Error(`${name}:${tag} isn't an Ollama model name.`);
    const path = name.includes("/") ? name : `library/${name}`;
    const res = await this.#http(`${this.#registry}/v2/${path}/manifests/${tag}`, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
    });
    if (!res.ok) throw new Error(`the Ollama registry answered ${res.status} for ${name}:${tag}`);
    return (
      ((await res.json()) as { layers?: { mediaType: string; digest: string; size: number }[] })
        .layers ?? []
    );
  }

  /** A blob of the Ollama registry: a model's GGUF, its projector, its licence. */
  ollamaBlobUrl(name: string, digest: string): string {
    const path = name.includes("/") ? name : `library/${name}`;
    return `${this.#registry}/v2/${path}/blobs/${digest}`;
  }

  /** The first lines of a model's licence, shown before download; null when it has none. */
  async ollamaLicense(name: string, tag: string): Promise<string | null> {
    const layers = await this.ollamaLayers(name, tag);
    const layer = layers.find((l) => l.mediaType.endsWith(".license"));
    if (!layer) return null;
    const res = await this.#http(this.ollamaBlobUrl(name, layer.digest), {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const first = (await res.text()).trim().split("\n")[0] ?? "";
    return first.slice(0, 120) || null;
  }
}

export interface OllamaListing {
  name: string;
  description: string | null;
  capabilities: string[];
  sizes: string[];
  pulls: number | null;
}

/** "1.2M" → 1200000. */
const count = (s: string) => {
  const m = /^([\d.]+)\s*([KMB]?)/i.exec(s.trim());
  if (!m?.[1]) return null;
  const mult = { "": 1, K: 1e3, M: 1e6, B: 1e9 }[(m[2] ?? "").toUpperCase()] ?? 1;
  return Math.round(Number(m[1]) * mult);
};

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/**
 * Ollama's search page read for its models: a link to /library/<name>,
 * its description, and its marked capabilities, sizes and pulls. There is
 * no public search API; this follows the page's own test markers.
 */
export function parseOllamaSearch(html: string): OllamaListing[] {
  const out: OllamaListing[] = [];
  const blocks = html.split(/<li\b[^>]*x-test-model\b/i).slice(1);
  for (const block of blocks) {
    const name = /href="\/library\/([\w.-]+(?:\/[\w.-]+)?)"/.exec(block)?.[1];
    if (!name || out.some((o) => o.name === name)) continue;
    const description = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block)?.[1];
    const all = (marker: string) =>
      [...block.matchAll(new RegExp(`x-test-${marker}[^>]*>([^<]*)<`, "gi"))].map((m) =>
        decode(m[1] ?? "").toLowerCase(),
      );
    const pulls = all("pull-count")[0];
    out.push({
      name,
      description: description ? decode(description) : null,
      capabilities: all("capability"),
      sizes: all("size").filter((s) => /^[\w.]+$/.test(s)),
      pulls: pulls ? count(pulls) : null,
    });
  }
  return out;
}
