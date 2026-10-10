// The token economy (ADR-066): a request too large is not a quota used up,
// a window is spent at the pace of its time, and every request knows its
// size. Pure: the daemon remembers what a provider said and spaces calls.

/** Roughly four characters a token: sizes are estimated, never billed, on this. */
export const tokensOf = (s: string) => Math.ceil(s.length / 4);

/** A request its provider refused for its size, with the provider's own numbers when it gave them. */
export interface TooLarge {
  /** "per-minute": larger than a tokens-per-minute limit (Groq's free tier); "context": than the model's window. */
  by: "per-minute" | "context";
  /** The most the provider takes in one request, when it said. */
  limit: number | null;
  /** What the refused request asked for, when it said. */
  requested: number | null;
  reason: string;
}

const NUM = (s: string | undefined) => (s ? Number(s.replace(/[,_\s]/g, "")) : null);

/**
 * Whether a provider refused a request for its size rather than for a used
 * quota (ADR-066 §1): a 413, "Request too large", "context length
 * exceeded", "maximum context length", "prompt is too long", or a
 * tokens-per-minute limit smaller than what one request asked for (Groq:
 * "on tokens per minute (TPM): Limit 8000, Requested 9314"). A per-minute
 * limit that only the minute's earlier use made too small ("Limit 8000,
 * Used 6000, Requested 3000") is a rate limit, not this.
 */
export function tooLargeOf(text: string | null | undefined): TooLarge | null {
  if (!text) return null;
  const reason = text.replace(/\s+/g, " ").trim().slice(0, 200);
  const tpm =
    /tokens per minute[^\n]{0,40}?limit[:\s]*([\d,]+)[^\n]{0,40}?(?:used[:\s]*([\d,]+)[^\n]{0,20}?)?requested[:\s]*([\d,]+)/i.exec(
      text,
    );
  if (tpm) {
    const limit = NUM(tpm[1]);
    const used = NUM(tpm[2]);
    const requested = NUM(tpm[3]);
    if (limit !== null && requested !== null && requested > limit)
      return { by: "per-minute", limit, requested, reason };
    // Too much this minute, not too large: a rate limit.
    if (used !== null) return null;
    if (/request too large|\b413\b/i.test(text))
      return { by: "per-minute", limit, requested, reason };
    return null;
  }
  // OpenAI: "This model's maximum context length is 8192 tokens. However, your messages resulted in 9000 tokens."
  const openai =
    /maximum context length is ([\d,]+) tokens[^\n]{0,120}?(?:resulted in|requested|you requested) ([\d,]+)/i.exec(
      text,
    );
  if (openai) return { by: "context", limit: NUM(openai[1]), requested: NUM(openai[2]), reason };
  // Anthropic: "prompt is too long: 210000 tokens > 200000 maximum".
  const anthropic = /prompt is too long:?\s*([\d,]+) tokens?\s*>\s*([\d,]+)/i.exec(text);
  if (anthropic)
    return { by: "context", limit: NUM(anthropic[2]), requested: NUM(anthropic[1]), reason };
  if (
    /context.?length.?exceeded|maximum context|exceeds? (?:the )?(?:model'?s? )?(?:maximum )?context|prompt is too long|input is too long|too many (?:input )?tokens|context window (?:is )?(?:exceeded|too small)/i.test(
      text,
    )
  ) {
    const limit = /(?:limit|maximum|max)[^\d\n]{0,20}([\d,]{3,})/i.exec(text);
    return { by: "context", limit: NUM(limit?.[1]), requested: null, reason };
  }
  if (/request (?:entity )?too large|payload too large|request_too_large|\b413\b/i.test(text))
    return { by: "per-minute", limit: null, requested: null, reason };
  return null;
}

/**
 * The most a model takes in one request, learned from a refusal: the limit
 * it named, else a little under what was refused (never below 1,000).
 */
export function maxRequestFrom(t: TooLarge, sent: number | null): number | null {
  if (t.limit) return t.limit;
  const refused = t.requested ?? sent;
  return refused ? Math.max(1000, Math.floor(refused * 0.8)) : null;
}

// ── Pacing (ADR-066 §5) ──────────────────────────────────────────────

/** How long a window lasts, by its name; null when Oraknid doesn't know. */
export function windowSpan(name: string): number | null {
  const n = name.toLowerCase();
  if (n === "five_hour" || /5.?h(?:our)?/.test(n)) return 5 * 3600_000;
  if (n.startsWith("seven_day") || /week/.test(n)) return 7 * 86400_000;
  if (/(?:^|_)(?:one_)?day|daily/.test(n)) return 86400_000;
  if (/minute|tpm|rpm/.test(n)) return 60_000;
  if (/hour/.test(n)) return 3600_000;
  return null;
}

/**
 * How far a window's use runs ahead of its time (ADR-066 §5): the share
 * used minus the share of the window gone by. Above zero, it is being
 * burnt early. Null when the window's length, use or reset is unknown, or
 * for a per-minute window (spaced, not paced).
 */
export function aheadOfPace(
  w: { name: string; utilization: number | null; resetsAt: number | null },
  now: number,
): number | null {
  const span = windowSpan(w.name);
  if (!span || span < 3600_000 || w.utilization === null || !w.resetsAt) return null;
  const left = Math.min(1, Math.max(0, (w.resetsAt - now) / span));
  return w.utilization - (1 - left);
}

/** The pace a window may run ahead of before routing spares it: a little, so bursts are fine. */
export const PACE_GRACE = 0.15;

/**
 * The tokens-per-minute limit a provider states in its rate-limit headers
 * (Groq, OpenAI: `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`).
 * Null when it states none.
 */
export function perMinuteFrom(headers: Record<string, string | null | undefined>): {
  tokens: number | null;
  tokensLeft: number | null;
} | null {
  const h = (k: string) => {
    const v = headers[k];
    const n = v === null || v === undefined || v === "" ? Number.NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const r = {
    tokens: h("x-ratelimit-limit-tokens"),
    tokensLeft: h("x-ratelimit-remaining-tokens"),
  };
  return r.tokens !== null || r.tokensLeft !== null ? r : null;
}
