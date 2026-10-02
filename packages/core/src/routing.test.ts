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

describe("effort", () => {
  it("matches the difficulty, rises with step-ups, and stays within what the model offers", () => {
    expect(chooseEffort(EFFORTS, "low", 0)).toBe("low");
    expect(chooseEffort(EFFORTS, "high", 0)).toBe("high");
    expect(chooseEffort(EFFORTS, "high", 5)).toBe("max");
    expect(chooseEffort([], "high", 1)).toBeNull();
  });
});
