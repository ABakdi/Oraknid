import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  ReviewDetail,
  ReviewNote,
  ReviewNoteAdd,
  ReviewNoteEdit,
  ReviewOpen,
  ReviewOpened,
  ReviewState,
  ReviewView,
} from "@oraknid/contracts";
import { and, asc, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects, reviewNotes, reviews, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";

// Reviews (ADR-064 §2–3, M16.1): the harness opens one at an evaluation
// step; I annotate the design or the running app on the review page, per
// device; Send notes ends the round, Approve ends the step. What is shown
// is served by the daemon on the review's own origin (frame.ts), never
// written into the project.

export type ReviewRow = typeof reviews.$inferSelect;
type NoteRow = typeof reviewNotes.$inferSelect;

export interface ReviewsDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  /** <data>: screenshots go under <data>/reviews/<id>/. */
  dataDir: string;
  /** The daemon's own port: the frame's origin is on it, and no review may proxy to it. */
  port: () => number;
  now?: () => number;
}

/** A review's frame origin's name: rv-<key>.localhost, a key nobody can guess. */
export const frameHost = (key: string) => `rv-${key}.localhost`;

/** The page in the web UI. */
export const reviewPath = (id: string) => `/review/${id}`;

/** Ports a review never proxies to, whatever it is told: none below 1024. */
const LOWEST_PORT = 1024;

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" = "BAD_REQUEST",
  ) {
    super(message);
  }
}

export class Reviews {
  readonly #now: () => number;

  constructor(private readonly d: ReviewsDeps) {
    this.#now = d.now ?? Date.now;
  }

  /**
   * Opens a review for a job's evaluation step, or the next round of the
   * step's review once notes were sent; the same step's open review is
   * returned as it is (its target brought up to date). The connected pages
   * are asked to open it (`review.opened`), and the inbox says it waits.
   */
  open(input: ReviewOpen): ReviewOpened {
    const job = this.d.db.select().from(jobs).where(eq(jobs.id, input.jobId)).get();
    if (!job) throw new ReviewError(`No job ${input.jobId}.`, "NOT_FOUND");
    if (job.state === "completed" || job.state === "cancelled")
      throw new ReviewError("That job has ended: nothing waits for a review any more.", "CONFLICT");
    const taskId = input.taskId ?? null;
    if (taskId) {
      const task = this.d.db
        .select({ jobId: tasks.jobId })
        .from(tasks)
        .where(eq(tasks.id, taskId))
        .get();
      if (task?.jobId !== job.id)
        throw new ReviewError(`No step ${taskId} in that job.`, "NOT_FOUND");
    }
    const target =
      input.kind === "design"
        ? this.#designFolder(job, String(input.target))
        : String(this.#appPort(input.target));
    const entry = normalEntry(input.entry);
    const title = input.title ?? (input.kind === "design" ? "The design" : "The app");
    const now = this.#now();
    const previous = taskId
      ? this.d.db
          .select()
          .from(reviews)
          .where(and(eq(reviews.jobId, job.id), eq(reviews.taskId, taskId)))
          .orderBy(desc(reviews.createdAt))
          .get()
      : this.d.db
          .select()
          .from(reviews)
          .where(
            and(eq(reviews.jobId, job.id), isNull(reviews.taskId), eq(reviews.kind, input.kind)),
          )
          .orderBy(desc(reviews.createdAt))
          .get();
    let id: string;
    let round: number;
    this.d.bus.atomically(() => {
      if (previous && previous.state === "open") {
        // Asked again while it waits: the same review, pointed at what is current.
        id = previous.id;
        round = previous.round;
        this.d.db
          .update(reviews)
          .set({ target, entry, title, kind: input.kind, updatedAt: now })
          .where(eq(reviews.id, id))
          .run();
        return;
      }
      if (previous && previous.state === "notes-sent") {
        id = previous.id;
        round = previous.round + 1;
        this.d.db
          .update(reviews)
          .set({
            target,
            entry,
            title,
            kind: input.kind,
            round,
            state: "open",
            updatedAt: now,
            endedAt: null,
          })
          .where(eq(reviews.id, id))
          .run();
      } else {
        id = newId(now);
        round = 1;
        this.d.db
          .insert(reviews)
          .values({
            id,
            jobId: job.id,
            taskId,
            projectId: job.projectId,
            kind: input.kind,
            title,
            target,
            entry,
            round,
            state: "open",
            frameKey: randomBytes(16).toString("hex"),
            createdAt: now,
            updatedAt: now,
          })
          .run();
      }
      const itemId = this.d.inbox.open({
        kind: "question",
        jobId: job.id,
        taskId,
        raisedBy: "eye",
        title:
          (input.kind === "design"
            ? "A design is ready for your review"
            : "The app is ready for your review") + (round > 1 ? ` (round ${round})` : ""),
        detail: `${title}: open it, point at what you'd keep, change or call a problem, on each device you care about; then **Approve** or **Send notes**.`,
        options: [],
      });
      this.d.db.update(reviews).set({ inboxItemId: itemId }).where(eq(reviews.id, id)).run();
      this.d.bus.publish({
        type: "review.opened",
        // On "inbox": every page of mine listens to it, and opens the review in a new tab.
        topic: "inbox",
        jobId: job.id,
        payload: {
          id,
          kind: input.kind,
          projectId: job.projectId,
          round,
          title,
          url: reviewPath(id),
        },
      });
    });
    // biome-ignore lint/style/noNonNullAssertion: set in the transaction above
    return { id: id!, url: reviewPath(id!), round: round! };
  }

  get(id: string, remote = false): ReviewDetail {
    const row = this.#row(id);
    const notes = this.d.db
      .select()
      .from(reviewNotes)
      .where(and(eq(reviewNotes.reviewId, id), isNull(reviewNotes.deletedAt)))
      .orderBy(asc(reviewNotes.id))
      .all()
      .map(noteView);
    const [view] = this.#views([row], remote);
    if (!view) throw new ReviewError(`No review ${id}.`, "NOT_FOUND");
    return { ...view, notes };
  }

  list(
    f: { projectId?: string; jobId?: string; state?: ReviewState } = {},
    remote = false,
  ): ReviewView[] {
    const where: SQL[] = [];
    if (f.projectId) where.push(eq(reviews.projectId, f.projectId));
    if (f.jobId) where.push(eq(reviews.jobId, f.jobId));
    if (f.state) where.push(eq(reviews.state, f.state));
    const rows = this.d.db
      .select()
      .from(reviews)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(reviews.updatedAt))
      .limit(200)
      .all();
    return this.#views(rows, remote);
  }

  /** The open reviews of a project (the chat's notes go to one of them). */
  openIn(projectId: string): ReviewView[] {
    return this.list({ projectId, state: "open" });
  }

  /** A round's notes, deleted ones left out: what The Eye turns into work. */
  notes(id: string, round?: number): ReviewNote[] {
    const row = this.#row(id);
    return this.d.db
      .select()
      .from(reviewNotes)
      .where(
        and(
          eq(reviewNotes.reviewId, id),
          eq(reviewNotes.round, round ?? row.round),
          isNull(reviewNotes.deletedAt),
        ),
      )
      .orderBy(asc(reviewNotes.id))
      .all()
      .map(noteView);
  }

  addNote(
    input: ReviewNoteAdd,
    o: { deviceId?: string | null; source?: "page" | "chat" } = {},
  ): ReviewNote {
    const row = this.#row(input.reviewId);
    if (row.state !== "open")
      throw new ReviewError("This review isn't open: its round has ended.", "CONFLICT");
    const id = newId(this.#now());
    const shot = input.screenshot ? this.#saveShot(row.id, id, input.screenshot) : null;
    this.d.bus.atomically(() => {
      this.d.db
        .insert(reviewNotes)
        .values({
          id,
          reviewId: row.id,
          round: row.round,
          kind: input.kind,
          text: this.d.bus.scrub(input.text),
          device: input.device,
          element: input.element
            ? {
                ...input.element,
                text: this.d.bus.scrub(input.element.text),
              }
            : null,
          page: input.page ?? null,
          screenshot: shot,
          console: (input.console ?? []).map((c) => ({ ...c, text: this.d.bus.scrub(c.text) })),
          requests: (input.requests ?? []).map((r) => ({ ...r, url: this.d.bus.scrub(r.url) })),
          source: o.source ?? "page",
          authorDeviceId: o.deviceId ?? null,
          createdAt: this.#now(),
        })
        .run();
      this.#touch(row.id);
      this.#noteEvent(row, id, "added");
    });
    return this.#noteView(id);
  }

  editNote(input: ReviewNoteEdit): ReviewNote {
    const note = this.#editable(input.id);
    this.d.bus.atomically(() => {
      this.d.db
        .update(reviewNotes)
        .set({
          ...(input.text !== undefined ? { text: this.d.bus.scrub(input.text) } : {}),
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          editedAt: this.#now(),
        })
        .where(eq(reviewNotes.id, note.id))
        .run();
      this.#touch(note.reviewId);
      this.#noteEvent(this.#row(note.reviewId), note.id, "edited");
    });
    return this.#noteView(note.id);
  }

  deleteNote(id: string) {
    const note = this.#editable(id);
    this.d.bus.atomically(() => {
      this.d.db
        .update(reviewNotes)
        .set({ deletedAt: this.#now(), screenshot: null })
        .where(eq(reviewNotes.id, id))
        .run();
      this.#touch(note.reviewId);
      this.#noteEvent(this.#row(note.reviewId), id, "deleted");
    });
    if (note.screenshot) rmSync(this.#shotFile(note.reviewId, note.screenshot), { force: true });
  }

  /**
   * Ends the round: my notes go to The Eye as `review.notes-sent` (on the
   * job's topic), which turns them into work and opens the next round.
   */
  sendNotes(id: string): { round: number; notes: number } {
    const row = this.#row(id);
    if (row.state !== "open") throw new ReviewError("This review isn't open.", "CONFLICT");
    const notes = this.notes(id);
    if (!notes.length)
      throw new ReviewError("No notes to send yet: add one, or Approve.", "BAD_REQUEST");
    this.d.bus.atomically(() => {
      this.#end(row, "notes-sent");
      this.d.bus.publish({
        type: "review.notes-sent",
        topic: `job:${row.jobId}`,
        jobId: row.jobId,
        payload: { reviewId: id, taskId: row.taskId, round: row.round, notes: notes.map(brief) },
        actor: "owner",
      });
    });
    return { round: row.round, notes: notes.length };
  }

  /** Ends the step: approved. Keep-notes travel with it, as constraints for later tasks. */
  approve(id: string) {
    const row = this.#row(id);
    if (row.state !== "open") throw new ReviewError("This review isn't open.", "CONFLICT");
    const notes = this.notes(id);
    this.d.bus.atomically(() => {
      this.#end(row, "approved");
      this.d.bus.publish({
        type: "review.approved",
        topic: `job:${row.jobId}`,
        jobId: row.jobId,
        payload: { reviewId: id, taskId: row.taskId, round: row.round, notes: notes.map(brief) },
        actor: "owner",
      });
    });
  }

  /** Taken back (the step was dropped, the job ended): nothing waits for it. */
  withdraw(id: string, actor: "owner" | "eye" | "oraknid" = "owner") {
    const row = this.#row(id);
    if (row.state === "withdrawn" || row.state === "approved") return;
    this.d.bus.atomically(() => {
      this.#end(row, "withdrawn");
      this.d.bus.publish({
        type: "review.withdrawn",
        topic: `job:${row.jobId}`,
        jobId: row.jobId,
        payload: { reviewId: id, round: row.round },
        actor,
      });
    });
  }

  /** Every review of a job not ended yet, withdrawn (the job ended). */
  withdrawJob(jobId: string) {
    for (const r of this.d.db
      .select({ id: reviews.id })
      .from(reviews)
      .where(and(eq(reviews.jobId, jobId), inArray(reviews.state, ["open", "notes-sent"])))
      .all())
      this.withdraw(r.id, "oraknid");
  }

  /**
   * A message of mine in the project's conversation, attached to its open
   * review as a general note (ADR-064 §3). Null when no single review is open.
   */
  attachChatToReview(projectId: string, text: string): { reviewId: string; noteId: string } | null {
    const open = this.openIn(projectId);
    const r = open.length === 1 ? open[0] : undefined;
    if (!r) return null;
    const note = this.addNote(
      { reviewId: r.id, kind: "general", text: text.slice(0, 4000), device: null, element: null },
      { source: "chat" },
    );
    return { reviewId: r.id, noteId: note.id };
  }

  /** The review an inbox item tells me about, if it is one. */
  reviewOfItem(itemId: string): ReviewRow | null {
    return this.d.db.select().from(reviews).where(eq(reviews.inboxItemId, itemId)).get() ?? null;
  }

  /** Reviews by inbox items, for the inbox's list. */
  reviewIdsOfItems(itemIds: string[]): Map<string, string> {
    if (!itemIds.length) return new Map();
    return new Map(
      this.d.db
        .select({ id: reviews.id, item: reviews.inboxItemId })
        .from(reviews)
        .where(inArray(reviews.inboxItemId, itemIds))
        .all()
        .map((r) => [r.item ?? "", r.id]),
    );
  }

  /** A note's screenshot as a data URL. */
  screenshot(noteId: string): string | null {
    const note = this.d.db.select().from(reviewNotes).where(eq(reviewNotes.id, noteId)).get();
    if (!note || note.deletedAt) throw new ReviewError(`No note ${noteId}.`, "NOT_FOUND");
    if (!note.screenshot) return null;
    const file = this.#shotFile(note.reviewId, note.screenshot);
    if (!existsSync(file)) return null;
    const type = note.screenshot.endsWith(".png") ? "image/png" : "image/jpeg";
    return `data:${type};base64,${readFileSync(file).toString("base64")}`;
  }

  /** The review whose frame origin has this key; a withdrawn one shows nothing. */
  byKey(key: string): ReviewRow | null {
    const row = this.d.db.select().from(reviews).where(eq(reviews.frameKey, key)).get();
    return row && row.state !== "withdrawn" ? row : null;
  }

  row(id: string): ReviewRow {
    return this.#row(id);
  }

  /** Where the frame loads the review at home: its own origin on this daemon. */
  frameUrl(row: Pick<ReviewRow, "frameKey" | "entry">): string {
    return `http://${frameHost(row.frameKey)}:${this.d.port()}${row.entry}`;
  }

  /**
   * The design's folder, checked again at every request: it must still be
   * a folder inside the project's (or the job's worktree), symlinks
   * resolved, or nothing is served.
   */
  designRoot(row: ReviewRow): string | null {
    if (row.kind !== "design") return null;
    const job = this.d.db.select().from(jobs).where(eq(jobs.id, row.jobId)).get();
    if (!job) return null;
    try {
      return this.#designFolder(job, row.target);
    } catch {
      return null;
    }
  }

  #designFolder(job: typeof jobs.$inferSelect, target: string): string {
    const project = this.d.db
      .select({ path: projects.workspacePath })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .get();
    if (!project) throw new ReviewError("That job's project is gone.", "NOT_FOUND");
    const roots = [project.path, job.worktree]
      .filter((p): p is string => !!p)
      .map((p) => {
        try {
          return realpathSync(p);
        } catch {
          return null;
        }
      })
      .filter((p): p is string => !!p);
    const base = job.worktree && existsSync(job.worktree) ? job.worktree : project.path;
    const asked = isAbsolute(target) ? target : resolve(base, target);
    let real: string;
    try {
      real = realpathSync(asked);
    } catch {
      throw new ReviewError(`No folder ${target}.`, "NOT_FOUND");
    }
    if (!statSync(real).isDirectory()) throw new ReviewError(`${target} is not a folder.`);
    if (!roots.some((r) => real === r || real.startsWith(r + sep)))
      throw new ReviewError(
        "A design is served from inside its project's folder (or the job's worktree) only.",
      );
    return real;
  }

  #appPort(target: string | number): number {
    let port: number;
    if (typeof target === "number") port = target;
    else if (/^\d+$/.test(target.trim())) port = Number(target.trim());
    else {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        throw new ReviewError(
          "An app is reviewed on its local port: a number, or http://127.0.0.1:<port>.",
        );
      }
      if (
        u.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) ||
        !u.port
      )
        throw new ReviewError("An app is reviewed on this computer only: http://127.0.0.1:<port>.");
      port = Number(u.port);
    }
    if (!Number.isInteger(port) || port < LOWEST_PORT || port > 65535)
      throw new ReviewError(
        `Port ${port} can't be reviewed: it must be between ${LOWEST_PORT} and 65535.`,
      );
    if (port === this.d.port())
      throw new ReviewError(
        "That is Oraknid's own port: a review shows the job's app, not Oraknid.",
      );
    return port;
  }

  #row(id: string): ReviewRow {
    const row = this.d.db.select().from(reviews).where(eq(reviews.id, id)).get();
    if (!row) throw new ReviewError(`No review ${id}.`, "NOT_FOUND");
    return row;
  }

  #editable(noteId: string): NoteRow {
    const note = this.d.db.select().from(reviewNotes).where(eq(reviewNotes.id, noteId)).get();
    if (!note || note.deletedAt) throw new ReviewError(`No note ${noteId}.`, "NOT_FOUND");
    const row = this.#row(note.reviewId);
    if (row.state !== "open" || note.round !== row.round)
      throw new ReviewError("That note's round has ended: it can't be changed now.", "CONFLICT");
    return note;
  }

  #noteView(id: string): ReviewNote {
    const n = this.d.db.select().from(reviewNotes).where(eq(reviewNotes.id, id)).get();
    if (!n) throw new ReviewError(`No note ${id}.`, "NOT_FOUND");
    return noteView(n);
  }

  #touch(id: string) {
    this.d.db.update(reviews).set({ updatedAt: this.#now() }).where(eq(reviews.id, id)).run();
  }

  #end(row: ReviewRow, state: Exclude<ReviewState, "open">) {
    const now = this.#now();
    this.d.db
      .update(reviews)
      .set({ state, updatedAt: now, endedAt: now })
      .where(eq(reviews.id, row.id))
      .run();
    if (row.inboxItemId) this.d.inbox.withdraw(row.inboxItemId);
  }

  #noteEvent(row: ReviewRow, noteId: string, change: "added" | "edited" | "deleted") {
    this.d.bus.publish({
      type: `review.note-${change}`,
      topic: `job:${row.jobId}`,
      jobId: row.jobId,
      payload: { reviewId: row.id, noteId, round: row.round },
      actor: "owner",
    });
  }

  #views(rows: ReviewRow[], remote: boolean): ReviewView[] {
    if (!rows.length) return [];
    const jobIds = [...new Set(rows.map((r) => r.jobId))];
    const about = new Map(
      this.d.db
        .select({ id: jobs.id, title: jobs.title, project: projects.name })
        .from(jobs)
        .innerJoin(projects, eq(projects.id, jobs.projectId))
        .where(inArray(jobs.id, jobIds))
        .all()
        .map((j) => [j.id, j]),
    );
    const counts = new Map<string, number>();
    for (const n of this.d.db
      .select({ reviewId: reviewNotes.reviewId, round: reviewNotes.round })
      .from(reviewNotes)
      .where(
        and(
          inArray(
            reviewNotes.reviewId,
            rows.map((r) => r.id),
          ),
          isNull(reviewNotes.deletedAt),
        ),
      )
      .all()) {
      const r = rows.find((x) => x.id === n.reviewId);
      if (r && r.round === n.round) counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
    }
    return rows.map((r) => ({
      id: r.id,
      jobId: r.jobId,
      taskId: r.taskId,
      projectId: r.projectId,
      projectName: about.get(r.jobId)?.project ?? "",
      jobTitle: about.get(r.jobId)?.title ?? "",
      title: r.title,
      kind: r.kind,
      target: r.kind === "app" ? `http://127.0.0.1:${r.target}` : r.target,
      entry: r.entry,
      round: r.round,
      state: r.state,
      // Away from home the frame can't load from this computer: it comes inlined (reviews.frame).
      frameUrl: remote || r.state === "withdrawn" ? null : this.frameUrl(r),
      noteCount: counts.get(r.id) ?? 0,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      endedAt: r.endedAt,
    }));
  }

  #shotFile(reviewId: string, name: string) {
    return join(this.d.dataDir, "reviews", reviewId, name);
  }

  #saveShot(reviewId: string, noteId: string, dataUrl: string): string {
    const m = /^data:image\/(jpeg|png);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new ReviewError("A screenshot is a JPEG or PNG data URL.");
    const name = `${noteId}.${m[1] === "png" ? "png" : "jpg"}`;
    const dir = join(this.d.dataDir, "reviews", reviewId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, name), Buffer.from(m[2] ?? "", "base64"), { mode: 0o600 });
    return name;
  }
}

/** "/" or a path inside the target, as the frame opens it. */
function normalEntry(entry: string | undefined): string {
  const e = (entry ?? "/").trim() || "/";
  if (/^[a-z]+:/i.test(e) || e.startsWith("//") || e.includes("\\") || e.includes("\0"))
    throw new ReviewError("The page to open is a path inside what is reviewed, like /index.html.");
  return e.startsWith("/") ? e : `/${e}`;
}

function noteView(n: NoteRow): ReviewNote {
  return {
    id: n.id,
    reviewId: n.reviewId,
    round: n.round,
    kind: n.kind,
    text: n.text,
    device: n.device ?? null,
    element: n.element ?? null,
    page: n.page,
    hasScreenshot: !!n.screenshot,
    console: n.console,
    requests: n.requests,
    source: n.source,
    createdAt: n.createdAt,
    editedAt: n.editedAt,
  };
}

/** A note as The Eye reads it in an event: the words, where, and what went wrong. */
function brief(n: ReviewNote) {
  return {
    id: n.id,
    kind: n.kind,
    text: n.text,
    device: n.device ? `${n.device.name} ${n.device.width}×${n.device.height}` : null,
    page: n.page,
    element: n.element
      ? { selector: n.element.selector, tag: n.element.tag, text: n.element.text.slice(0, 200) }
      : null,
    console: n.console.slice(-5).map((c) => `${c.level}: ${c.text.slice(0, 300)}`),
    requests: n.requests
      .slice(-5)
      .map((r) => `${r.method} ${r.url.slice(0, 200)} → ${r.status ?? r.error ?? "failed"}`),
    source: n.source,
  };
}
