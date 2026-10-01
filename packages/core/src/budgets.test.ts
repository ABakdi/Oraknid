import { DEFAULT_BUDGET } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { checkBudget, raiseBudget } from "./budgets.ts";

const use = (o: Partial<{ tokens: number; wallClockMs: number; money: number }> = {}) => ({
  tokens: 0,
  wallClockMs: 0,
  money: 0,
  ...o,
});

describe("budgets (BR-9, BR-10)", () => {
  const budget = { ...DEFAULT_BUDGET, tokens: { limit: 1000, hard: true } };

  it("warns once at 80% of a hard limit, and stops at it", () => {
    expect(checkBudget(budget, use({ tokens: 799 }), new Set())).toEqual([]);
    const warn = checkBudget(budget, use({ tokens: 800 }), new Set());
    expect(warn).toMatchObject([{ dimension: "tokens", kind: "warning", hard: true }]);
    expect(warn[0]?.message).toBe(
      "The job has used 80% of its token budget (800 tokens of 1,000 tokens).",
    );
    expect(checkBudget(budget, use({ tokens: 900 }), new Set(["tokens:warning"]))).toEqual([]);
    const stop = checkBudget(budget, use({ tokens: 1000 }), new Set(["tokens:warning"]));
    expect(stop[0]?.message).toBe(
      "The job used its token budget (1,000 tokens of 1,000 tokens); it is paused until I raise it.",
    );
  });

  it("treats the default time limit as an alarm: it notifies and carries on", () => {
    const [alarm] = checkBudget(DEFAULT_BUDGET, use({ wallClockMs: 8 * 3600_000 }), new Set());
    expect(alarm).toMatchObject({ dimension: "wallClockMs", kind: "reached", hard: false });
    expect(alarm?.message).toBe(
      "The job passed its time alarm (8h 0m of 8h 0m); it carries on. Come and look.",
    );
  });

  it("never warns about a money budget of zero: it means no money at all", () => {
    expect(checkBudget(DEFAULT_BUDGET, use({ money: 0 }), new Set())).toEqual([]);
  });

  it("raises one limit and keeps the rest", () => {
    expect(raiseBudget(budget, "tokens", 1.5).tokens).toEqual({ limit: 1500, hard: true });
    expect(raiseBudget(budget, "tokens", 1.5).money).toEqual(DEFAULT_BUDGET.money);
  });
});
