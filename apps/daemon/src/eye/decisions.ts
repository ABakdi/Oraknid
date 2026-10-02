import { EyeModels, type PlanComparison, type PlanOutcome, type WebPlan } from "@oraknid/contracts";
import { planMeasures } from "@oraknid/core";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { events, eyePlans, jobs, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { EyePins, PlanRecord } from "./brain.ts";

// The Eye's decision models (ADR-022): a model per kind of decision, a
// shadow planner, and the plans kept to compare them.

const EYE_LEG = "eye.legModelId";
const PINS = "eye.models";
const Pins = EyeModels.omit({ leg: true });
const NONE = { planning: null, judging: null, quick: null, shadow: null };

export class EyeDecisions {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly now: () => number = Date.now,
  ) {}

  models(): EyeModels {
    return {
      leg: readSetting(this.db, EYE_LEG, EyeModels.shape.leg, null),
      ...readSetting(this.db, PINS, Pins, NONE),
    };
  }

  pins(): EyePins {
    return readSetting(this.db, PINS, Pins, NONE);
  }

  setModels(m: EyeModels) {
    writeSetting(this.db, EYE_LEG, EyeModels.shape.leg, m.leg);
    const { leg: _leg, ...pins } = m;
    writeSetting(this.db, PINS, Pins, pins);
    this.bus.publish({
      type: "settings.updated",
      topic: "overview",
      jobId: null,
      payload: { eyeModels: m },
      actor: "owner",
    });
  }

  record(r: PlanRecord) {
    this.db
      .insert(eyePlans)
      .values({
        id: newId(this.now()),
        jobId: r.jobId,
        pairId: r.pairId,
        call: r.call,
        role: r.role,
        model: r.model,
        plan: r.plan,
        error: r.error,
        ms: r.ms,
        firstTry: r.firstTry,
        createdAt: this.now(),
      })
      .run();
    this.bus.publish({
      type: "eye.planned",
      topic: `job:${r.jobId}`,
      jobId: r.jobId,
      payload: { call: r.call, role: r.role, model: r.model, ok: r.error === null },
    });
  }

  /** Each plan call of the job, its plan and its shadow's, with their measures. */
  comparisons(jobId: string): PlanComparison[] {
    const rows = this.db
      .select()
      .from(eyePlans)
      .where(eq(eyePlans.jobId, jobId))
      .orderBy(asc(eyePlans.createdAt))
      .all();
    const pairs = new Map<string, PlanComparison>();
    for (const r of rows) {
      const pair = pairs.get(r.pairId) ?? {
        pairId: r.pairId,
        call: r.call,
        at: r.createdAt,
        plans: [],
      };
      const plan = r.plan as WebPlan | null;
      pair.plans.push({
        role: r.role,
        model: r.model,
        error: r.error,
        ms: r.ms,
        firstTry: r.firstTry,
        measures: plan ? planMeasures(plan) : null,
        titles: plan ? plan.tasks.map((t) => t.title) : [],
      });
      pairs.set(r.pairId, pair);
    }
    return [...pairs.values()];
  }

  /** How the plans that ran fared: tasks done, attempts, checks repaired, replans. */
  outcome(jobId: string): PlanOutcome {
    const ts = this.db.select().from(tasks).where(eq(tasks.jobId, jobId)).all();
    const job = this.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    const repaired = this.db
      .select({ payload: events.payload })
      .from(events)
      .where(and(eq(events.jobId, jobId), eq(events.type, "task.check-reviewed")))
      .all()
      .filter((e) => (e.payload as { broken?: boolean }).broken).length;
    return {
      tasksDone: ts.filter((t) => t.state === "done").length,
      tasksTotal: ts.length,
      attempts: ts.reduce((n, t) => n + t.attemptCount, 0),
      checksRepaired: repaired,
      replans: job?.verifyRound ?? 0,
    };
  }
}
