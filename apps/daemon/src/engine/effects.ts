import type { SideEffectState } from "@oraknid/contracts";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { sideEffects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";

export type EffectRow = typeof sideEffects.$inferSelect;

export interface EffectSpec {
  /** Unique within the job (and task): the same key is the same action. */
  key: string;
  /** What kind of action, e.g. "git.push", "email.send". Picks the reconciler. */
  action: string;
  payload: Record<string, unknown>;
  taskId?: string | null;
  /** Needs my approval before it runs (BR-5). */
  gated?: boolean;
  /** What the approval shows me, in plain words. */
  describe?: string;
  /** The approval's title, when the action's name says too little. */
  title?: string;
}

/** After a crash: did this action happen in the outside world? */
export type Reconciler = (effect: EffectRow) => Promise<"happened" | "did-not-happen" | "unknown">;

export const HAPPENED = "It happened";
export const DID_NOT_HAPPEN = "It did not happen";

export class AwaitingOwner extends Error {
  constructor(
    readonly inboxItemId: string,
    message: string,
  ) {
    super(message);
    this.name = "AwaitingOwner";
  }
}

export class EffectDenied extends Error {
  constructor(action: string) {
    super(`I denied "${action}".`);
    this.name = "EffectDenied";
  }
}

/**
 * The side-effect outbox (BR-6). Each external action is written as
 * `intended` before anything happens and `performing` just before it
 * runs, so after a crash an action is never blindly repeated.
 */
export class SideEffects {
  readonly #reconcilers = new Map<string, Reconciler>();

  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly inbox: InboxStore,
    private readonly now: () => number = Date.now,
  ) {}

  reconciler(action: string, fn: Reconciler) {
    this.#reconcilers.set(action, fn);
  }

  static keyOf(jobId: string, spec: Pick<EffectSpec, "key" | "taskId">) {
    return `${jobId}:${spec.taskId ?? "-"}:${spec.key}`;
  }

  get(idempotencyKey: string): EffectRow | undefined {
    return this.db
      .select()
      .from(sideEffects)
      .where(eq(sideEffects.idempotencyKey, idempotencyKey))
      .get();
  }

  /** Records the intent once; later calls return the existing row. */
  intend(jobId: string, spec: EffectSpec): EffectRow {
    const key = SideEffects.keyOf(jobId, spec);
    const existing = this.get(key);
    if (existing) return existing;
    const t = this.now();
    this.bus.atomically(() => {
      this.db
        .insert(sideEffects)
        .values({
          id: newId(t),
          jobId,
          taskId: spec.taskId ?? null,
          idempotencyKey: key,
          action: spec.action,
          payload: spec.payload,
          // Ungated actions need no approval: they are approved by intent.
          state: spec.gated ? "intended" : "approved",
          createdAt: t,
          updatedAt: t,
        })
        .run();
      this.#event(jobId, key, spec.gated ? "intended" : "approved");
    });
    return this.get(key) as EffectRow;
  }

  set(
    key: string,
    state: SideEffectState,
    extra: { result?: unknown; problem?: string | null; inboxItemId?: string | null } = {},
  ) {
    this.bus.atomically(() => {
      const row = this.get(key);
      if (!row) throw new Error(`No side effect ${key}.`);
      this.db
        .update(sideEffects)
        .set({
          state,
          updatedAt: this.now(),
          ...(extra.result !== undefined ? { result: extra.result } : {}),
          ...(extra.problem !== undefined ? { problem: extra.problem } : {}),
          ...(extra.inboxItemId !== undefined ? { inboxItemId: extra.inboxItemId } : {}),
        })
        .where(eq(sideEffects.idempotencyKey, key))
        .run();
      this.#event(row.jobId, key, state);
    });
  }

  /** Asks me to approve a gated action, once. Returns the inbox item. */
  requestApproval(row: EffectRow, describe: string, title?: string): string {
    if (row.inboxItemId) return row.inboxItemId;
    const id = this.inbox.open({
      kind: "approval",
      jobId: row.jobId,
      taskId: row.taskId,
      raisedBy: "eye",
      title: title ?? `Approve: ${row.action}`,
      detail: describe,
      options: ["Approve", "Deny"],
      defaultOption: null,
    });
    this.set(row.idempotencyKey, row.state as SideEffectState, { inboxItemId: id });
    return id;
  }

  /** Asks me whether an action caught mid-way happened, once. Returns the inbox item. */
  askWhetherItHappened(row: EffectRow): string {
    if (row.inboxItemId) return row.inboxItemId;
    const id = this.inbox.open({
      kind: "question",
      jobId: row.jobId,
      taskId: row.taskId,
      raisedBy: "eye",
      title: `Did "${row.action}" happen?`,
      detail: `${row.problem ?? ""}\n\nWhat it was doing: ${JSON.stringify(row.payload)}`,
      options: [HAPPENED, DID_NOT_HAPPEN],
      defaultOption: null,
    });
    this.set(row.idempotencyKey, row.state as SideEffectState, { inboxItemId: id });
    return id;
  }

  approve(key: string) {
    this.set(key, "approved", { inboxItemId: null });
  }

  deny(key: string) {
    this.set(key, "denied", { inboxItemId: null });
  }

  /** My answer to "did this happen?" after reconciliation could not tell. */
  resolve(key: string, happened: boolean) {
    this.set(key, happened ? "performed" : "approved", { problem: null, inboxItemId: null });
  }

  /**
   * Settles one action caught in `performing` with its reconciler.
   * Returns the row afterwards: `performed`, back to `approved`, or still
   * `performing` with a problem when it needs me.
   */
  async reconcile(row: EffectRow): Promise<EffectRow> {
    const check = this.#reconcilers.get(row.action);
    const verdict = check ? await check(row).catch(() => "unknown" as const) : "unknown";
    if (verdict === "happened") this.set(row.idempotencyKey, "performed", { problem: null });
    else if (verdict === "did-not-happen")
      this.set(row.idempotencyKey, "approved", { problem: null });
    else {
      const problem = check
        ? `Oraknid stopped while doing "${row.action}" and cannot tell whether it happened.`
        : `Oraknid stopped while doing "${row.action}", and has no way to check whether it happened.`;
      this.set(row.idempotencyKey, "performing", { problem });
    }
    return this.get(row.idempotencyKey) as EffectRow;
  }

  /** After a crash: settles every action caught in `performing`. Returns the ones that need me. */
  async reconcileAll(): Promise<EffectRow[]> {
    const caught = this.db
      .select()
      .from(sideEffects)
      .where(inArray(sideEffects.state, ["performing"]))
      .all();
    const needMe: EffectRow[] = [];
    for (const row of caught) {
      // One I was already asked about stays with me.
      if (row.inboxItemId) {
        needMe.push(row);
        continue;
      }
      const after = await this.reconcile(row);
      if (after.state === "performing") needMe.push(after);
    }
    return needMe;
  }

  #event(jobId: string, key: string, state: SideEffectState) {
    this.bus.publish({
      type: "effect.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { key, state },
    });
  }
}
