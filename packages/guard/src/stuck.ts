// An agent stuck on blocks (ADR-053): three blocks in a row, or twenty in
// one task, and The Eye asks the owner, with the blocked actions and their
// reasons. An action that runs ends a row.

export interface Blocked {
  action: string;
  reason: string;
  /** Layer 1 (the rules), 2 (the judge), or the agent's own auto mode (Claude Code's classifier). */
  layer: 1 | 2 | "leg";
}

export const IN_A_ROW = 3;
export const IN_A_TASK = 20;

export class StuckWatch {
  #tasks = new Map<string, { row: Blocked[]; total: Blocked[]; askedAtTotal: boolean }>();

  constructor(
    private readonly inARow = IN_A_ROW,
    private readonly inATask = IN_A_TASK,
  ) {}

  #of(task: string) {
    let t = this.#tasks.get(task);
    if (!t) {
      t = { row: [], total: [], askedAtTotal: false };
      this.#tasks.set(task, t);
    }
    return t;
  }

  /** An action ran: the row ends. */
  allowed(task: string) {
    const t = this.#tasks.get(task);
    if (t) t.row = [];
  }

  /**
   * An action was blocked. Returns the blocks to show the owner when the
   * agent is stuck now (the row, or the whole task's at its twentieth), else null.
   */
  blocked(task: string, b: Blocked): { why: string; blocks: Blocked[] } | null {
    const t = this.#of(task);
    t.row.push(b);
    t.total.push(b);
    if (t.total.length >= this.inATask && !t.askedAtTotal) {
      t.askedAtTotal = true;
      const blocks = t.total.slice(-this.inATask);
      t.row = [];
      return { why: `${t.total.length} actions were blocked in this task`, blocks };
    }
    if (t.row.length >= this.inARow) {
      const blocks = t.row;
      t.row = [];
      return { why: `${blocks.length} actions in a row were blocked`, blocks };
    }
    return null;
  }

  /** A task's counts as they stand, to keep across a restart; null when it has none. */
  snapshot(task: string): { row: Blocked[]; total: Blocked[]; askedAtTotal: boolean } | null {
    const t = this.#tasks.get(task);
    return t ? { row: [...t.row], total: [...t.total], askedAtTotal: t.askedAtTotal } : null;
  }

  /** A task's counts as kept, in place of what is in memory. */
  restore(task: string, s: { row: Blocked[]; total: Blocked[]; askedAtTotal: boolean } | null) {
    if (!s) this.#tasks.delete(task);
    else
      this.#tasks.set(task, { row: [...s.row], total: [...s.total], askedAtTotal: s.askedAtTotal });
  }

  /** Blocks counted for a task so far. */
  count(task: string): number {
    return this.#tasks.get(task)?.total.length ?? 0;
  }

  forget(task: string) {
    this.#tasks.delete(task);
  }

  /** Every task whose key starts so (a job's, `<job>:`) is forgotten. */
  forgetStarting(prefix: string) {
    for (const k of this.#tasks.keys()) if (k.startsWith(prefix)) this.#tasks.delete(k);
  }
}
