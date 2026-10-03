import { z } from "zod";
import type { Db } from "../db/open.ts";
import { readSetting, writeSetting } from "../settings.ts";

// A Leg's work, stopped without stopping its job (Jobs-and-Projects → Controls):
// pausing a Leg pauses its running sessions in place, at a safe point, and
// their tasks wait for it; cancelling a Leg's work in a job ends its sessions
// there and its tasks go on without it.

/** Why an attempt was stopped while its job goes on. */
export class LegStop extends Error {
  constructor(
    readonly how: "pause" | "cancel",
    readonly legId: string,
    readonly legName: string,
  ) {
    super(
      how === "pause"
        ? `${legName} was paused; the task waits for it.`
        : `${legName}'s work in this job was cancelled; the task goes on without it.`,
    );
  }
}

/** Per job: Legs its tasks no longer use, and the tasks waiting for a paused Leg. */
const LegWork = z.object({
  /** Legs this job's tasks don't use any more (their work here cancelled). */
  avoid: z.array(z.string()).default([]),
  /** By task: Legs that task doesn't use any more. */
  taskAvoid: z.record(z.string(), z.array(z.string())).default({}),
  /** By task: the paused Leg it waits for. */
  waitFor: z.record(z.string(), z.string()).default({}),
});
export type LegWork = z.infer<typeof LegWork>;
const NONE: LegWork = { avoid: [], taskAvoid: {}, waitFor: {} };

export const legWorkKey = (jobId: string) => `job.legWork.${jobId}`;

export const readLegWork = (db: Db, jobId: string): LegWork =>
  readSetting(db, legWorkKey(jobId), LegWork, NONE);

function change(db: Db, jobId: string, fn: (w: LegWork) => void) {
  const w = structuredClone(readLegWork(db, jobId));
  fn(w);
  writeSetting(db, legWorkKey(jobId), LegWork, w);
}

/** What routing must know of a task: the Legs it may not use, and the paused one it waits for. */
export function legLimits(db: Db, jobId: string, taskId: string) {
  const w = readLegWork(db, jobId);
  return {
    avoid: new Set([...w.avoid, ...(w.taskAvoid[taskId] ?? [])]),
    waitFor: w.waitFor[taskId] ?? null,
  };
}

/** The task no longer waits for a Leg: it started on it again, or I reassigned it. */
export function stopWaiting(db: Db, jobId: string, taskId: string) {
  if (!readLegWork(db, jobId).waitFor[taskId]) return;
  change(db, jobId, (w) => {
    delete w.waitFor[taskId];
  });
}

interface Running {
  jobId: string;
  taskId: string;
  legId: string;
  stop: (reason: LegStop) => void;
  ended: Promise<unknown>;
}

/** Attempts running now, each with its Leg: what a Leg's pause or cancel reaches. */
const running = new Set<Running>();

/** Called by an attempt once its Leg is chosen; the returned function ends the registration. */
export function trackAttempt(r: Running): () => void {
  running.add(r);
  return () => running.delete(r);
}

/**
 * Pauses a Leg's running sessions in place (BR-7: at a safe point, a
 * handoff left behind); each task waits for the Leg. Resolves once every
 * one has stopped.
 */
export async function pauseLegSessions(db: Db, legId: string, legName: string) {
  const hit = [...running].filter((r) => r.legId === legId);
  for (const r of hit)
    change(db, r.jobId, (w) => {
      w.waitFor[r.taskId] = legId;
    });
  for (const r of hit) r.stop(new LegStop("pause", legId, legName));
  await Promise.allSettled(hit.map((r) => r.ended));
  return hit.length;
}

/**
 * Cancels what a Leg is doing in a job (or on one of its tasks): its
 * sessions there end at a safe point, the tasks go back to ready and
 * don't use that Leg again in this job (that task). Resolves once stopped.
 */
export async function cancelLegWork(
  db: Db,
  jobId: string,
  legId: string,
  legName: string,
  taskId?: string,
) {
  change(db, jobId, (w) => {
    if (taskId) w.taskAvoid[taskId] = [...new Set([...(w.taskAvoid[taskId] ?? []), legId])];
    else w.avoid = [...new Set([...w.avoid, legId])];
    for (const [t, l] of Object.entries(w.waitFor))
      if (l === legId && (!taskId || t === taskId)) delete w.waitFor[t];
  });
  const hit = [...running].filter(
    (r) => r.jobId === jobId && r.legId === legId && (!taskId || r.taskId === taskId),
  );
  for (const r of hit) r.stop(new LegStop("cancel", legId, legName));
  await Promise.allSettled(hit.map((r) => r.ended));
  return hit.length;
}

/**
 * "Give it to another Leg" (ADR-045): the task no longer uses the Leg it
 * kept going wrong on; with one picked, it goes to that Leg.
 */
export function giveToLeg(
  db: Db,
  jobId: string,
  taskId: string,
  fromLegId: string,
  toLegId: string | null,
) {
  change(db, jobId, (w) => {
    w.taskAvoid[taskId] = [...new Set([...(w.taskAvoid[taskId] ?? []), fromLegId])].filter(
      (id) => id !== toLegId,
    );
    if (toLegId) w.waitFor[taskId] = toLegId;
    else delete w.waitFor[taskId];
  });
}
