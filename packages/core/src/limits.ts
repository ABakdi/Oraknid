// Limits are where the provider puts them (ADR-068): a usage limit first
// limits the model that hit it, not its Leg; the Leg only when its words say
// the account is out, or when a second model of it hits one meanwhile. A
// short limit is a wait, never a block; a model that was refused for its
// pace is spaced; the models I use myself go first. Pure: the daemon keeps
// what was learned.

/** What a limit turned out to cover on a Leg, learned from what happened (ADR-068 §1). */
export type LimitScope = "model" | "account";

/** A limit whose reset comes sooner than this is waited for, never a block (ADR-068 §3). */
export const SHORT_WAIT_MS = 30 * 60_000;

/** A limit that gives no reset is kept this long. */
export const DEFAULT_LIMIT_MS = 15 * 60_000;

/**
 * Whether a limit's words say the whole account is out, not one model:
 * "Individual quota reached", "upgrade your subscription", credits,
 * billing, a plan, an account's or organisation's quota.
 */
export function accountWide(text: string | null | undefined): boolean {
  if (!text) return false;
  return /individual quota|upgrade|subscription|\bcredits?\b|billing|\bplan\b|insufficient[_ ](?:quota|balance|funds)|payment|your account|account(?:'s)? (?:quota|limit|usage)|organi[sz]ation(?:'s)? (?:quota|limit)/i.test(
    text,
  );
}

/**
 * The scope a new limit on a Leg's model takes (ADR-068 §1): the Leg's when
 * its words say the account is out, when the Leg's limits turned out to be
 * account-wide before, or when another of its models is limited right now
 * (and the Leg isn't known for per-model limits); otherwise the model's.
 * `learned` is what the Leg's scope is known to be from now on, when this
 * limit taught it.
 */
export function limitScopeOf(o: {
  text: string | null | undefined;
  known: LimitScope | null;
  /** Another model of the same Leg is limited now. */
  otherLimited: boolean;
}): { scope: "model" | "leg"; learned: LimitScope | null; why: string } {
  if (accountWide(o.text))
    return { scope: "leg", learned: "account", why: "its words say the account is out" };
  if (o.known === "account")
    return { scope: "leg", learned: null, why: "its limits were account-wide before" };
  if (o.otherLimited && o.known !== "model")
    return {
      scope: "leg",
      learned: "account",
      why: "a second model of it hit a limit meanwhile: the limit is the account's",
    };
  return { scope: "model", learned: null, why: "only this model was refused" };
}

/**
 * Whether a model is a preview or experimental free one: tight per-model
 * rate limits, poor for long agent work ("preview", "alpha", "beta",
 * "experimental", "contributor", or a "-free" variant).
 */
export function previewModel(model: string): boolean {
  return /preview|alpha|\bbeta\b|-beta|experimental|\bexp\b|-exp\b|contributor|-free$|:free$/i.test(
    model,
  );
}

/** A requests-a-minute pace learned from rate limits (ADR-068 §4). */
export interface Pace {
  /** Requests a minute the model is spaced to. */
  rpm: number;
  /** When it was last learned. */
  at: number;
}

/** A pace is forgotten a day after it was last learned: free tiers change. */
export const PACE_LIFE_MS = 24 * 3600_000;

/**
 * The pace after another rate limit: 20 requests a minute the first time,
 * half of it each time after, never under 2.
 */
export function slowerPace(prev: Pace | null, now: number): Pace {
  const live = prev && now - prev.at < PACE_LIFE_MS ? prev.rpm : null;
  return { rpm: live === null ? 20 : Math.max(2, Math.floor(live / 2)), at: now };
}

/** The least time between two requests at a pace, in ms. */
export const spacingOf = (p: Pace) => Math.ceil(60_000 / Math.max(1, p.rpm));

/**
 * Whether a wait until `until` is short (ADR-068 §3): a limit that resets
 * within half an hour is waited for, the job never blocked on it.
 */
export function shortWait(until: number | null, now: number): boolean {
  return until !== null && until - now <= SHORT_WAIT_MS;
}

/** A clock time in my words for a limit's end: "07:32". */
export function clockOf(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
