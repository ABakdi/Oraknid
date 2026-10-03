import type { Budget } from "@oraknid/contracts";

// Budgets (docs/01-Specification/Budgets-and-Quotas.md): hard limits stop
// new work and ask me; soft ones notify and continue; at 80% of a hard
// limit I'm warned (BR-9). Money defaults to 0 (BR-10).

export type BudgetDimension = "tokens" | "wallClockMs" | "money";

export interface BudgetUse {
  tokens: number;
  wallClockMs: number;
  money: number;
}

export interface BudgetFinding {
  dimension: BudgetDimension;
  kind: "warning" | "reached";
  hard: boolean;
  used: number;
  limit: number;
  /** In plain words, for the inbox and notifications. */
  message: string;
}

const NAMES: Record<BudgetDimension, string> = {
  tokens: "token",
  wallClockMs: "time",
  money: "money",
};

const show = (d: BudgetDimension, n: number) =>
  d === "wallClockMs"
    ? `${Math.floor(n / 3600_000)}h ${Math.round((n % 3600_000) / 60_000)}m`
    : d === "money"
      ? `$${n.toFixed(2)}`
      : `${Math.round(n).toLocaleString("en-US")} tokens`;

/**
 * What the job's use means against its budget. `already` holds what was
 * reported before (e.g. "tokens:warning"), so each finding is made once.
 */
export function checkBudget(
  budget: Budget,
  use: BudgetUse,
  already: ReadonlySet<string>,
  /** Whose budget it is: a job's, or a project's across its jobs (ADR-034). */
  of: "job" | "project" = "job",
): BudgetFinding[] {
  const who = of === "project" ? "The project" : "The job";
  const paused = of === "project" ? "its jobs are paused" : "it is paused";
  const out: BudgetFinding[] = [];
  const dims: [BudgetDimension, { limit: number; hard: boolean } | null][] = [
    ["tokens", budget.tokens],
    ["wallClockMs", budget.wallClockMs],
    // A zero money budget means "no money", not "a limit of zero to warn about".
    ["money", budget.money.limit > 0 ? budget.money : null],
  ];
  for (const [d, b] of dims) {
    if (!b) continue;
    const used = use[d];
    if (used >= b.limit && !already.has(`${d}:reached`)) {
      out.push({
        dimension: d,
        kind: "reached",
        hard: b.hard,
        used,
        limit: b.limit,
        message: b.hard
          ? `${who} used its ${NAMES[d]} budget (${show(d, used)} of ${show(d, b.limit)}); ${paused} until I raise it.`
          : `${who} passed its ${NAMES[d]} alarm (${show(d, used)} of ${show(d, b.limit)}); it carries on. Come and look.`,
      });
    } else if (b.hard && used >= b.limit * 0.8 && used < b.limit && !already.has(`${d}:warning`)) {
      out.push({
        dimension: d,
        kind: "warning",
        hard: true,
        used,
        limit: b.limit,
        message: `${who} has used 80% of its ${NAMES[d]} budget (${show(d, used)} of ${show(d, b.limit)}).`,
      });
    }
  }
  return out;
}

/** A raised budget: the dimension's limit times `factor`, the rest unchanged. */
export function raiseBudget(budget: Budget, d: BudgetDimension, factor: number): Budget {
  const b = budget[d];
  if (!b) return budget;
  return { ...budget, [d]: { ...b, limit: Math.ceil(b.limit * factor) } };
}
