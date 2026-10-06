import { describe, expect, it } from "vitest";
import { effectiveProfile, emptyStoredProfile, record } from "./profiles.ts";
import { chooseEffort, type RouteCandidate, type RouteTask, route } from "./routing.ts";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const claude = (model: string, over: Partial<RouteCandidate> = {}): RouteCandidate => ({
  legId: "L1",
  legModelId: `m-${model}`,
  model,
  legName: "Claude",
  health: "healthy",
  paused: false,
  effortLevels: model === "haiku" ? [] : EFFORTS,
  profile: effectiveProfile("claude-code", model, emptyStoredProfile()),
  windows: [{ name: "five_hour", utilization: 0.2, resetsAt: null }],
  ...over,
});
const local = (over: Partial<RouteCandidate> = {}): RouteCandidate => ({
  legId: "L2",
  legModelId: "m-qwen",
  model: "qwen",
  legName: "Ollama",
  health: "healthy",
  paused: false,
  effortLevels: [],
  profile: effectiveProfile("openai-compatible", "qwen", emptyStoredProfile()),
  windows: [],
  ...over,
});
const task = (over: Partial<RouteTask> = {}): RouteTask => ({
  kind: "implement",
  difficulty: "medium",
  requiredCapabilities: ["implementation"],
  estimatedTokens: 20_000,
  stepUp: 0,
  ...over,
});
const pool = () => [claude("opus"), claude("sonnet"), claude("haiku"), local()];
const top = (t: RouteTask, c = pool()) => route(t, c, { moneyAllowed: false }).ranked[0];

describe("routing: the smallest sufficient model (BR-21)", () => {
  it("gives a medium task to Sonnet, not Opus", () => {
    expect(top(task())?.candidate.model).toBe("sonnet");
  });

  it("gives a hard task to Opus at high effort", () => {
    const r = top(task({ difficulty: "high", requiredCapabilities: ["architecture"] }));
    expect([r?.candidate.model, r?.effort]).toEqual(["opus", "high"]);
  });

  it("gives small mechanical work to a cheap model", () => {
    const r = top(
      task({ kind: "mechanical", difficulty: "low", requiredCapabilities: ["mechanical"] }),
    );
    expect(["haiku", "qwen"]).toContain(r?.candidate.model);
  });

  it("keeps a scarce window's models for hard tasks", () => {
    const scarce = [{ name: "seven_day_opus", utilization: 0.9, resetsAt: null }];
    const r = route(task({ difficulty: "medium" }), [claude("opus", { windows: scarce })], {
      moneyAllowed: false,
    });
    expect(r.ranked).toEqual([]);
    expect(r.excluded[0]?.why).toMatch(/10% of a window left; kept for hard tasks/);
    expect(
      route(task({ difficulty: "high" }), [claude("opus", { windows: scarce })], {
        moneyAllowed: false,
      }).ranked,
    ).toHaveLength(1);
  });

  it("steps up after failures: more effort, then a stronger model", () => {
    const once = top(task({ stepUp: 1 }));
    expect(once?.candidate.model).toBe("sonnet");
    expect(once?.effort).toBe("high");
    const thrice = top(task({ stepUp: 4 }));
    expect(thrice?.candidate.model).toBe("opus");
  });

  it("learns: a model that keeps failing a kind of task drops", () => {
    let stored = emptyStoredProfile();
    for (let i = 0; i < 10; i++)
      stored = record(stored, "implement", { success: false, tokens: 1, ms: 1, escalations: 1 });
    const failing = claude("sonnet", {
      profile: effectiveProfile("claude-code", "sonnet", stored),
    });
    expect(top(task(), [failing, claude("opus")])?.candidate.model).toBe("opus");
  });
});

describe("routing: who is out, and why", () => {
  it("keeps a job under its quota-share budget, but only when it is hard", () => {
    const busy = claude("opus", {
      windows: [{ name: "seven_day", utilization: 0.62, resetsAt: Date.now() + 60_000 }],
    });
    const hard = route(task(), [busy, claude("sonnet")], {
      moneyAllowed: false,
      quotaShare: { limit: 0.5, hard: true },
    });
    expect(hard.ranked.map((r) => r.candidate.model)).toEqual(["sonnet"]);
    expect(hard.excluded.map((e) => e.why)).toEqual([
      "Claude · opus: its seven_day window is at 62%, and this job may use it up to 50%.",
    ]);
    const soft = route(task(), [busy], {
      moneyAllowed: false,
      quotaShare: { limit: 0.5, hard: false },
    });
    expect(soft.ranked).toHaveLength(1);
  });

  it("excludes rate-limited, paused, used-up and paid Legs, saying why", () => {
    const r = route(
      task(),
      [
        claude("sonnet", { health: "rate-limited" }),
        claude("opus", { legModelId: "p", paused: true }),
        claude("opus", {
          legModelId: "u",
          windows: [{ name: "five_hour", utilization: 1, resetsAt: Date.now() + 1000 }],
        }),
        local({ profile: { ...local().profile, costModel: "per-token" } }),
      ],
      { moneyAllowed: false },
    );
    expect(r.ranked).toEqual([]);
    expect(r.excluded.map((e) => e.why)).toEqual([
      "Claude · sonnet: rate-limited.",
      "Claude · opus: paused.",
      "Claude · opus: the five_hour window is used up.",
      "Ollama · qwen: costs money and this job has no money budget (BR-10).",
    ]);
  });

  it("excludes a model too weak for the task, and one whose context is too small", () => {
    const r = route(
      task({ difficulty: "high", estimatedTokens: 300_000 }),
      [claude("haiku"), claude("opus")],
      { moneyAllowed: false },
    );
    expect(r.ranked).toEqual([]);
    expect(r.excluded.map((e) => e.why)).toEqual([
      "Claude · haiku: made for low tasks; this one is high.",
      "Claude · opus: its context window (200000) is too small for this task.",
    ]);
  });

  it("lets the strongest available model try when none is rated for the task (seen live)", () => {
    const r = route(task({ difficulty: "high" }), [claude("haiku"), local()], {
      moneyAllowed: false,
    });
    expect(r.ranked.length).toBe(2);
    expect(r.ranked[0]?.reasons[0]).toBe(
      "nothing rated for high tasks is available; the strongest that is takes it",
    );
    // And when one is rated for it, the weaker ones never are.
    const fit = route(task({ difficulty: "high" }), [claude("haiku"), claude("opus")], {
      moneyAllowed: false,
    });
    expect(fit.ranked.map((x) => x.candidate.model)).toEqual(["opus"]);
  });

  it("honours a pin, even on a model weaker than the task", () => {
    const r = route(task({ difficulty: "high", pinnedModelId: "m-haiku" }), pool(), {
      moneyAllowed: false,
    });
    expect(r.ranked.map((x) => x.candidate.model)).toEqual(["haiku"]);
  });

  it("avoids a model that already failed this task while others remain", () => {
    expect(top(task({ avoid: ["m-sonnet"] }))?.candidate.model).toBe("opus");
  });
});

describe("routing: spread across Legs (ADR-050)", () => {
  it("sends a task to the account with free sessions before the busy one", () => {
    const busy = claude("sonnet", { sessions: { running: 2, limit: 3 } });
    const idle = claude("sonnet", {
      legId: "L3",
      legModelId: "m-sonnet-2",
      legName: "Claude (work)",
      sessions: { running: 0, limit: 3 },
    });
    const r = route(task(), [busy, idle], { moneyAllowed: false });
    expect(r.ranked[0]?.candidate.legName).toBe("Claude (work)");
    expect(r.ranked[1]?.reasons).toContain("2 of 3 sessions busy on Claude");
  });
});

describe("effort", () => {
  it("matches the difficulty, rises with step-ups, and stays within what the model offers", () => {
    expect(chooseEffort(EFFORTS, "low", 0)).toBe("low");
    expect(chooseEffort(EFFORTS, "high", 0)).toBe("high");
    expect(chooseEffort(EFFORTS, "high", 5)).toBe("max");
    expect(chooseEffort([], "high", 1)).toBeNull();
  });
});

// M13.22: the research task of 2026-10-04. Claude Max healthy (its week at 67%),
// OpenCode's free models unproven, Antigravity rate-limited.
describe("routing: proven before unproven (M13.22)", () => {
  const week = [{ name: "seven_day", utilization: 0.67, resetsAt: null }];
  const max = (model: string, over: Partial<RouteCandidate> = {}) =>
    claude(model, { windows: week, ...over });
  const free = (model: string, over: Partial<RouteCandidate> = {}): RouteCandidate => ({
    legId: "OC",
    legModelId: `oc-${model}`,
    model,
    legName: "Opencode",
    health: "healthy",
    paused: false,
    effortLevels: [],
    profile: effectiveProfile("opencode", model, emptyStoredProfile()),
    windows: [],
    ...over,
  });
  const research = task({
    kind: "research",
    requiredCapabilities: ["summarize", "classify"],
  });
  const live = () => [
    max("sonnet"),
    max("opus"),
    max("haiku"),
    free("big-pickle"),
    free("jev-1.13-free"),
    free("deepseek-v4-flash-free"),
    free("mimo-v2.6-flash-free"),
  ];

  it("gives the medium research task to Claude Sonnet, and says why the free models lost", () => {
    const r = route(research, live(), { moneyAllowed: false });
    expect(r.ranked[0]?.candidate.model).toBe("sonnet");
    const pickle = r.ranked.find((x) => x.candidate.model === "big-pickle");
    expect(pickle?.reasons).toContain("unproven: no task seen done yet");
    expect((pickle?.score ?? 0) < (r.ranked[0]?.score ?? 0)).toBe(true);
  });

  it("gives medium implementation to Sonnet too, a flat subscription before a free model", () => {
    const r = route(task(), live(), { moneyAllowed: false });
    expect(r.ranked[0]?.candidate.model).toBe("sonnet");
    expect(r.ranked[0]?.reasons).toContain("quota cost ×2.0");
  });

  it("lets a free model earn its place from what it gets done, and lose it faster", () => {
    let good = emptyStoredProfile();
    for (let i = 0; i < 4; i++)
      good = record(good, "research", { success: true, tokens: 1, ms: 1, escalations: 0 });
    const proven = free("big-pickle", {
      profile: effectiveProfile("opencode", "big-pickle", good),
    });
    const fresh = free("jev-1.13-free");
    const before = route(research, [fresh], { moneyAllowed: false }).ranked[0]?.score ?? 0;
    const after = route(research, [proven], { moneyAllowed: false }).ranked[0];
    expect(after?.reasons).toContain("4 of 4 research tasks done");
    expect((after?.score ?? 0) - before).toBeGreaterThan(1.5);
    let bad = emptyStoredProfile();
    bad = record(bad, "research", { success: false, tokens: 1, ms: 1, escalations: 0 });
    const failed = free("big-pickle", { profile: effectiveProfile("opencode", "big-pickle", bad) });
    const once = route(research, [failed], { moneyAllowed: false }).ranked[0];
    expect(once?.reasons).toContain("0 of 1 research tasks done (still unproven)");
    expect((once?.score ?? 0) < before).toBe(true);
    // A known model moves slowly from one failure: one bad day doesn't rewrite it.
    const sonnetOnce = max("sonnet", { profile: effectiveProfile("claude-code", "sonnet", bad) });
    const s0 = route(research, [max("sonnet")], { moneyAllowed: false }).ranked[0]?.score ?? 0;
    const s1 = route(research, [sonnetOnce], { moneyAllowed: false }).ranked[0]?.score ?? 0;
    expect(s0 - s1).toBeLessThan(before - (once?.score ?? 0));
  });

  it("still lets the free models work when Claude's window is kept for hard tasks", () => {
    const scarce = [{ name: "seven_day", utilization: 0.9, resetsAt: null }];
    const r = route(
      research,
      [max("sonnet", { windows: scarce }), free("big-pickle"), free("jev-1.13-free")],
      { moneyAllowed: false },
    );
    expect(r.ranked[0]?.candidate.legName).toBe("Opencode");
    expect(r.excluded[0]?.why).toMatch(/kept for hard tasks/);
  });

  it("rests a model after a provider failure, and says until when and why", () => {
    const now = Date.UTC(2026, 9, 4, 12, 0);
    const r = route(
      research,
      [
        free("jev-1.13-free", {
          cooldown: { until: now + 5 * 60_000, reason: "Internal server error" },
        }),
        free("big-pickle", { cooldown: { until: now - 1, reason: "over" } }),
      ],
      { moneyAllowed: false, now },
    );
    expect(r.ranked.map((x) => x.candidate.model)).toEqual(["big-pickle"]);
    expect(r.excluded.map((e) => e.why)).toEqual([
      "Opencode · jev-1.13-free: resting until 12:05 UTC after a provider failure (Internal server error).",
    ]);
  });

  it("after one provider failure tries no other unproven model of that Leg next; after two, another Leg", () => {
    const known = free("anthropic/claude-sonnet-4-5");
    expect(known.profile.prior).toBeUndefined();
    // One failure: a known model of the same Leg is fine, its unproven ones are not.
    const one = route(research, [free("big-pickle", { legProviderFailures: 1 }), known], {
      moneyAllowed: false,
    });
    expect(one.ranked[0]?.candidate.model).toBe("anthropic/claude-sonnet-4-5");
    expect(one.ranked[1]?.reasons).toContain(
      "Opencode just failed at its provider: not another unproven model of it next",
    );
    // Two in a row: the other Leg, though this one has no window to spare.
    const two = route(task(), [{ ...known, legProviderFailures: 2 }, max("sonnet")], {
      moneyAllowed: false,
    });
    expect(two.ranked[0]?.candidate.legName).toBe("Claude");
    expect(
      route(task(), [known, max("sonnet")], { moneyAllowed: false }).ranked[0]?.candidate.legName,
    ).toBe("Opencode");
    expect(two.ranked[1]?.reasons).toContain(
      "2 provider failures in a row on Opencode: another Leg first",
    );
  });
});
