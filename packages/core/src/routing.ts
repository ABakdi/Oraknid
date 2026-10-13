import type {
  Capability,
  Difficulty,
  EffectiveProfile,
  LegHealth,
  TaskKind,
} from "@oraknid/contracts";
import { whenSaid } from "./harness.ts";
import { previewModel } from "./limits.ts";
import { aheadOfPace, PACE_GRACE } from "./tokens.ts";

// Model-aware routing (The-Eye → Routing, ADR-013, BR-21): the smallest
// model and effort that will reliably do the task, sparing scarce windows.

export interface RouteCandidate {
  legId: string;
  legModelId: string;
  model: string;
  legName: string;
  health: LegHealth;
  paused: boolean;
  /** Supported effort levels, lowest first; empty when the model has none. */
  effortLevels: string[];
  profile: EffectiveProfile;
  /** Every window that applies: the account's and the model's own. */
  windows: { name: string; utilization: number | null; resetsAt: number | null }[];
  /** A provider failure set this model, or its whole Leg, aside until then (M13.22). */
  cooldown?: { until: number; reason: string } | null;
  /** Provider failures in a row on its Leg, none since a turn went through (M13.22). */
  legProviderFailures?: number;
  /** Its Leg's task sessions running now and its limit: work spreads across Legs (ADR-050). */
  sessions?: { running: number; limit: number };
  /** Its Leg's kind ("claude-code"…), for a job's Claude share (ADR-052 §3). */
  legKind?: string;
  /** The most it takes in one request, as its provider said refusing a larger one (ADR-066 §1). */
  maxRequestTokens?: number | null;
  /** A usage limit on this model alone, until then (ADR-068 §1): its Leg's other models go on. */
  limited?: { until: number; reason: string } | null;
  /** I use this model myself, in the tool's own history or config (ADR-068 §2). */
  preferred?: boolean;
}

/**
 * The provider a Leg's kind draws on, for a job's Claude share (ADR-052 §3):
 * the routing layer's to know, so the harness never names a kind.
 */
export function providerFamily(legKind: string | undefined): "claude" | "other" {
  return legKind === "claude-code" ? "claude" : "other";
}

export interface RouteTask {
  kind: TaskKind;
  difficulty: Difficulty;
  requiredCapabilities: Capability[];
  /** Tokens the task's context is expected to need. */
  estimatedTokens: number;
  /** Steps up taken after failures: each one asks for more effort or a stronger model. */
  stepUp: number;
  /** I pinned it: only this Leg model is considered. */
  pinnedModelId?: string | null;
  /** Leg models that already failed this task, avoided unless nothing else is left. */
  avoid?: string[];
  /** The kind of work, for the ladder's rungs (ADR-052 §3); from `kind` when unset. */
  work?: WorkKind;
  /** About how large one request of it is, in tokens: models that take less are left out (ADR-066 §1). */
  requestTokens?: number;
  /**
   * A Leg one of whose models just hit a limit on this task: its other
   * models go first when they fit (ADR-068 §1).
   */
  preferLeg?: string | null;
}

export interface RouteOptions {
  /** Money may be spent (BR-10); without it, per-token Legs are out. */
  moneyAllowed: boolean;
  /** Below this remaining share, a window's models only take high-difficulty tasks. */
  scarceBelow?: number;
  /** The job's quota-share budget: the share (0–1) of any window it may push a Leg to. */
  quotaShare?: { limit: number; hard: boolean } | null;
  now?: number;
  /** Internal: nothing was strong enough, so the strongest available may take it. */
  stretch?: boolean;
  /**
   * The job's Claude share (ADR-052 §3): the share of its attempts that may
   * run on Claude, and the share used so far. Past it, Claude takes a task
   * only when nothing else can.
   */
  claudeShare?: { limit: number; used: number } | null;
  /**
   * The work is urgent (a job I marked so): windows may be spent ahead of
   * their time (ADR-066 §5). Otherwise a window used faster than its time
   * goes by scores lower.
   */
  urgent?: boolean;
}

export interface Route {
  candidate: RouteCandidate;
  effort: string | null;
  score: number;
  /** Its rung on the ladder for this kind of work (ADR-052 §3). */
  rung?: number;
  /** Why it scored that way, for the task's routing record. */
  reasons: string[];
  /** Rated for easier work than this, it takes it because nothing rated for it is available. */
  stretched?: boolean;
}

export interface RouteResult {
  ranked: Route[];
  /** Candidates left out and why, in plain words. */
  excluded: { legModelId: string; why: string }[];
}

const RANK: Record<Difficulty, number> = { low: 0, medium: 1, high: 2 };
const DEFAULT_EFFORT: Record<Difficulty, string[]> = {
  low: ["low", "medium"],
  medium: ["medium", "high"],
  high: ["high", "xhigh", "max"],
};

/**
 * How far routing trusts a model for a kind of task (M13.22): its prior,
 * moved by what it got done. A known family starts at the success rate the
 * default strengths assume and moves slowly; an unproven model (a free one,
 * an unknown name) starts below it, as if it had failed once already, and
 * every outcome moves it fast: two tasks done and it is trusted like a
 * known model, one failed and it falls further. Its record on this kind of
 * task when it has one, else on every kind.
 */
export function trust(
  profile: EffectiveProfile,
  kind: TaskKind,
): { score: number; reason: string | null; proven: boolean } {
  const unproven = profile.prior === "unproven";
  const kinds = Object.values(profile.observed);
  const all = {
    attempts: kinds.reduce((n, o) => n + (o?.attempts ?? 0), 0),
    successes: kinds.reduce((n, o) => n + (o?.successes ?? 0), 0),
  };
  const own = profile.observed[kind];
  const seen = own && own.attempts > 0 ? own : all.attempts > 0 ? all : null;
  const [prior, weight] = unproven ? [0.4, 1] : [EXPECTED, 3];
  const done = seen?.successes ?? 0;
  const tried = seen?.attempts ?? 0;
  const rate = (done + prior * weight) / (tried + weight);
  const score = Math.round((rate - EXPECTED) * 5 * 100) / 100;
  // Proven: a known family, or an unproven one that got two tasks of any kind done.
  const proven = !unproven || all.successes >= 2;
  if (!seen) return { score, reason: unproven ? "unproven: no task seen done yet" : null, proven };
  const what = seen === own ? `${kind} tasks` : "tasks";
  return {
    score,
    reason: `${done} of ${tried} ${what} done${proven ? "" : " (still unproven)"}`,
    proven,
  };
}

/** What a model must have done on a kind of task to be trusted one level harder at it. */
export const EARNED = { attempts: 5, rate: 0.8 } as const;

const LEVELS = ["low", "medium", "high"] as const;

/**
 * The hardest work routing trusts a model with for a kind of task (The-Eye
 * → Routing, earned difficulty): its profile's `maxDifficulty`, one level
 * higher once its own record on that kind shows it: at least
 * `EARNED.attempts` tasks of the kind, `EARNED.rate` of them done. Failures
 * bring the rate under it and the level back down; never more than one
 * level, never past high, and never for a model that does text work only.
 */
export function earnedDifficulty(
  profile: EffectiveProfile,
  kind: TaskKind,
): { level: Difficulty; reason: string | null } {
  const base = profile.maxDifficulty;
  const own = profile.observed[kind];
  const textOnly = !profile.tools.edits && !profile.tools.shell;
  if (base === "high" || textOnly || !own || own.attempts < EARNED.attempts)
    return { level: base, reason: null };
  if (own.successes / own.attempts < EARNED.rate) return { level: base, reason: null };
  const level = LEVELS[RANK[base] + 1] as Difficulty;
  return {
    level,
    reason: `${own.successes} of ${own.attempts} ${kind} tasks done: trusted with ${level} ones`,
  };
}

/** The success rate the default strengths assume (profiles.ts, learnStrength). */
const EXPECTED = 0.7;

/** The effort for a difficulty, raised by step-ups, within what the model supports. */
export function chooseEffort(
  levels: string[],
  difficulty: Difficulty,
  stepUp: number,
): string | null {
  if (levels.length === 0) return null;
  const wanted = DEFAULT_EFFORT[difficulty].find((e) => levels.includes(e)) ?? levels[0] ?? null;
  const at = Math.max(0, levels.indexOf(wanted as string));
  return levels[Math.min(levels.length - 1, at + stepUp)] ?? null;
}

export function route(task: RouteTask, candidates: RouteCandidate[], o: RouteOptions): RouteResult {
  const scarceBelow = o.scarceBelow ?? 0.25;
  const now = o.now ?? Date.now();
  const excluded: RouteResult["excluded"] = [];
  const routes: Route[] = [];
  // Each step-up raises the effort; every second one also the difficulty, which moves the task to a stronger model.
  const difficulty = (["low", "medium", "high"] as const)[
    Math.min(2, RANK[task.difficulty] + Math.floor(task.stepUp / 2))
  ] as Difficulty;

  let tooWeak = 0;
  for (const c of candidates) {
    const out = (why: string) =>
      excluded.push({ legModelId: c.legModelId, why: `${c.legName} · ${c.model}: ${why}` });
    if (task.pinnedModelId && c.legModelId !== task.pinnedModelId) continue;
    if (c.paused) {
      out("paused.");
      continue;
    }
    if (c.health !== "healthy" && c.health !== "degraded") {
      out(`${c.health}.`);
      continue;
    }
    if (c.limited && c.limited.until > now) {
      out(`rate-limited until ${whenSaid(c.limited.until, now)} (${c.limited.reason}).`);
      continue;
    }
    if (c.cooldown && c.cooldown.until > now) {
      out(
        `resting until ${new Date(c.cooldown.until).toISOString().slice(11, 16)} UTC after a provider failure (${c.cooldown.reason}).`,
      );
      continue;
    }
    const full = c.windows.find(
      (w) => (w.utilization ?? 0) >= 1 && (w.resetsAt ?? Number.POSITIVE_INFINITY) > now,
    );
    if (full) {
      out(`the ${full.name} window is used up.`);
      continue;
    }
    const share = o.quotaShare;
    const over =
      share?.hard &&
      c.windows.find(
        (w) =>
          (w.utilization ?? 0) >= share.limit && (w.resetsAt ?? Number.POSITIVE_INFINITY) > now,
      );
    if (over && share) {
      out(
        `its ${over.name} window is at ${Math.round((over.utilization ?? 0) * 100)}%, and this job may use it up to ${Math.round(share.limit * 100)}%.`,
      );
      continue;
    }
    if (c.profile.costModel === "per-token" && !o.moneyAllowed) {
      out("costs money and this job has no money budget (BR-10).");
      continue;
    }
    const reasons: string[] = [];
    let score = 0;

    // Difficulty fit: too weak is out; far too strong is penalised (BR-21).
    // Its level, raised by what it got done of this kind of task (earned difficulty), only to
    // let it take harder work: a model never scores lower for what it earned.
    const earned = earnedDifficulty(c.profile, task.kind);
    const short = RANK[c.profile.maxDifficulty] < RANK[difficulty];
    const level = short ? earned.level : c.profile.maxDifficulty;
    const gap = RANK[level] - RANK[difficulty];
    if (gap < 0 && !task.pinnedModelId && !o.stretch) {
      out(`made for ${level} tasks; this one is ${difficulty}.`);
      tooWeak++;
      continue;
    }
    if (gap < 0 && o.stretch) score -= 2 * -gap;
    const window = c.profile.contextWindow;
    if (window && task.estimatedTokens * 1.2 > window) {
      out(`its context window (${window}) is too small for this task.`);
      continue;
    }
    // A model whose provider refused a request this size takes none like it (ADR-066 §1).
    const max = c.maxRequestTokens;
    if (max && task.requestTokens && task.requestTokens > max) {
      out(
        `it takes at most ${max} tokens in one request, and this one needs about ${task.requestTokens}.`,
      );
      continue;
    }

    score += gap === 0 ? 3 : gap === 1 ? 1 : -1;
    reasons.push(
      gap === 0 ? "right size for the task" : gap > 0 ? "stronger than the task needs" : "pinned",
    );
    if (short && earned.reason) reasons.push(earned.reason);

    // Scarce windows are kept for hard work.
    const tightest = Math.min(...c.windows.map((w) => 1 - (w.utilization ?? 0)), 1);
    if (tightest < scarceBelow && difficulty !== "high" && !task.pinnedModelId) {
      out(`only ${Math.round(tightest * 100)}% of a window left; kept for hard tasks.`);
      continue;
    }
    score += tightest;
    if (tightest < 1) reasons.push(`${Math.round(tightest * 100)}% of its tightest window left`);

    // A window is spent at the pace of its time, unless the work is urgent (ADR-066 §5).
    if (!o.urgent && !task.pinnedModelId) {
      const ahead = c.windows
        .map((w) => ({ w, by: aheadOfPace(w, now) }))
        .filter((x): x is { w: (typeof c.windows)[number]; by: number } => x.by !== null)
        .sort((a, b) => b.by - a.by)[0];
      if (ahead && ahead.by > PACE_GRACE) {
        score -= ahead.by * 4;
        reasons.push(
          `its ${ahead.w.name} window is ${Math.round((ahead.w.utilization ?? 0) * 100)}% used with ${Math.round(((ahead.w.utilization ?? 0) - ahead.by) * 100)}% of its time gone: spared to keep its pace`,
        );
      }
    }

    const strengths = task.requiredCapabilities.map((cap) => c.profile.strengths[cap] ?? 0);
    const capability = strengths.length
      ? strengths.reduce((a, b) => a + b, 0) / strengths.length
      : 0;
    score += capability;
    reasons.push(`capability ${capability.toFixed(1)}/5`);

    const trusted = trust(c.profile, task.kind);
    score += trusted.score;
    if (trusted.reason) reasons.push(trusted.reason);

    // The models I use myself go first among their Leg's (ADR-068 §2); a preview or experimental
    // free model I don't use has tight limits, poor for an agent's long work.
    if (c.preferred) {
      score += 1.5;
      reasons.push("you use this one");
    } else if (previewModel(c.model) && task.kind !== "mechanical") {
      score -= 1;
      reasons.push("a preview model: tight limits for long agent work");
    }
    // A model of this Leg just hit a limit on the task: another of its models first (ADR-068 §1).
    if (task.preferLeg && c.legId === task.preferLeg) {
      score += 2;
      reasons.push(`another model of ${c.legName}, whose model hit a limit`);
    }

    // Its provider failing is not the task failing, but the next try goes elsewhere (M13.22).
    const streak = c.legProviderFailures ?? 0;
    if (streak >= 2) {
      score -= 3;
      reasons.push(`${streak} provider failures in a row on ${c.legName}: another Leg first`);
    } else if (streak === 1 && !trusted.proven) {
      score -= 1.5;
      reasons.push(
        `${c.legName} just failed at its provider: not another unproven model of it next`,
      );
    }

    // Tasks side by side spread across Legs and accounts: a busier Leg scores a little lower (ADR-050).
    if (c.sessions && c.sessions.running > 0) {
      score -= (c.sessions.running / Math.max(1, c.sessions.limit)) * 1.5;
      reasons.push(`${c.sessions.running} of ${c.sessions.limit} sessions busy on ${c.legName}`);
    }

    const effort = chooseEffort(c.effortLevels, task.difficulty, task.stepUp);
    if (task.stepUp > 0) reasons.push(`stepped up ${task.stepUp}×`);
    const multiplier = effort ? (c.profile.effortMultipliers[effort] ?? 1) : 1;
    const cost = c.profile.quotaWeight * multiplier;
    score -= Math.log2(cost) * 0.6;
    reasons.push(`quota cost ×${cost.toFixed(1)}`);

    if (
      (c.profile.costModel === "local" || c.profile.costModel === "free") &&
      (task.kind === "mechanical" || task.difficulty === "low")
    ) {
      score += 1;
      reasons.push("free for small work");
    }
    if (c.health === "degraded") {
      score -= 1;
      reasons.push("degraded");
    }
    if (task.avoid?.includes(c.legModelId)) {
      score -= 4;
      reasons.push("already failed this task");
    }
    if (
      c.profile.knownFailures.some((f) => f.includes("tools")) &&
      task.kind !== "mechanical" &&
      c.profile.costModel === "local"
    ) {
      score -= 1;
      reasons.push("may not call tools reliably");
    }

    routes.push({ candidate: c, effort, score, reasons });
  }

  // The ladder (ADR-052 §3): a task a model failed goes up, never sideways or down. Only
  // candidates on a higher rung than the strongest that failed it are left; with none, the
  // top of the ladder (the strongest allowed) takes it again.
  const work = task.work ?? workKindOf({ kind: task.kind });
  for (const r of routes) r.rung = rungOf(r.candidate.profile, work, task.kind);
  const failed = candidates.filter((c) => task.avoid?.includes(c.legModelId));
  if (failed.length && routes.length && !task.pinnedModelId) {
    const floor = Math.max(...failed.map((c) => rungOf(c.profile, work, task.kind)));
    const above = routes.filter((r) => (r.rung ?? 0) > floor);
    if (above.length) {
      for (const r of routes.filter((x) => (x.rung ?? 0) <= floor))
        excluded.push({
          legModelId: r.candidate.legModelId,
          why: `${r.candidate.legName} · ${r.candidate.model}: not above the model that failed this task (the ladder goes up).`,
        });
      routes.splice(0, routes.length, ...above);
      for (const r of routes) r.reasons.unshift("a rung up after a failure");
    } else {
      const top = Math.max(...routes.map((r) => r.rung ?? 0));
      for (const r of routes)
        if ((r.rung ?? 0) === top) {
          r.score += 10;
          r.reasons.unshift("the top of the ladder: the strongest allowed takes it again");
        }
    }
  }
  // Past the job's Claude share, Claude takes a task only when nothing else can (ADR-052 §3).
  const share = o.claudeShare;
  if (share && share.used >= share.limit) {
    const claude = (r: Route) => providerFamily(r.candidate.legKind) === "claude";
    const others = routes.filter((r) => !claude(r));
    if (others.length && others.length < routes.length) {
      for (const r of routes.filter(claude))
        excluded.push({
          legModelId: r.candidate.legModelId,
          why: `${r.candidate.legName} · ${r.candidate.model}: this job used its Claude share (${Math.round(share.limit * 100)}%).`,
        });
      routes.splice(0, routes.length, ...others);
    }
  }
  const ranked = routes.sort((a, b) => b.score - a.score);
  // When every Leg that could take it is rated for easier work, the strongest of them tries it
  // rather than the job blocking (seen live: free models only, and a plan to make).
  if (!ranked.length && tooWeak > 0 && !o.stretch) {
    const stretched = route(task, candidates, { ...o, stretch: true });
    for (const r of stretched.ranked) {
      r.stretched = true;
      r.reasons.unshift(
        `nothing rated for ${difficulty} tasks is available; the strongest that is takes it`,
      );
    }
    // None could stretch either: why each was left out then, not "made for easier tasks".
    return {
      ranked: stretched.ranked,
      excluded: stretched.ranked.length ? excluded : stretched.excluded,
    };
  }
  return { ranked, excluded };
}

// ── The ladder (ADR-052 §3) ──────────────────────────────────────────

/** The kinds of work a model has a rung for. */
export type WorkKind = "code" | "server" | "research" | "docs" | "review" | "planning";

/** What each kind of work needs most. */
const NEEDS: Record<WorkKind, Capability[]> = {
  code: ["implementation", "debugging", "tests"],
  server: ["implementation", "debugging"],
  research: ["summarize", "docs", "review"],
  docs: ["docs"],
  review: ["review"],
  planning: ["planning", "architecture"],
};

const DOCS = /(?:^|\/)(?:docs?|notes)\/|\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

/** The kind of work a task is, for its rung. */
export function workKindOf(t: { kind: string; scope?: string[] }, serverJob = false): WorkKind {
  if (serverJob) return "server";
  if (t.kind === "research") return "research";
  if (t.kind === "plan") return "planning";
  if (t.kind === "review") return "review";
  if (t.scope?.length && t.scope.every((g) => DOCS.test(g))) return "docs";
  return "code";
}

/**
 * A model's rung for a kind of work: first the hardest work it is made for,
 * then its strength at what the work needs, moved by what it got done
 * (routing's trust). Higher is stronger. Until it has outcomes, its
 * profile's order ("estimated").
 */
export function rungOf(profile: EffectiveProfile, work: WorkKind, kind: TaskKind): number {
  const needs = NEEDS[work];
  const strength = needs.reduce((n, c) => n + (profile.strengths[c] ?? 0), 0) / needs.length;
  return (
    RANK[earnedDifficulty(profile, kind).level] * 10 + strength * 1.5 + trust(profile, kind).score
  );
}

/** The capabilities a kind of work needs, for The Eye's own choice. */
export const workNeeds = (work: WorkKind): Capability[] => [...NEEDS[work]];
