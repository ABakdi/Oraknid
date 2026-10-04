import { randomBytes } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type {
  BackupDestination,
  BackupKeyView,
  BackupPlanPatch,
  BackupPlanTest,
  BackupPlanView,
  BackupRunView,
  BackupTarget,
  BackupTestResult,
  NewBackupPlan,
  RestorePreview,
} from "@oraknid/contracts";
import { BackupTarget as TargetSchema } from "@oraknid/contracts";
import { describeSchedule, nextRun, toPrune } from "@oraknid/core";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Client } from "ssh2";
import type { Download } from "../cloud/routes.ts";
import type { Cloud } from "../cloud/service.ts";
import type { Db } from "../db/open.ts";
import { backupKeys, backupPlans, backupRuns } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Servers } from "../servers/service.ts";
import { exec, execStream, q, sshWords } from "../servers/ssh.ts";
import {
  checkTarget,
  dumpCommand,
  extOf,
  KIND_NAMES,
  mongoTestScript,
  PLACED,
  pgFormatOf,
  plainError,
  readTest,
  restoreCommand,
  sane,
  secretLine,
  testCommand,
} from "./dump.ts";
import {
  ageDecrypt,
  ageEncrypt,
  Ends,
  newAgeKey,
  recipientOf,
  tap,
  zstdCompress,
  zstdDecompress,
} from "./streams.ts";

// Scheduled, encrypted database backups (ADR-044): plans, their runs, age
// keys, Verify and Restore. A run streams the database's native dump from
// its server over SSH, compresses it (zstd), encrypts it (age) when the
// plan has a key, and writes it to this computer or to another server,
// hashing it on the way. Passwords and private keys are in the keychain.

type PlanRow = typeof backupPlans.$inferSelect;
type RunRow = typeof backupRuns.$inferSelect;

const PASSWORD = (planId: string) => `backup.plan.${planId}.password`;
/** MongoDB: a connection string, a secret (it can hold a password). */
const URI = (planId: string) => `backup.plan.${planId}.uri`;
const PRIVATE_KEY = (keyId: string) => `backup.key.${keyId}`;
/** A plan's time this far past when Oraknid looks: it was off, so the run is a missed one. */
const MISSED_AFTER = 10 * 60_000;
const RESTORE_TTL = 5 * 60_000;

export interface BackupsDeps {
  db: Db;
  bus: EventBus;
  secrets: Secrets;
  servers: Pick<Servers, "client" | "row">;
  /** Cloud storage, a destination (ADR-046). */
  cloud?: Pick<
    Cloud,
    | "providers"
    | "provider"
    | "label"
    | "putFile"
    | "getFile"
    | "open"
    | "deleteFile"
    | "tmpFile"
    | "removeTmp"
  >;
  now?: () => number;
  /** How often plans are looked at (ms). */
  tickMs?: number;
}

/** `~/x` and `x` are in my home; the rest as written. */
const localFolder = (f: string) =>
  f === "~" ? homedir() : f.startsWith("~/") ? join(homedir(), f.slice(2)) : f;
/** On a server, a path without `~/` is from the login's home already. */
const remoteFolder = (f: string) => (f === "~" ? "." : f.startsWith("~/") ? f.slice(2) : f);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "backup";

function stamp(ms: number) {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * The stages piped together. A command at the far end of SSH that ends
 * early (a full disk, a refused login) would leave writes to it waiting
 * forever: its end stops the pipe.
 */
async function piped(stages: unknown[], farEnd?: Promise<unknown> | null) {
  const ac = new AbortController();
  let settled = false;
  void farEnd?.then(() => {
    if (!settled) ac.abort(new Error("The other end stopped before the end of the stream."));
  });
  try {
    await (pipeline as (...s: unknown[]) => Promise<void>)(...stages, { signal: ac.signal });
  } finally {
    settled = true;
  }
}

const words = (error: unknown) => (error instanceof Error ? error.message : String(error));

interface PendingRestore {
  runId: string;
  target: BackupTarget;
  password: string | undefined;
  expiresAt: number;
}

export class Backups {
  readonly #running = new Map<string, Promise<BackupRunView>>();
  readonly #restores = new Map<string, PendingRestore>();
  #timer: NodeJS.Timeout | undefined;
  #ticking = false;

  constructor(private readonly d: BackupsDeps) {}

  #now() {
    return this.d.now?.() ?? Date.now();
  }

  #publish(type: string, payload: Record<string, unknown>, actor = "oraknid") {
    this.d.bus.publish({ type, topic: "overview", jobId: null, payload, actor });
  }

  // ── Keys

  #keyRow(id: string) {
    const k = this.d.db.select().from(backupKeys).where(eq(backupKeys.id, id)).get();
    if (!k) throw new Error(`No backup key ${id}.`);
    return k;
  }

  keys(): BackupKeyView[] {
    const plans = this.d.db.select({ keyId: backupPlans.keyId }).from(backupPlans).all();
    return this.d.db
      .select()
      .from(backupKeys)
      .orderBy(backupKeys.createdAt)
      .all()
      .map((k) => ({
        id: k.id,
        name: k.name,
        publicKey: k.publicKey,
        imported: k.imported,
        exportedAt: k.exportedAt,
        createdAt: k.createdAt,
        planCount: plans.filter((p) => p.keyId === k.id).length,
      }));
  }

  #keyView(id: string) {
    const k = this.keys().find((x) => x.id === id);
    if (!k) throw new Error(`No backup key ${id}.`);
    return k;
  }

  /** A new age key: its private half straight into the keychain. */
  async createKey(name: string, actor = "owner"): Promise<BackupKeyView> {
    const { identity, recipient } = await newAgeKey();
    const id = newId(this.#now());
    await this.d.secrets.set(PRIVATE_KEY(id), identity);
    this.d.db
      .insert(backupKeys)
      .values({ id, name, publicKey: recipient, createdAt: this.#now() })
      .run();
    this.#publish("backup.key.created", { id, name, publicKey: recipient }, actor);
    return this.#keyView(id);
  }

  /** A private key I already have, kept in the keychain. */
  async importKey(name: string, privateKey: string): Promise<BackupKeyView> {
    const recipient = await recipientOf(privateKey);
    const same = this.d.db
      .select()
      .from(backupKeys)
      .where(eq(backupKeys.publicKey, recipient))
      .get();
    if (same) throw new Error(`That key is already here, as "${same.name}".`);
    const id = newId(this.#now());
    await this.d.secrets.set(PRIVATE_KEY(id), privateKey.trim());
    const now = this.#now();
    this.d.db
      .insert(backupKeys)
      // Mine already: nothing to export.
      .values({ id, name, publicKey: recipient, imported: true, exportedAt: now, createdAt: now })
      .run();
    this.#publish("backup.key.imported", { id, name, publicKey: recipient }, "owner");
    return this.#keyView(id);
  }

  /** The private key, once, for me to keep somewhere safe; after that it never leaves the keychain. */
  async exportKey(id: string): Promise<{ name: string; publicKey: string; privateKey: string }> {
    const k = this.#keyRow(id);
    if (k.exportedAt)
      throw new Error(
        "This key's private half was already taken once; it stays in the keychain for restores.",
      );
    const privateKey = await this.d.secrets.get(PRIVATE_KEY(id));
    if (!privateKey) throw new Error("This key's private half isn't in the keychain.");
    this.d.db
      .update(backupKeys)
      .set({ exportedAt: this.#now() })
      .where(eq(backupKeys.id, id))
      .run();
    this.#publish("backup.key.exported", { id, name: k.name }, "owner");
    return { name: k.name, publicKey: k.publicKey, privateKey };
  }

  async renameKey(id: string, name: string) {
    this.#keyRow(id);
    this.d.db.update(backupKeys).set({ name }).where(eq(backupKeys.id, id)).run();
    this.#publish("backup.key.updated", { id }, "owner");
  }

  /** Gone, with its private half: refused while a plan or a kept backup needs it. */
  async removeKey(id: string) {
    const k = this.#keyRow(id);
    const plan = this.d.db.select().from(backupPlans).where(eq(backupPlans.keyId, id)).get();
    if (plan) throw new Error(`The plan "${plan.name}" encrypts with this key.`);
    const kept = this.d.db
      .select()
      .from(backupRuns)
      .where(and(eq(backupRuns.keyId, id), eq(backupRuns.state, "ok"), isNull(backupRuns.prunedAt)))
      .all().length;
    if (kept)
      throw new Error(
        `${kept} kept backup${kept === 1 ? " is" : "s are"} encrypted with this key: without it ${kept === 1 ? "it" : "they"} can't be restored.`,
      );
    await this.d.secrets.delete(PRIVATE_KEY(id));
    this.d.db.delete(backupKeys).where(eq(backupKeys.id, id)).run();
    this.#publish("backup.key.removed", { id, name: k.name }, "owner");
  }

  // ── Plans

  #planRow(id: string): PlanRow {
    const p = this.d.db.select().from(backupPlans).where(eq(backupPlans.id, id)).get();
    if (!p) throw new Error(`No backup plan ${id}.`);
    return p;
  }

  #runView(r: RunRow): BackupRunView {
    let location = "this computer";
    if (r.destination.kind === "server") {
      try {
        location = this.d.servers.row(r.destination.serverId).name;
      } catch {
        location = "a removed server";
      }
    } else if (r.destination.kind === "cloud")
      location = r.destination.providerId
        ? `cloud storage, ${this.d.cloud?.label(r.destination.providerId) ?? "?"}`
        : "cloud storage";
    return {
      id: r.id,
      planId: r.planId,
      state: r.state,
      trigger: r.trigger,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      size: r.size,
      durationMs: r.durationMs,
      checksum: r.checksum,
      location,
      path: r.path,
      keyId: r.keyId,
      error: r.error,
      verifiedAt: r.verifiedAt,
      verifyOk: r.verifyOk,
      verifyNote: r.verifyNote,
      prunedAt: r.prunedAt,
    };
  }

  async #planView(p: PlanRow): Promise<BackupPlanView> {
    const last = this.d.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.planId, p.id))
      .orderBy(desc(backupRuns.startedAt))
      .limit(1)
      .get();
    return {
      id: p.id,
      name: p.name,
      target: p.target,
      schedule: p.schedule,
      destination: p.destination,
      retention: p.retention,
      keyId: p.keyId,
      enabled: p.enabled,
      hasPassword: !!(await this.d.secrets.get(PASSWORD(p.id))),
      hasUri: p.target.kind === "mongodb" && !!(await this.d.secrets.get(URI(p.id))),
      nextRunAt: p.enabled ? p.nextRunAt : null,
      running: this.#running.has(p.id),
      lastRun: last ? this.#runView(last) : null,
      createdAt: p.createdAt,
    };
  }

  async plans(serverId?: string): Promise<BackupPlanView[]> {
    const rows = this.d.db.select().from(backupPlans).orderBy(backupPlans.name).all();
    return Promise.all(
      rows
        .filter(
          (p) =>
            !serverId ||
            p.serverId === serverId ||
            (p.destination.kind === "server" && p.destination.serverId === serverId),
        )
        .map((p) => this.#planView(p)),
    );
  }

  plan(id: string): Promise<BackupPlanView> {
    return this.#planView(this.#planRow(id));
  }

  #check(p: {
    target: BackupTarget;
    destination: BackupDestination;
    keyId: string | null;
    schedule: PlanRow["schedule"];
  }) {
    checkTarget(p.target);
    this.d.servers.row(p.target.serverId);
    if (p.destination.kind === "server") this.d.servers.row(p.destination.serverId);
    if (p.destination.kind === "cloud") {
      const cloud = this.d.cloud;
      if (!cloud) throw new Error("Cloud storage isn't available here.");
      if (p.destination.providerId) cloud.provider(p.destination.providerId);
      else if (cloud.providers().length === 0)
        throw new Error("There is no cloud storage yet: add a provider in Cloud storage first.");
    }
    if (p.keyId) this.#keyRow(p.keyId);
    // Throws in words for a cron line that never comes round.
    nextRun(p.schedule, this.#now());
  }

  async createPlan(input: NewBackupPlan, actor = "owner"): Promise<BackupPlanView> {
    const target = TargetSchema.parse(input.target);
    this.#check({ ...input, target });
    const id = newId(this.#now());
    if (input.uri && target.kind !== "mongodb")
      throw new Error("A connection string is MongoDB's: leave it empty for this kind.");
    if (input.password) await this.d.secrets.set(PASSWORD(id), input.password);
    if (input.uri) await this.d.secrets.set(URI(id), input.uri);
    this.d.db
      .insert(backupPlans)
      .values({
        id,
        name: input.name,
        serverId: target.serverId,
        target,
        schedule: input.schedule,
        destination: input.destination,
        retention: input.retention,
        keyId: input.keyId,
        enabled: input.enabled,
        nextRunAt: nextRun(input.schedule, this.#now()),
        createdAt: this.#now(),
      })
      .run();
    this.#publish("backup.plan.created", { id, name: input.name }, actor);
    return this.plan(id);
  }

  async updatePlan(patch: BackupPlanPatch, actor = "owner"): Promise<BackupPlanView> {
    const p = this.#planRow(patch.id);
    // A target given without its kind's fields keeps the plan's own (a
    // change from the helper, or an older client, never resets them).
    const target = patch.target
      ? TargetSchema.parse({
          ...patch.target,
          options:
            patch.target.options ??
            (patch.target.kind === p.target.kind ? p.target.options : undefined),
        })
      : p.target;
    if (patch.uri && target.kind !== "mongodb")
      throw new Error("A connection string is MongoDB's: leave it empty for this kind.");
    const next = {
      name: patch.name ?? p.name,
      target,
      schedule: patch.schedule ?? p.schedule,
      destination: patch.destination ?? p.destination,
      retention: patch.retention ?? p.retention,
      keyId: patch.keyId === undefined ? p.keyId : patch.keyId,
      enabled: patch.enabled ?? p.enabled,
    };
    this.#check(next);
    if (patch.password) await this.d.secrets.set(PASSWORD(p.id), patch.password);
    else if (patch.clearPassword) await this.d.secrets.delete(PASSWORD(p.id));
    if (patch.uri) await this.d.secrets.set(URI(p.id), patch.uri);
    // Another kind has no use for it.
    else if (patch.clearUri || target.kind !== "mongodb") await this.d.secrets.delete(URI(p.id));
    const rescheduled =
      JSON.stringify(next.schedule) !== JSON.stringify(p.schedule) || (next.enabled && !p.enabled);
    this.d.db
      .update(backupPlans)
      .set({
        ...next,
        serverId: next.target.serverId,
        ...(rescheduled ? { nextRunAt: nextRun(next.schedule, this.#now()) } : {}),
      })
      .where(eq(backupPlans.id, p.id))
      .run();
    this.#publish("backup.plan.updated", { id: p.id }, actor);
    return this.plan(p.id);
  }

  /** Gone with its password; its backups stay where they are unless I say so. */
  async removePlan(id: string, deleteBackups = false) {
    const p = this.#planRow(id);
    if (this.#running.has(id)) throw new Error("It's running: wait for it to end.");
    if (deleteBackups)
      for (const r of this.d.db
        .select()
        .from(backupRuns)
        .where(and(eq(backupRuns.planId, id), isNull(backupRuns.prunedAt)))
        .all())
        if (r.path) await this.#deleteFile(r).catch(() => {});
    await this.d.secrets.delete(PASSWORD(id));
    await this.d.secrets.delete(URI(id));
    this.d.db.delete(backupRuns).where(eq(backupRuns.planId, id)).run();
    this.d.db.delete(backupPlans).where(eq(backupPlans.id, id)).run();
    this.#publish("backup.plan.removed", { id, name: p.name }, "owner");
  }

  // ── Test connection

  /**
   * Test connection (ADR-044 → Changed 2026-10-04): the form as it is,
   * nothing saved. The server over SSH; the database's own client logged
   * in with what was given, read only (its version and databases); the
   * destination, a small file written there and removed. Each part says
   * ok or why not; secrets go as the dump's do, never on a command line.
   */
  async testPlan(input: BackupPlanTest): Promise<BackupTestResult> {
    const kept = input.planId ? this.#planRow(input.planId) : null;
    const target = TargetSchema.parse(input.target);
    const password =
      input.password ?? (kept ? await this.d.secrets.get(PASSWORD(kept.id)) : null) ?? undefined;
    const uri =
      target.kind === "mongodb"
        ? (input.uri ??
          (kept && !input.clearUri ? await this.d.secrets.get(URI(kept.id)) : null) ??
          undefined)
        : undefined;
    const destination = this.#testDestination(input.destination).catch(
      (error): BackupTestResult["destination"] => ({ ok: false, said: words(error) }),
    );
    const result: BackupTestResult = {
      server: { ok: null, said: "" },
      database: {
        ok: null,
        said: "Not tried: the server wasn't reached.",
        version: null,
        databases: [],
      },
      destination: { ok: null, said: "" },
    };
    let client: Client | null = null;
    let srv: ReturnType<Servers["row"]> | null = null;
    try {
      srv = this.d.servers.row(target.serverId);
      client = await this.d.servers.client(target.serverId);
      result.server = { ok: true, said: `Reached ${srv.name} over SSH as ${srv.user}.` };
    } catch (error) {
      result.server = { ok: false, said: sshWords(error, srv) };
    }
    if (client && srv)
      result.database = await this.#testDatabase(client, srv, target, password, uri);
    result.destination = await destination;
    return result;
  }

  async #testDatabase(
    client: Client,
    srv: { name: string; user: string },
    target: BackupTarget,
    password: string | undefined,
    uri: string | undefined,
  ): Promise<BackupTestResult["database"]> {
    const name = KIND_NAMES[target.kind];
    const no = (said: string) => ({ ok: false, said, version: null, databases: [] });
    try {
      checkTarget(target);
    } catch (error) {
      return no(words(error));
    }
    // MongoDB's shell takes its login in the script on stdin; the others in the secret line.
    const stdin =
      target.kind === "mongodb"
        ? `\n${mongoTestScript(target, password, uri)}`
        : `${secretLine(target.kind, password)}\n`;
    let r: { code: number | null; stdout: string; stderr: string };
    try {
      r = await exec(client, testCommand(target, { uri: !!uri }), { stdin, timeoutMs: 45_000 });
    } catch {
      return no(`${name} gave no answer in 45 seconds.`);
    }
    if (r.code !== 0)
      return no(
        plainError(target, r.code, `${r.stdout}\n${r.stderr}`, {
          server: srv.name,
          user: srv.user,
          password,
          uri,
        }),
      );
    const { version, databases } = readTest(target.kind, r.stdout);
    const shown = databases.length
      ? `${databases.slice(0, 12).join(", ")}${databases.length > 12 ? ` and ${databases.length - 12} more` : ""}`
      : "none it may list";
    const where = target.container ? ` in ${target.container}` : "";
    if (
      target.database &&
      (target.kind === "postgres" || target.kind === "mysql" || target.kind === "mongodb") &&
      !databases.includes(target.database)
    )
      return {
        ok: false,
        said: `${name} ${version ?? ""}${where} let the login in, but has no database "${target.database}" (it has ${shown}).`,
        version,
        databases,
      };
    return {
      ok: true,
      said:
        target.kind === "sqlite"
          ? `SQLite ${version ?? ""} opened ${target.path} (read only)${where}.`
          : `${name} ${version ?? ""}${where} let the login in; its databases: ${shown}.`,
      version,
      databases,
    };
  }

  /** The destination takes a file: a small one written there and removed, with any folder it made. */
  async #testDestination(d: BackupDestination): Promise<BackupTestResult["destination"]> {
    const probe = `.oraknid-probe-${randomBytes(6).toString("hex")}`;
    if (d.kind === "local") {
      const folder = resolve(localFolder(d.folder));
      let made: string | undefined;
      try {
        made = mkdirSync(folder, { recursive: true, mode: 0o700 });
        const file = join(folder, probe);
        writeFileSync(file, "oraknid\n", { mode: 0o600 });
        rmSync(file, { force: true });
        return { ok: true, said: `This computer's folder ${d.folder} takes backups.` };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return {
          ok: false,
          said:
            code === "EACCES" || code === "EPERM"
              ? `Oraknid can't write in ${d.folder} on this computer: permission denied.`
              : code === "ENOTDIR" || code === "EEXIST"
                ? `${d.folder} on this computer is a file, not a folder.`
                : code === "EROFS"
                  ? `${d.folder} is on a read-only disk.`
                  : code === "ENOSPC"
                    ? `The disk holding ${d.folder} is full.`
                    : `${d.folder} on this computer: ${words(error)}`,
        };
      } finally {
        // Only the folders this test made, each removed only while empty.
        if (made)
          for (let x = folder; x.startsWith(made); x = dirname(x)) {
            try {
              rmdirSync(x);
            } catch {
              break;
            }
            if (x === made) break;
          }
      }
    }
    if (d.kind === "server") {
      let srv: ReturnType<Servers["row"]> | null = null;
      try {
        srv = this.d.servers.row(d.serverId);
        const c = await this.d.servers.client(d.serverId);
        const folder = remoteFolder(d.folder).replace(/\/+$/, "") || ".";
        // Writes a file in the folder (made if need be) and removes both what it made.
        const script =
          'd=$1; r=0; t=$d; top=; while [ ! -d "$t" ]; do top=$t; t=$(dirname "$t"); done; umask 077; mkdir -p "$d" || exit 3; f="$d/$2"; echo oraknid > "$f" || { r=4; }; rm -f "$f"; if [ -n "$top" ]; then x=$d; while rmdir "$x" 2>/dev/null; do [ "$x" = "$top" ] && break; x=$(dirname "$x"); done; fi; exit $r';
        const r = await exec(c, `sh -c ${q(script)} sh ${q(folder)} ${q(probe)}`, {
          timeoutMs: 30_000,
        });
        if (r.code === 0)
          return { ok: true, said: `${srv.name}'s folder ${d.folder} takes backups.` };
        const said = r.stderr.trim().split("\n").at(-1) ?? "";
        return {
          ok: false,
          said: /Permission denied/i.test(said)
            ? `${srv.user} can't write in ${d.folder} on ${srv.name}: permission denied.`
            : /Read-only/i.test(said)
              ? `${d.folder} on ${srv.name} is on a read-only disk.`
              : /No space/i.test(said)
                ? `The disk holding ${d.folder} on ${srv.name} is full.`
                : /Not a directory|File exists/i.test(said)
                  ? `${d.folder} on ${srv.name} is a file, not a folder.`
                  : `Couldn't write in ${d.folder} on ${srv.name}: ${said || `exit ${r.code}`}`,
        };
      } catch (error) {
        return { ok: false, said: sshWords(error, srv) };
      }
    }
    const cloud = this.d.cloud;
    if (!cloud) return { ok: false, said: "Cloud storage isn't available here." };
    if (!d.providerId && cloud.providers().length === 0)
      return { ok: false, said: "There is no cloud storage yet: add a provider in Cloud storage." };
    const file = cloud.tmpFile("probe");
    try {
      writeFileSync(file, "oraknid\n", { mode: 0o600 });
      const at = `${d.folder.replace(/^\/+|\/+$/g, "")}/${probe}`;
      const put = await cloud.putFile(file, at, { providerId: d.providerId, actor: "oraknid" });
      await cloud.deleteFile(put.providerId, put.path, "oraknid");
      return {
        ok: true,
        said: `Cloud storage (${cloud.label(put.providerId)}) took a test file in ${d.folder} and let it be removed.`,
      };
    } catch (error) {
      return { ok: false, said: `Cloud storage: ${words(error)}` };
    } finally {
      cloud.removeTmp(file);
    }
  }

  runs(o: { planId?: string; limit?: number } = {}): BackupRunView[] {
    return this.d.db
      .select()
      .from(backupRuns)
      .where(o.planId ? eq(backupRuns.planId, o.planId) : undefined)
      .orderBy(desc(backupRuns.startedAt))
      .limit(o.limit ?? 50)
      .all()
      .map((r) => this.#runView(r));
  }

  run(id: string): BackupRunView {
    return this.#runView(this.#runRow(id));
  }

  #runRow(id: string): RunRow {
    const r = this.d.db.select().from(backupRuns).where(eq(backupRuns.id, id)).get();
    if (!r) throw new Error(`No backup ${id}.`);
    return r;
  }

  // ── Running

  /** Starts a run now; the promise ends with it. Throws if the plan is already running. */
  begin(
    planId: string,
    trigger: "schedule" | "missed" | "manual" = "manual",
    actor = "owner",
  ): { runId: string; done: Promise<BackupRunView> } {
    const p = this.#planRow(planId);
    if (this.#running.has(planId)) throw new Error(`"${p.name}" is running already.`);
    const runId = newId(this.#now());
    this.d.db
      .insert(backupRuns)
      .values({
        id: runId,
        planId,
        state: "running",
        trigger,
        startedAt: this.#now(),
        destination: p.destination,
        keyId: p.keyId,
      })
      .run();
    this.#publish(
      "backup.run.started",
      {
        planId,
        runId,
        name: p.name,
        trigger,
        ...(trigger === "missed" ? { note: "Oraknid was off at its time: run now instead." } : {}),
      },
      actor,
    );
    const done = this.#run(p, runId).finally(() => this.#running.delete(planId));
    this.#running.set(planId, done);
    return { runId, done };
  }

  async #run(p: PlanRow, runId: string): Promise<BackupRunView> {
    const started = this.#now();
    const t = p.target;
    const password = await this.d.secrets.get(PASSWORD(p.id));
    const uri = t.kind === "mongodb" ? await this.d.secrets.get(URI(p.id)) : null;
    const name = `${stamp(started)}-${t.kind === "redis" ? "all" : (t.database ?? (t.kind === "sqlite" ? slug(t.path?.split("/").pop() ?? "db") : "all"))}.${extOf(t)}.zst${p.keyId ? ".age" : ""}`;
    const dir = `${slug(p.name)}-${p.id.slice(-6).toLowerCase()}`;
    let cleanup: () => Promise<void> = async () => {};
    /** Where it went: in the pool, the provider it was placed in. */
    let stored: BackupDestination = p.destination;
    let server = "?";
    let user = "?";
    try {
      const srv = this.d.servers.row(t.serverId);
      server = srv.name;
      user = srv.user;
      const recipient = p.keyId ? this.#keyRow(p.keyId).publicKey : null;
      const source = await this.d.servers.client(t.serverId);
      const { channel, done } = await execStream(source, dumpCommand(t, { uri: !!uri }));
      channel.end(`${secretLine(t.kind, password, uri ?? undefined)}\n`);
      const counter = tap();
      // Where it goes: written as `.part`, renamed once the dump said it ended well.
      let path: string;
      let out: NodeJS.WritableStream;
      let finish: () => Promise<void>;
      let destDone: Promise<{ code: number | null; stderr: string }> | null = null;
      if (p.destination.kind === "local") {
        const folder = join(localFolder(p.destination.folder), dir);
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        path = join(folder, name);
        const part = `${path}.part`;
        out = createWriteStream(part, { mode: 0o600 });
        cleanup = async () => rmSync(part, { force: true });
        finish = async () => renameSync(part, path);
      } else if (p.destination.kind === "cloud") {
        // Made here first (its size decides where it fits), then handed to the provider.
        const cloud = this.d.cloud;
        if (!cloud) throw new Error("Cloud storage isn't available here.");
        const dest = p.destination;
        const part = cloud.tmpFile("backup");
        const inPool = `${dest.folder.replace(/^\/+|\/+$/g, "")}/${dir}/${name}`;
        path = inPool;
        out = createWriteStream(part, { mode: 0o600 });
        cleanup = async () => cloud.removeTmp(part);
        finish = async () => {
          try {
            const put = await cloud.putFile(part, inPool, {
              providerId: dest.providerId,
              actor: "oraknid",
            });
            path = put.path;
            stored = { kind: "cloud", providerId: put.providerId, folder: dest.folder };
          } finally {
            cloud.removeTmp(part);
          }
        };
      } else {
        const dest = await this.d.servers.client(p.destination.serverId);
        const folder = `${remoteFolder(p.destination.folder).replace(/\/+$/, "")}/${dir}`;
        path = `${folder}/${name}`;
        const s = await execStream(
          dest,
          `sh -c ${q('umask 077 && mkdir -p "$1" && cat > "$2.part"')} sh ${q(folder)} ${q(path)}`,
        );
        // Nothing comes back but its end, which only arrives once its output is read.
        s.channel.resume();
        out = s.channel;
        destDone = s.done;
        cleanup = async () => {
          await exec(dest, `rm -f ${q(`${path}.part`)}`).catch(() => {});
        };
        finish = async () => {
          const r = await exec(dest, `mv ${q(`${path}.part`)} ${q(path)}`);
          if (r.code !== 0) throw new Error(`Couldn't put the backup in place: ${r.stderr.trim()}`);
        };
      }
      const stages: unknown[] = [channel, zstdCompress()];
      if (recipient) stages.push(ageEncrypt(recipient));
      stages.push(counter.stream, out);
      const destError = async () => {
        const d = destDone ? await destDone : { code: 0, stderr: "" };
        return d.code === 0
          ? null
          : `Couldn't write on ${p.destination.kind === "server" ? this.d.servers.row(p.destination.serverId).name : "the server"}: ${d.stderr.trim().split("\n").at(-1) ?? `exit ${d.code}`}`;
      };
      try {
        await piped(stages, destDone);
      } catch (error) {
        throw new Error(
          (await destError()) ?? (error instanceof Error ? error.message : String(error)),
        );
      }
      const dump = await done;
      if (dump.code !== 0)
        throw new Error(
          plainError(t, dump.code, dump.stderr, { server, user, password, uri: uri ?? undefined }),
        );
      const destFailed = await destError();
      if (destFailed) throw new Error(destFailed);
      if (counter.size === 0) throw new Error("The dump wrote nothing.");
      await finish();
      const ended = this.#now();
      this.d.db
        .update(backupRuns)
        .set({
          state: "ok",
          endedAt: ended,
          size: counter.size,
          durationMs: ended - started,
          checksum: counter.checksum,
          path,
          destination: stored,
        })
        .where(eq(backupRuns.id, runId))
        .run();
      this.#publish("backup.run.ended", {
        planId: p.id,
        runId,
        name: p.name,
        state: "ok",
        size: counter.size,
      });
      await this.#prune(p).catch(() => {});
    } catch (error) {
      await cleanup().catch(() => {});
      let message = error instanceof Error ? error.message : String(error);
      for (const s of [password, uri]) if (s) message = message.split(s).join("•••");
      const ended = this.#now();
      this.d.db
        .update(backupRuns)
        .set({ state: "failed", endedAt: ended, durationMs: ended - started, error: message })
        .where(eq(backupRuns.id, runId))
        .run();
      this.#publish("backup.run.ended", {
        planId: p.id,
        runId,
        name: p.name,
        state: "failed",
        error: message,
      });
      // A notification (Notifications → backup.failed).
      this.#publish("backup.failed", { planId: p.id, runId, name: p.name, error: message });
    }
    return this.#runView(this.#runRow(runId));
  }

  /** Retention: what's beyond the plan's count or age goes, the newest good one always stays. */
  async #prune(p: PlanRow) {
    const good = this.d.db
      .select()
      .from(backupRuns)
      .where(
        and(eq(backupRuns.planId, p.id), eq(backupRuns.state, "ok"), isNull(backupRuns.prunedAt)),
      )
      .all();
    for (const r of toPrune(good, p.retention, this.#now())) {
      await this.#deleteFile(r);
      this.d.db
        .update(backupRuns)
        .set({ prunedAt: this.#now() })
        .where(eq(backupRuns.id, r.id))
        .run();
      this.#publish("backup.pruned", { planId: p.id, runId: r.id });
    }
  }

  async #deleteFile(r: RunRow) {
    if (!r.path) return;
    if (r.destination.kind === "local") rmSync(r.path, { force: true });
    else if (r.destination.kind === "cloud") {
      if (!this.d.cloud || !r.destination.providerId)
        throw new Error("Cloud storage isn't available here.");
      await this.d.cloud.deleteFile(r.destination.providerId, r.path, "oraknid");
    } else {
      const c = await this.d.servers.client(r.destination.serverId);
      const res = await exec(c, `rm -f ${q(r.path)}`);
      if (res.code !== 0) throw new Error(res.stderr.trim());
    }
  }

  /** The stored file, as a stream (and the connection it comes through). */
  async #read(r: RunRow): Promise<{ stream: NodeJS.ReadableStream; done: Promise<string | null> }> {
    if (!r.path || r.state !== "ok" || r.prunedAt)
      throw new Error("That backup isn't kept any more.");
    if (r.destination.kind === "local") {
      const s = createReadStream(r.path);
      return { stream: s, done: Promise.resolve(null) };
    }
    if (r.destination.kind === "cloud") {
      // Brought here first, into a file of mine, removed once read.
      const cloud = this.d.cloud;
      if (!cloud || !r.destination.providerId)
        throw new Error("Cloud storage isn't available here.");
      const file = cloud.tmpFile("verify");
      try {
        await cloud.getFile(r.destination.providerId, r.path, file);
      } catch (error) {
        cloud.removeTmp(file);
        throw new Error(
          `Couldn't bring it from ${cloud.label(r.destination.providerId)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const s = createReadStream(file);
      s.once("close", () => cloud.removeTmp(file));
      return { stream: s, done: Promise.resolve(null) };
    }
    const c: Client = await this.d.servers.client(r.destination.serverId);
    const { channel, done } = await execStream(c, `cat -- ${q(r.path)}`);
    channel.end();
    return {
      stream: channel,
      done: done.then((d) => (d.code === 0 ? null : d.stderr.trim() || `exit ${d.code}`)),
    };
  }

  /** The stream of a stored backup, decrypted and decompressed, into `into`. */
  async #unpack(
    r: RunRow,
    into: NodeJS.WritableStream,
    farEnd?: Promise<unknown>,
  ): Promise<{ checksum: string }> {
    const counter = tap();
    const identity = r.keyId ? await this.d.secrets.get(PRIVATE_KEY(r.keyId)) : null;
    if (r.keyId && !identity)
      throw new Error("Its key's private half isn't in the keychain: import it first.");
    const { stream, done } = await this.#read(r);
    const stages: unknown[] = [stream, counter.stream];
    if (identity) stages.push(ageDecrypt(identity));
    stages.push(zstdDecompress(), into);
    try {
      await piped(stages, farEnd);
    } catch (error) {
      const m = error instanceof Error ? error.message : String(error);
      throw new Error(
        /zstd|Unknown frame|corrupt|Data corruption/i.test(m)
          ? `It can't be decompressed: ${m}`
          : m,
      );
    }
    const err = await done;
    if (err) throw new Error(`Couldn't read it: ${err}`);
    return { checksum: counter.checksum };
  }

  /** Decrypts, decompresses and looks at a backup: is it whole, and of its kind? */
  async verify(runId: string, actor = "owner"): Promise<BackupRunView> {
    const r = this.#runRow(runId);
    const p = this.#planRow(r.planId);
    let ok = false;
    let note: string;
    try {
      const ends = new Ends();
      const { checksum } = await this.#unpack(r, ends);
      if (r.checksum && checksum !== r.checksum)
        note = "Its checksum changed since it was made: the file was altered or damaged.";
      else ({ ok, note } = sane(p.target.kind, ends.head, ends.tail, ends.size));
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    this.d.db
      .update(backupRuns)
      .set({ verifiedAt: this.#now(), verifyOk: ok, verifyNote: note })
      .where(eq(backupRuns.id, runId))
      .run();
    this.#publish("backup.verified", { planId: p.id, runId, ok, note }, actor);
    return this.#runView(this.#runRow(runId));
  }

  /**
   * A kept backup as a download (ADR-046): as stored, or decrypted with its
   * key when I ask (still zstd-compressed). Only to a browser on this
   * computer (`backups.downloadLink`).
   */
  async openStored(runId: string, decrypt = false): Promise<Download> {
    const r = this.#runRow(runId);
    if (!r.path || r.state !== "ok" || r.prunedAt)
      throw new Error("That backup isn't kept any more.");
    if (decrypt && !r.keyId) throw new Error("That backup isn't encrypted.");
    const identity = decrypt && r.keyId ? await this.d.secrets.get(PRIVATE_KEY(r.keyId)) : null;
    if (decrypt && !identity)
      throw new Error("Its key's private half isn't in the keychain: import it first.");
    const fileName = r.path.split("/").pop() ?? "backup";
    let source: NodeJS.ReadableStream;
    let size: number | null = r.size;
    let done: Promise<string | null>;
    if (r.destination.kind === "cloud" && r.destination.providerId && this.d.cloud) {
      const o = await this.d.cloud.open(r.destination.providerId, r.path);
      source = o.stream;
      size = o.size;
      done = o.done;
    } else ({ stream: source, done } = await this.#read(r));
    this.#publish("backup.downloaded", { planId: r.planId, runId, decrypted: !!identity }, "owner");
    if (!identity) return { stream: source as Readable, name: fileName, size, done };
    return {
      stream: Readable.from(ageDecrypt(identity)(source as AsyncIterable<Buffer>)),
      name: fileName.replace(/\.age$/, ""),
      size: null,
      done,
    };
  }

  /** What keeps a cloud provider in use, in words; null when nothing does. */
  cloudUse(providerId: string): string | null {
    const plan = this.d.db
      .select()
      .from(backupPlans)
      .all()
      .find((p) => p.destination.kind === "cloud" && p.destination.providerId === providerId);
    if (plan) return `The backup plan "${plan.name}" keeps its backups there.`;
    const kept = this.d.db
      .select()
      .from(backupRuns)
      .where(and(eq(backupRuns.state, "ok"), isNull(backupRuns.prunedAt)))
      .all()
      .filter(
        (r) => r.destination.kind === "cloud" && r.destination.providerId === providerId,
      ).length;
    return kept
      ? `${kept} kept backup${kept === 1 ? " is" : "s are"} there: without it ${kept === 1 ? "it" : "they"} can't be restored.`
      : null;
  }

  /**
   * A restore's first step: what it will replace, said in words, and the
   * word to type back. Nothing changes until the second step.
   */
  async prepareRestore(o: {
    runId: string;
    target?: BackupTarget | undefined;
    password?: string | undefined;
  }): Promise<RestorePreview> {
    const r = this.#runRow(o.runId);
    const p = this.#planRow(r.planId);
    if (r.state !== "ok" || r.prunedAt || !r.path)
      throw new Error("That backup isn't kept any more.");
    const target = o.target ? TargetSchema.parse(o.target) : p.target;
    if (target.kind !== p.target.kind)
      throw new Error(
        `A ${KIND_NAMES[p.target.kind]} backup restores only into ${KIND_NAMES[p.target.kind]}.`,
      );
    checkTarget(target);
    const server = this.d.servers.row(target.serverId).name;
    const where = `${target.container ? `the container ${target.container} on ` : ""}${server}`;
    const what =
      target.kind === "sqlite"
        ? `the SQLite file ${target.path}`
        : target.kind === "redis"
          ? "all of Redis's data"
          : target.database
            ? `the database "${target.database}"`
            : `every database`;
    const when = new Date(r.startedAt).toLocaleString();
    const token = randomBytes(18).toString("base64url");
    const expiresAt = this.#now() + RESTORE_TTL;
    this.#restores.set(token, {
      runId: r.id,
      target,
      password: o.password,
      expiresAt,
    });
    return {
      token,
      summary: `Replace ${what} ${target.container ? "in" : "on"} ${where} with the backup of ${when} (${p.name}). What is there now is lost.${target.kind === "redis" ? " Redis stops and starts again to load it." : ""}`,
      confirmWord:
        target.kind === "sqlite"
          ? (target.path?.split("/").pop() ?? server)
          : (target.database ?? server),
      expiresAt,
    };
  }

  /** The second step: with the word typed back, the backup goes in. Mine only, never an agent's. */
  async restore(token: string, typed: string): Promise<{ note: string }> {
    const pending = this.#restores.get(token);
    if (!pending || pending.expiresAt < this.#now()) {
      this.#restores.delete(token);
      throw new Error("That restore wasn't confirmed in time: start it again.");
    }
    const r = this.#runRow(pending.runId);
    const p = this.#planRow(r.planId);
    const t = pending.target;
    const confirmWord =
      t.kind === "sqlite"
        ? (t.path?.split("/").pop() ?? "")
        : (t.database ?? this.d.servers.row(t.serverId).name);
    if (typed.trim() !== confirmWord)
      throw new Error(`Type "${confirmWord}" to confirm: nothing was restored.`);
    this.#restores.delete(token);
    const same = JSON.stringify(t) === JSON.stringify(p.target);
    const password =
      pending.password ?? (same ? await this.d.secrets.get(PASSWORD(p.id)) : undefined);
    const uri =
      same && t.kind === "mongodb"
        ? ((await this.d.secrets.get(URI(p.id))) ?? undefined)
        : undefined;
    const srv = this.d.servers.row(t.serverId);
    this.#publish(
      "backup.restore.started",
      { planId: p.id, runId: r.id, server: srv.name, database: t.database },
      "owner",
    );
    try {
      const client = await this.d.servers.client(t.serverId);
      const { channel, done } = await execStream(
        client,
        restoreCommand(t, p.target.database, { uri: !!uri, pgFormat: pgFormatOf(r.path) }),
      );
      // What the tool prints is dropped; its stderr is kept for the error.
      channel.on("data", () => {});
      channel.write(`${secretLine(t.kind, password, uri)}\n`);
      let broken: unknown = null;
      await this.#unpack(r, channel, done).catch((e) => {
        broken = e;
      });
      const res = await done;
      const placed = t.kind === "redis" && res.stderr.includes(PLACED);
      if (res.code !== 0 && !placed)
        throw new Error(
          plainError(t, res.code, res.stderr, { server: srv.name, user: srv.user, password, uri }),
        );
      if (broken) throw broken;
      const note =
        t.kind === "redis" && !t.container
          ? "Restored: Redis was stopped to load it. If it didn't come back by itself, start it (sudo systemctl start redis)."
          : "Restored.";
      this.#publish("backup.restore.ended", { planId: p.id, runId: r.id, ok: true }, "owner");
      return { note };
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      for (const s of [password, uri]) if (s) message = message.split(s).join("•••");
      this.#publish(
        "backup.restore.ended",
        { planId: p.id, runId: r.id, ok: false, error: message },
        "owner",
      );
      throw new Error(message);
    }
  }

  // ── The schedule

  /** Runs what is due; a time long past is a missed run (Oraknid was off), run once and said so. */
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      for (const p of this.d.db
        .select()
        .from(backupPlans)
        .where(eq(backupPlans.enabled, true))
        .all()) {
        let next = p.nextRunAt;
        if (next === null) {
          next = nextRun(p.schedule, now);
          this.d.db
            .update(backupPlans)
            .set({ nextRunAt: next })
            .where(eq(backupPlans.id, p.id))
            .run();
        }
        if (next > now || this.#running.has(p.id)) continue;
        this.d.db
          .update(backupPlans)
          .set({ nextRunAt: nextRun(p.schedule, now) })
          .where(eq(backupPlans.id, p.id))
          .run();
        this.begin(p.id, now - next > MISSED_AFTER ? "missed" : "schedule", "oraknid");
      }
    } finally {
      this.#ticking = false;
    }
  }

  /** Runs cut by a stop are failed, their partial files gone; then the schedule starts. */
  start() {
    for (const r of this.d.db
      .select()
      .from(backupRuns)
      .where(eq(backupRuns.state, "running"))
      .all()) {
      this.d.db
        .update(backupRuns)
        .set({ state: "failed", endedAt: this.#now(), error: "Oraknid stopped during the run." })
        .where(eq(backupRuns.id, r.id))
        .run();
    }
    void this.tick().catch(() => {});
    this.#timer = setInterval(() => void this.tick().catch(() => {}), this.d.tickMs ?? 30_000);
    this.#timer.unref();
  }

  /** Every run in progress, to wait for in tests. */
  settled(): Promise<unknown> {
    return Promise.allSettled([...this.#running.values()]);
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** The plan in words, for the helper. */
  describe(p: BackupPlanView): string {
    const server = (() => {
      try {
        return this.d.servers.row(p.target.serverId).name;
      } catch {
        return "?";
      }
    })();
    const dest =
      p.destination.kind === "local"
        ? `this computer, ${p.destination.folder}`
        : p.destination.kind === "cloud"
          ? `cloud storage (${p.destination.providerId ? (this.d.cloud?.label(p.destination.providerId) ?? "?") : "the pool, placed by its rule"}), ${p.destination.folder}`
          : `${(() => {
              try {
                return this.d.servers.row((p.destination as { serverId: string }).serverId).name;
              } catch {
                return "?";
              }
            })()}, ${p.destination.folder}`;
    return `"${p.name}" (id ${p.id}): ${KIND_NAMES[p.target.kind]} ${p.target.database ?? "all"}${p.target.container ? ` in container ${p.target.container}` : ""} on ${server}; ${describeSchedule(p.schedule)}; to ${dest}; keep ${p.retention.count ?? "any number"} / ${p.retention.days ? `${p.retention.days} days` : "any age"}; ${p.keyId ? "encrypted" : "not encrypted"}; ${p.enabled ? "on" : "paused"}${p.hasPassword ? "" : ", no password kept"}; last run: ${p.lastRun ? `${p.lastRun.state}${p.lastRun.error ? ` (${p.lastRun.error})` : ""} (run id ${p.lastRun.id})` : "never"}.`;
  }
}
