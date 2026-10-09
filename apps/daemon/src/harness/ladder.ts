import type { TaskKind } from "@oraknid/contracts";
import { type RouteCandidate, rungOf, type WorkKind } from "@oraknid/core";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { AttemptDeps } from "./types.ts";

// The ladder never stalls (ADR-064 §7, after the Keys job): a paused agent
// is not the top of the ladder; the strongest model available now is. When
// a task fails there and a stronger model's Leg is only paused, I'm asked
// once, without the work waiting: "<Leg> would help here: unpause it, or go
// on with <the one on it>?". Unpausing it lets the next climb reach it.

const Asked = z.array(z.object({ legId: z.string(), itemId: z.string() }));
const askedKey = (jobId: string) => `job.ladderAsked.${jobId}`;
const UNPAUSE = "Unpause";

/**
 * The strongest model above `mine` for this work that only a pause keeps
 * from the task: a paused Leg's, the Legs the job may use and the task
 * doesn't avoid.
 */
export function pausedAbove(
  all: RouteCandidate[],
  mine: number,
  work: WorkKind,
  kind: TaskKind,
): RouteCandidate | null {
  return (
    all
      .filter((c) => c.paused && (c.health === "healthy" || c.health === "degraded"))
      .map((c) => ({ c, rung: rungOf(c.profile, work, kind) }))
      .filter((x) => x.rung > mine)
      .sort((a, b) => b.rung - a.rung)[0]?.c ?? null
  );
}

/** Asks once per job and Leg, in the inbox; the work goes on meanwhile. */
export function askOnceToUnpause(
  d: Pick<AttemptDeps, "db" | "inbox">,
  jobId: string,
  taskId: string,
  stronger: { legId: string; legName: string; model: string },
  current: { legName: string; model: string },
) {
  const asked = readSetting(d.db, askedKey(jobId), Asked, []);
  if (asked.some((a) => a.legId === stronger.legId)) return;
  const itemId = d.inbox.open({
    kind: "question",
    jobId,
    taskId,
    raisedBy: "eye",
    title: `${stronger.legName} would help here: unpause it, or go on with ${current.legName}?`,
    detail: `A task failed on ${current.legName} · ${current.model}, the strongest model available now. ${stronger.legName} · ${stronger.model} is stronger for this work but paused in Oraknid. The work goes on with ${current.legName} meanwhile; unpausing ${stronger.legName} lets the task climb to it.`,
    options: [`${UNPAUSE} ${stronger.legName}`, `Go on with ${current.legName}`],
    defaultOption: null,
  });
  writeSetting(d.db, askedKey(jobId), Asked, [...asked, { legId: stronger.legId, itemId }]);
}

/** My answer to that question: "Unpause" unpauses the Leg; "go on" leaves it as it is. */
export function answerLadder(
  d: { db: Db; registry: LegRegistry },
  jobId: string,
  itemId: string,
  inbox: InboxStore,
) {
  const hit = readSetting(d.db, askedKey(jobId), Asked, []).find((a) => a.itemId === itemId);
  if (!hit) return;
  const answer = inbox.get(itemId)?.answer ?? "";
  if (answer.startsWith(UNPAUSE) && d.registry.get(hit.legId)?.paused)
    d.registry.update(hit.legId, { paused: false });
}
