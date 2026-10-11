import type { Budget, Difficulty, TaskKind } from "@oraknid/contracts";
import {
  busyMachine,
  clockOf,
  nextRung,
  providerFamily,
  type Route,
  type RouteCandidate,
  route,
  rungOf,
  shortWait,
  type WorkKind,
  whenSaid,
  workKindOf,
} from "@oraknid/core";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { attempts, jobs } from "../db/schema.ts";
import { legLimits, stopWaiting } from "../eye/leg-work.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { legSessionLimit } from "../resources/work.ts";
import { CLAUDE_SHARE, readSetting } from "../settings.ts";
import { askOnceToUnpause, pausedAbove } from "./ladder.ts";
import type { AttemptDeps, AttemptJob, AttemptOutcome, TaskRow } from "./types.ts";

// Routing and admission for a task's attempt (ADR-052 §3, ADR-016, ADR-050;
// ADR-056 §8: the controller's Preparing): a paused Leg's task waits for it,
// the Legs and models the job may use ranked for the task, a busy Leg or a
// busy machine waited for, and when none can take it, why and until when.
// The provider of a Leg is the routing layer's to know (core's
// `providerFamily`), never a kind named here.

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

/**
 * About how large one request of an agent's session is before its own work
 * piles up: the agent's own prompt and tools (3–6k tokens for the CLIs) and
 * the context pack (under 4k, ADR-066 §4).
 */
export const TASK_REQUEST_TOKENS = 9_000;

/** A task routed: the model that takes it, how, and the ladder above it. */
export interface Routed {
  pick: Route;
  leg: RouteCandidate;
  work: WorkKind;
  /** What the task shows of its routing. */
  routing: {
    leg: string;
    model: string;
    effort: string | null;
    score: number;
    reasons: string[];
    excluded: { legModelId: string; why: string }[];
  };
  /**
   * A model on a higher rung of the ladder for this kind of work that may
   * take the task now (ADR-052 §3); null at the top, for a task I pinned or
   * gave to a Leg, or with nothing stronger allowed.
   */
  higher: () => Route | null;
}

/**
 * The model that takes the task now (a paused Leg's task waits for it only when no other can take it, ADR-064 §7), waiting while
 * every Leg that could take it is busy; or, when none can, the attempt's
 * outcome: blocked, with why and until when.
 */
export async function pickRoute(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  signal: AbortSignal,
): Promise<Routed | Extract<AttemptOutcome, { kind: "blocked" }>> {
  const now = d.now;
  const taskId = task.id;
  let waitedFor = legLimits(d.db, job.id, taskId).waitFor;

  // ADR-009: after a usage limit, another account of the same provider is not a fallback unless I allowed it.
  const sameProvider = new Set(readSetting(d.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []));
  // Entries are "kind:legId": the account that hit the limit may come back after its reset; others may not.
  const limited = task.limitedKinds
    .map((e) => e.split(":") as [string, string])
    .filter(([k]) => !sameProvider.has(k));
  const blockedKinds = new Set(limited.map(([k]) => k));
  const limitedLegs = new Set(limited.map(([, id]) => id));
  // Legs whose work in this job (or on this task) I cancelled are not used again; a task that
  // waited for a Leg now resumed goes back to it.
  const { avoid: avoidLegs } = legLimits(d.db, job.id, taskId);
  const usable = (c: RouteCandidate) =>
    !blockedKinds.has(d.registry.require(c.legId).kind) || limitedLegs.has(c.legId);
  // The task as routing sees it (ADR-052 §3).
  const routeTask = () => ({
    kind: task.kind as TaskKind,
    difficulty: task.difficulty as Difficulty,
    requiredCapabilities: task.requiredCapabilities as never,
    estimatedTokens: 20_000 + Math.ceil(task.instructions.length / 4),
    stepUp: task.stepUp,
    pinnedModelId: task.pinnedModelId,
    avoid: task.avoid,
    work: (job.serverJob ? "server" : workKindOf(task)) as WorkKind,
    // One request of an agent's session: its own prompt and tools, the context pack, the task (ADR-066 §1).
    requestTokens: TASK_REQUEST_TOKENS + Math.ceil(task.instructions.length / 4),
  });
  // ── A paused Leg's task never waits for it while another can take it (ADR-064 §7) ──
  let saidWaitingFor = false;
  for (;;) {
    waitedFor = legLimits(d.db, job.id, taskId).waitFor;
    const leg = waitedFor ? d.registry.get(waitedFor) : null;
    if (!leg?.paused) break;
    const others = candidatesFor(d.registry, job.allowedLegIds).filter(
      (c) => c.legId !== leg.id && !avoidLegs.has(c.legId) && usable(c),
    );
    if (
      route(routeTask(), others, { moneyAllowed: job.moneyAllowed, quotaShare: null, now: now() })
        .ranked[0]
    ) {
      stopWaiting(d.db, job.id, taskId);
      waitedFor = null;
      d.bus.publish({
        type: "task.leg-paused-goes-on",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: {
          taskId,
          legId: leg.id,
          reason: `${leg.name} is paused: the strongest model available takes the task for now.`,
        },
      });
      break;
    }
    if (!saidWaitingFor) {
      saidWaitingFor = true;
      d.bus.publish({
        type: "task.waiting-for-leg",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: {
          taskId,
          legId: leg.id,
          reason: `It waits for ${leg.name}, paused, as no other Leg can take it; it goes on when the Leg is resumed.`,
        },
      });
    }
    await pause(1000, signal);
  }
  // Read after the wait: a Leg resumed meanwhile is a candidate again; read again while the
  // task waits out a short limit (ADR-068 §3).
  const gather = () => {
    const allowed = candidatesFor(d.registry, job.allowedLegIds).filter(
      (c) => !avoidLegs.has(c.legId),
    );
    const backTo = waitedFor ? allowed.filter((c) => c.legId === waitedFor) : [];
    // Back to its Leg when that Leg can take it; one out of quota or failing hands it to the others.
    const back =
      backTo.length &&
      route(routeTask(), backTo.filter(usable), {
        moneyAllowed: job.moneyAllowed,
        quotaShare: null,
        now: now(),
      }).ranked[0]
        ? backTo
        : [];
    const all = back.length ? back : allowed;
    const candidates = all.filter(usable);
    return { back, candidates, heldBack: all.length - candidates.length };
  };
  let { back, candidates, heldBack } = gather();
  // Read now, so a budget I changed while the job runs applies to the next task.
  const row = d.db
    .select({ budget: jobs.budget, priority: jobs.priority })
    .from(jobs)
    .where(eq(jobs.id, job.id))
    .get();
  const budget = row?.budget as Budget | undefined;
  const quotaShare = budget?.quotaShare ?? null;
  // The kind of work, for the ladder's rungs (ADR-052 §3).
  const work: WorkKind = job.serverJob ? "server" : workKindOf(task);
  // The Leg whose model just hit a limit on this task: its other models go first (ADR-068 §1).
  const limitedBefore = lastLimited(d, taskId);
  const forRoute = { ...routeTask(), preferLeg: limitedBefore?.legId ?? null };
  const routeOptions = () => ({
    moneyAllowed: job.moneyAllowed,
    quotaShare,
    claudeShare: claudeShareOf(d, job.id, budget),
    // A job I put ahead may spend its Legs' windows ahead of their time (ADR-066 §5).
    urgent: (row?.priority ?? 0) > 0,
    now: now(),
  });
  // A Leg runs at most its limit of task sessions at once (ADR-016). When only busy Legs could
  // take the task, it waits for one, without blocking its job.
  // And a new session waits for room on the machine: a local model needs headroom (ADR-016).
  let machineBusy: string | null = null;
  const free = (c: RouteCandidate) => {
    if (d.supervisor.busy(c.legId) >= legSessionLimit(d.registry, c.legId)) return false;
    // A model refused for its pace runs one session at a time (ADR-068 §4).
    if (d.registry.paceOf(c.legModelId) && d.supervisor.busyModel(c.legId, c.model) > 0)
      return false;
    const why = d.machine ? busyMachine(d.machine(), c.profile.costModel === "local") : null;
    if (why) machineBusy = why;
    return !why;
  };
  // Each candidate knows how busy its Leg is: tasks side by side spread across Legs (ADR-050).
  const withSessions = (c: RouteCandidate): RouteCandidate => ({
    ...c,
    sessions: { running: d.supervisor.busy(c.legId), limit: legSessionLimit(d.registry, c.legId) },
  });
  // The earliest reset that frees a model or a Leg: a limit, a rest, a used-up window, or one
  // past this job's quota share.
  const share = quotaShare?.hard ? quotaShare.limit : null;
  const earliest = () =>
    [
      ...d.registry
        .all()
        .filter((l) => !job.allowedLegIds.length || job.allowedLegIds.includes(l.id))
        .map((l) => l.limitedUntil),
      // A model limited alone (ADR-068 §1).
      ...candidates.map((c) => c.limited?.until),
      // A model or Leg resting after a provider failure (M13.22).
      ...candidates.map((c) => c.cooldown?.until),
      ...(share === null
        ? []
        : candidates.flatMap((c) =>
            c.windows.filter((w) => (w.utilization ?? 0) >= share).map((w) => w.resetsAt),
          )),
    ]
      .filter((t): t is number => !!t && t > now())
      .sort((a, b) => a - b)[0] ?? null;
  let routed = route(forRoute, candidates.filter(free).map(withSessions), routeOptions());
  let saidWaiting: string | null = null;
  let noted = false;
  for (;;) {
    while (!routed.ranked[0] && route(forRoute, candidates, routeOptions()).ranked[0]) {
      const reason = machineBusy
        ? `It waits for room: ${machineBusy}.`
        : "Every Leg that could take it is busy; it starts when one is free.";
      if (saidWaiting !== reason) {
        saidWaiting = reason;
        d.bus.publish({
          type: "task.waiting-for-leg",
          topic: `job:${job.id}`,
          jobId: job.id,
          payload: { taskId, reason },
        });
      }
      machineBusy = null;
      await pause(1000, signal);
      routed = route(forRoute, candidates.filter(free).map(withSessions), routeOptions());
    }
    if (routed.ranked[0]) break;
    // A short limit is a wait, never a block (ADR-068 §3): the task waits for the model, or for
    // another one sooner, and goes on by itself.
    // Only a reset after which a model can take the task counts: one still past the job's share,
    // or too weak for it, once free, is no reason to wait.
    const until = freedAt(d, forRoute, candidates, routeOptions());
    if (!shortWait(until, now()) || until === null) break;
    const reason = waitingSaid(d, candidates, until);
    if (saidWaiting !== reason) {
      saidWaiting = reason;
      noted = true;
      d.waiting?.(job.id, taskId, reason);
      d.bus.publish({
        type: "task.waiting-for-leg",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: { taskId, reason, until },
      });
    }
    await pause(Math.max(20, Math.min(d.routePollMs ?? 1000, until - now())), signal);
    ({ back, candidates, heldBack } = gather());
    routed = route(forRoute, candidates.filter(free).map(withSessions), routeOptions());
  }
  if (noted) d.waiting?.(job.id, taskId, null);
  const pick = routed.ranked[0];
  if (!pick) {
    const until = earliest();
    const resets = until ? ` until ${whenSaid(until, now())}` : "";
    return {
      kind: "blocked",
      reason: heldBack
        ? `"${task.title}" hit a usage limit on ${[...blockedKinds].join(", ")}; other accounts of the same provider are not used as fallback (ADR-009). It waits${resets}, for another provider, or for my setting.`
        : whyNoLeg(d, job, task.title, routed.excluded, until),
      until,
    };
  }
  // The model limited before goes on record with the one that takes the work (ADR-068 §6).
  if (limitedBefore && pick.candidate.legModelId !== limitedBefore.legModelId) {
    const line = `${limitedBefore.legName}'s ${limitedBefore.model} is rate-limited until ${clockOf(limitedBefore.until)}; ${pick.candidate.legId === limitedBefore.legId ? pick.candidate.model : `${pick.candidate.legName} · ${pick.candidate.model}`} takes the work.`;
    pick.reasons.unshift(line);
    d.bus.publish({
      type: "task.limit-goes-on",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId, reason: line },
    });
  }
  const leg = pick.candidate;
  if (waitedFor) stopWaiting(d.db, job.id, taskId);
  return {
    pick,
    leg,
    work,
    routing: {
      leg: leg.legName,
      model: leg.model,
      effort: pick.effort,
      score: pick.score,
      reasons: pick.reasons,
      excluded: routed.excluded,
    },
    higher: () => {
      const mine = rungOf(leg.profile, work, task.kind as TaskKind);
      const open = candidatesFor(d.registry, job.allowedLegIds).filter(
        (c) => !avoidLegs.has(c.legId) && usable(c),
      );
      const r = route({ ...forRoute, avoid: [...new Set([...task.avoid, leg.legModelId])] }, open, {
        ...routeOptions(),
        claudeShare: claudeShareOf(d, job.id, budget),
      });
      const held = !!task.pinnedModelId || back.length > 0;
      const up = nextRung(mine, r.ranked, held);
      // The top available, failed: a stronger model only paused is asked about once (ADR-064 §7).
      if (up === "top" && !held) {
        const paused = pausedAbove(
          candidatesFor(d.registry, job.allowedLegIds).filter((c) => !avoidLegs.has(c.legId)),
          mine,
          work,
          task.kind as TaskKind,
        );
        if (paused)
          askOnceToUnpause(d, job.id, taskId, paused, { legName: leg.legName, model: leg.model });
      }
      return up === "top" ? null : up;
    },
  };
}

/**
 * The model of this task's last attempt when that attempt ended on a limit
 * of that model alone, still running (ADR-068 §1); null otherwise.
 */
function lastLimited(
  d: AttemptDeps,
  taskId: string,
): { legId: string; legModelId: string; legName: string; model: string; until: number } | null {
  const a = d.db
    .select({ legId: attempts.legId, legModelId: attempts.legModelId, outcome: attempts.outcome })
    .from(attempts)
    .where(eq(attempts.taskId, taskId))
    .orderBy(desc(attempts.startedAt))
    .get();
  if (a?.outcome !== "unavailable") return null;
  const limit = d.registry.limitOf(a.legModelId);
  const leg = d.registry.get(a.legId);
  const m = d.registry.model(a.legModelId);
  if (!limit || !leg || !m || leg.health === "rate-limited") return null;
  return {
    legId: a.legId,
    legModelId: a.legModelId,
    legName: leg.name,
    model: m.model,
    until: limit.until,
  };
}

/**
 * The earliest time a limited or resting model can take the task (ADR-068
 * §3): when its own limit, its rest and its Leg's limit are over, and
 * routing then takes it (its windows, the job's share, its fit). Null when
 * none would.
 */
function freedAt(
  d: AttemptDeps,
  task: Parameters<typeof route>[0],
  candidates: RouteCandidate[],
  opts: Parameters<typeof route>[2],
): number | null {
  const at = opts.now ?? d.now();
  let best: number | null = null;
  for (const c of candidates) {
    const leg = d.registry.get(c.legId);
    const legUntil = leg?.health === "rate-limited" ? (leg.limitedUntil ?? null) : null;
    const t = Math.max(c.limited?.until ?? 0, c.cooldown?.until ?? 0, legUntil ?? 0);
    if (t <= at || (best !== null && t >= best)) continue;
    const freed: RouteCandidate = {
      ...c,
      limited: null,
      cooldown: null,
      health: legUntil ? "healthy" : c.health,
    };
    if (route(task, [freed], { ...opts, now: t + 1 }).ranked[0]) best = t;
  }
  return best;
}

/**
 * What a task waiting out a short limit says (ADR-068 §3): the model (or
 * Leg) whose limit ends first, until when, and that another model may take
 * it sooner.
 */
function waitingSaid(d: AttemptDeps, candidates: RouteCandidate[], until: number): string {
  const model = candidates.find((c) => c.limited?.until === until);
  const resting = candidates.find((c) => c.cooldown?.until === until);
  const leg = d.registry.all().find((l) => l.limitedUntil === until);
  const who = model
    ? `${model.legName} · ${model.model}`
    : leg
      ? leg.name
      : resting
        ? `${resting.legName} · ${resting.model}`
        : "a model";
  const why = model || leg ? "rate limit" : resting ? "resting after a provider failure" : "limit";
  return `Waiting for ${who} until ${clockOf(until)} (${why}), or another model sooner; it goes on by itself.`;
}

/** Waits, or throws as soon as the attempt is stopped. */
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/** Every visible Leg model the job may use, as routing candidates. */
export function candidatesFor(registry: LegRegistry, allowed: string[]): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const leg of registry.all()) {
    if (allowed.length && !allowed.includes(leg.id)) continue;
    const view = registry.view(leg);
    for (const m of view.models.filter((x) => !x.hidden)) {
      out.push({
        legId: leg.id,
        legModelId: m.id,
        model: m.model,
        legName: leg.name,
        health: view.health,
        paused: view.paused,
        effortLevels: m.effortLevels,
        profile: m.profile,
        windows: [...view.quota, ...m.quota],
        cooldown: registry.cooldownOf(leg.id, m.id),
        legProviderFailures: registry.providerStreak(leg.id),
        legKind: leg.kind,
        maxRequestTokens: registry.maxRequestOf(m.id),
        // A limit on this model alone, and whether I use it myself (ADR-068).
        limited: m.limit,
        preferred: m.preferred,
      });
    }
  }
  return out;
}

/**
 * The job's Claude share (ADR-052 §3): its budget's, else my setting for
 * every job; with how much of its attempts so far ran on Claude, by the
 * routing layer's provider family. Null: as needed.
 */
function claudeShareOf(
  d: AttemptDeps,
  jobId: string,
  budget: Budget | undefined,
): { limit: number; used: number } | null {
  const limit =
    budget?.claudeShare ??
    readSetting(d.db, CLAUDE_SHARE, z.number().min(0).max(1).nullable(), null);
  if (limit === null || limit === undefined) return null;
  const rows = d.db
    .select({ legId: attempts.legId, outcome: attempts.outcome })
    .from(attempts)
    .where(eq(attempts.jobId, jobId))
    .all()
    .filter((a) => a.outcome !== "unavailable");
  const claude = new Set(
    d.registry
      .all()
      .filter((l) => providerFamily(l.kind) === "claude")
      .map((l) => l.id),
  );
  const used = rows.length ? rows.filter((r) => claude.has(r.legId)).length / rows.length : 0;
  return { limit, used };
}

/**
 * Why no Leg can take a task, in words that say what to do (ADR-052 §4):
 * a paused Leg is paused, not out of quota; a quota says until when; a Leg
 * that can't start says why. Never "out of quota" for a Leg that isn't.
 */
function whyNoLeg(
  d: AttemptDeps,
  job: AttemptJob,
  title: string,
  excluded: { legModelId: string; why: string }[],
  until: number | null,
): string {
  const at = d.now();
  const legsAllowed = d.registry
    .all()
    .filter((l) => !job.allowedLegIds.length || job.allowedLegIds.includes(l.id));
  if (!legsAllowed.length) return `No Leg can take "${title}": there are no Legs.`;
  const parts: string[] = [];
  let paused = 0;
  for (const l of legsAllowed) {
    if (l.paused) {
      paused++;
      parts.push(`${l.name} is paused in Oraknid: unpause it on its card (Legs) to go on`);
    } else if (!l.enabled) parts.push(`${l.name} is turned off: turn it on in Legs`);
    else if (l.health === "rate-limited" && l.limitedUntil && l.limitedUntil > at)
      parts.push(`${l.name} is out of quota until ${whenSaid(l.limitedUntil, at)}`);
    else if (l.health === "rate-limited") parts.push(`${l.name} is out of quota`);
    else if (l.health === "unavailable" || l.health === "disabled")
      parts.push(`${l.name} can't be used: ${l.healthDetail ?? l.health}`);
    else {
      const ids = new Set(d.registry.models(l.id).map((m) => m.id));
      const whys = excluded.filter((e) => ids.has(e.legModelId)).map((e) => e.why);
      if (whys.length) parts.push(whys.join(" ").replace(/\.$/, ""));
    }
  }
  const when = until ? ` It goes on by itself at ${whenSaid(until, at)}.` : "";
  const act =
    paused && paused === legsAllowed.length
      ? " Unpause one to go on."
      : !until && paused
        ? " Unpause a Leg, or add one that can do it."
        : "";
  return `No Leg can take "${title}": ${parts.join("; ") || "none of them fits it"}.${when}${act}`;
}
