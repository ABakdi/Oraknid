import type { ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import {
  type CloudAddStep,
  type CloudAuthorization,
  type CloudEntry,
  type CloudKind,
  type CloudListing,
  CloudPlacement,
  type CloudProviderPatch,
  type CloudProviderView,
  type CloudStatus,
  type CloudTransfer,
  NewCloudProvider,
  NewRcloneProvider,
  type RcloneBackend,
  RcloneBackend as RcloneBackendShape,
  type RcloneBackends,
  type RcloneOption,
  type S3Preset,
} from "@oraknid/contracts";
import {
  checkOptions,
  choosePlace,
  formModel,
  formOptions,
  type PlaceCandidate,
  RCLONE_SCHEMA_FORMAT,
  readRcloneOption,
  readRcloneSchema,
  summaryOf,
} from "@oraknid/core";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { cloudProviders } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { RCLONE_FIX, Rclone, rcloneError, rcloneProviders, rcloneVersion } from "./rclone.ts";

// Cloud storage (ADR-046): my providers through rclone, seen as one pool.
// A file lives in one provider; folders are merged by path. Credentials
// are written into Oraknid's encrypted rclone config and nowhere else:
// not SQLite, not a view, not an event, not a command line.

type Row = typeof cloudProviders.$inferSelect;

export const CONFIG_PASSWORD = "cloud.rclone.password";
export const PLACEMENT_SETTING = "cloud.placement";
const DEFAULT_PLACEMENT: CloudPlacement = {
  mode: "auto",
  rule: "free",
  providerId: null,
  largeFromBytes: 100 * 1024 * 1024,
};
/** Free space older than this is asked again before a file is placed. */
const STALE_MS = 5 * 60_000;
/** At most this many results from a search. */
const SEARCH_LIMIT = 500;
/** How long a sign-in in the browser may take. */
const AUTH_MS = 10 * 60_000;

/** rclone's `provider` for each preset. */
const S3_PROVIDER: Record<S3Preset, string> = {
  Minio: "Minio",
  AWS: "AWS",
  R2: "Cloudflare",
  B2: "Other",
  Wasabi: "Wasabi",
  Other: "Other",
};
const PRESET_NAMES: Record<S3Preset, string> = {
  Minio: "MinIO",
  AWS: "AWS S3",
  R2: "Cloudflare R2",
  B2: "Backblaze B2",
  Wasabi: "Wasabi",
  Other: "S3-compatible",
};
export const KIND_NAMES: Record<CloudKind, string> = {
  s3: "Object storage",
  drive: "Google Drive",
  dropbox: "Dropbox",
  mega: "MEGA",
  rclone: "rclone",
};

/** How long an add may wait on rclone's questions (OneDrive's drive …). */
const PENDING_MS = 15 * 60_000;
/** One step of rclone's own setup (`config update`), at most. */
const STEP_MS = 120_000;

/** rclone's answer to one step of a provider's setup (`config update --non-interactive`). */
interface ConfigOut {
  State: string;
  Option: Record<string, unknown> | null;
  Error: string;
}

/** An add of any backend, waiting on an answer to rclone's question. */
interface Pending {
  id: string;
  providerId: string;
  remote: string;
  input: NewRcloneProvider;
  backend: RcloneBackend;
  /** Every secret given, to keep out of what is said. */
  secrets: string[];
  /** Where rclone's setup stands, and what it asks. */
  state: string | null;
  option: RcloneOption | null;
  timer: NodeJS.Timeout;
}

/** A path inside the pool, made plain: no empty parts, never outside. */
export function cleanPath(p: string): string {
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === ".." || s === "." || /[\0\r\n]/.test(s)))
    throw new Error("That path isn't one inside the pool.");
  return parts.join("/");
}

const joinPath = (...parts: string[]) => parts.filter(Boolean).join("/");
const baseName = (p: string) => p.split("/").pop() ?? p;
const parentOf = (p: string) => p.split("/").slice(0, -1).join("/");

/** Characters rclone's filters read as patterns, taken as themselves. */
const globEscape = (s: string) => s.replace(/[\\*?[\]{}]/g, (c) => `\\${c}`);

interface LsItem {
  Path: string;
  Name: string;
  Size: number;
  MimeType?: string;
  ModTime?: string;
  IsDir: boolean;
}

interface AuthSession {
  session: string;
  kind: string;
  state: "waiting" | "ready" | "failed";
  url: string | null;
  error: string | null;
  token: string | null;
  /** More than a token (a drive id …): rclone's own fields for the config. */
  extra: Record<string, string>;
  child: ChildProcess | null;
  expiresAt: number;
}

export interface CloudDeps {
  db: Db;
  bus: EventBus;
  secrets: Secrets;
  dataDir: string;
  now?: () => number;
  /** rclone's binary (tests); found on the PATH otherwise. */
  rclone?: () => string | null;
  /** A provider still in use (a backup plan), in words; null when it isn't. */
  usedBy?: (providerId: string) => string | null;
}

export class Cloud {
  readonly rclone: Rclone;
  readonly #auth = new Map<string, AuthSession>();
  #onTransfer: (t: CloudTransfer) => void = () => {};
  readonly #configFile: string;

  constructor(private readonly d: CloudDeps) {
    const dir = join(d.dataDir, "cloud");
    this.#configFile = join(dir, "rclone.conf");
    this.rclone = new Rclone({
      ...(d.rclone ? { bin: d.rclone } : {}),
      configFile: this.#configFile,
      password: () => this.#password(),
    });
  }

  #now() {
    return this.d.now?.() ?? Date.now();
  }

  /** The config's password: made once, kept in the keychain. */
  async #password(): Promise<string> {
    const kept = await this.d.secrets.get(CONFIG_PASSWORD);
    if (kept) return kept;
    const made = randomBytes(32).toString("base64url");
    await this.d.secrets.set(CONFIG_PASSWORD, made);
    mkdirSync(join(this.d.dataDir, "cloud"), { recursive: true, mode: 0o700 });
    return made;
  }

  /** Where files wait on their way in or out (0700, mine only). */
  tmpDir(): string {
    const dir = join(this.d.dataDir, "tmp", "cloud");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  configFile() {
    return this.#configFile;
  }

  /** Progress of uploads and downloads, for the live socket. */
  onTransfer(fn: (t: CloudTransfer) => void) {
    this.#onTransfer = fn;
  }

  transfer(t: CloudTransfer) {
    try {
      this.#onTransfer(t);
    } catch {}
  }

  #publish(type: string, payload: Record<string, unknown>, actor = "owner") {
    this.d.bus.publish({ type, topic: "storage", jobId: null, payload, actor });
  }

  readonly #versions = new Map<string, string | null>();

  status(): CloudStatus {
    const path = this.rclone.bin();
    let version: string | null = null;
    if (path) {
      if (!this.#versions.has(path)) this.#versions.set(path, rcloneVersion(path));
      version = this.#versions.get(path) ?? null;
    }
    return {
      rclone: {
        found: !!path && !!version,
        path,
        version,
        fix: path && version ? null : RCLONE_FIX,
      },
    };
  }

  // ── Providers

  #row(id: string): Row {
    const r = this.d.db.select().from(cloudProviders).where(eq(cloudProviders.id, id)).get();
    if (!r) throw new Error(`No cloud provider ${id}.`);
    return r;
  }

  #rows(): Row[] {
    return this.d.db
      .select()
      .from(cloudProviders)
      .orderBy(asc(cloudProviders.priority), asc(cloudProviders.createdAt))
      .all();
  }

  /**
   * Its free space is what it holds against a limit I set (object storage,
   * and any backend whose `about` can't tell), not its own figure.
   */
  #sized(r: Row) {
    return r.kind === "s3" || (r.kind === "rclone" && r.info.about !== "yes");
  }

  #view(r: Row): CloudProviderView {
    const preset = (r.info.preset as S3Preset | undefined) ?? null;
    const where =
      r.kind === "s3"
        ? `bucket ${r.root}${r.info.endpoint ? ` at ${r.info.endpoint.replace(/^https?:\/\//, "")}` : ""}`
        : r.kind === "mega"
          ? `${r.info.email}${r.root ? ` · ${r.root}/` : ""}`
          : r.root
            ? `${r.root}/`
            : "the whole account";
    const what =
      r.kind === "rclone"
        ? `${r.info.title ?? r.info.backend}${r.info.provider ? ` (${r.info.provider})` : ""}`
        : preset
          ? PRESET_NAMES[preset]
          : KIND_NAMES[r.kind];
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      backend: r.kind === "rclone" ? (r.info.backend ?? "rclone") : r.kind,
      detail: `${what} · ${where}`,
      preset,
      root: r.root,
      space: !this.#sized(r)
        ? r.freeBytes !== null
          ? "provider"
          : "unknown"
        : r.unlimited
          ? "unlimited"
          : r.limitBytes
            ? "limit"
            : "unknown",
      usedBytes: r.usedBytes,
      freeBytes: r.unlimited ? null : r.freeBytes,
      totalBytes: r.unlimited ? null : (r.totalBytes ?? r.limitBytes),
      limitBytes: r.limitBytes,
      unlimited: r.unlimited,
      priority: r.priority,
      checkedAt: r.checkedAt,
      error: r.error,
      createdAt: r.createdAt,
    };
  }

  providers(): CloudProviderView[] {
    return this.#rows().map((r) => this.#view(r));
  }

  provider(id: string): CloudProviderView {
    return this.#view(this.#row(id));
  }

  /** `remote:root/path` for rclone. */
  #at(r: Row, path = "") {
    return `${r.remote}:${joinPath(r.root, cleanPath(path))}`;
  }

  /**
   * A new provider: its section written into the encrypted config, then
   * checked; one that doesn't answer isn't kept.
   */
  async addProvider(input: NewCloudProvider, actor = "owner"): Promise<CloudProviderView> {
    const p = NewCloudProvider.parse(input);
    if (!this.status().rclone.found) throw new Error(`rclone isn't installed. ${RCLONE_FIX}`);
    const id = newId(this.#now());
    const remote = `o-${id.toLowerCase()}`;
    const folder = cleanPath(p.folder);
    const section = new Map<string, string>();
    let root = folder;
    let info: Record<string, string | null> = {};
    const secrets: string[] = [];
    if (p.kind === "s3") {
      section.set("type", "s3");
      section.set("provider", S3_PROVIDER[p.preset]);
      section.set("env_auth", "false");
      section.set("access_key_id", p.accessKeyId);
      section.set("secret_access_key", p.secretAccessKey);
      if (p.region) section.set("region", p.region);
      if (p.endpoint) section.set("endpoint", p.endpoint);
      // Never public: what I upload is private to my account.
      section.set("acl", "private");
      section.set("no_check_bucket", "true");
      root = joinPath(p.bucket, folder);
      info = { preset: p.preset, endpoint: p.endpoint, region: p.region, bucket: p.bucket };
      secrets.push(p.secretAccessKey, p.accessKeyId);
    } else if (p.kind === "mega") {
      section.set("type", "mega");
      section.set("user", p.email);
      section.set("pass", await this.rclone.obscure(p.password));
      info = { email: p.email };
      secrets.push(p.password);
    } else {
      const auth = this.#auth.get(p.authSession);
      if (!auth || auth.kind !== p.kind)
        throw new Error("That sign-in isn't here any more: sign in again.");
      if (auth.state !== "ready" || !auth.token)
        throw new Error("The sign-in hasn't finished: finish it in the browser first.");
      section.set("type", p.kind);
      if (p.kind === "drive") section.set("scope", "drive");
      section.set("token", auth.token);
      for (const [k, v] of Object.entries(auth.extra)) section.set(k, v);
      secrets.push(auth.token);
    }
    await this.rclone.edit((s) => {
      s.set(remote, section);
    });
    const scrub = (m: string) => secrets.reduce((t, x) => (x ? t.split(x).join("•••") : t), m);
    try {
      // The bucket or the folder is made when it isn't there; then read.
      if (root)
        await this.rclone.ok([
          "mkdir",
          // Uploads don't look for the bucket (a key may not be allowed to); adding makes it.
          ...(p.kind === "s3" ? ["--s3-no-check-bucket=false"] : []),
          `${remote}:${root}`,
        ]);
      await this.rclone.ok(["lsjson", "--max-depth", "1", `${remote}:${root}`]);
    } catch (error) {
      await this.rclone.edit((s) => {
        s.delete(remote);
      });
      throw new Error(
        `${KIND_NAMES[p.kind]} didn't answer: ${scrub(error instanceof Error ? error.message : String(error))}`,
      );
    }
    if (p.kind === "drive" || p.kind === "dropbox") this.#auth.delete(p.authSession);
    const last = this.#rows().at(-1);
    this.d.db
      .insert(cloudProviders)
      .values({
        id,
        name: p.name,
        kind: p.kind,
        remote,
        root,
        info,
        limitBytes: p.kind === "s3" ? p.limitBytes : null,
        unlimited: p.kind === "s3" ? p.unlimited : false,
        priority: (last?.priority ?? -1) + 1,
        createdAt: this.#now(),
      })
      .run();
    this.#publish("cloud.provider.added", { id, name: p.name, kind: p.kind }, actor);
    await this.check(id).catch(() => {});
    return this.provider(id);
  }

  async updateProvider(patch: CloudProviderPatch): Promise<CloudProviderView> {
    const r = this.#row(patch.id);
    if (!this.#sized(r) && (patch.limitBytes !== undefined || patch.unlimited !== undefined))
      throw new Error(`${r.info.title ?? KIND_NAMES[r.kind]} says its own free space.`);
    this.d.db
      .update(cloudProviders)
      .set({
        ...(patch.name ? { name: patch.name } : {}),
        ...(patch.limitBytes !== undefined ? { limitBytes: patch.limitBytes } : {}),
        ...(patch.unlimited !== undefined ? { unlimited: patch.unlimited } : {}),
      })
      .where(eq(cloudProviders.id, r.id))
      .run();
    this.#publish("cloud.provider.updated", { id: r.id });
    if (patch.limitBytes !== undefined || patch.unlimited !== undefined)
      await this.check(r.id).catch(() => {});
    return this.provider(r.id);
  }

  /** The priority order (Automatic → priority): the ids, first first. */
  reorder(ids: string[]) {
    const rows = this.#rows();
    const order = [...ids, ...rows.map((r) => r.id).filter((x) => !ids.includes(x))];
    order.forEach((id, i) => {
      this.d.db.update(cloudProviders).set({ priority: i }).where(eq(cloudProviders.id, id)).run();
    });
    this.#publish("cloud.provider.updated", { order });
  }

  /** Gone from Oraknid and its config; the files stay in the account. */
  async removeProvider(id: string) {
    const r = this.#row(id);
    const used = this.d.usedBy?.(id);
    if (used) throw new Error(used);
    await this.rclone.edit((s) => {
      s.delete(r.remote);
    });
    this.d.db.delete(cloudProviders).where(eq(cloudProviders.id, id)).run();
    const placement = this.placement();
    if (placement.providerId === id)
      this.setPlacement({ ...placement, mode: "auto", providerId: null });
    this.#publish("cloud.provider.removed", { id, name: r.name });
  }

  /** Used and free space: the provider's own (`about`), or what it holds against my limit. */
  async check(id: string): Promise<CloudProviderView> {
    const r = this.#row(id);
    let set: Partial<Row> = {};
    try {
      let about: { total?: number; used?: number; free?: number } | null = null;
      let cantTell = false;
      if (!this.#sized(r)) {
        const asked = this.rclone.json<{ total?: number; used?: number; free?: number }>([
          "about",
          "--json",
          `${r.remote}:`,
        ]);
        // A backend with `about` whose server can't run it (an SFTP server without a shell)
        // or can't say its free space (a WebDAV server without quotas): what it holds is read
        // below, against a limit of mine; when that fails too, the provider is down.
        about = r.kind === "rclone" ? await asked.catch(() => ({})) : await asked;
        const free =
          about.free ??
          (about.total !== undefined && about.used !== undefined ? about.total - about.used : null);
        if (free === null && r.kind === "rclone") {
          cantTell = true;
          about = null;
        } else
          set = {
            usedBytes: about.used ?? null,
            freeBytes: free,
            totalBytes: about.total ?? null,
            error: null,
          };
      }
      if (!about) {
        const s = await this.rclone.json<{ bytes: number }>(["size", "--json", this.#at(r)]);
        if (cantTell) {
          r.info = { ...r.info, about: "no" };
          this.d.db
            .update(cloudProviders)
            .set({ info: r.info })
            .where(eq(cloudProviders.id, id))
            .run();
        }
        set = {
          usedBytes: s.bytes,
          freeBytes: r.limitBytes ? Math.max(0, r.limitBytes - s.bytes) : null,
          totalBytes: r.limitBytes,
          error: null,
        };
      }
    } catch (error) {
      set = { error: error instanceof Error ? error.message : String(error) };
    }
    this.d.db
      .update(cloudProviders)
      .set({ ...set, checkedAt: this.#now() })
      .where(eq(cloudProviders.id, id))
      .run();
    this.#publish(
      "cloud.provider.checked",
      { id, ok: !set.error, error: set.error ?? null },
      "oraknid",
    );
    return this.provider(id);
  }

  // ── Where an upload goes

  placement(): CloudPlacement {
    return readSetting(this.d.db, PLACEMENT_SETTING, CloudPlacement, DEFAULT_PLACEMENT);
  }

  setPlacement(p: CloudPlacement) {
    const parsed = CloudPlacement.parse(p);
    if (parsed.mode === "provider") {
      if (!parsed.providerId) throw new Error("Pick the provider uploads go to.");
      this.#row(parsed.providerId);
    }
    writeSetting(this.d.db, PLACEMENT_SETTING, CloudPlacement, parsed, this.#now());
    this.#publish("cloud.placement", { ...parsed });
    return this.placement();
  }

  /** The provider a file of `size` goes to, or why none can take it (thrown, in words). */
  async place(size: number, pick?: string | null): Promise<string> {
    const placement = this.placement();
    const stale = this.#rows().filter(
      (r) => (r.checkedAt ?? 0) < this.#now() - STALE_MS || r.error,
    );
    await Promise.all(stale.map((r) => this.check(r.id).catch(() => {})));
    const candidates: PlaceCandidate[] = this.#rows().map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      object: r.kind === "s3" || r.info.bucket === "yes",
      free: r.unlimited ? Number.POSITIVE_INFINITY : r.freeBytes,
      priority: r.priority,
      broken: !!r.error,
    }));
    const placed = choosePlace(candidates, size, placement, pick);
    if (!placed.ok) throw new Error(placed.reason);
    return placed.id;
  }

  // ── The pool

  async #ls(r: Row, path: string, extra: string[] = []): Promise<LsItem[]> {
    const res = await this.rclone.run(["lsjson", ...extra, this.#at(r, path)]);
    // 3: the folder isn't in this provider.
    if (res.code === 3) return [];
    if (res.code !== 0) throw new Error(rcloneError(res.stderr));
    return JSON.parse(res.stdout || "[]") as LsItem[];
  }

  /** One folder of the pool: its folders merged across providers, each file with its own. */
  async list(path = ""): Promise<CloudListing> {
    const at = cleanPath(path);
    return this.#gather(at, (r) => this.#ls(r, at), false);
  }

  /** Files whose name holds `q`, anywhere under `path`. */
  async search(q: string, path = ""): Promise<CloudListing> {
    const at = cleanPath(path);
    const words = q.trim();
    if (!words) return this.list(at);
    return this.#gather(
      at,
      (r) =>
        this.#ls(r, at, [
          "-R",
          "--files-only",
          "--ignore-case",
          "--include",
          `*${globEscape(words)}*`,
        ]),
      true,
    );
  }

  async #gather(
    at: string,
    read: (r: Row) => Promise<LsItem[]>,
    searching: boolean,
  ): Promise<CloudListing> {
    const rows = this.#rows();
    const results = await Promise.all(
      rows.map(async (r) => {
        try {
          return { r, items: await read(r), error: null };
        } catch (error) {
          return { r, items: [], error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    const folders = new Map<string, CloudEntry>();
    const files: CloudEntry[] = [];
    for (const { r, items } of results) {
      for (const it of items) {
        const path = joinPath(at, it.Path);
        if (it.IsDir) {
          const f = folders.get(path);
          if (f) f.providers.push(r.id);
          else
            folders.set(path, {
              path,
              name: it.Name,
              isDir: true,
              size: null,
              modTime: it.ModTime ?? null,
              mimeType: null,
              providerId: null,
              providers: [r.id],
            });
        } else
          files.push({
            path,
            name: it.Name,
            isDir: false,
            size: it.Size >= 0 ? it.Size : null,
            modTime: it.ModTime ?? null,
            mimeType: it.MimeType ?? null,
            providerId: r.id,
            providers: [r.id],
          });
      }
    }
    const byName = (a: CloudEntry, b: CloudEntry) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const entries = [...[...folders.values()].sort(byName), ...files.sort(byName)];
    return {
      path: at,
      entries: searching ? entries.slice(0, SEARCH_LIMIT) : entries,
      errors: results
        .filter((x) => x.error)
        .map((x) => ({ providerId: x.r.id, name: x.r.name, error: x.error as string })),
      truncated: searching && entries.length > SEARCH_LIMIT,
    };
  }

  /** A file of one provider, or null when it isn't there. */
  async stat(providerId: string, path: string): Promise<CloudEntry | null> {
    const r = this.#row(providerId);
    const p = cleanPath(path);
    // Files only: on object storage any missing path is "a folder".
    const res = await this.rclone.run(["lsjson", "--stat", "--files-only", this.#at(r, p)]);
    if (res.code !== 0) return null;
    const it = JSON.parse(res.stdout || "null") as LsItem | null;
    if (!it) return null;
    return {
      path: p,
      name: it.Name,
      isDir: it.IsDir,
      size: it.Size >= 0 ? it.Size : null,
      modTime: it.ModTime ?? null,
      mimeType: it.MimeType ?? null,
      providerId,
      providers: [providerId],
    };
  }

  /**
   * A file of this computer into the pool, at `path` (its folder and name):
   * to the provider I pick, else where the rule puts it. An existing file
   * there is replaced only when `replace`.
   */
  async putFile(
    localFile: string,
    path: string,
    o: {
      providerId?: string | null;
      replace?: boolean;
      transfer?: string;
      actor?: string;
      /** Already placed (the upload route places before the bytes come). */
      placed?: string;
    } = {},
  ): Promise<{ providerId: string; path: string; size: number }> {
    const p = cleanPath(path);
    if (!p) throw new Error("A file needs a name.");
    const size = statSync(localFile).size;
    const providerId = o.placed ?? (await this.place(size, o.providerId ?? null));
    const r = this.#row(providerId);
    if (!o.replace && (await this.stat(providerId, p)))
      throw new Error(`There is already a file ${p} in ${r.name}.`);
    const id = o.transfer ?? newId(this.#now());
    const name = baseName(p);
    let last = 0;
    this.transfer({ id, name, phase: "send", bytes: 0, total: size, providerId, error: null });
    try {
      await this.rclone.ok(["copyto", localFile, this.#at(r, p)], {
        onStats: (s) => {
          const at = this.#now();
          if (at - last < 250) return;
          last = at;
          this.transfer({
            id,
            name,
            phase: "send",
            bytes: s.bytes,
            total: size,
            providerId,
            error: null,
          });
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transfer({
        id,
        name,
        phase: "failed",
        bytes: 0,
        total: size,
        providerId,
        error: message,
      });
      throw new Error(`Couldn't put it in ${r.name}: ${message}`);
    }
    this.transfer({ id, name, phase: "done", bytes: size, total: size, providerId, error: null });
    // What it holds now, without asking again.
    const now = this.#row(providerId);
    this.d.db
      .update(cloudProviders)
      .set({
        usedBytes: now.usedBytes === null ? null : now.usedBytes + size,
        freeBytes: now.freeBytes === null ? null : Math.max(0, now.freeBytes - size),
      })
      .where(eq(cloudProviders.id, providerId))
      .run();
    this.#publish("cloud.file.uploaded", { providerId, path: p, size }, o.actor ?? "owner");
    return { providerId, path: p, size };
  }

  /** A file of the pool onto this computer. */
  async getFile(providerId: string, path: string, localFile: string): Promise<void> {
    const r = this.#row(providerId);
    await this.rclone.ok(["copyto", this.#at(r, path), localFile]);
  }

  /** A file's bytes as they come, for a download. */
  async open(
    providerId: string,
    path: string,
  ): Promise<{
    stream: Readable;
    done: Promise<string | null>;
    name: string;
    size: number | null;
  }> {
    const r = this.#row(providerId);
    const p = cleanPath(path);
    const st = await this.stat(providerId, p);
    if (!st || st.isDir) throw new Error(`No file ${p} in ${r.name}.`);
    const { stdout, done } = await this.rclone.stream(["cat", this.#at(r, p)]);
    return { stream: stdout, done, name: st.name, size: st.size };
  }

  /** A file renamed or moved: in its provider, or to another one. */
  async move(o: {
    providerId: string;
    path: string;
    toPath: string;
    toProviderId?: string | null;
    actor?: string;
  }) {
    const from = this.#row(o.providerId);
    const to = this.#row(o.toProviderId ?? o.providerId);
    const src = cleanPath(o.path);
    const dst = cleanPath(o.toPath);
    if (!src || !dst) throw new Error("Move a file, to a name.");
    if (from.id === to.id && src === dst) return;
    if (await this.stat(to.id, dst)) throw new Error(`There is already ${dst} in ${to.name}.`);
    const st = await this.stat(from.id, src);
    if (!st) throw new Error(`No file ${src} in ${from.name}.`);
    if (from.id !== to.id && st.size !== null) {
      const placed = await this.place(st.size, to.id).catch((e: Error) => e);
      if (placed instanceof Error) throw placed;
    }
    await this.rclone.ok(["moveto", this.#at(from, src), this.#at(to, dst)]);
    this.#publish(
      "cloud.file.moved",
      { providerId: from.id, path: src, toProviderId: to.id, toPath: dst },
      o.actor ?? "owner",
    );
  }

  /** A folder renamed or moved, in every provider holding it. */
  async moveFolder(path: string, toPath: string, actor = "owner") {
    const src = cleanPath(path);
    const dst = cleanPath(toPath);
    if (!src || !dst) throw new Error("Not the pool itself.");
    if (dst === src || dst.startsWith(`${src}/`)) throw new Error("Not into itself.");
    const listing = await this.list(parentOf(src));
    const folder = listing.entries.find((e) => e.isDir && e.path === src);
    if (!folder) throw new Error(`No folder ${src}.`);
    for (const id of folder.providers) {
      const r = this.#row(id);
      await this.rclone.ok(["moveto", this.#at(r, src), this.#at(r, dst)]);
    }
    this.#publish("cloud.folder.moved", { path: src, toPath: dst }, actor);
  }

  async deleteFile(providerId: string, path: string, actor = "owner") {
    const r = this.#row(providerId);
    const p = cleanPath(path);
    if (!p) throw new Error("Not the pool itself.");
    const st = await this.stat(providerId, p);
    await this.rclone.ok(["deletefile", this.#at(r, p)]);
    if (st?.size)
      this.d.db
        .update(cloudProviders)
        .set({
          usedBytes: r.usedBytes === null ? null : Math.max(0, r.usedBytes - st.size),
          freeBytes: r.freeBytes === null ? null : r.freeBytes + st.size,
        })
        .where(eq(cloudProviders.id, r.id))
        .run();
    this.#publish("cloud.file.deleted", { providerId, path: p }, actor);
  }

  /** A folder and everything in it, in every provider holding it. */
  async deleteFolder(path: string, actor = "owner") {
    const p = cleanPath(path);
    if (!p) throw new Error("Not the pool itself.");
    const listing = await this.list(parentOf(p));
    const folder = listing.entries.find((e) => e.isDir && e.path === p);
    if (!folder) throw new Error(`No folder ${p}.`);
    for (const id of folder.providers) {
      const r = this.#row(id);
      await this.rclone.ok(["purge", this.#at(r, p)]);
      void this.check(id).catch(() => {});
    }
    this.#publish("cloud.folder.deleted", { path: p }, actor);
  }

  // ── Every backend rclone supports (ADR-046 → Changed 2026-10-04)

  #schema: { version: string; backends: Promise<RcloneBackend[]> } | null = null;

  /**
   * rclone's backends, read from its own `config providers` once per rclone
   * version: kept in memory, and on disk beside the config so the next start
   * doesn't ask again.
   */
  #backends(): Promise<RcloneBackend[]> {
    const { rclone } = this.status();
    if (!rclone.found || !rclone.path || !rclone.version)
      return Promise.reject(new Error(`rclone isn't installed. ${RCLONE_FIX}`));
    if (this.#schema?.version === rclone.version) return this.#schema.backends;
    const version = rclone.version;
    const bin = rclone.path;
    const file = join(
      this.d.dataDir,
      "cloud",
      `backends-${createHash("sha256").update(`${version}|${RCLONE_SCHEMA_FORMAT}`).digest("hex").slice(0, 16)}.json`,
    );
    const backends = (async () => {
      try {
        const kept = JSON.parse(readFileSync(file, "utf8")) as {
          version?: string;
          backends?: unknown;
        };
        if (kept.version === version) return z.array(RcloneBackendShape).parse(kept.backends);
      } catch {}
      const read = readRcloneSchema(await rcloneProviders(bin));
      try {
        mkdirSync(join(this.d.dataDir, "cloud"), { recursive: true, mode: 0o700 });
        writeFileSync(file, JSON.stringify({ version, backends: read }), { mode: 0o600 });
      } catch {}
      return read;
    })();
    this.#schema = { version, backends };
    // A failure is asked again next time.
    backends.catch(() => {
      if (this.#schema?.backends === backends) this.#schema = null;
    });
    return backends;
  }

  /** Read at start, so the add dialog opens on it at once; nothing said when rclone isn't there. */
  preloadBackends() {
    if (this.rclone.bin()) void this.#backends().catch(() => {});
  }

  async backends(): Promise<RcloneBackends> {
    const list = await this.#backends();
    return { version: this.status().rclone.version, backends: list.map(summaryOf) };
  }

  async backend(name: string): Promise<RcloneBackend> {
    const b = (await this.#backends()).find((x) => x.name === name);
    if (!b) throw new Error(`rclone here has no backend ${name}.`);
    return b;
  }

  readonly #pending = new Map<string, Pending>();

  /**
   * A provider of any backend, from the form made of rclone's schema: its
   * options checked against that schema, passwords obscured through
   * rclone's stdin, everything written into the encrypted config; then
   * rclone's own setup runs (`config update`, its values in its
   * environment, never its command line) and may ask questions (OneDrive's
   * drive, a code), answered with `answerRclone`; then it is checked.
   */
  async addRclone(input: NewRcloneProvider, actor = "owner"): Promise<CloudAddStep> {
    const p = NewRcloneProvider.parse(input);
    const b = await this.backend(p.backend);
    const { values, errors } = checkOptions(b, p.options);
    const wrong = Object.entries(errors);
    if (wrong.length)
      throw new Error(`Check the form: ${wrong.map(([k, v]) => `${k}: ${v}`).join(" ")}`);
    const fields = new Map(formOptions(formModel(b, values)).map((o) => [o.name, o]));
    const secrets: string[] = [];
    const section = new Map<string, string>([["type", b.name]]);
    for (const [k, v] of Object.entries(values)) {
      const o = fields.get(k);
      if (o?.secret) secrets.push(v, p.options[k] ?? "");
      section.set(k, o?.password ? await this.rclone.obscure(v) : v);
      if (o?.password) secrets.push(section.get(k) as string);
    }
    let auth: AuthSession | undefined;
    if (b.oauth) {
      auth = p.authSession ? this.#auth.get(p.authSession) : undefined;
      if (!auth || auth.kind !== b.name) throw new Error(`Sign in to ${b.title} first.`);
      if (auth.state !== "ready" || !auth.token)
        throw new Error("The sign-in hasn't finished: finish it in the browser first.");
      for (const [k, v] of Object.entries(auth.extra)) if (!section.has(k)) section.set(k, v);
      section.set("token", auth.token);
      secrets.push(auth.token);
    }
    const providerId = newId(this.#now());
    const pending: Pending = {
      id: randomBytes(12).toString("base64url"),
      providerId,
      remote: `o-${providerId.toLowerCase()}`,
      input: { ...p, options: {} },
      backend: b,
      secrets: secrets.filter((s) => s.length >= 3),
      state: null,
      option: null,
      timer: setTimeout(() => void this.cancelRclone(pending.id), PENDING_MS),
    };
    pending.timer.unref();
    // What the pages say of it: the sub-provider (not a secret), nothing else of the form.
    if (values.provider) pending.input.options = { provider: values.provider };
    await this.rclone.edit((s) => {
      s.set(pending.remote, section);
    });
    this.#pending.set(pending.id, pending);
    if (auth && p.authSession) this.#auth.delete(p.authSession);
    return this.#setup(pending, null, null, actor);
  }

  /** An answer to rclone's question; a password or a code passes in its environment. */
  async answerRclone(pendingId: string, answer: string, actor = "owner"): Promise<CloudAddStep> {
    const p = this.#pending.get(pendingId);
    if (!p?.state || !p.option) throw new Error("That add isn't waiting any more: start again.");
    const o = p.option;
    const v = answer.trim();
    if (/[\r\n]/.test(v)) throw new Error("An answer can't hold a line break.");
    if (o.exclusive && o.examples.length && !o.examples.some((e) => e.value === v))
      throw new Error(`Pick one of: ${o.examples.map((e) => e.help || e.value).join(", ")}.`);
    if (o.required && !v && !o.default) throw new Error("It needs an answer.");
    if (o.secret && v.length >= 3) p.secrets.push(v);
    return this.#setup(p, p.state, v, actor);
  }

  /** An add given up: its section gone from the config. */
  async cancelRclone(pendingId: string) {
    const p = this.#pending.get(pendingId);
    if (!p) return;
    this.#pending.delete(pendingId);
    clearTimeout(p.timer);
    await this.rclone
      .edit((s) => {
        s.delete(p.remote);
      })
      .catch(() => {});
  }

  #scrub(p: Pending, m: string) {
    return p.secrets.reduce((t, x) => (x ? t.split(x).join("•••") : t), m);
  }

  /** One step of rclone's setup: its state and the answer, in its environment. */
  async #configStep(remote: string, state: string | null, result: string | null) {
    const env: Record<string, string> =
      state === null
        ? {}
        : { RCLONE_CONTINUE: "true", RCLONE_STATE: state, RCLONE_RESULT: result ?? "" };
    const r = await this.rclone.serial(() =>
      this.rclone.run(["config", "update", remote, "--non-interactive"], {
        env,
        timeoutMs: STEP_MS,
      }),
    );
    if (r.code !== 0) throw new Error(rcloneError(r.stderr));
    try {
      return JSON.parse(r.stdout) as ConfigOut;
    } catch {
      throw new Error("rclone's setup said something Oraknid doesn't understand.");
    }
  }

  async #setup(
    p: Pending,
    state: string | null,
    result: string | null,
    actor: string,
  ): Promise<CloudAddStep> {
    try {
      let out = await this.#configStep(p.remote, state, result);
      let said: string | null = null;
      for (let i = 0; i < 50; i++) {
        if (out.Error) said = out.Error;
        if (!out.State) {
          if (out.Error) throw new Error(out.Error);
          break;
        }
        const opt = out.Option;
        // A step with nothing to ask goes on; a token already there is kept.
        if (!opt || opt.Name === "config_refresh_token") {
          out = await this.#configStep(p.remote, out.State, opt ? "false" : "");
          continue;
        }
        const option = readRcloneOption(opt);
        if (!option) throw new Error("rclone asked something Oraknid can't show.");
        p.state = out.State;
        p.option = { ...option, required: option.required || option.exclusive };
        return {
          provider: null,
          question: {
            pending: p.id,
            option: p.option,
            error: said ? this.#scrub(p, said) : null,
          },
        };
      }
      if (out.State) throw new Error("rclone's setup didn't end.");
      return { provider: await this.#finish(p, actor), question: null };
    } catch (error) {
      await this.cancelRclone(p.id);
      throw new Error(
        `${p.backend.title} didn't answer: ${this.#scrub(p, error instanceof Error ? error.message : String(error))}`,
      );
    }
  }

  /** Set up: its folder made and listed, what it can say learned, then kept. */
  async #finish(p: Pending, actor: string): Promise<CloudProviderView> {
    const { remote, input, backend: b } = p;
    const root = cleanPath(input.folder);
    const f = await this.rclone.json<{ Features?: { About?: boolean; BucketBased?: boolean } }>([
      "backend",
      "features",
      `${remote}:`,
    ]);
    const bucket = f.Features?.BucketBased === true || b.bucket;
    if (bucket && !root)
      throw new Error(
        `${b.title} keeps files in buckets: give the folder as bucket or bucket/folder.`,
      );
    if (root) await this.rclone.ok(["mkdir", `${remote}:${root}`]);
    await this.rclone.ok(["lsjson", "--max-depth", "1", `${remote}:${root}`]);
    this.#pending.delete(p.id);
    clearTimeout(p.timer);
    const about = f.Features?.About === true;
    const last = this.#rows().at(-1);
    this.d.db
      .insert(cloudProviders)
      .values({
        id: p.providerId,
        name: input.name,
        kind: "rclone",
        remote,
        root,
        info: {
          backend: b.name,
          title: b.title,
          provider: input.options.provider ?? null,
          about: about ? "yes" : "no",
          bucket: bucket ? "yes" : "no",
        },
        limitBytes: input.limitBytes,
        unlimited: about ? false : input.unlimited,
        priority: (last?.priority ?? -1) + 1,
        createdAt: this.#now(),
      })
      .run();
    this.#publish(
      "cloud.provider.added",
      { id: p.providerId, name: input.name, kind: "rclone", backend: b.name },
      actor,
    );
    await this.check(p.providerId).catch(() => {});
    return this.provider(p.providerId);
  }

  // ── Signing in through rclone's own authorization, in a browser on this computer

  /**
   * Starts `rclone authorize`: its address (on 127.0.0.1, so a browser on
   * this computer) comes back; the token it hands over is kept in memory
   * until the provider is added.
   */
  async authorizeStart(
    kind: string,
    options: Record<string, string> = {},
  ): Promise<CloudAuthorization> {
    const args = ["authorize", kind];
    if (kind !== "drive" && kind !== "dropbox") {
      const b = await this.backend(kind);
      if (!b.oauth)
        throw new Error(`${b.title} doesn't sign in through a browser: fill in its form.`);
      // What the sign-in needs to know (Zoho's region): the everyday options set, never a
      // secret. Always a blob, so what rclone sets beside the token (pCloud's host) comes back.
      const fields = new Map(formOptions(formModel(b, options)).map((o) => [o.name, o]));
      const blob: Record<string, string> = {};
      for (const [k, v] of Object.entries(options)) {
        const o = fields.get(k);
        if (o && !o.secret && !o.advanced && v.trim() && !/[\r\n]/.test(v)) blob[k] = v.trim();
      }
      args.push(Buffer.from(JSON.stringify(blob)).toString("base64").replace(/=+$/, ""));
    }
    for (const a of this.#auth.values()) if (a.state === "waiting") this.authorizeCancel(a.session);
    const session = randomBytes(12).toString("base64url");
    const child = await this.rclone.start([...args, "--auth-no-open-browser"]);
    const a: AuthSession = {
      session,
      kind,
      state: "waiting",
      url: null,
      error: null,
      token: null,
      extra: {},
      child,
      expiresAt: this.#now() + AUTH_MS,
    };
    this.#auth.set(session, a);
    let out = "";
    let err = "";
    const gotUrl = new Promise<void>((resolve) => {
      const look = () => {
        const m = /(http:\/\/127\.0\.0\.1:\d+\/auth\?state=[\w-]+)/.exec(`${out}\n${err}`);
        if (m && !a.url) {
          a.url = m[1] as string;
          resolve();
        }
      };
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString("utf8");
        look();
        const pasted = /--->\s*\n([\s\S]+?)\n\s*<---End paste/.exec(out);
        if (pasted && a.state === "waiting") {
          try {
            Object.assign(a, readToken(pasted[1] as string), { state: "ready" });
            this.#publish("cloud.authorized", { session, kind }, "owner");
          } catch (error) {
            a.state = "failed";
            a.error = error instanceof Error ? error.message : String(error);
          }
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        err = `${err}${d.toString("utf8")}`.slice(-20_000);
        look();
      });
      child.once("close", (code) => {
        a.child = null;
        if (a.state === "waiting") {
          a.state = "failed";
          a.error =
            code === null
              ? "The sign-in was stopped."
              : `The sign-in didn't finish: ${(() => {
                  try {
                    return JSON.parse(err.trim().split("\n").at(-1) ?? "").msg;
                  } catch {
                    return err.trim().split("\n").at(-1) || `rclone ended (${code})`;
                  }
                })()}`;
        }
        resolve();
      });
    });
    const timer = setTimeout(() => this.authorizeCancel(session), AUTH_MS);
    timer.unref();
    await Promise.race([gotUrl, new Promise((r) => setTimeout(r, 15_000).unref())]);
    if (!a.url && a.state === "waiting") {
      this.authorizeCancel(session);
      a.error = "rclone didn't give a sign-in address.";
    }
    return this.authorizeStatus(session);
  }

  authorizeStatus(session: string): CloudAuthorization {
    const a = this.#auth.get(session);
    if (!a) throw new Error("That sign-in isn't here any more: sign in again.");
    return { session, kind: a.kind, state: a.state, url: a.url, error: a.error };
  }

  authorizeCancel(session: string) {
    const a = this.#auth.get(session);
    if (!a) return;
    a.child?.kill("SIGTERM");
    if (a.state === "waiting") {
      a.state = "failed";
      a.error = "The sign-in was stopped.";
    }
  }

  stop() {
    for (const a of this.#auth.values()) a.child?.kill("SIGTERM");
    for (const p of this.#pending.values()) clearTimeout(p.timer);
    this.rclone.stopAll();
  }

  /** A provider in words, for the helper and the backups page. */
  label(id: string): string {
    try {
      return this.#row(id).name;
    } catch {
      return "a removed provider";
    }
  }

  /** The temporary file a download or an upload passes through, removed after. */
  tmpFile(prefix: string) {
    return join(this.tmpDir(), `${prefix}-${randomBytes(8).toString("hex")}`);
  }

  removeTmp(file: string) {
    rmSync(file, { force: true });
  }
}

/**
 * What `rclone authorize` hands over: the token itself (JSON), or, when the
 * backend needs more, a base64 blob of its fields with the token in it.
 */
export function readToken(text: string): { token: string; extra: Record<string, string> } {
  const t = text.trim();
  const asToken = (s: string) => {
    const j = JSON.parse(s) as { access_token?: unknown };
    if (typeof j.access_token !== "string") throw new Error("not a token");
    return JSON.stringify(j);
  };
  try {
    return { token: asToken(t), extra: {} };
  } catch {}
  try {
    const fields = JSON.parse(Buffer.from(t, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const token = typeof fields.token === "string" ? asToken(fields.token) : null;
    if (!token) throw new Error("no token");
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields))
      if (k !== "token" && typeof v === "string" && /^[a-z_]+$/.test(k)) extra[k] = v;
    return { token, extra };
  } catch {
    throw new Error("rclone's sign-in gave something Oraknid doesn't understand.");
  }
}
