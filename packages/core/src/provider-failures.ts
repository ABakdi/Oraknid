// Provider failures (Legs-and-Capability-Profiles → Provider failures, M13.22):
// a session that ended on its provider's error, not on the task. Seen 2026-10-04:
// "Internal server error", "Upstream request failed: Model is unavailable" —
// counted as the task failing, each one sent the task to the next untried free
// model of the same failing provider, seven attempts in twenty minutes.

export interface ProviderFailure {
  /** One model is out ("model"), or every model of the Leg (its account, its CLI). */
  scope: "model" | "leg";
  /** How long the first such failure rests it; each one in a row doubles it. */
  restMs: number;
  /** In plain words, for the routing record. */
  reason: string;
}

const MIN = 60_000;

const KINDS: { pattern: RegExp; failure: Omit<ProviderFailure, "reason"> }[] = [
  // The model itself is gone or unknown at the provider.
  {
    pattern:
      /model[^.\n]{0,40}\b(is |are )?(unavailable|not available|not found|does not exist|not supported|deprecated)|no such model|unknown model|model_not_found|no endpoints? found/i,
    failure: { scope: "model", restMs: 30 * MIN },
  },
  // The account: signed out, a bad key, no credit, a usage limit said as an error.
  {
    pattern:
      /\b401\b|\b403\b|unauthori[sz]ed|forbidden|invalid (api )?key|api key|authentication|not (logged|signed) in|log ?in again|credentials?|insufficient (credit|balance|quota)|billing|payment required|\b402\b|usage limit|quota (exceeded|reached)|rate.?limit|too many requests|\b429\b/i,
    failure: { scope: "leg", restMs: 15 * MIN },
  },
  // The provider failed: 5xx, overloaded, the connection.
  {
    pattern:
      /internal server error|server error|\b50[0-4]\b|bad gateway|service unavailable|gateway time-?out|overloaded|upstream|temporar(il)?y unavailable|try again later|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|connection (reset|refused|closed)|timed out|error from provider/i,
    failure: { scope: "model", restMs: 5 * MIN },
  },
  // The Leg's own program broke under it (its database, its process).
  {
    pattern:
      /failed query|SQLITE_|database is locked|OpenCode exited|did not start|could not start|the session ended/i,
    failure: { scope: "leg", restMs: 2 * MIN },
  },
];

/**
 * Whether a session's error is its provider's (or its Leg's own program's)
 * rather than the task's, and what to rest. Unknown errors are the task's.
 */
export function providerFailure(error: string | null | undefined): ProviderFailure | null {
  if (!error) return null;
  for (const k of KINDS)
    if (k.pattern.test(error))
      return { ...k.failure, reason: error.replace(/\s+/g, " ").trim().slice(0, 160) };
  return null;
}

/** The rest for the `n`th failure in a row (1-based): doubled each time, at most four hours. */
export function restFor(f: ProviderFailure, n: number): number {
  return Math.min(4 * 60 * MIN, f.restMs * 2 ** Math.max(0, n - 1));
}
