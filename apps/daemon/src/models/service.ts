import { type ChildProcess, execFile, type spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import {
  type CatalogEntry,
  type LocalModelView,
  type ModelDownload,
  type ModelKind,
  ModelRole,
  ModelRunSettings,
  type ModelSearch,
  type ModelSettingsPatch,
  type ModelsStatus,
  type ResourceThresholds,
  type ToolCalling,
} from "@oraknid/contracts";
import { admitModel, type MachineReading } from "@oraknid/core";
import { testToolCalling } from "@oraknid/leg-oraknid-agent";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { localModels } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { diskSpace } from "../resources/disks.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { Catalog, type CatalogSources } from "./catalog.ts";
import { download } from "./download.ts";
import { type MachineRoom, runPlan } from "./fit.ts";
import { readGguf } from "./gguf.ts";
import {
  binDirs,
  findProgram,
  freePort,
  measureSpeed,
  OllamaClient,
  type Running,
  startLlamaServer,
} from "./runtime.ts";

// Local models (ADR-054): found, downloaded, run, given roles and used
// everywhere. One llama-server per loaded model on a free local port (or
// the model loaded in an Ollama already here); each loaded chat model is a
// model of the Local Leg (oraknid-agent, ADR-052 §6); a model loads only
// when the machine has room (ADR-050), and the idle ones go first.

export type ModelRow = typeof localModels.$inferSelect;

export const ROLES_SETTING = "models.roles";
const Roles = z.partialRecord(ModelRole, z.string());

const run = promisify(execFile);
const GB = 1024 ** 3;

export interface LocalModelsOptions {
  db: Db;
  bus: EventBus;
  registry: LegRegistry;
  /** Tests a Leg again (its models and health). */
  checkLeg: (id: string) => Promise<void>;
  dataDir: string;
  now?: () => number;
  /** The machine now (ADR-050). */
  reading: () => MachineReading | null;
  thresholds: () => ResourceThresholds;
  /** An open danger incident's message. */
  danger: () => string | null;
  /** The models the Local Leg's sessions use right now, by name. */
  inUse?: () => Set<string>;
  /** What a model's server holds, from the metrics (by its process). */
  processOf?: (pid: number) => { rssBytes: number; vramBytes: number } | null;
  /** The folders a job's files may be read from (its project's), for the ocr and transcribe tools. */
  jobFolders?: (jobId: string | null) => string[];
  fetch?: typeof fetch;
  catalog?: CatalogSources;
  /** Ollama's address; null: never use one. */
  ollamaUrl?: string | null;
  programs?: { llamaServer?: () => string | null; whisper?: () => string | null };
  spawn?: typeof spawn;
  idleCheckMs?: number;
  loadTimeoutMs?: number;
}

interface Loaded {
  baseUrl: string;
  port: number | null;
  running: Running | null;
  contextSize: number | null;
  gpuLayers: number | null;
  since: number;
}

interface Pending {
  abort: AbortController;
  done: number;
  total: number;
  rate: number;
  at: number;
}

/** Each role's kind of model, for suggesting one (ADR-054 → Roles). */
const ROLE_KIND: Record<ModelRole, ModelKind> = {
  translate: "text",
  ocr: "vision",
  transcribe: "speech",
  embed: "embedding",
  mail: "text",
  code: "text",
  general: "text",
};

const isChat = (kinds: string[]) => kinds.includes("text") || kinds.includes("vision");

export class LocalModels {
  readonly dir: string;
  readonly catalog: Catalog;
  readonly #http: typeof fetch;
  readonly #now: () => number;
  readonly #loaded = new Map<string, Loaded>();
  readonly #loading = new Map<string, Promise<void>>();
  readonly #pending = new Map<string, Pending>();
  readonly #ollama: OllamaClient | null;
  #ollamaSeen: { at: number; version: string | null } = { at: 0, version: null };
  #timer: NodeJS.Timeout | null = null;
  #stopped = false;

  constructor(private readonly o: LocalModelsOptions) {
    this.dir = join(o.dataDir, "models");
    this.#http = o.fetch ?? fetch;
    this.#now = o.now ?? Date.now;
    this.catalog = new Catalog({ fetch: this.#http, ...o.catalog });
    const url = o.ollamaUrl === undefined ? ollamaFromEnv() : o.ollamaUrl;
    this.#ollama = url ? new OllamaClient(url, this.#http) : null;
  }

  // ── Starting and stopping ──────────────────────────────────────────

  /** Downloads cut by a restart wait as paused; models kept loaded load again. */
  async start() {
    for (const row of this.#rows())
      if (row.state === "downloading") this.#set(row.id, { state: "paused" });
    await this.#syncLeg();
    await this.syncOllama().catch(() => {});
    for (const row of this.#rows())
      if (row.state === "ready" && this.settingsOf(row).keepLoaded)
        void this.load(row.id).catch((e) =>
          console.warn(`keeping ${row.name} loaded failed:`, e.message),
        );
    this.#timer = setInterval(() => void this.unloadIdle(), this.o.idleCheckMs ?? 60_000);
    this.#timer.unref();
  }

  async stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    for (const p of this.#pending.values()) p.abort.abort();
    await Promise.all([...this.#loaded.keys()].map((id) => this.#stopServer(id)));
  }

  // ── What there is ──────────────────────────────────────────────────

  #rows(): ModelRow[] {
    return this.o.db.select().from(localModels).orderBy(localModels.createdAt).all();
  }

  get(id: string): ModelRow {
    const row = this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
    if (!row) throw new Error(`No model ${id}.`);
    return row;
  }

  settingsOf(row: ModelRow): ModelRunSettings {
    const parsed = ModelRunSettings.safeParse(row.settings);
    return parsed.success ? parsed.data : ModelRunSettings.parse({});
  }

  list(): LocalModelView[] {
    const roles = this.roles();
    return this.#rows().map((row) => this.view(row, roles));
  }

  view(row: ModelRow, roles = this.roles()): LocalModelView {
    const loaded = this.#loaded.get(row.id);
    const pending = this.#pending.get(row.id);
    const pid = loaded?.running?.child.pid ?? null;
    const held = pid ? (this.o.processOf?.(pid) ?? null) : null;
    return {
      id: row.id,
      source: row.source,
      repo: row.repo,
      file: row.file,
      name: row.name,
      runner: row.runner,
      state: loaded
        ? "loaded"
        : this.#loading.has(row.id)
          ? "loading"
          : (row.state as LocalModelView["state"]),
      error: row.error,
      sizeBytes: row.sizeBytes,
      quant: row.quant,
      kinds: row.kinds as ModelKind[],
      license: row.license,
      contextLength: row.contextLength,
      download:
        row.state === "downloading" || row.state === "paused"
          ? {
              doneBytes: pending?.done ?? row.doneBytes,
              totalBytes: pending?.total || row.sizeBytes,
              bytesPerSec: pending?.rate ?? 0,
            }
          : null,
      loaded: loaded
        ? {
            baseUrl: loaded.baseUrl,
            port: loaded.port,
            pid,
            contextSize: loaded.contextSize,
            gpuLayers: loaded.gpuLayers,
            vramBytes: held?.vramBytes ?? null,
            rssBytes: held?.rssBytes ?? null,
            since: loaded.since,
          }
        : null,
      tokensPerSec: row.tokensPerSec,
      toolCalls: (row.toolCalls as ToolCalling | null) ?? null,
      settings: this.settingsOf(row),
      roles: ModelRole.options.filter((r) => roles[r] === row.id),
      lastUsedAt: row.lastUsedAt,
      createdAt: row.createdAt,
    };
  }

  runtimes() {
    return {
      llamaServer:
        this.o.programs?.llamaServer?.() ?? findProgram(["llama-server"], binDirs(this.o.dataDir)),
      whisper:
        this.o.programs?.whisper?.() ??
        findProgram(["whisper-cli", "whisper-cpp", "whisper"], binDirs(this.o.dataDir)),
    };
  }

  /** Ollama's version when one answers (looked at most every 30 s). */
  async ollamaVersion(): Promise<string | null> {
    if (!this.#ollama) return null;
    if (this.#now() - this.#ollamaSeen.at < 30_000) return this.#ollamaSeen.version;
    const version = await this.#ollama.version();
    this.#ollamaSeen = { at: this.#now(), version };
    return version;
  }

  /** The machine as fitting and loading read it (ADR-050). */
  room(): MachineRoom {
    const r = this.o.reading();
    mkdirSync(this.dir, { recursive: true });
    const disk = diskSpace([{ label: "the models folder", path: this.dir }])[0];
    return {
      gpus: (r?.gpus ?? []).map((g) => ({
        name: g.name,
        totalBytes: g.totalBytes,
        usedBytes: g.usedBytes,
      })),
      memoryTotal: r?.memoryTotal ?? 0,
      memoryAvailable: r?.memoryAvailable ?? 0,
      diskFree: disk?.freeBytes ?? null,
      minFreeDisk: this.o.thresholds().minFreeDiskBytes,
    };
  }

  async status(): Promise<ModelsStatus> {
    const room = this.room();
    const version = await this.ollamaVersion();
    const rows = this.#rows();
    const effective = this.effectiveRoles();
    return {
      dir: this.dir,
      diskFreeBytes: room.diskFree,
      usedBytes: rows.filter((r) => r.path).reduce((n, r) => n + r.doneBytes, 0),
      diskLow: room.diskFree !== null && room.diskFree < room.minFreeDisk,
      runtimes: {
        ...this.runtimes(),
        ollama: version && this.#ollama ? this.#ollama.url : null,
      },
      machine: {
        gpus: room.gpus,
        memoryTotalBytes: room.memoryTotal,
        memoryAvailableBytes: room.memoryAvailable,
      },
      roles: Object.fromEntries(
        ModelRole.options.map((r) => [r, effective[r] ?? null]),
      ) as ModelsStatus["roles"],
      legId: this.#leg()?.id ?? null,
    };
  }

  // ── Finding ────────────────────────────────────────────────────────

  search(q: ModelSearch) {
    return this.catalog.search(q, this.room());
  }

  async details(source: "huggingface" | "ollama", id: string): Promise<CatalogEntry> {
    const room = this.room();
    if (source === "huggingface") return this.catalog.hfRepo(id, room);
    const entry = await this.catalog.ollamaModel(id, room);
    const tag = entry.files[0]?.name;
    const license = tag ? await this.catalog.ollamaLicense(id, tag).catch(() => null) : null;
    return { ...entry, license };
  }

  // ── Downloading ────────────────────────────────────────────────────

  /**
   * Starts a download into <data>/models/<id> (llama.cpp), or a pull into
   * the Ollama here when llama-server isn't installed and Ollama is.
   */
  async download(input: ModelDownload): Promise<LocalModelView> {
    const room = this.room();
    const llama = this.runtimes().llamaServer;
    const ollama = !llama && (await this.ollamaVersion()) ? this.#ollama : null;
    type Part = { name: string; url: string; sha256: string | null; sizeBytes: number | null };
    let parts: Part[] = [];
    let projector: Part | null = null;
    let kinds: ModelKind[] = ["text"];
    let license: string | null = null;
    let quant: string | null = null;
    let size = 0;
    let name: string;
    let pullName: string | null = null;
    if (input.source === "huggingface") {
      const entry = await this.catalog.hfRepo(input.repo, room);
      const file = entry.files.find((f) => f.name === input.file);
      if (!file) throw new Error(`${input.repo} has no file ${input.file}.`);
      kinds = entry.kinds;
      license = entry.license;
      quant = file.quant;
      size = file.sizeBytes ?? 0;
      name = modelName(entry.name, quant);
      const shas = await this.#hfShas(input.repo);
      parts = file.parts.map((p) => ({
        name: p,
        url: this.catalog.hfUrl(input.repo, p),
        sha256: shas.get(p)?.sha ?? null,
        sizeBytes: shas.get(p)?.size ?? null,
      }));
      if (entry.projector && kinds.includes("vision")) {
        projector = {
          name: entry.projector,
          url: this.catalog.hfUrl(input.repo, entry.projector),
          sha256: shas.get(entry.projector)?.sha ?? null,
          sizeBytes: shas.get(entry.projector)?.size ?? null,
        };
        size += projector.sizeBytes ?? 0;
      }
      if (ollama && quant) pullName = `hf.co/${input.repo}:${quant}`;
    } else {
      const entry = await this.catalog.ollamaModel(input.repo, room);
      kinds = entry.kinds;
      name = `${input.repo}:${input.file}`;
      if (ollama) pullName = name;
      else {
        const layers = await this.catalog.ollamaLayers(input.repo, input.file);
        const model = layers.find((l) => l.mediaType.endsWith(".model"));
        if (!model) throw new Error(`${name} has no model file in Ollama's registry.`);
        const proj = layers.find((l) => l.mediaType.endsWith(".projector"));
        parts = [
          {
            name: `${input.repo.replace(/\//g, "-")}-${input.file}.gguf`,
            url: this.catalog.ollamaBlobUrl(input.repo, model.digest),
            sha256: model.digest.replace(/^sha256:/, ""),
            sizeBytes: model.size,
          },
        ];
        if (proj)
          projector = {
            name: `${input.repo.replace(/\//g, "-")}-${input.file}-mmproj.gguf`,
            url: this.catalog.ollamaBlobUrl(input.repo, proj.digest),
            sha256: proj.digest.replace(/^sha256:/, ""),
            sizeBytes: proj.size,
          };
        size = model.size + (proj?.size ?? 0);
      }
      license = await this.catalog.ollamaLicense(input.repo, input.file).catch(() => null);
    }
    if (room.diskFree !== null && size > room.diskFree - room.minFreeDisk)
      throw new Error(
        `Not enough disk for ${name}: it takes ${(size / GB).toFixed(1)} GB and the disk would fall under its floor of ${(room.minFreeDisk / GB).toFixed(1)} GB.`,
      );
    const taken = new Set(this.#rows().map((r) => r.name));
    let unique = name;
    for (let i = 2; taken.has(unique); i++) unique = `${name}-${i}`;
    const id = newId(this.#now());
    this.o.db
      .insert(localModels)
      .values({
        id,
        source: input.source,
        repo: input.repo,
        file: input.file,
        name: unique,
        runner: pullName ? "ollama" : "llama.cpp",
        state: "downloading",
        path: pullName ? null : join(this.dir, id),
        parts: [...parts, ...(projector ? [projector] : [])].map((p) => ({
          name: p.name,
          sha256: p.sha256,
          sizeBytes: p.sizeBytes,
        })),
        projector: projector?.name ?? null,
        sizeBytes: size,
        quant,
        kinds,
        license,
        settings: {},
        createdAt: this.#now(),
      })
      .run();
    this.#event("model.added", { id, name: unique });
    void this.#fetch(id, pullName, [...parts, ...(projector ? [projector] : [])]);
    return this.view(this.get(id));
  }

  /** The checksums Hugging Face gives for a repository's files. */
  async #hfShas(repo: string) {
    const res = await this.#http(
      `${(this.o.catalog?.huggingface ?? "https://huggingface.co").replace(/\/+$/, "")}/api/models/${repo}?blobs=true`,
      { signal: AbortSignal.timeout(20_000) },
    );
    const body = res.ok
      ? ((await res.json()) as {
          siblings?: {
            rfilename: string;
            size?: number;
            lfs?: { sha256?: string; size?: number };
          }[];
        })
      : {};
    return new Map(
      (body.siblings ?? []).map((s) => [
        s.rfilename,
        { sha: s.lfs?.sha256 ?? null, size: s.lfs?.size ?? s.size ?? null },
      ]),
    );
  }

  /** Runs a download (or an Ollama pull) to its end, a pause, or a failure. */
  async #fetch(
    id: string,
    pullName: string | null,
    parts: { name: string; url: string; sha256: string | null; sizeBytes: number | null }[],
  ) {
    const row = this.get(id);
    const abort = new AbortController();
    const pending: Pending = {
      abort,
      done: row.doneBytes,
      total: row.sizeBytes,
      rate: 0,
      at: this.#now(),
    };
    this.#pending.set(id, pending);
    let lastEvent = 0;
    const progress = (done: number, total: number | null) => {
      const now = this.#now();
      const dt = (now - pending.at) / 1000;
      if (dt > 0.5) {
        pending.rate = Math.max(0, (done - pending.done) / dt);
        pending.at = now;
      }
      pending.done = done;
      if (total) pending.total = total;
      if (now - lastEvent >= 1000) {
        lastEvent = now;
        this.o.db.update(localModels).set({ doneBytes: done }).where(eq(localModels.id, id)).run();
        this.#event("model.progress", { id, done, total: pending.total });
      }
    };
    try {
      if (pullName && this.#ollama) {
        await this.#ollama.pull(pullName, progress, abort.signal);
        this.#set(id, { state: "ready", error: null, doneBytes: pending.total, name: pullName });
      } else {
        const folder = join(this.dir, id);
        mkdirSync(folder, { recursive: true });
        let before = 0;
        for (const part of parts) {
          await download({
            url: part.url,
            dest: join(folder, basename(part.name)),
            sha256: part.sha256,
            fetch: this.#http,
            signal: abort.signal,
            onProgress: (done) => progress(before + done, pending.total),
          });
          before += statSync(join(folder, basename(part.name))).size;
        }
        const first = parts.find((p) => p.name !== this.get(id).projector);
        const meta = first ? readGguf(join(folder, basename(first.name))) : null;
        this.#set(id, {
          state: "ready",
          error: null,
          doneBytes: before,
          sizeBytes: before,
          contextLength: meta?.contextLength ?? null,
          layers: meta?.layers ?? null,
        });
      }
      this.#event("model.state", { id, state: "ready" });
    } catch (error) {
      if (abort.signal.aborted) {
        if (!this.#stopped && this.#exists(id)) {
          this.#set(id, { state: "paused", doneBytes: pending.done });
          this.#event("model.state", { id, state: "paused" });
        }
      } else if (this.#exists(id)) {
        this.#set(id, { state: "failed", error: (error as Error).message });
        this.#event("model.state", { id, state: "failed", error: (error as Error).message });
      }
    } finally {
      this.#pending.delete(id);
    }
  }

  #exists(id: string) {
    return !!this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
  }

  pause(id: string) {
    const p = this.#pending.get(id);
    if (!p) throw new Error("That model isn't downloading.");
    p.abort.abort();
  }

  /** Takes a paused or failed download up again where it stopped. */
  resume(id: string): LocalModelView {
    const row = this.get(id);
    if (row.state !== "paused" && row.state !== "failed")
      throw new Error(`${row.name} isn't paused.`);
    if (this.#pending.has(id)) return this.view(row);
    this.#set(id, { state: "downloading", error: null });
    const pullName = row.runner === "ollama" ? row.name : null;
    const urls = row.parts.map((p) => ({
      ...p,
      url:
        row.source === "huggingface"
          ? this.catalog.hfUrl(row.repo, p.name)
          : this.catalog.ollamaBlobUrl(row.repo, `sha256:${p.sha256 ?? ""}`),
    }));
    void this.#fetch(id, pullName, urls);
    return this.view(this.get(id));
  }

  async remove(id: string) {
    const row = this.get(id);
    this.#pending.get(id)?.abort.abort();
    await this.unload(id).catch(() => {});
    if (row.path) rmSync(row.path, { recursive: true, force: true });
    this.o.db.delete(localModels).where(eq(localModels.id, id)).run();
    const roles = this.roles();
    for (const r of ModelRole.options) if (roles[r] === id) delete roles[r];
    writeSetting(this.o.db, ROLES_SETTING, Roles, roles);
    this.#event("model.removed", { id, name: row.name });
  }

  // ── Running ────────────────────────────────────────────────────────

  /** Loads a model (once at a time), admitted like any work (ADR-050). */
  load(id: string): Promise<void> {
    if (this.#loaded.has(id)) return Promise.resolve();
    const busy = this.#loading.get(id);
    if (busy) return busy;
    const p = this.#load(id).finally(() => this.#loading.delete(id));
    this.#loading.set(id, p);
    this.#event("model.state", { id, state: "loading" });
    return p;
  }

  async #load(id: string) {
    const row = this.get(id);
    if (row.state !== "ready") throw new Error(`${row.name} isn't downloaded yet.`);
    if (!isChat(row.kinds) && !(row.kinds as string[]).includes("embedding"))
      throw new Error(
        `${row.name} is a speech model: whisper.cpp uses it when transcribing, nothing to load.`,
      );
    const s = this.settingsOf(row);
    let loaded: Loaded;
    try {
      if (row.runner === "ollama") {
        if (!this.#ollama || !(await this.ollamaVersion()))
          throw new Error(`${row.name} is in Ollama, and no Ollama answers here: start Ollama.`);
        await this.#admit(row, { vramBytes: row.sizeBytes, gpuIndex: 0, ramBytes: 0.5 * GB });
        await this.#ollama.load(row.name, s.keepLoaded ? -1 : s.idleMinutes || 5);
        loaded = {
          baseUrl: this.#ollama.baseUrl,
          port: null,
          running: null,
          contextSize: null,
          gpuLayers: null,
          since: this.#now(),
        };
      } else {
        const binary = this.runtimes().llamaServer;
        if (!binary)
          throw new Error(
            "llama-server isn't installed: run install.sh --local-models, or put llama.cpp's llama-server on the PATH.",
          );
        const model = row.parts.find((p) => p.name !== row.projector);
        if (!row.path || !model) throw new Error(`${row.name} has no file.`);
        const room = this.room();
        const plan = runPlan(
          row.sizeBytes,
          { layers: row.layers, contextLength: row.contextLength },
          room,
          s,
        );
        await this.#admit(row, plan);
        const port = await freePort();
        const running = await startLlamaServer(
          {
            binary,
            model: join(row.path, basename(model.name)),
            projector: row.projector ? join(row.path, basename(row.projector)) : null,
            alias: row.name,
            port,
            contextSize: plan.contextSize,
            gpuLayers: plan.gpuLayers,
            embeddings: (row.kinds as string[]).includes("embedding"),
            logFile: join(this.o.dataDir, "logs", "models", `${row.id}.log`),
          },
          {
            fetch: this.#http,
            ...(this.o.spawn ? { spawn: this.o.spawn } : {}),
            ...(this.o.loadTimeoutMs ? { timeoutMs: this.o.loadTimeoutMs } : {}),
          },
        );
        loaded = {
          baseUrl: running.baseUrl,
          port,
          running,
          contextSize: plan.contextSize,
          gpuLayers: plan.gpuLayers,
          since: this.#now(),
        };
        // A server that ends by itself is no longer loaded: said once, and the Leg told.
        void running.exited.then(() => {
          if (this.#loaded.get(id)?.running !== running) return;
          this.#loaded.delete(id);
          this.#event("model.state", { id, state: "ready", reason: "its server stopped" });
          void this.#syncLeg();
        });
      }
    } catch (error) {
      this.#event("model.state", { id, state: "ready", error: (error as Error).message });
      throw error;
    }
    this.#loaded.set(id, loaded);
    this.#set(id, { lastUsedAt: this.#now() });
    // Measured once loaded: its speed, and how it calls tools (ADR-052 §6).
    const kinds = row.kinds as string[];
    if (isChat(kinds)) {
      const tps = await measureSpeed(this.#http, loaded.baseUrl, row.name);
      const calls = row.toolCalls
        ? (row.toolCalls as ToolCalling)
        : (await testToolCalling(this.#http, loaded.baseUrl, row.name, {})).mode;
      this.#set(id, { tokensPerSec: tps, toolCalls: calls });
    }
    this.#event("model.state", { id, state: "loaded" });
    await this.#syncLeg();
  }

  /** Room for this model, unloading idle ones first when that makes it (ADR-050). */
  async #admit(
    row: ModelRow,
    plan: { vramBytes: number; gpuIndex: number | null; ramBytes: number },
  ) {
    const ask = () =>
      admitModel(
        {
          name: row.name,
          vramBytes: plan.vramBytes,
          gpuIndex: plan.gpuIndex,
          ramBytes: plan.ramBytes,
        },
        this.o.reading(),
        this.o.thresholds(),
        this.o.danger(),
      );
    let v = ask();
    if (!v.ok && v.why !== "danger") {
      const freed = await this.unloadIdle(true);
      if (freed.length) v = ask();
    }
    if (!v.ok) throw new Error(`${row.name} can't load now: ${v.reason}.`);
  }

  async unload(id: string) {
    if (!this.#loaded.has(id)) return;
    await this.#stopServer(id);
    this.#event("model.state", { id, state: "ready" });
    await this.#syncLeg();
  }

  async #stopServer(id: string) {
    const loaded = this.#loaded.get(id);
    if (!loaded) return;
    this.#loaded.delete(id);
    if (loaded.running) await loaded.running.stop();
    else {
      const row = this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
      if (row && this.#ollama) await this.#ollama.unload(row.name);
    }
  }

  /**
   * Unloads models no session uses: after their idle minutes, or all of
   * them (`all`) to make room. Returns their names.
   */
  async unloadIdle(all = false): Promise<string[]> {
    const busy = this.o.inUse?.() ?? new Set<string>();
    const out: string[] = [];
    for (const [id, l] of [...this.#loaded]) {
      const row = this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
      if (!row) continue;
      if (busy.has(row.name)) {
        this.#set(id, { lastUsedAt: this.#now() });
        continue;
      }
      const s = this.settingsOf(row);
      const idleFor = this.#now() - Math.max(row.lastUsedAt ?? 0, l.since);
      if (all || (!s.keepLoaded && s.idleMinutes > 0 && idleFor >= s.idleMinutes * 60_000)) {
        await this.unload(id);
        out.push(row.name);
      }
    }
    return out;
  }

  /** Under danger, idle models go first (ADR-054): what was unloaded, in words, or null. */
  async relieve(): Promise<string | null> {
    const names = await this.unloadIdle(true);
    return names.length
      ? `Unloaded the idle model${names.length === 1 ? "" : "s"} ${names.join(", ")} to free memory.`
      : null;
  }

  setSettings(patch: ModelSettingsPatch): LocalModelView {
    const row = this.get(patch.id);
    const { id: _id, ...rest } = patch;
    const next = ModelRunSettings.parse({ ...this.settingsOf(row), ...rest });
    this.#set(row.id, { settings: next });
    this.#event("model.state", { id: row.id, settings: next });
    return this.view(this.get(row.id));
  }

  /** The loaded models' servers, for the metrics (their memory and VRAM). */
  watched(): { id: string; label: string; pid: number }[] {
    const out: { id: string; label: string; pid: number }[] = [];
    for (const [id, l] of this.#loaded) {
      const pid = l.running?.child.pid;
      if (!pid) continue;
      const row = this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
      out.push({ id: `model:${id}`, label: `Model · ${row?.name ?? id}`, pid });
    }
    return out;
  }

  /** A model was used (a session, a role's tool): its idle time starts again. */
  touch(name: string) {
    const row = this.o.db.select().from(localModels).where(eq(localModels.name, name)).get();
    if (row) this.#set(row.id, { lastUsedAt: this.#now() });
  }

  // ── The Local Leg ──────────────────────────────────────────────────

  #leg() {
    return this.o.registry
      .all()
      .find((l) => l.kind === "oraknid-agent" && (l.config as { local?: unknown }).local === true);
  }

  /** Each loaded chat model is a model of the Local Leg (ADR-054). */
  async #syncLeg() {
    const endpoints = [...this.#loaded.entries()].flatMap(([id, l]) => {
      const row = this.o.db.select().from(localModels).where(eq(localModels.id, id)).get();
      if (!row || !isChat(row.kinds as string[])) return [];
      return [
        {
          model: row.name,
          baseUrl: l.baseUrl,
          displayName: row.name,
          ...(l.contextSize ? { contextWindow: l.contextSize } : {}),
          ...(row.toolCalls ? { toolCalls: row.toolCalls as ToolCalling } : {}),
        },
      ];
    });
    let leg = this.#leg();
    if (!leg && !endpoints.length) return;
    if (!leg) {
      const names = new Set(this.o.registry.all().map((l) => l.name));
      leg = await this.o.registry.create({
        kind: "oraknid-agent",
        name: names.has("Local") ? "Local models" : "Local",
        config: { local: true, models: [], endpoints },
      });
    } else this.o.registry.setConfig(leg.id, { endpoints });
    await this.o.checkLeg(leg.id).catch(() => {});
  }

  /** Models already in the Ollama here become models of Oraknid's own list (ADR-054). */
  async syncOllama() {
    if (!this.#ollama || !(await this.ollamaVersion())) return;
    const have = new Set(this.#rows().map((r) => r.name));
    for (const m of await this.#ollama.tags()) {
      if (have.has(m.name)) continue;
      const [repo = m.name, tag = "latest"] = m.name.split(":");
      const embedding = /embed|bge|minilm|nomic/i.test(m.name);
      this.o.db
        .insert(localModels)
        .values({
          id: newId(this.#now()),
          source: "ollama",
          repo,
          file: tag,
          name: m.name,
          runner: "ollama",
          state: "ready",
          path: null,
          sizeBytes: m.size,
          doneBytes: m.size,
          kinds: embedding
            ? ["embedding"]
            : /llava|vision|vl\b|gemma3/i.test(m.name)
              ? ["text", "vision"]
              : ["text"],
          settings: {},
          createdAt: this.#now(),
        })
        .run();
    }
  }

  // ── Roles ──────────────────────────────────────────────────────────

  roles(): Partial<Record<ModelRole, string>> {
    return readSetting(this.o.db, ROLES_SETTING, Roles, {});
  }

  setRole(role: ModelRole, id: string | null) {
    if (id) {
      const row = this.get(id);
      const kind = ROLE_KIND[role];
      const kinds = row.kinds as ModelKind[];
      if (!kinds.includes(kind) && !(kind === "text" && kinds.includes("vision")))
        throw new Error(`${row.name} isn't a ${kind} model, so it can't ${role}.`);
    }
    const roles = this.roles();
    if (id) roles[role] = id;
    else delete roles[role];
    writeSetting(this.o.db, ROLES_SETTING, Roles, roles);
    this.#event("model.roles", { role, id });
  }

  /** Each role's model: mine, else the one suggested for this computer. */
  effectiveRoles(): Partial<Record<ModelRole, string>> {
    const mine = this.roles();
    const out: Partial<Record<ModelRole, string>> = {};
    for (const r of ModelRole.options) {
      const id = mine[r] ?? this.suggest(r)?.id;
      if (id) out[r] = id;
    }
    return out;
  }

  /** The model suggested for a role: loaded first, then the fastest, then the smallest. */
  suggest(role: ModelRole): ModelRow | null {
    const kind = ROLE_KIND[role];
    const rows = this.#rows().filter((r) => {
      const kinds = r.kinds as ModelKind[];
      if (r.state !== "ready") return false;
      if (kind === "text") return kinds.includes("text");
      if (kind === "vision")
        return kinds.includes("vision") && (r.runner === "ollama" || !!r.projector);
      if (kind === "speech") return kinds.includes("speech");
      return kinds.includes(kind);
    });
    rows.sort(
      (a, b) =>
        Number(this.#loaded.has(b.id)) - Number(this.#loaded.has(a.id)) ||
        (b.tokensPerSec ?? 0) - (a.tokensPerSec ?? 0) ||
        a.sizeBytes - b.sizeBytes,
    );
    return rows[0] ?? null;
  }

  /** The model for a role, loaded (ADR-054 → Roles as tools). */
  async forRole(
    role: ModelRole,
    ...fallbacks: ModelRole[]
  ): Promise<{ row: ModelRow; baseUrl: string }> {
    const effective = this.effectiveRoles();
    const id = [role, ...fallbacks].map((r) => effective[r]).find(Boolean);
    if (!id)
      throw new Error(
        `No local model can ${role} yet: download one on the Models page and give it the role "${role}".`,
      );
    const row = this.get(id);
    if (row.runner === "llama.cpp" && (row.kinds as string[]).includes("speech"))
      return { row, baseUrl: "" };
    await this.load(id);
    this.touch(row.name);
    const loaded = this.#loaded.get(id);
    if (!loaded) throw new Error(`${row.name} didn't load.`);
    return { row, baseUrl: loaded.baseUrl };
  }

  async #chat(role: ModelRole, fallbacks: ModelRole[], messages: unknown[]): Promise<string> {
    const { row, baseUrl } = await this.forRole(role, ...fallbacks);
    const res = await this.#http(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: row.name, messages, temperature: 0.1, stream: false }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok)
      throw new Error(`${row.name} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return (body.choices?.[0]?.message?.content ?? "").trim();
  }

  translate(text: string, to: string, from?: string): Promise<string> {
    return this.#chat(
      "translate",
      ["general"],
      [
        {
          role: "system",
          content: `Translate the user's text${from ? ` from ${from}` : ""} into ${to}. Keep its meaning, tone and formatting. Answer with the translation only.`,
        },
        { role: "user", content: text },
      ],
    );
  }

  summarize(text: string, instructions?: string): Promise<string> {
    return this.#chat(
      "mail",
      ["general"],
      [
        {
          role: "system",
          content: `Summarise the user's text concisely and faithfully.${instructions ? ` ${instructions}` : ""} Answer with the summary only.`,
        },
        { role: "user", content: text },
      ],
    );
  }

  async ocr(path: string, jobId: string | null): Promise<string> {
    const file = this.#jobFile(path, jobId);
    const ext = extname(file).slice(1).toLowerCase();
    const mime = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
    }[ext];
    if (!mime) throw new Error("OCR reads images: PNG, JPEG, WebP or GIF.");
    const data = readFileSync(file).toString("base64");
    return this.#chat(
      "ocr",
      [],
      [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe all the text in this image exactly, keeping its layout. Answer with the text only.",
            },
            { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
          ],
        },
      ],
    );
  }

  async embed(texts: string[]): Promise<{ model: string; vectors: number[][] }> {
    const { row, baseUrl } = await this.forRole("embed");
    const res = await this.#http(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: row.name, input: texts }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok)
      throw new Error(`${row.name} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { data?: { embedding: number[]; index?: number }[] };
    return {
      model: row.name,
      vectors: [...(body.data ?? [])]
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((d) => d.embedding),
    };
  }

  /** Speech to text with whisper.cpp (ADR-054): a speech model given the role, and whisper-cli. */
  async transcribe(path: string, jobId: string | null): Promise<string> {
    const file = this.#jobFile(path, jobId);
    const whisper = this.runtimes().whisper;
    if (!whisper)
      throw new Error(
        "whisper.cpp isn't installed: run install.sh --local-models, or put whisper-cli on the PATH.",
      );
    const { row } = await this.forRole("transcribe");
    const model = row.path ? join(row.path, basename(row.parts[0]?.name ?? "")) : null;
    if (!model || !existsSync(model)) throw new Error(`${row.name} has no file for whisper.cpp.`);
    this.touch(row.name);
    const { stdout } = await run(whisper, ["-m", model, "-f", file, "-nt", "-np"], {
      timeout: 30 * 60_000,
      maxBuffer: 32 << 20,
    });
    return stdout.trim();
  }

  /** A job's file, by path inside its project's folder only. */
  #jobFile(path: string, jobId: string | null): string {
    const roots = (this.o.jobFolders?.(jobId) ?? []).filter(existsSync).map((r) => realpathSync(r));
    const real = existsSync(path) ? realpathSync(path) : null;
    if (!real) throw new Error(`${path} does not exist: give the file's full path.`);
    if (!roots.some((r) => real === r || real.startsWith(`${r}/`)))
      throw new Error(`${path} is outside this job's project: only its own files can be read.`);
    return real;
  }

  // ── Plumbing ───────────────────────────────────────────────────────

  #set(id: string, patch: Partial<typeof localModels.$inferInsert>) {
    this.o.db.update(localModels).set(patch).where(eq(localModels.id, id)).run();
  }

  #event(type: string, payload: Record<string, unknown>) {
    this.o.bus.publish({ type, topic: "overview", jobId: null, payload });
  }
}

/** "Qwen2.5-7B-Instruct-GGUF" + Q4_K_M → "qwen2.5-7b-instruct:q4_k_m". */
export function modelName(repoName: string, quant: string | null): string {
  const base = repoName.replace(/[-_.]?gguf$/i, "").toLowerCase();
  return quant ? `${base}:${quant.toLowerCase()}` : base;
}

function ollamaFromEnv(): string {
  const host = process.env.OLLAMA_HOST;
  if (!host) return "http://127.0.0.1:11434";
  const url = host.startsWith("http") ? host : `http://${host}`;
  return url.replace(/\/+$/, "").replace("0.0.0.0", "127.0.0.1");
}

export type { ChildProcess };
