import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "./brain.ts";

/** A job blocked because no model could think for The Eye (brain.ts, `noThinkerSaid`). */
export const NO_THINKER = /^No Leg can think for The Eye right now: /;

/** At most one resume of the same job by itself in this long, should it block again at once. */
const AGAIN_MS = 5 * 60_000;

/**
 * A job blocked only because no model could think for The Eye waits for
 * one, never for me (ADR-067 §3): when a reset is known, the block is a
 * wait with that time (`blockedUntil`, resumed by the daemon's quota
 * timer); and whenever a model can think again (a Leg unpaused, a limit
 * reset, a model's earned level rising), it goes on by itself.
 */
export function watchForThinker(d: {
  db: Db;
  bus: EventBus;
  runner: Pick<JobRunner, "resume">;
  brain: Pick<EyeBrain, "thinkerFree">;
  now?: () => number;
  intervalMs?: number;
}): () => void {
  const now = d.now ?? Date.now;
  const resumed = new Map<string, number>();
  const free = () => {
    try {
      return d.brain.thinkerFree?.() ?? null;
    } catch (error) {
      console.error("checking for a free thinker failed", error);
      return null;
    }
  };

  // Blocked for no thinker: when the earliest reset is known, it waits until then.
  const off = d.bus.subscribe((e) => {
    if (e.type !== "job.state" || !e.jobId) return;
    const p = e.payload as { to?: string; reason?: string | null } | null;
    if (p?.to !== "blocked" || !NO_THINKER.test(p.reason ?? "")) return;
    const f = free();
    if (f && !f.free && f.until && f.until > now())
      d.db.update(jobs).set({ blockedUntil: f.until }).where(eq(jobs.id, e.jobId)).run();
  });

  const check = () => {
    const waiting = d.db.select().from(jobs).where(eq(jobs.state, "blocked")).all();
    const mine = waiting.filter((j) => NO_THINKER.test(j.blockedReason ?? ""));
    if (!mine.length) return;
    const f = free();
    if (!f) return;
    for (const j of mine) {
      if (!f.free) {
        // A reset learned since it blocked: the wait gets its time.
        if (!j.blockedUntil && f.until && f.until > now())
          d.db.update(jobs).set({ blockedUntil: f.until }).where(eq(jobs.id, j.id)).run();
        continue;
      }
      const last = resumed.get(j.id) ?? 0;
      if (now() - last < AGAIN_MS) continue;
      resumed.set(j.id, now());
      d.db.update(jobs).set({ blockedUntil: null }).where(eq(jobs.id, j.id)).run();
      void d.runner
        .resume(j.id)
        .then(() =>
          d.bus.publish({
            type: "job.auto-resumed",
            topic: `job:${j.id}`,
            jobId: j.id,
            payload: { reason: "An agent can think for The Eye again; it goes on by itself." },
            actor: "oraknid",
          }),
        )
        .catch((error) => console.error("auto-resume failed", error));
    }
  };
  const timer = setInterval(check, d.intervalMs ?? 30_000);
  timer.unref();
  return () => {
    off();
    clearInterval(timer);
  };
}
