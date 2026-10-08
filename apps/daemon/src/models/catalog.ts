import type {
  CatalogEntry,
  CatalogFile,
  ModelKind,
  ModelSearch,
  ModelSearchResult,
} from "@oraknid/contracts";
import { fitOf, type MachineRoom } from "./fit.ts";

// Finding models (ADR-054): Hugging Face's GGUF repositories through its
// public API, and Ollama's library through its site and registry. Every
// file says its size, quantisation and whether it fits this computer.
// What the sources answer is kept ten minutes; Refresh asks them again.

export interface CatalogSources {
  fetch?: typeof fetch;
  huggingface?: string;
  ollamaWeb?: string;
  ollamaRegistry?: string;
  now?: () => number;
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

/** How long a search page, a repository's record or a manifest is kept. */
const CACHE_MS = 10 * 60_000;
const CACHE_MAX = 500;

export class Catalog {
  readonly #http: typeof fetch;
  readonly #hf: string;
  readonly #web: string;
  readonly #registry: string;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(o: CatalogSources = {}) {
    this.#http = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
    this.#hf = (o.huggingface ?? SOURCES.huggingface).replace(/\/+$/, "");
    this.#web = (o.ollamaWeb ?? SOURCES.ollamaWeb).replace(/\/+$/, "");
    this.#registry = (o.ollamaRegistry ?? SOURCES.ollamaRegistry).replace(/\/+$/, "");
  }

  /** A source's answer kept a few minutes (a failure isn't kept); `fresh` asks again. */
  #cached<T>(key: string, load: () => Promise<T>, fresh = false): Promise<T> {
    const now = this.#now();
    const hit = this.#cache.get(key);
    if (hit && !fresh && now - hit.at < CACHE_MS) return hit.value as Promise<T>;
    const value = load();
    this.#cache.set(key, { at: now, value });
    value.catch(() => {
      if (this.#cache.get(key)?.value === value) this.#cache.delete(key);
    });
    if (this.#cache.size > CACHE_MAX)
      for (const [k, v] of this.#cache) if (now - v.at >= CACHE_MS) this.#cache.delete(k);
    while (this.#cache.size > CACHE_MAX) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    return value;
  }

  async #json<T>(url: string): Promise<T> {
    const res = await this.#http(url, {
      signal: AbortSignal.timeout(20_000),
      headers: { accept: "application/json", "user-agent": "Oraknid" },
    });
    if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
    return (await res.json()) as T;
  }

  /**
   * Both sources at once, each giving up to `limit`; one failing still
   * gives the other's (with what failed). With both, the list interleaves
   * them by relevance so neither fills it (`interleave`).
   */
  async search(q: ModelSearch, room: MachineRoom): Promise<ModelSearchResult> {
    const problems: string[] = [];
    const take = (name: string, p: Promise<CatalogEntry[]>) =>
      p.catch((e: Error) => {
        problems.push(`${name}: ${e.message}`);
        return [] as CatalogEntry[];
      });
    const [hfFound, ollamaFound] = await Promise.all([
      q.source === "ollama" ? [] : take("Hugging Face", this.searchHf(q, room)),
      q.source === "huggingface" ? [] : take("Ollama", this.searchOllama(q, room)),
    ]);
    const keep = (entries: CatalogEntry[]) => {
      let out = entries;
      if (q.kind) out = out.filter((e) => e.kinds.includes(q.kind as ModelKind));
      if (q.fitsOnly)
        out = out
          .map((e) => ({
            ...e,
            files: e.files.filter((f) => f.fit.fits === "yes" || f.fit.fits === "tight"),
          }))
          .filter((e) => e.files.length > 0);
      return out;
    };
    const hf = keep(hfFound);
    const ollama = keep(ollamaFound);
    return {
      entries: interleave(q.query, ollama, hf),
      counts: { huggingface: hf.length, ollama: ollama.length },
      problems,
    };
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
    const url = `${this.#hf}/api/models?${params}`;
    const found = await this.#cached(url, () => this.#json<HfModel[]>(url), q.fresh);
    return Promise.all(
      found.map(async (m) => {
        // Sizes and checksums come with the repository's own record.
        const full = await this.#hfRecord(m.id, q.fresh).catch(() => m);
        return this.#hfEntry(full, room);
      }),
    );
  }

  #hfRecord(repo: string, fresh = false): Promise<HfModel> {
    const url = `${this.#hf}/api/models/${repo}?blobs=true`;
    return this.#cached(url, () => this.#json<HfModel>(url), fresh);
  }

  /** One repository's files, for the page's file list and before a download. */
  async hfRepo(repo: string, room: MachineRoom): Promise<CatalogEntry> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
      throw new Error(`${repo} isn't a Hugging Face repository.`);
    return this.#hfEntry(await this.#hfRecord(repo), room);
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

  /**
   * ollama.com's search page, read for its models (`parseOllamaSearch`).
   * When it finds nothing (or fails) and what I typed is a model's name,
   * the registry is asked for that model itself.
   */
  async searchOllama(q: ModelSearch, room: MachineRoom): Promise<CatalogEntry[]> {
    const query = q.query.trim();
    let listed: OllamaListing[] = [];
    let failed: Error | null = null;
    try {
      listed = await this.#ollamaSearchPage(query, q.fresh);
    } catch (error) {
      failed = error as Error;
    }
    if (!listed.length) {
      const named = await this.#ollamaByName(query, q.fresh);
      if (named) listed = [named];
      else if (failed) throw failed;
    }
    return Promise.all(listed.slice(0, q.limit).map((m) => this.#ollamaEntry(m, room, q.fresh)));
  }

  #ollamaSearchPage(query: string, fresh = false): Promise<OllamaListing[]> {
    const url = `${this.#web}/search?q=${encodeURIComponent(query)}`;
    return this.#cached(
      url,
      async () => {
        const res = await this.#http(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "text/html", "user-agent": "Oraknid" },
        });
        if (!res.ok) throw new Error(`ollama.com answered ${res.status}`);
        return parseOllamaSearch(await res.text());
      },
      fresh,
    );
  }

  /** "qwen2.5", "llama3.2:3b": the model itself when the registry has it, else null. */
  async #ollamaByName(query: string, fresh = false): Promise<OllamaListing | null> {
    const m = /^([\w.-]+(?:\/[\w.-]+)?)(?::([\w.-]+))?$/.exec(query.toLowerCase());
    if (!m?.[1]) return null;
    const tag = m[2] ?? "latest";
    const layers = await this.ollamaLayers(m[1], tag, fresh).catch(() => null);
    if (!layers?.some((l) => l.mediaType.endsWith(".model"))) return null;
    return {
      name: m[1],
      description: null,
      capabilities: layers.some((l) => l.mediaType.endsWith(".projector")) ? ["vision"] : [],
      sizes: [tag],
      pulls: null,
    };
  }

  async ollamaModel(name: string, room: MachineRoom): Promise<CatalogEntry> {
    const listed = await this.#ollamaSearchPage(name).catch(() => [] as OllamaListing[]);
    const m = listed.find((x) => x.name === name) ?? {
      name,
      description: null,
      capabilities: [],
      sizes: [],
      pulls: null,
    };
    return this.#ollamaEntry(m, room);
  }

  async #ollamaEntry(m: OllamaListing, room: MachineRoom, fresh = false): Promise<CatalogEntry> {
    const tags = m.sizes.length ? m.sizes : ["latest"];
    const files = await Promise.all(
      tags.map(async (tag): Promise<CatalogFile> => {
        const layers = await this.ollamaLayers(m.name, tag, fresh).catch(() => null);
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
    fresh = false,
  ): Promise<{ mediaType: string; digest: string; size: number }[]> {
    if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name) || !/^[\w.-]+$/.test(tag))
      throw new Error(`${name}:${tag} isn't an Ollama model name.`);
    const path = name.includes("/") ? name : `library/${name}`;
    const url = `${this.#registry}/v2/${path}/manifests/${tag}`;
    return this.#cached(
      url,
      async () => {
        const res = await this.#http(url, {
          signal: AbortSignal.timeout(20_000),
          headers: { accept: "application/vnd.docker.distribution.manifest.v2+json" },
        });
        if (!res.ok)
          throw new Error(`the Ollama registry answered ${res.status} for ${name}:${tag}`);
        const body = (await res.json()) as {
          layers?: { mediaType: string; digest: string; size: number }[];
        };
        return body.layers ?? [];
      },
      fresh,
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

/** A size tag of Ollama's library: 8b, 0.6b, 335m, 16x17b, e4b. */
const SIZE_TAG = /^(?:\d+x)?\d+(?:\.\d+)?[kmbt]$|^e\d+(?:\.\d+)?b$/i;
/** The capabilities ollama.com marks a model with. */
const CAPABILITIES = new Set(["tools", "vision", "embedding", "thinking", "audio", "cloud"]);
const LIBRARY_LINK = /<a\b[^>]*\bhref="(?:https:\/\/ollama\.com)?\/library\/([\w.-]+)"/i;

/**
 * Ollama's search page read for its models. There is no public search API
 * (ollama.com/api/tags lists only its cloud models), so the page is read by
 * what is least likely to change: each model is a link to /library/<name>;
 * its description the first paragraph after it; its capabilities and sizes
 * the short labels between the description and its download count
 * (`title="120,138,678 downloads"`). The page's older `x-test-*` markers,
 * gone from it by October 2026, are still read when present.
 */
export function parseOllamaSearch(html: string): OllamaListing[] {
  const out: OllamaListing[] = [];
  const blocks = html
    .split(/(?=<a\b[^>]*\bhref="(?:https:\/\/ollama\.com)?\/library\/[\w.-])/i)
    .slice(1);
  for (const raw of blocks) {
    const name = LIBRARY_LINK.exec(raw)?.[1];
    if (!name || out.some((o) => o.name === name)) continue;
    // The model's own part: up to the end of its list item, when it has one.
    const block = raw.split(/<\/li>/i)[0] ?? raw;
    const marked = (marker: string) =>
      [...block.matchAll(new RegExp(`x-test-${marker}\\b[^>]*>([^<]*)<`, "gi"))].map((m) =>
        decode(m[1] ?? "").toLowerCase(),
      );
    const para = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const description = para?.[1] ? decode(para[1]) || null : null;
    // Its labels: between the description and the download count.
    const from = para ? para.index + para[0].length : 0;
    const countAt = block.search(/downloads"|pulls"|x-test-pull-count/i);
    const labels = [
      ...block
        .slice(from, countAt > from ? countAt : undefined)
        .matchAll(/<span\b[^>]*>([^<]+)</gi),
    ]
      .map((m) => decode(m[1] ?? "").toLowerCase())
      .filter(Boolean);
    const sizes = [...new Set([...marked("size"), ...labels.filter((l) => SIZE_TAG.test(l))])];
    const capabilities = [
      ...new Set([...marked("capability"), ...labels.filter((l) => CAPABILITIES.has(l))]),
    ];
    const exact = /title="([\d,]+)\s+(?:downloads|pulls)"/i.exec(block)?.[1];
    const shown = marked("pull-count")[0];
    out.push({
      name,
      description,
      capabilities,
      sizes: sizes.filter((x) => /^[\w.]+$/.test(x)),
      pulls: exact ? Number(exact.replace(/,/g, "")) : shown ? count(shown) : null,
    });
  }
  return out;
}

/** "Llama-3.2-3B-Instruct-GGUF" → "llama323binstruct": names compared plainly. */
const plain = (s: string) =>
  s
    .toLowerCase()
    .replace(/[-_.]?gguf$/i, "")
    .replace(/[^a-z0-9]+/g, "");

/**
 * How well a model's name answers a query: 0 named exactly, 1 its name
 * starts with it, 2 has every word of it, 3 otherwise (found by its
 * description or tags).
 */
export function relevance(name: string, query: string): number {
  const q = plain(query);
  if (!q) return 3;
  const n = plain(name.split("/").at(-1) ?? name);
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  const words = query
    .toLowerCase()
    .split(/[\s/,]+/)
    .map(plain)
    .filter(Boolean);
  return words.every((w) => n.includes(w)) ? 2 : 3;
}

/**
 * Both sources' results as one list: by relevance first, then each
 * source's own order taken in turn (Ollama's first, its names being the
 * canonical ones), so neither source fills the list when both found
 * something.
 */
export function interleave(
  query: string,
  ollama: CatalogEntry[],
  hf: CatalogEntry[],
): CatalogEntry[] {
  return [
    ...ollama.map((e, i) => ({ e, i, s: 0, r: relevance(e.name, query) })),
    ...hf.map((e, i) => ({ e, i, s: 1, r: relevance(e.name, query) })),
  ]
    .sort((a, b) => a.r - b.r || a.i - b.i || a.s - b.s)
    .map((x) => x.e);
}
