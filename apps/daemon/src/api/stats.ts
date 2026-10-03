import type { Budget } from "@oraknid/contracts";
import { and, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, legModels, legs, sessions, tasks } from "../db/schema.ts";
import { projectBudget } from "../settings.ts";

// Stats for the charts and the per-project numbers (Web-UI → Charts, Projects).

export const StatsScope = z.object({
  jobId: z.string().optional(),
  projectId: z.string().optional(),
});

export const TokenBucket = z.object({ t: z.number(), series: z.string(), tokens: z.number() });

function jobIds(db: Db, scope: z.infer<typeof StatsScope>): string[] | null {
  if (scope.jobId) return [scope.jobId];
  if (scope.projectId)
    return db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.projectId, scope.projectId))
      .all()
      .map((j) => j.id);
  return null;
}

/** Tokens over time, per Leg model (a session's tokens count at its start). */
export function tokensOverTime(
  db: Db,
  i: z.infer<typeof StatsScope> & { since: number; bucketMs: number },
) {
  const ids = jobIds(db, i);
  const where: SQL[] = [gte(sessions.startedAt, i.since)];
  if (ids) where.push(inArray(sessions.jobId, ids.length ? ids : [""]));
  const rows = db
    .select({
      startedAt: sessions.startedAt,
      input: sessions.inputTokens,
      output: sessions.outputTokens,
      write: sessions.cacheWriteTokens,
      leg: legs.name,
      model: legModels.model,
      eye: sessions.attemptId,
    })
    .from(sessions)
    .leftJoin(legs, eq(legs.id, sessions.legId))
    .leftJoin(legModels, eq(legModels.id, sessions.legModelId))
    .where(and(...where))
    .all();
  const out = new Map<string, z.infer<typeof TokenBucket>>();
  for (const r of rows) {
    const t = Math.floor(r.startedAt / i.bucketMs) * i.bucketMs;
    // The Eye's reasoning is shown on its own (ADR-008).
    const series = r.eye?.startsWith("eye:") ? "The Eye" : `${r.leg ?? "?"} · ${r.model ?? "?"}`;
    const key = `${t}|${series}`;
    const b = out.get(key) ?? { t, series, tokens: 0 };
    b.tokens += r.input + r.output + r.write;
    out.set(key, b);
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

export const Summary = z.object({
  tokens: z.number(),
  timeMs: z.number(),
  tasks: z.object({ done: z.number(), failed: z.number(), total: z.number() }),
  attempts: z.number(),
  successRate: z.number().nullable(),
  byLeg: z.array(
    z.object({
      series: z.string(),
      tokens: z.number(),
      attempts: z.number(),
      successes: z.number(),
      ms: z.number(),
    }),
  ),
});

/** Totals and a breakdown by Leg model, for a job, a project, or everything. */
export function summary(
  db: Db,
  scope: z.infer<typeof StatsScope>,
  now = Date.now(),
): z.infer<typeof Summary> {
  const ids = jobIds(db, scope);
  const inJobs = <T extends { jobId: unknown }>(col: T["jobId"]) =>
    ids ? inArray(col as never, ids.length ? ids : [""]) : undefined;
  const s = db.select().from(sessions).where(inJobs(sessions.jobId)).all();
  const t = db.select().from(tasks).where(inJobs(tasks.jobId)).all();
  const a = db
    .select({
      outcome: attempts.outcome,
      startedAt: attempts.startedAt,
      endedAt: attempts.endedAt,
      legModelId: attempts.legModelId,
      legId: attempts.legId,
    })
    .from(attempts)
    .where(inJobs(attempts.jobId))
    .all();
  const j = db
    .select({ startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(ids ? inArray(jobs.id, ids.length ? ids : [""]) : undefined)
    .all();
  const names = new Map(
    db
      .select({ id: legModels.id, model: legModels.model, leg: legs.name })
      .from(legModels)
      .leftJoin(legs, eq(legs.id, legModels.legId))
      .all()
      .map((r) => [r.id, `${r.leg ?? "?"} · ${r.model}`]),
  );
  const byLeg = new Map<
    string,
    { series: string; tokens: number; attempts: number; successes: number; ms: number }
  >();
  const row = (id: string) => {
    const series = names.get(id) ?? "?";
    const r = byLeg.get(series) ?? { series, tokens: 0, attempts: 0, successes: 0, ms: 0 };
    byLeg.set(series, r);
    return r;
  };
  for (const x of s)
    row(x.legModelId).tokens += x.inputTokens + x.outputTokens + x.cacheWriteTokens;
  for (const x of a) {
    const r = row(x.legModelId);
    r.attempts++;
    if (x.outcome === "succeeded") r.successes++;
    r.ms += (x.endedAt ?? now) - x.startedAt;
  }
  const ended = a.filter((x) => x.outcome);
  return {
    tokens: s.reduce((n, x) => n + x.inputTokens + x.outputTokens + x.cacheWriteTokens, 0),
    timeMs: j.reduce((n, x) => n + (x.startedAt ? (x.finishedAt ?? now) - x.startedAt : 0), 0),
    tasks: {
      done: t.filter((x) => x.state === "done").length,
      failed: t.filter((x) => x.state === "failed").length,
      total: t.length,
    },
    attempts: a.length,
    successRate: ended.length
      ? ended.filter((x) => x.outcome === "succeeded").length / ended.length
      : null,
    byLeg: [...byLeg.values()].sort((x, y) => y.tokens - x.tokens),
  };
}

const Outcomes = { succeeded: z.number(), failed: z.number(), other: z.number() };

export const ChartsInput = StatsScope.extend({
  /** Attempts from this time on; budget burn always covers the whole scope. */
  since: z.number().default(0),
  bucketMs: z.number().int().positive().default(86400_000),
});

export const Charts = z.object({
  bucketMs: z.number(),
  /** Tasks verified (an attempt that succeeded) and attempts that failed, per bucket. */
  throughput: z.array(z.object({ t: z.number(), done: z.number(), failed: z.number() })),
  /** Per Leg: attempts by outcome ("other": reassigned or abandoned), tokens, time. */
  byLeg: z.array(
    z.object({
      legId: z.string(),
      leg: z.string(),
      kind: z.string(),
      ...Outcomes,
      tokens: z.number(),
      ms: z.number(),
      /** Every token its attempts used, over the tasks they verified; null before one is. */
      tokensPerVerified: z.number().nullable(),
      /** Every millisecond its attempts ran, over the tasks they verified. */
      msPerVerified: z.number().nullable(),
    }),
  ),
  /** Per task kind: attempts by outcome. */
  byKind: z.array(z.object({ kind: z.string(), ...Outcomes })),
  /** Money spent (US dollars). Nothing counts money yet (paid Legs come later): always 0. */
  money: z.object({
    total: z.number(),
    points: z.array(z.object({ t: z.number(), money: z.number() })),
  }),
  /** Tokens used so far against the token limit: a job's, a project's; null for everything. */
  burn: z
    .object({
      limit: z.number().nullable(),
      hard: z.boolean(),
      used: z.number(),
      points: z.array(z.object({ t: z.number(), used: z.number() })),
    })
    .nullable(),
});
export type Charts = z.infer<typeof Charts>;

/** At most this many buckets in a series, the newest kept. */
const MAX_BUCKETS = 400;

type Counted = { succeeded: number; failed: number; other: number };
const count = (r: Counted, outcome: string | null) => {
  if (outcome === "succeeded") r.succeeded++;
  else if (outcome === "failed") r.failed++;
  else if (outcome) r.other++;
};
const tried = (r: Counted) => r.succeeded + r.failed + r.other;

/**
 * The charts' numbers (Web-UI → Charts) for a job, a project or everything:
 * throughput, success and failure by Leg and by task kind, tokens and time
 * per verified task, money, and budget burn against the limit.
 */
export function charts(db: Db, i: z.input<typeof ChartsInput>, now = Date.now()): Charts {
  const since = i.since ?? 0;
  const bucketMs = i.bucketMs ?? 86400_000;
  const bucket = (t: number) => Math.floor(t / bucketMs) * bucketMs;
  const ids = jobIds(db, i);
  const inScope = (col: typeof attempts.jobId | typeof sessions.jobId) =>
    ids ? inArray(col, ids.length ? ids : [""]) : undefined;
  const a = db
    .select({
      id: attempts.id,
      legId: attempts.legId,
      outcome: attempts.outcome,
      startedAt: attempts.startedAt,
      endedAt: attempts.endedAt,
      kind: tasks.kind,
    })
    .from(attempts)
    .leftJoin(tasks, eq(tasks.id, attempts.taskId))
    .where(and(inScope(attempts.jobId), gte(attempts.startedAt, since)))
    .all();
  const s = db
    .select({
      attemptId: sessions.attemptId,
      startedAt: sessions.startedAt,
      input: sessions.inputTokens,
      output: sessions.outputTokens,
      write: sessions.cacheWriteTokens,
    })
    .from(sessions)
    .where(inScope(sessions.jobId))
    .all()
    .map((x) => ({ ...x, tokens: x.input + x.output + x.write }));
  const legRows = new Map(
    db
      .select({ id: legs.id, name: legs.name, kind: legs.kind })
      .from(legs)
      .all()
      .map((l) => [l.id, l]),
  );

  // Throughput: every bucket between the first and the last, an empty one as 0.
  const tp = new Map<number, { t: number; done: number; failed: number }>();
  for (const x of a) {
    if (x.endedAt === null || (x.outcome !== "succeeded" && x.outcome !== "failed")) continue;
    const t = bucket(x.endedAt);
    const r = tp.get(t) ?? { t, done: 0, failed: 0 };
    if (x.outcome === "succeeded") r.done++;
    else r.failed++;
    tp.set(t, r);
  }
  const throughput: Charts["throughput"] = [];
  if (tp.size) {
    const last = Math.max(...tp.keys());
    const first = Math.max(Math.min(...tp.keys()), last - (MAX_BUCKETS - 1) * bucketMs);
    for (let t = first; t <= last; t += bucketMs)
      throughput.push(tp.get(t) ?? { t, done: 0, failed: 0 });
  }

  const tokensOf = new Map<string, number>();
  for (const x of s)
    if (x.attemptId) tokensOf.set(x.attemptId, (tokensOf.get(x.attemptId) ?? 0) + x.tokens);
  const byLeg = new Map<string, Charts["byLeg"][number]>();
  const byKind = new Map<string, Charts["byKind"][number]>();
  for (const x of a) {
    const l = legRows.get(x.legId);
    const leg = byLeg.get(x.legId) ?? {
      legId: x.legId,
      leg: l?.name ?? "?",
      kind: l?.kind ?? "?",
      succeeded: 0,
      failed: 0,
      other: 0,
      tokens: 0,
      ms: 0,
      tokensPerVerified: null,
      msPerVerified: null,
    };
    count(leg, x.outcome);
    leg.tokens += tokensOf.get(x.id) ?? 0;
    leg.ms += (x.endedAt ?? now) - x.startedAt;
    byLeg.set(x.legId, leg);
    const kind = x.kind ?? "?";
    const k = byKind.get(kind) ?? { kind, succeeded: 0, failed: 0, other: 0 };
    count(k, x.outcome);
    byKind.set(kind, k);
  }
  for (const r of byLeg.values())
    if (r.succeeded) {
      r.tokensPerVerified = Math.round(r.tokens / r.succeeded);
      r.msPerVerified = Math.round(r.ms / r.succeeded);
    }

  // Burn: the scope's tokens added up over its whole life, against its limit.
  let burn: Charts["burn"] = null;
  const limit = i.jobId
    ? (
        db.select({ budget: jobs.budget }).from(jobs).where(eq(jobs.id, i.jobId)).get()?.budget as
          | Budget
          | undefined
      )?.tokens
    : i.projectId
      ? projectBudget(db, i.projectId).tokens
      : undefined;
  if (limit !== undefined) {
    const per = new Map<number, number>();
    for (const x of s) per.set(bucket(x.startedAt), (per.get(bucket(x.startedAt)) ?? 0) + x.tokens);
    let used = 0;
    const points = [...per.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([t, n]) => {
        used += n;
        return { t, used };
      })
      .slice(-MAX_BUCKETS);
    burn = { limit: limit?.limit ?? null, hard: limit?.hard ?? false, used, points };
  }

  return {
    bucketMs,
    throughput,
    byLeg: [...byLeg.values()].sort((x, y) => tried(y) - tried(x) || x.leg.localeCompare(y.leg)),
    byKind: [...byKind.values()].sort(
      (x, y) => tried(y) - tried(x) || x.kind.localeCompare(y.kind),
    ),
    money: { total: 0, points: [] },
    burn,
  };
}

export const Activity = z.object({
  sessionId: z.string(),
  legId: z.string(),
  model: z.string(),
  effort: z.string().nullable(),
  jobId: z.string().nullable(),
  taskId: z.string().nullable(),
  task: z.string().nullable(),
  eye: z.boolean(),
  contextTokens: z.number().nullable(),
  startedAt: z.number(),
});

/** What every Leg is doing right now (Overview → Legs now). */
export function activity(db: Db): z.infer<typeof Activity>[] {
  return db
    .select({
      sessionId: sessions.id,
      legId: sessions.legId,
      model: legModels.model,
      effort: sessions.effort,
      jobId: sessions.jobId,
      taskId: sessions.taskId,
      task: tasks.title,
      attemptId: sessions.attemptId,
      contextTokens: sessions.contextTokens,
      startedAt: sessions.startedAt,
    })
    .from(sessions)
    .leftJoin(legModels, eq(legModels.id, sessions.legModelId))
    .leftJoin(tasks, eq(tasks.id, sessions.taskId))
    .where(isNull(sessions.endedAt))
    .all()
    .map((r) => ({ ...r, model: r.model ?? "?", eye: !!r.attemptId?.startsWith("eye:") }));
}
