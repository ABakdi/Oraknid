import { ACTIVE_JOB_STATES } from "@oraknid/contracts";
import type { Inhibitor, InhibitorState } from "@oraknid/os";
import { count, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";

export interface InhibitControllerOptions {
  inhibitor: Inhibitor;
  activeJobs: () => number;
  /** BR-11: release within 60 s of the last job leaving an active state. */
  releaseAfterMs?: number;
  /** Re-check even without events, in case one was missed. */
  pollMs?: number;
}

/** Holds the sleep inhibitor exactly while jobs are active (BR-11). */
export function createInhibitController(options: InhibitControllerOptions) {
  const releaseAfterMs = options.releaseAfterMs ?? 45_000;
  let releaseTimer: NodeJS.Timeout | undefined;

  async function reconcile(): Promise<InhibitorState> {
    const n = options.activeJobs();
    if (n > 0) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
      return options.inhibitor.acquire(`${n} job${n === 1 ? "" : "s"} running`);
    }
    if (options.inhibitor.state().held && !releaseTimer) {
      releaseTimer = setTimeout(() => {
        releaseTimer = undefined;
        if (options.activeJobs() === 0) void options.inhibitor.release();
      }, releaseAfterMs);
    }
    return options.inhibitor.state();
  }

  const poll = setInterval(() => void reconcile(), options.pollMs ?? 15_000);
  poll.unref();

  return {
    reconcile,
    async stop() {
      clearInterval(poll);
      clearTimeout(releaseTimer);
      await options.inhibitor.release();
    },
  };
}

/** Jobs in a state that keeps the machine awake. */
export const countActiveJobs = (db: Db) => () =>
  db
    .select({ n: count() })
    .from(jobs)
    .where(inArray(jobs.state, [...ACTIVE_JOB_STATES]))
    .get()?.n ?? 0;
