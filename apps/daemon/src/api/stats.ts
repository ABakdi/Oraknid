import { and, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, legModels, legs, sessions, tasks } from "../db/schema.ts";

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
