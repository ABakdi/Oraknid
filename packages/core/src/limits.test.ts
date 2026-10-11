import { describe, expect, it } from "vitest";
import {
  accountWide,
  limitScopeOf,
  previewModel,
  SHORT_WAIT_MS,
  shortWait,
  slowerPace,
  spacingOf,
} from "./limits.ts";
import { effectiveProfile, emptyStoredProfile } from "./profiles.ts";
import { type RouteCandidate, route } from "./routing.ts";

// Limits are where the provider puts them (ADR-068), from the Keys job of
// 2026-10-11: OpenCode's longcat-2.5-preview-free said "Rate limit
// exceeded. Please try again later." and the whole Leg, big-pickle with it,
// was taken away for 15 minutes.

describe("a limit's scope (ADR-068 §1)", () => {
  it("reads the account in the words: individual quota, upgrade, subscription, credits, billing, a plan", () => {
    for (const said of [
      "Individual quota reached. Please upgrade your subscription to increase your limits.",
      "You have run out of credits.",
      "insufficient_quota: check your plan and billing details",
      "Your account's usage limit was reached.",
    ])
      expect(accountWide(said), said).toBe(true);
    for (const said of [
      "Rate limit exceeded. Please try again later.",
      "429 Too Many Requests",
      "Rate limit reached for model `openai/gpt-oss-20b` on requests per minute",
    ])
      expect(accountWide(said), said).toBe(false);
  });

  it("limits the model first, the Leg when the account is out, known to be, or a second model is limited meanwhile", () => {
    const rate = "Rate limit exceeded. Please try again later.";
    expect(limitScopeOf({ text: rate, known: null, otherLimited: false })).toMatchObject({
      scope: "model",
      learned: null,
    });
    expect(
      limitScopeOf({ text: "Individual quota reached", known: "model", otherLimited: false }),
    ).toMatchObject({ scope: "leg", learned: "account" });
    expect(limitScopeOf({ text: rate, known: null, otherLimited: true })).toMatchObject({
      scope: "leg",
      learned: "account",
    });
    expect(limitScopeOf({ text: rate, known: "account", otherLimited: false })).toMatchObject({
      scope: "leg",
      learned: null,
    });
    // Its limits turned out to be per model: a second model limited stays the model's.
    expect(limitScopeOf({ text: rate, known: "model", otherLimited: true })).toMatchObject({
      scope: "model",
    });
  });
});

describe("waiting and pacing (ADR-068 §3, §4)", () => {
  it("a limit within half an hour is a wait; a longer one, or none, isn't", () => {
    const now = 1_000_000;
    expect(shortWait(now + 15 * 60_000, now)).toBe(true);
    expect(shortWait(now + SHORT_WAIT_MS + 1, now)).toBe(false);
    expect(shortWait(null, now)).toBe(false);
  });

  it("paces a model at 20 requests a minute after its first rate limit, half that after each one more, never under 2", () => {
    let p = slowerPace(null, 0);
    expect(p.rpm).toBe(20);
    expect(spacingOf(p)).toBe(3000);
    p = slowerPace(p, 1);
    expect(p.rpm).toBe(10);
    for (let i = 0; i < 5; i++) p = slowerPace(p, 2);
    expect(p.rpm).toBe(2);
    // Forgotten after a day: free tiers change.
    expect(slowerPace(p, 2 + 25 * 3600_000).rpm).toBe(20);
  });
});

describe("routing around a model's limit, and the models I use (ADR-068 §1, §2)", () => {
  const oc = (model: string, over: Partial<RouteCandidate> = {}): RouteCandidate => ({
    legId: "OC",
    legModelId: `oc-${model}`,
    model,
    legName: "OpenCode",
    health: "healthy",
    paused: false,
    effortLevels: [],
    profile: effectiveProfile("opencode", model, emptyStoredProfile()),
    windows: [],
    ...over,
  });
  const task = {
    kind: "implement" as const,
    difficulty: "medium" as const,
    requiredCapabilities: ["implementation" as const],
    estimatedTokens: 20_000,
    stepUp: 0,
  };
  const now = Date.parse("2026-10-11T07:00:00");

  it("leaves out a model limited alone, saying until when; its Leg's other models go on", () => {
    const r = route(
      task,
      [
        oc("longcat-2.5-preview-free", {
          limited: { until: now + 15 * 60_000, reason: "Rate limit exceeded." },
        }),
        oc("big-pickle"),
      ],
      { moneyAllowed: false, now },
    );
    expect(r.ranked.map((x) => x.candidate.model)).toEqual(["big-pickle"]);
    expect(r.excluded[0]?.why).toBe(
      "OpenCode · longcat-2.5-preview-free: rate-limited until 07:15 today (Rate limit exceeded.).",
    );
    // Past its reset it is a candidate again.
    expect(
      route(task, [oc("longcat-2.5-preview-free", { limited: { until: now - 1, reason: "x" } })], {
        moneyAllowed: false,
        now,
      }).ranked,
    ).toHaveLength(1);
  });

  it("ranks the model I use first among its Leg's, and a preview model I don't use lower for agent work", () => {
    const r = route(
      task,
      [
        oc("longcat-2.5-preview-free"),
        oc("nemotron-3-super-free"),
        oc("big-pickle", { preferred: true }),
      ],
      { moneyAllowed: false, now },
    );
    expect(r.ranked[0]?.candidate.model).toBe("big-pickle");
    expect(r.ranked[0]?.reasons).toContain("you use this one");
    expect(r.ranked[1]?.reasons).toContain("a preview model: tight limits for long agent work");
    expect(previewModel("longcat-2.5-preview-free")).toBe(true);
    expect(previewModel("big-pickle")).toBe(false);
  });

  it("after a model's limit, another model of the same Leg goes first", () => {
    const other = (model: string): RouteCandidate => ({
      ...oc(model),
      legId: "OTHER",
      legName: "Other",
    });
    const r = route({ ...task, preferLeg: "OC" }, [other("model-a"), oc("model-b")], {
      moneyAllowed: false,
      now,
    });
    expect(r.ranked[0]?.candidate.legId).toBe("OC");
    expect(r.ranked[0]?.reasons).toContain("another model of OpenCode, whose model hit a limit");
  });
});
