import { describe, expect, it } from "vitest";
import {
  defaultProfile,
  effectiveProfile,
  emptyStoredProfile,
  estimateUtilization,
  learnStrength,
  record,
} from "./profiles.ts";

describe("default profiles", () => {
  it("ranks Claude models by strength and quota cost", () => {
    const opus = defaultProfile("claude-code", "opus");
    const sonnet = defaultProfile("claude-code", "sonnet");
    const haiku = defaultProfile("claude-code", "haiku");
    expect(opus.strengths.planning).toBeGreaterThan(sonnet.strengths.planning ?? 0);
    expect(opus.quotaWeight).toBeGreaterThan(sonnet.quotaWeight);
    expect(sonnet.quotaWeight).toBeGreaterThan(haiku.quotaWeight);
    expect(haiku.strengths.mechanical).toBeGreaterThan(haiku.strengths.planning ?? 0);
    expect([opus.maxDifficulty, sonnet.maxDifficulty, haiku.maxDifficulty]).toEqual([
      "high",
      "medium",
      "low",
    ]);
  });

  it("starts a bare local model on small text work", () => {
    const local = defaultProfile("openai-compatible", "qwen3-coder:30b");
    expect(local.costModel).toBe("local");
    expect(local.strengths.summarize).toBeGreaterThan(local.strengths.architecture ?? 0);
    expect(local.maxDifficulty).toBe("low");
  });
});

describe("learning (at most ±0.5 per 20 attempts)", () => {
  it("does not move before 20 attempts", () => {
    expect(learnStrength(3, { attempts: 19, successes: 0, tokens: 0, ms: 0, escalations: 0 })).toBe(
      3,
    );
  });

  it("moves by at most half a point per 20 attempts, either way", () => {
    expect(
      learnStrength(3, { attempts: 20, successes: 20, tokens: 0, ms: 0, escalations: 0 }),
    ).toBe(3.5);
    expect(learnStrength(3, { attempts: 20, successes: 0, tokens: 0, ms: 0, escalations: 0 })).toBe(
      2.5,
    );
    expect(
      learnStrength(3, { attempts: 100, successes: 0, tokens: 0, ms: 0, escalations: 0 }),
    ).toBe(1.3);
    expect(
      learnStrength(5, { attempts: 100, successes: 100, tokens: 0, ms: 0, escalations: 0 }),
    ).toBe(5);
  });

  it("records outcomes per task kind", () => {
    let p = emptyStoredProfile();
    p = record(p, "implement", { success: true, tokens: 100, ms: 5, escalations: 0 });
    p = record(p, "implement", { success: false, tokens: 50, ms: 5, escalations: 2 });
    expect(p.observed.implement).toEqual({
      attempts: 2,
      successes: 1,
      tokens: 150,
      ms: 10,
      escalations: 2,
    });
  });
});

describe("effective profile", () => {
  it("applies learning to the matching capability, and my overrides win over both", () => {
    let stored = emptyStoredProfile();
    for (let i = 0; i < 40; i++)
      stored = record(stored, "test", { success: false, tokens: 1, ms: 1, escalations: 0 });
    const learned = effectiveProfile("claude-code", "sonnet", stored);
    expect(learned.strengths.tests).toBe(3);
    expect(learned.learned.tests).toBe(3);

    stored = { ...stored, overrides: { strengths: { tests: 5 }, quotaWeight: 3 } };
    const mine = effectiveProfile("claude-code", "sonnet", stored);
    expect(mine.strengths.tests).toBe(5);
    expect(mine.learned.tests).toBe(3);
    expect(mine.quotaWeight).toBe(3);
  });
});

describe("estimated utilization", () => {
  it("is unknown without my limit, and capped at a full window", () => {
    expect(estimateUtilization(500, undefined)).toBeNull();
    expect(estimateUtilization(250, 1000)).toBe(0.25);
    expect(estimateUtilization(5000, 1000)).toBe(1);
  });
});
