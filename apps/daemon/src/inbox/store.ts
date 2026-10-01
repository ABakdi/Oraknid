import type { Actor, InboxFilter, InboxItem } from "@oraknid/contracts";
import { and, desc, eq, type SQL } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { inboxItems, jobs, projects, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";

export interface NewInboxItem {
  kind: "approval" | "question";
  jobId: string;
  taskId?: string | null;
  raisedBy: Actor;
  title: string;
  detail: string;
  options: string[];
  defaultOption?: string | null;
}

/**
 * The inbox's storage. Approvals and questions are raised here; answering
 * them from the UI, routing and notifications arrive in M1.7.
 */
export class InboxStore {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  open(item: NewInboxItem): string {
    const id = newId(this.now());
    this.bus.atomically(() => {
      this.db
        .insert(inboxItems)
        .values({
          id,
          kind: item.kind,
          jobId: item.jobId,
          taskId: item.taskId ?? null,
          raisedBy: item.raisedBy,
          title: this.bus.scrub(item.title),
          detail: this.bus.scrub(item.detail),
          options: item.options,
          defaultOption: item.defaultOption ?? null,
          state: "open",
          createdAt: this.now(),
        })
        .run();
      this.bus.publish({
        type: "inbox.opened",
        topic: "inbox",
        jobId: item.jobId,
        payload: { id, kind: item.kind, title: item.title },
      });
    });
    return id;
  }

  /**
   * Open first, approvals before questions (they block work), newest first
   * (Approvals → The inbox). Each item names its job and project, and can
   * be filtered by them, by kind and state, and searched (Checkpoint 1 → F1-2).
   */
  list(filter: string | InboxFilter = {}): InboxItem[] {
    const f: InboxFilter =
      typeof filter === "string" ? { state: filter as InboxFilter["state"] } : filter;
    const where: SQL[] = [];
    if (f.state) where.push(eq(inboxItems.state, f.state));
    if (f.kind) where.push(eq(inboxItems.kind, f.kind));
    if (f.jobId) where.push(eq(inboxItems.jobId, f.jobId));
    if (f.projectId) where.push(eq(jobs.projectId, f.projectId));
    let rows = this.db
      .select({
        item: inboxItems,
        jobTitle: jobs.title,
        projectId: jobs.projectId,
        projectName: projects.name,
        taskTitle: tasks.title,
      })
      .from(inboxItems)
      .innerJoin(jobs, eq(jobs.id, inboxItems.jobId))
      .innerJoin(projects, eq(projects.id, jobs.projectId))
      .leftJoin(tasks, eq(tasks.id, inboxItems.taskId))
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(inboxItems.id))
      .all()
      .map((r) => ({
        ...(r.item as InboxItem),
        jobTitle: r.jobTitle,
        projectId: r.projectId,
        projectName: r.projectName,
        taskTitle: r.taskTitle,
      }));
    const words = (f.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length) {
      rows = rows.filter((i) => {
        const hay = [i.title, i.detail, i.jobTitle, i.projectName, i.taskTitle, i.answer]
          .join("\n")
          .toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const rank = (i: InboxItem) => (i.state === "open" ? 0 : 2) + (i.kind === "approval" ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b)).slice(0, f.limit ?? 500);
  }

  get(id: string) {
    return this.db.select().from(inboxItems).where(eq(inboxItems.id, id)).get();
  }

  /** Takes back a question nobody needs answered any more (the attempt that asked has ended). */
  withdraw(id: string) {
    this.bus.atomically(() => {
      const item = this.get(id);
      if (item?.state !== "open") return;
      this.db.update(inboxItems).set({ state: "withdrawn" }).where(eq(inboxItems.id, id)).run();
      this.bus.publish({
        type: "inbox.withdrawn",
        topic: "inbox",
        jobId: item.jobId,
        payload: { id },
      });
    });
  }

  answer(id: string, answer: string, deviceId: string | null = null) {
    this.bus.atomically(() => {
      const item = this.get(id);
      if (!item) throw new Error(`No inbox item ${id}.`);
      if (item.state === "withdrawn")
        throw new Error("That question was withdrawn: nothing waits for it any more.");
      if (item.state !== "open") throw new Error("That item was already answered.");
      // An approval is answered with one of its options, never free text read as a denial (Audit 1 → Q1-11).
      if (item.kind === "approval" && !item.options.includes(answer))
        throw new Error(`Answer with one of: ${item.options.join(", ")}.`);
      this.db
        .update(inboxItems)
        .set({ state: "answered", answer, answeredAt: this.now(), answeredByDeviceId: deviceId })
        .where(eq(inboxItems.id, id))
        .run();
      this.bus.publish({
        type: "inbox.answered",
        topic: "inbox",
        jobId: item.jobId,
        payload: { id, answer },
        actor: "owner",
      });
    });
  }
}
