import type { EffectiveProfile } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { unusableOf } from "./harness/outcome.ts";
import { usageLimitOf } from "./harness.ts";
import { providerFailure } from "./provider-failures.ts";
import { type RouteCandidate, route } from "./routing.ts";
import { aheadOfPace, maxRequestFrom, perMinuteFrom, type TooLarge, tooLargeOf } from "./tokens.ts";

// The token economy (ADR-066): size is not quota, windows are paced.

/** Groq's answer to one request larger than the free tier's tokens a minute (2026-10-10). */
const GROQ_413 = `The model server answered 413: {"error":{"message":"Request too large for model \`openai/gpt-oss-20b\` in organization \`org_01k\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Requested 12446, please reduce your message size and try again. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}`;
/** Groq's answer when the minute's earlier requests used the room: a rate limit, spaced. */
const GROQ_429 = `The model server answered 429: {"error":{"message":"Rate limit reached for model \`openai/gpt-oss-20b\` in organization \`org_01k\` service tier \`on_demand\` on tokens per minute (TPM): Limit 8000, Used 6100, Requested 2950. Please try again in 7.6s.","type":"tokens","code":"rate_limit_exceeded"}}`;
const OPENAI_CONTEXT = `400: {"error":{"message":"This model's maximum context length is 8192 tokens. However, your messages resulted in 9012 tokens. Please reduce the length of the messages.","type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}`;

describe("a request too large is not a quota (ADR-066 §1)", () => {
  it("reads Groq's 413 with its numbers, and never as a usage limit", () => {
    expect(tooLargeOf(GROQ_413)).toMatchObject({
      by: "per-minute",
      limit: 8000,
      requested: 12446,
    });
    expect(usageLimitOf(GROQ_413, 0)).toBeNull();
    expect(unusableOf(GROQ_413, "openai/gpt-oss-20b", 0)).toMatchObject({
      kind: "too-large",
      limit: 8000,
    });
    expect(maxRequestFrom(tooLargeOf(GROQ_413) as TooLarge, null)).toBe(8000);
  });

  it("keeps a per-minute limit the minute's use filled a rate limit, with its reset", () => {
    expect(tooLargeOf(GROQ_429)).toBeNull();
    const limit = usageLimitOf(GROQ_429, 1_000_000);
    expect(limit?.until).toBe(1_000_000 + 7600);
  });

  it("reads a context window exceeded, OpenAI's and Anthropic's", () => {
    expect(tooLargeOf(OPENAI_CONTEXT)).toMatchObject({
      by: "context",
      limit: 8192,
      requested: 9012,
    });
    expect(tooLargeOf("prompt is too long: 210000 tokens > 200000 maximum")).toMatchObject({
      by: "context",
      limit: 200000,
      requested: 210000,
    });
    expect(tooLargeOf("413 Request Entity Too Large")).toMatchObject({ limit: null });
    expect(maxRequestFrom(tooLargeOf("413 Request Entity Too Large") as TooLarge, 10_000)).toBe(
      8000,
    );
    expect(tooLargeOf("Individual quota reached. Resets in 2h")).toBeNull();
    expect(unusableOf(OPENAI_CONTEXT, "m", 0)?.kind).toBe("too-large");
    // A plain 429 stays what it was.
    expect(providerFailure("429 Too Many Requests")?.scope).toBe("leg");
    expect(usageLimitOf("429 Too Many Requests", 0)).not.toBeNull();
  });

  it("reads the tokens a minute a provider states in its headers", () => {
    expect(
      perMinuteFrom({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "1200" }),
    ).toEqual({ tokens: 8000, tokensLeft: 1200 });
    expect(perMinuteFrom({})).toBeNull();
  });
});

const profile = (o: Partial<EffectiveProfile> = {}): EffectiveProfile =>
  ({
    strengths: { implementation: 3, summarize: 3, classify: 3 },
    maxDifficulty: "medium",
    contextWindow: 128_000,
    costModel: "subscription",
    quotaWeight: 1,
    effortMultipliers: {},
    windowLimits: {},
    knownFailures: [],
    observed: {},
    prior: "known",
    tools: { edits: true, shell: true, mcp: true, browse: true },
    ...o,
  }) as unknown as EffectiveProfile;

const candidate = (id: string, o: Partial<RouteCandidate> = {}): RouteCandidate => ({
  legId: id,
  legModelId: id,
  model: id,
  legName: id,
  health: "healthy",
  paused: false,
  effortLevels: [],
  profile: profile(),
  windows: [],
  ...o,
});

const task = {
  kind: "implement" as const,
  difficulty: "medium" as const,
  requiredCapabilities: ["implementation" as const],
  estimatedTokens: 20_000,
  stepUp: 0,
};

describe("routing by size and pace (ADR-066 §1, §5)", () => {
  it("leaves out a model whose known largest request is smaller than this one", () => {
    const r = route(
      { ...task, requestTokens: 12_000 },
      [candidate("groq", { maxRequestTokens: 8000 }), candidate("claude")],
      { moneyAllowed: false },
    );
    expect(r.ranked.map((x) => x.candidate.legId)).toEqual(["claude"]);
    expect(r.excluded[0]?.why).toContain("at most 8000 tokens in one request");
    // A small request still goes to it.
    const small = route(
      { ...task, requestTokens: 2000 },
      [candidate("groq", { maxRequestTokens: 8000 })],
      { moneyAllowed: false },
    );
    expect(small.ranked).toHaveLength(1);
  });

  it("spares a window burnt ahead of its time, unless the work is urgent", () => {
    const now = 10 * 3600_000;
    // 70% of a five-hour window used one hour in; the other Leg at an even pace.
    const early = candidate("early", {
      windows: [{ name: "five_hour", utilization: 0.7, resetsAt: now + 4 * 3600_000 }],
    });
    const even = candidate("even", {
      windows: [{ name: "five_hour", utilization: 0.75, resetsAt: now + 1.25 * 3600_000 }],
    });
    expect(aheadOfPace(early.windows[0] as RouteCandidate["windows"][number], now)).toBeCloseTo(
      0.5,
    );
    expect(aheadOfPace(even.windows[0] as RouteCandidate["windows"][number], now)).toBeCloseTo(0);
    const r = route(task, [early, even], { moneyAllowed: false, now });
    expect(r.ranked[0]?.candidate.legId).toBe("even");
    expect(r.ranked[1]?.reasons.join(" ")).toContain("spared to keep its pace");
    const urgent = route(task, [early, even], { moneyAllowed: false, now, urgent: true });
    expect(urgent.ranked[0]?.candidate.legId).toBe("early");
  });
});
