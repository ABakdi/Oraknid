// A harness for any model (ADR-052, Phase 15): what the jobs of 2026-10-06
// taught. Agents read in their own words (a quota until its reset, a model
// deprecated for another), checks told broken from failing, Oraknid's own
// files never scope drift, and the ladder each kind of work climbs.

// ── Unusable agents, from their own words (ADR-052 §4) ───────────────

const UNIT: [RegExp, number][] = [
  [/^(?:days?|d)$/i, 86_400_000],
  [/^(?:hours?|hrs?|h)$/i, 3_600_000],
  [/^(?:minutes?|mins?|m)$/i, 60_000],
  [/^(?:seconds?|secs?|s)$/i, 1000],
];
const DURATION =
  /(\d+(?:\.\d+)?)\s*(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;

/** A duration in words ("51h49m11s", "2 hours and 5 minutes", "30s") in ms, or null. */
export function durationMs(text: string): number | null {
  let total = 0;
  let any = false;
  for (const m of text.matchAll(DURATION)) {
    const n = Number(m[1]);
    const unit = UNIT.find(([re]) => re.test(m[2] as string));
    if (!unit || !Number.isFinite(n)) continue;
    total += n * unit[1];
    any = true;
  }
  return any ? Math.round(total) : null;
}

/**
 * When an agent says it can be used again, read from its own words:
 * "Resets in 51h49m11s", "try again in 2 hours", "resets at
 * 2026-10-09T14:00:00Z", "reset_at: 1760018400". Null when it doesn't say.
 */
export function resetsAtFrom(text: string, now: number): number | null {
  const rel =
    /\b(?:resets?|reset\s+time|try(?:ing)?\s+again|retry|available\s+again|wait)\b[^\n\d]{0,20}?\b(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i.exec(
      text,
    );
  if (rel) {
    const ms = durationMs(rel[1] as string);
    if (ms !== null) return now + ms;
  }
  const iso =
    /\b(?:resets?|reset_at|resets_at|until|available)\b[^\n\d]{0,20}?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(
      text,
    );
  if (iso) {
    const t = Date.parse((iso[1] as string).replace(" ", "T"));
    if (Number.isFinite(t) && t > now) return t;
  }
  const epoch = /\b(?:reset_?at|resets_?at|x-ratelimit-reset)\b["':=\s]{1,4}(\d{10,13})\b/i.exec(
    text,
  );
  if (epoch) {
    const n = Number(epoch[1]);
    const t = n < 1e12 ? n * 1000 : n;
    if (t > now) return t;
  }
  return null;
}

/**
 * A usage limit in an agent's words ("Individual quota reached",
 * "rate limit", "429", "usage limit"), with its reset when it says one.
 */
export function usageLimitOf(
  text: string | null | undefined,
  now: number,
): { until: number | null; reason: string } | null {
  if (!text) return null;
  if (
    !/quota|rate.?limit|usage limit|resource.?exhausted|\b429\b|too many requests|limit (?:reached|exceeded)|out of credits/i.test(
      text,
    )
  )
    return null;
  return { until: resetsAtFrom(text, now), reason: text.replace(/\s+/g, " ").trim().slice(0, 200) };
}

/**
 * A model its provider deprecated, and the one it names instead: "Model
 * mimo-v2.5-free has been deprecated. Use mimo-v2.6-flash-free instead."
 */
export function deprecationOf(
  text: string | null | undefined,
): { model: string | null; replacement: string | null } | null {
  if (
    !text ||
    !/deprecat|no longer (?:available|supported)|has been retired|was retired/i.test(text)
  )
    return null;
  if (!/model/i.test(text)) return null;
  const model =
    /model\s+[`'"]?([\w.:/@-]+?)[`'"]?\s+(?:has been|is|was|is now)\s+(?:deprecated|retired)/i.exec(
      text,
    )?.[1] ?? null;
  const replacement =
    /\b(?:use|switch to|try|migrate to)\s+(?:the\s+)?(?:model\s+)?[`'"]?([\w.:/@-]+?)[`'"]?\s+instead\b/i.exec(
      text,
    )?.[1] ??
    /\b(?:replaced by|successor(?: is)?:?)\s+[`'"]?([\w.:/@-]+?)[`'"]?(?=[\s.,;)]|$)/i.exec(
      text,
    )?.[1] ??
    null;
  return { model, replacement };
}

/** A day and time in my words, for a reset: "Thursday 14:00", or "14:00" today. */
export function whenSaid(at: number, now: number): string {
  const d = new Date(at);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const same = new Date(now).toDateString() === d.toDateString();
  if (same) return `${hm} today`;
  if (at - now < 6 * 86_400_000)
    return `${d.toLocaleDateString("en-GB", { weekday: "long" })} ${hm}`;
  return `${d.toISOString().slice(0, 10)} ${hm}`;
}

// ── Oraknid's own files are never scope drift (ADR-052 → Consequences) ─

/**
 * Files Oraknid itself, or a session at its request, writes in a job's
 * folder: its own folder, and the handoff note an agent leaves when it
 * hands over. Never counted as edits outside the task's scope.
 */
export function oraknidOwn(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  return (
    p.startsWith(".oraknid/") ||
    /^(?:notes\/)?handoffs?(?:\.md|\/.*)$/i.test(p) ||
    /^notes\/handoff[\w.-]*\.md$/i.test(p)
  );
}

/**
 * What a build, a test run or an install writes by itself: installed
 * dependencies, build output, caches and lockfiles. Never scope drift: a task
 * that runs `pnpm install` and `pnpm build` makes them doing its job (a
 * scaffold killed and rolled back for its own `dist/` and `node_modules/`,
 * 2026-10-08).
 */
export function generatedFile(path: string): boolean {
  const p = path.replace(/^\.\//, "");
  return (
    /(?:^|\/)(?:node_modules|\.pnpm-store|dist|build|out|\.next|\.nuxt|\.svelte-kit|\.output|coverage|\.turbo|\.vite|\.cache|\.parcel-cache|target|__pycache__|\.venv|venv|\.tox|\.gradle|\.pytest_cache|\.mypy_cache|\.ruff_cache)\//.test(
      p,
    ) ||
    /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json|Cargo\.lock|poetry\.lock|uv\.lock|Pipfile\.lock|go\.sum|composer\.lock|Gemfile\.lock)$/.test(
      p,
    ) ||
    /\.tsbuildinfo$/.test(p)
  );
}

// ── Checks tested before they judge (ADR-052 §2) ─────────────────────

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/**
 * Whether a failed check is broken itself rather than failing on the
 * work: a shell syntax or quoting error, a `test` broken by its quoting,
 * a program that isn't installed or can't run, a program refusing its own
 * arguments, a pattern that isn't one. Only a hint: The Eye decides.
 */
export function brokenCheckHint(exitCode: number | null, output: string): string | null {
  if (exitCode === 0) return null;
  const out = output.replace(ANSI, "");
  // Setup, not the work (ADR-049): ssh can't read what it was given, or can't reach the server.
  if (
    /Can't open user config file|no such identity:|Bad configuration option|Could not resolve hostname/i.test(
      out,
    )
  )
    return "ssh can't set up its connection from what the check gives it (a config, a key or a host that isn't where checks run): a check reaches a server by its alias alone, `ssh <alias> <command>`";
  if (
    /No such file or directory/.test(out) &&
    /\/legs\/[^/\s]+\/jobs\/|\/\.local\/share\/oraknid\/|\/oraknid-check-/.test(out)
  )
    return "it names a path private to the job (its home, its ssh config), which isn't there where checks run";
  if (
    /^ssh: connect to host .*(Connection refused|timed out|No route to host)|Permission denied \(publickey/m.test(
      out,
    )
  )
    return "ssh couldn't connect from where checks run: a check reaches a server by its alias alone, `ssh <alias> <command>`, over Oraknid's own connection";
  const missing = /(?:^|\s)([\w.+-]+): (?:command )?not found/m.exec(out);
  if (exitCode === 127 && missing) return `\`${missing[1]}\` isn't installed where checks run`;
  // A file of the work that isn't there yet (`./hello.sh: not found`) is the work's.
  if (exitCode === 126 && !/\.\/|\/[\w.-]+:/.test(out))
    return "a program in it can't be run (not executable)";
  if (
    /syntax error|unexpected EOF|unterminated quoted string|unexpected end of file|bad substitution|unmatched [`'"(]|missing [`'"]?\]|Unterminated quoted/i.test(
      out,
    )
  )
    return "the shell can't parse it (a syntax or quoting error)";
  if (
    /unary operator expected|binary operator expected|integer expression expected|test: too many arguments|\[: too many arguments/i.test(
      out,
    )
  )
    return "a `test` in it is broken by its quoting";
  if (/(?:grep|sed|awk|jq):.*(?:invalid|unmatched|unterminated|syntax|parse error)/i.test(out))
    return "a pattern or program in it is invalid";
  if (
    exitCode === 2 &&
    /^usage:|invalid option|unrecognized option|illegal option|unknown option/im.test(out)
  )
    return "a program in it refused its own arguments";
  return null;
}

/**
 * The agent's words that a check is broken, with its evidence ("the
 * removal is complete … Oraknid's automated check #1 fails due to a
 * quoting issue"): the sentence that says so, or null.
 */
export function saysCheckBroken(report: string): string | null {
  const sentences = report
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const check = /\b(?:check|checks|verify|verification|test command)\b/i;
  const broken =
    /\b(?:is|are|looks|seems|appears)\s+(?:broken|wrong|incorrect|buggy|faulty|malformed|invalid)\b|\bbroken\b|\bquoting (?:issue|bug|problem|error)\b|\bsyntax error\b|\bcan(?:not|'t) (?:ever )?pass\b|\bnever pass(?:es)?\b|\bfalse (?:negative|failure)\b|\bbug in (?:the|oraknid's) check\b|\bfails? (?:due to|because of) (?:a |the )?(?:quoting|syntax|typo|bug)\b|\bcheck itself\b/i;
  const hit = sentences.find((s) => check.test(s) && broken.test(s));
  return hit ? hit.slice(0, 400) : null;
}

/**
 * The agent's words that it can't finish without me: blocked by a guard
 * or a rule, or something only I can do or allow ("The check is right and
 * the fix is blocked by a guardrail that only the owner can lift… Owner
 * action required: rm -rf /root/misahaty"). The sentences that say so, or null.
 */
export function saysOwnerNeeded(report: string): string | null {
  const sentences = report
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .filter(Boolean);
  const needs =
    /\bowner action (?:is )?required\b|\bonly (?:the )?owner\b|\bowner (?:must|needs to|has to|should|will need to)\b|\bneeds? (?:the owner|you) to\b|\brequires? (?:the )?owner\b|\b(?:the )?owner'?s? (?:approval|permission|action)\b|\bguard ?rails?\b|\bblocked by (?:a |the |an |oraknid'?s? )?(?:guard|rule|hook|policy|safety)|\b(?:you|the owner) (?:can|could) (?:run|lift|allow|approve)\b|\bmanual(?:ly)? (?:step|action|run)\b/i;
  const hits = sentences.filter((s) => needs.test(s));
  return hits.length ? hits.join(" ").slice(0, 600) : null;
}

// ── One interview round when the spec is complete (ADR-052 §7) ───────

/**
 * A goal that already reads as a complete spec: long, or a list of the
 * features, or sections. Its interview is one round.
 */
export function specComplete(goal: string): boolean {
  const words = goal.trim().split(/\s+/).filter(Boolean).length;
  const lines = goal.split("\n");
  const items = lines.filter((l) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l)).length;
  const headings = lines.filter((l) => /^\s*#{1,6}\s+\S/.test(l)).length;
  return words >= 250 || items >= 6 || (headings >= 2 && words >= 120);
}
