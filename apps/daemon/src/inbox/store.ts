import type { Actor, InboxItem } from "@oraknid/contracts";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { inboxItems } from "../db/schema.ts";
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
          title: item.title,
          detail: item.detail,
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

  /** Open first, approvals before questions (they block work), newest first (Approvals → The inbox). */
  list(state?: string): InboxItem[] {
    const q = this.db.select().from(inboxItems);
    const rows = (state ? q.where(eq(inboxItems.state, state)) : q)
      .orderBy(desc(inboxItems.id))
      .all() as InboxItem[];
    const rank = (i: InboxItem) => (i.state === "open" ? 0 : 2) + (i.kind === "approval" ? 0 : 1);
    return rows.sort((a, b) => rank(a) - rank(b));
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
      if (item.state !== "open") throw new Error("That item was already answered.");
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
