import { existsSync, mkdirSync } from "node:fs";
import type { Event, EyeReport } from "@oraknid/contracts";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { eyeMessages, jobs, projects, silkEntries, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { firstLine } from "../workspace/projects.ts";
import type { EyeBrain } from "./brain.ts";

// A job named by what it is (Jobs-and-Projects → A job's name and
// description). Right after it's made, The Eye gives it a name and a
// description of what it's for, unless I typed the name (then only the
// description); when it ends with work done, the description becomes what
// it did, from The Eye's report of the ending (ADR-045). Never blocking: a
// queue, one quick-model call at a time. Without a model the goal's first
// line stays, and the call is tried again when a Leg or The Eye's models
// change, or every few minutes. At start, older jobs still named by their
// first line are named too, slowly, on the quick model I chose only.
//
// Once (ADR-066 §2): a job is named when it is made, and again only when its
// goal changed before it started (named as it starts, never as I type); it
// is described once when it is completed or stopped, never each time it is
// blocked. The backfill tries a job once a week at most, so a job its model
// can't name isn't asked again at every restart. (43 namings in three days,
// 2026-10-10: a draft renamed after every pause in my typing, and a job
// "ended" again at each of its blocks, each one an agent session.)

export interface NamingDeps {
  db: Db;
  bus: EventBus;
  brain?: EyeBrain;
  now: () => number;
  /** Where a call runs when the job has no folder (an empty folder of Oraknid's). */
  tmpDir: string;
  /** The pause between two calls of the backfill. */
  gapMs?: number;
  /** How often calls that found no model are tried again. */
  retryMs?: number;
  /** When the backfill of older jobs starts, after the daemon is up. */
  backfillDelayMs?: number;
}

type Kind = "name" | "end";
interface Item {
  jobId: string;
  kind: Kind;
  backfill: boolean;
}

export interface JobNaming {
  /** Resolves when nothing is queued or running (for tests). */
  idle(): Promise<void>;
  /** Tries again the calls that found no model. */
  retry(): void;
  /** Names the older jobs still named by their goal's first line. */
  backfill(): void;
  stop(): void;
}

const ENDED = new Set(["completed", "cancelled"]);
/** When the backfill last tried each job (ADR-066 §2): not again within a week. */
const TRIED = "eye.namingTried";
const Tried = z.record(z.string(), z.number());
const TRY_AGAIN_MS = 7 * 86_400_000;
/** What may bring a model back: a Leg added, changed or healthy again, The Eye's models chosen. */
const RETRY_ON = new Set([
  "leg.created",
  "leg.updated",
  "leg.health",
  "leg.profile",
  "settings.updated",
]);

export function startJobNaming(d: NamingDeps): JobNaming {
  const queue = new Map<string, Item>();
  const waiting = new Map<string, Item>();
  let running: Promise<void> | null = null;
  let stopped = false;

  const enqueue = (item: Item) => {
    if (stopped || !d.brain?.nameJob) return;
    const had = queue.get(item.jobId);
    // An ending covers a naming; a live request goes before the backfill.
    queue.set(item.jobId, {
      ...item,
      kind: had?.kind === "end" ? "end" : item.kind,
      backfill: item.backfill && (had?.backfill ?? true),
    });
    waiting.delete(item.jobId);
    running ??= drain().finally(() => {
      running = null;
    });
  };

  async function drain() {
    while (!stopped && queue.size) {
      const next = [...queue.values()].find((i) => !i.backfill) ?? [...queue.values()][0];
      if (!next) break;
      queue.delete(next.jobId);
      await run(next).catch((error) => console.error("naming a job failed", error));
      if (next.backfill && d.gapMs !== 0)
        await new Promise((r) => setTimeout(r, d.gapMs ?? 5_000).unref());
    }
  }

  async function run(item: Item) {
    const brain = d.brain;
    if (!brain?.nameJob) return;
    const job = d.db.select().from(jobs).where(eq(jobs.id, item.jobId)).get();
    if (!job) return;
    const wantsTitle = job.namedBy === null;
    const wantsDescription =
      job.describedAs !== "mine" && (item.kind === "end" || job.describedAs === null);
    if (!wantsTitle && !wantsDescription) return;
    const project = d.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
    const outcome = item.kind === "end" ? outcomeOf(d.db, job.id) : undefined;
    if (item.backfill) {
      const tried = readSetting(d.db, TRIED, Tried, {});
      const ids = new Set(
        d.db
          .select({ id: jobs.id })
          .from(jobs)
          .all()
          .map((j) => j.id),
      );
      writeSetting(
        d.db,
        TRIED,
        Tried,
        Object.fromEntries([
          ...Object.entries(tried).filter(([id]) => ids.has(id)),
          [job.id, d.now()],
        ]),
      );
    }
    let named: Awaited<ReturnType<NonNullable<EyeBrain["nameJob"]>>>;
    try {
      named = await brain.nameJob({
        jobId: job.id,
        cwd: folderFor(d, job.worktree, project?.workspacePath ?? null),
        goal: job.goal,
        project: project?.name ?? "",
        ...(outcome ? { outcome } : {}),
        ...(item.backfill ? { quickOnly: true } : {}),
      });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // No model now: the first line stays until one can (tried again later).
      if (/^No Leg can think/.test(why)) waiting.set(item.jobId, item);
      else console.warn(`The Eye couldn't name the job ${job.id}: ${why}`);
      return;
    }
    const now = d.db.select().from(jobs).where(eq(jobs.id, item.jobId)).get();
    // Gone, or its goal changed while The Eye thought (a draft): the next call names it.
    if (!now || now.goal !== job.goal) return;
    const set: Partial<typeof jobs.$inferInsert> = {};
    if (now.namedBy === null) Object.assign(set, { title: tidy(named.title), namedBy: "eye" });
    const describe =
      now.describedAs !== "mine" &&
      (item.kind === "end" || now.describedAs === null || now.describedAs === "purpose");
    // A purpose never replaces what it did (an ending arrived first).
    if (describe && !(item.kind === "name" && now.describedAs === "outcome"))
      Object.assign(set, {
        description: named.description.trim(),
        describedAs: item.kind === "end" ? "outcome" : "purpose",
      });
    if (!Object.keys(set).length) return;
    d.bus.atomically(() => {
      d.db.update(jobs).set(set).where(eq(jobs.id, job.id)).run();
      const after = d.db.select().from(jobs).where(eq(jobs.id, job.id)).get();
      d.bus.publish({
        type: "job.named",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: {
          id: job.id,
          title: after?.title,
          description: after?.description ?? null,
          namedBy: after?.namedBy ?? null,
          describedAs: after?.describedAs ?? null,
        },
        actor: "eye",
      });
    });
  }

  const onEvent = (e: Event) => {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    if (e.type === "job.created" && e.jobId)
      enqueue({ jobId: e.jobId, kind: "name", backfill: false });
    else if (e.type === "job.state" && e.jobId && p.from === "draft")
      // Its goal changed while it was a draft (its first line is back): named once, as it starts.
      // A job already named is left as it is (`run` asks nothing).
      enqueue({ jobId: e.jobId, kind: "name", backfill: false });
    else if (e.type === "eye.replied" && e.jobId && p.intent === "report") {
      // Its ending, once: completed, or stopped with work done; a block is no ending (ADR-066 §2).
      const kind = reportKind(d.db, String(p.id));
      if (kind === "job-done" || (kind === "cancelled" && didWork(d.db, e.jobId)))
        enqueue({ jobId: e.jobId, kind: "end", backfill: false });
    } else if (waiting.size && RETRY_ON.has(e.type)) retry();
  };

  function retry() {
    for (const item of [...waiting.values()]) enqueue(item);
  }

  function backfill() {
    const tried = readSetting(d.db, TRIED, Tried, {});
    for (const job of d.db.select().from(jobs).all()) {
      // A draft is named as it starts; a job tried lately isn't asked again so soon.
      if (job.state === "draft") continue;
      if ((tried[job.id] ?? 0) > d.now() - TRY_AGAIN_MS) continue;
      const worked = didWork(d.db, job.id);
      const ended = job.state === "completed" || (ENDED.has(job.state) && worked);
      if (job.namedBy === null && job.title !== firstLine(job.goal)) {
        // Named by me before names were The Eye's: kept, nothing to ask.
        d.db.update(jobs).set({ namedBy: "me" }).where(eq(jobs.id, job.id)).run();
        continue;
      }
      if (job.namedBy === null)
        enqueue({ jobId: job.id, kind: ended ? "end" : "name", backfill: true });
      else if (ended && job.describedAs === "purpose")
        // It ended while no model could describe it.
        enqueue({ jobId: job.id, kind: "end", backfill: true });
      else if (!ENDED.has(job.state) && job.describedAs === null)
        enqueue({ jobId: job.id, kind: "name", backfill: true });
    }
  }

  const off = d.bus.subscribe((e) => {
    try {
      onEvent(e);
    } catch (error) {
      console.error("naming a job failed", error);
    }
  });
  const retryTimer = setInterval(retry, d.retryMs ?? 10 * 60_000);
  retryTimer.unref();
  const backfillTimer =
    d.backfillDelayMs === undefined || d.backfillDelayMs >= 0
      ? setTimeout(backfill, d.backfillDelayMs ?? 30_000)
      : null;
  backfillTimer?.unref();

  return {
    async idle() {
      while (running) await running;
    },
    retry,
    backfill,
    stop() {
      stopped = true;
      off();
      clearInterval(retryTimer);
      if (backfillTimer) clearTimeout(backfillTimer);
      queue.clear();
    },
  };
}

/** A title as a list shows it: one line, no quotes, no full stop. */
const tidy = (title: string) =>
  title
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["“'](.*)["”']$/, "$1")
    .replace(/[.!?:]+$/, "");

function folderFor(d: NamingDeps, worktree: string | null, workspace: string | null): string {
  for (const f of [worktree, workspace]) if (f && existsSync(f)) return f;
  mkdirSync(d.tmpDir, { recursive: true });
  return d.tmpDir;
}

function reportKind(db: Db, messageId: string): EyeReport["kind"] | undefined {
  const m = db.select().from(eyeMessages).where(eq(eyeMessages.id, messageId)).get();
  return (m?.action as { report?: EyeReport } | null)?.report?.kind;
}

function didWork(db: Db, jobId: string): boolean {
  return !!db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.state, "done")))
    .get();
}

/**
 * How a job ended, for its description: The Eye's report of the ending (its
 * summary, facts and what's left to me), the tasks done, else its Silk.
 */
export function outcomeOf(db: Db, jobId: string): string {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) return "";
  const reports = db
    .select()
    .from(eyeMessages)
    .where(and(eq(eyeMessages.jobId, jobId), eq(eyeMessages.author, "eye")))
    .orderBy(desc(eyeMessages.createdAt), desc(eyeMessages.id))
    .all()
    .filter((m) => {
      const kind = (m.action as { report?: EyeReport } | null)?.report?.kind;
      return kind === "job-done" || kind === "cancelled" || kind === "blocked";
    });
  const last = reports[0];
  const report = (last?.action as { report?: EyeReport } | null)?.report;
  const done = db
    .select({ title: tasks.title })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.state, "done")))
    .all()
    .map((t) => t.title);
  const state =
    job.state === "completed"
      ? "It was completed."
      : job.state === "cancelled"
        ? "It was stopped before the end."
        : job.state === "blocked"
          ? `It is blocked: ${job.blockedReason ?? "it can't go on"}.`
          : `It is ${job.state}.`;
  const parts = [state];
  if (last) parts.push(`The Eye's report:\n${last.text}`);
  for (const f of report?.facts ?? []) parts.push(`${f.label}: ${f.value}`);
  if (report?.todo.length)
    parts.push(`Left to the owner:\n${report.todo.map((t) => `- ${t}`).join("\n")}`);
  if (done.length)
    parts.push(
      `Tasks done (${done.length}): ${done.slice(0, 10).join("; ")}${done.length > 10 ? "; …" : ""}`,
    );
  if (job.branch && !report?.facts.some((f) => f.label === "Branch"))
    parts.push(`Branch: ${job.branch}`);
  if (!last) {
    const silk = db
      .select()
      .from(silkEntries)
      .where(eq(silkEntries.jobId, jobId))
      .orderBy(desc(silkEntries.createdAt))
      .limit(6)
      .all();
    if (silk.length)
      parts.push(
        `What is known (Silk):\n${silk.map((s) => `- ${s.title}: ${s.body.replace(/\s+/g, " ").slice(0, 300)}`).join("\n")}`,
      );
  }
  return parts.join("\n\n");
}
