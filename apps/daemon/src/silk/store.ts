import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Actor, SilkEntry, SilkKind } from "@oraknid/contracts";
import { current, parseMirrorEdits, renderMirror } from "@oraknid/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects, silkEntries, silkMirror } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";

export interface NewSilkEntry {
  jobId: string;
  taskId?: string | null;
  kind: SilkKind;
  title: string;
  body: string;
  authoredBy: Actor;
  supersedes?: string | null;
}

export const IMPORT = "Import my edits";
export const DISCARD = "Discard them";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Silk (docs/01-Specification/Silk.md): the database is the source of
 * truth; after every change the mirror under `.oraknid/silk/` is
 * rewritten, and my hand edits are offered for import, never applied
 * silently and never overwritten silently (ADR-007).
 */
export class SilkStore {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly inbox: InboxStore,
    private readonly now: () => number = Date.now,
  ) {}

  add(e: NewSilkEntry): SilkEntry {
    if (!e.title.trim()) throw new Error("A Silk entry needs a title.");
    const row = {
      id: newId(this.now()),
      jobId: e.jobId,
      taskId: e.taskId ?? null,
      kind: e.kind,
      title: e.title.trim(),
      body: e.body,
      supersedes: e.supersedes ?? null,
      authoredBy: e.authoredBy,
      createdAt: this.now(),
    };
    this.bus.atomically(() => {
      if (row.supersedes) {
        const old = this.get(row.supersedes);
        if (!old || old.jobId !== e.jobId) throw new Error("That entry is not in this job's Silk.");
        // My entries are never superseded automatically (Silk → Editing).
        if (old.authoredBy === "owner" && e.authoredBy !== "owner") {
          throw new Error("Only I can supersede an entry I wrote.");
        }
      }
      this.db.insert(silkEntries).values(row).run();
      this.bus.publish({
        type: "silk.added",
        topic: `job:${e.jobId}`,
        jobId: e.jobId,
        payload: { id: row.id, kind: row.kind, title: row.title, supersedes: row.supersedes },
        actor: typeof e.authoredBy === "string" ? e.authoredBy : `leg:${e.authoredBy.legId}`,
      });
    });
    this.writeMirror(e.jobId);
    return row as SilkEntry;
  }

  get(id: string): SilkEntry | undefined {
    return this.db.select().from(silkEntries).where(eq(silkEntries.id, id)).get() as
      | SilkEntry
      | undefined;
  }

  /** Every entry of the job, superseded ones included, oldest first. */
  all(jobId: string): SilkEntry[] {
    return this.db
      .select()
      .from(silkEntries)
      .where(eq(silkEntries.jobId, jobId))
      .orderBy(asc(silkEntries.id))
      .all() as SilkEntry[];
  }

  current(jobId: string): SilkEntry[] {
    return current(this.all(jobId));
  }

  /** The mirror lives in the job's worktree, or its project folder before there is one. */
  mirrorDir(jobId: string): string | null {
    const row = this.db
      .select({ path: projects.workspacePath, worktree: jobs.worktree })
      .from(jobs)
      .innerJoin(projects, eq(jobs.projectId, projects.id))
      .where(eq(jobs.id, jobId))
      .get();
    return row ? join(row.worktree ?? row.path, ".oraknid", "silk") : null;
  }

  /**
   * Rewrites the mirror. A file I edited since Oraknid last wrote it is
   * left alone until I answer the import question.
   */
  writeMirror(jobId: string, opts: { check?: boolean } = {}) {
    const dir = this.mirrorDir(jobId);
    if (!dir || !existsSync(dirname(dirname(dir)))) return;
    if (opts.check ?? true) this.checkMirror(jobId);
    const job = this.db.select({ title: jobs.title }).from(jobs).where(eq(jobs.id, jobId)).get();
    const files = renderMirror(job?.title ?? jobId, this.all(jobId));
    for (const [file, content] of Object.entries(files)) {
      const known = this.#known(jobId, file);
      if (known?.pendingItemId) continue;
      const path = join(dir, file);
      mkdirSync(dirname(path), { recursive: true });
      // Atomic: a crash never leaves half a file (ADR-007).
      writeFileSync(`${path}.tmp`, content);
      renameSync(`${path}.tmp`, path);
      this.db
        .insert(silkMirror)
        .values({ jobId, file, hash: hash(content) })
        .onConflictDoUpdate({
          target: [silkMirror.jobId, silkMirror.file],
          set: { hash: hash(content) },
        })
        .run();
    }
  }

  /** Looks for hand edits; asks me once per edited file. Returns the files asked about. */
  checkMirror(jobId: string): string[] {
    const dir = this.mirrorDir(jobId);
    if (!dir) return [];
    const asked: string[] = [];
    const tracked = this.db.select().from(silkMirror).where(eq(silkMirror.jobId, jobId)).all();
    for (const t of tracked) {
      if (t.pendingItemId) continue;
      const path = join(dir, t.file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      if (hash(text) === t.hash) continue;
      const edits = parseMirrorEdits(t.file, text, this.all(jobId));
      if (edits.length === 0) {
        // A change with nothing to import (e.g. a removed section): Silk only grows.
        this.#setHash(jobId, t.file, "");
        continue;
      }
      const itemId = this.inbox.open({
        kind: "question",
        jobId,
        raisedBy: "eye",
        title: `Import my edits to Silk (${t.file})?`,
        detail: edits
          .map((e) => `- ${e.supersedes ? "Changed" : "New"}: **${e.title}**`)
          .join("\n"),
        options: [IMPORT, DISCARD],
        defaultOption: IMPORT,
      });
      this.db
        .update(silkMirror)
        .set({ pendingItemId: itemId })
        .where(and(eq(silkMirror.jobId, jobId), eq(silkMirror.file, t.file)))
        .run();
      asked.push(t.file);
    }
    return asked;
  }

  /** My answer to an import question: import the edits as my entries, or put Oraknid's version back. */
  answerImport(itemId: string, answer: string): boolean {
    const t = this.db.select().from(silkMirror).where(eq(silkMirror.pendingItemId, itemId)).get();
    if (!t) return false;
    let imported = 0;
    if (answer === IMPORT) {
      const dir = this.mirrorDir(t.jobId);
      const text =
        dir && existsSync(join(dir, t.file)) ? readFileSync(join(dir, t.file), "utf8") : "";
      const taskId = t.file.startsWith("handoffs/")
        ? t.file.slice("handoffs/".length, -".md".length)
        : null;
      for (const edit of parseMirrorEdits(t.file, text, this.all(t.jobId))) {
        this.add({
          jobId: t.jobId,
          taskId: taskId === "job" ? null : taskId,
          kind: edit.kind,
          title: edit.title,
          body: edit.body,
          authoredBy: "owner",
          supersedes: edit.supersedes,
        });
        imported++;
      }
    }
    this.db
      .update(silkMirror)
      .set({ pendingItemId: null, hash: "" })
      .where(and(eq(silkMirror.jobId, t.jobId), eq(silkMirror.file, t.file)))
      .run();
    // My answer settles this file: write Oraknid's version without asking again.
    this.writeMirror(t.jobId, { check: false });
    this.bus.publish({
      type: "silk.mirror",
      topic: `job:${t.jobId}`,
      jobId: t.jobId,
      payload: { file: t.file, answer, imported },
    });
    return true;
  }

  #known(jobId: string, file: string) {
    return this.db
      .select()
      .from(silkMirror)
      .where(and(eq(silkMirror.jobId, jobId), eq(silkMirror.file, file)))
      .get();
  }

  #setHash(jobId: string, file: string, value: string) {
    this.db
      .update(silkMirror)
      .set({ hash: value })
      .where(and(eq(silkMirror.jobId, jobId), eq(silkMirror.file, file)))
      .run();
  }
}
