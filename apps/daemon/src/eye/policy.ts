import type { Autonomy } from "@oraknid/contracts";
import type { GatedAction, PolicyContext, RuleLevel } from "@oraknid/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { readSetting, writeSetting } from "../settings.ts";

export const GlobalPolicy = z.object({ allow: z.array(z.string()), deny: z.array(z.string()) });
export type GlobalPolicy = z.infer<typeof GlobalPolicy>;
const KEY = "policy.global";

export const readGlobalPolicy = (db: Db): GlobalPolicy =>
  readSetting(db, KEY, GlobalPolicy, { allow: [], deny: [] });

export function writeGlobalPolicy(db: Db, bus: EventBus, policy: GlobalPolicy) {
  for (const src of [...policy.allow, ...policy.deny]) {
    try {
      new RegExp(src);
    } catch {
      throw new Error(`/${src}/ is not a valid pattern.`);
    }
  }
  writeSetting(db, KEY, GlobalPolicy, policy);
  bus.publish({
    type: "policy.updated",
    topic: "overview",
    jobId: null,
    payload: { level: "global", ...policy },
  });
}

/**
 * The policy context for a job, read fresh on every decision so a change
 * of autonomy, a waiver or a rule applies at once (Approvals → Autonomy
 * levels: changeable while the job runs).
 */
export function policyFor(db: Db, jobId: string, worktree: string): PolicyContext {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  const global = readGlobalPolicy(db);
  const rules: RuleLevel[] = [
    { level: "job", allow: job?.allowRules ?? [], deny: job?.denyRules ?? [] },
    { level: "global", allow: global.allow, deny: global.deny },
  ];
  return {
    worktree,
    autonomy: (job?.autonomy ?? "supervised") as Autonomy,
    waived: new Set((job?.waived ?? []) as GatedAction[]),
    rules,
  };
}

/** "Approve all like this for this job": a gate becomes a waiver, an unknown program an allow rule. */
export function approveAllLikeThis(
  db: Db,
  bus: EventBus,
  jobId: string,
  what: { gated: GatedAction } | { allowRule: string },
) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return;
  if ("gated" in what) {
    db.update(jobs)
      .set({ waived: [...new Set([...job.waived, what.gated])] })
      .where(eq(jobs.id, jobId))
      .run();
  } else {
    db.update(jobs)
      .set({ allowRules: [...new Set([...job.allowRules, what.allowRule])] })
      .where(eq(jobs.id, jobId))
      .run();
  }
  // Every waiver is audited (Approvals → Overrides).
  bus.publish({ type: "policy.waived", topic: `job:${jobId}`, jobId, payload: what });
}
