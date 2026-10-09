import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_PROJECT_WORK,
  type EvaluationEdit,
  EvaluationKind,
  Evaluations,
  type PlannedEvaluation,
  ProjectWorkSettings,
  type TaskEvaluation,
  type WebPlan,
} from "@oraknid/contracts";
import { EVALUATION_WORDS, evaluationTask, isEvaluation, meaningWords } from "@oraknid/core";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { jobs, taskEdges, tasks } from "../db/schema.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import {
  inboxReviews,
  type ReviewNote,
  type ReviewOutcome,
  type ReviewPort,
  type ReviewTarget,
} from "../harness/reviews.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { projectPorts, readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import { BrainStopped, type EyeBrain } from "./brain.ts";
import { detectRun, freePort, runningApp, startApp, stopApp } from "./run-app.ts";
import { storeWeb, taskRows } from "./web-store.ts";

// Evaluation steps at work (ADR-064 §1–§3, M16.2): an evaluation node of
// The Web opens a review for me through the ReviewPort, the job waits on
// it while nothing else can go on, and what I say comes back: approved,
// the node is done and the tasks after it go on; notes, The Eye turns them
// into tasks before the node (keep-notes kept in Silk as decisions every
// later task is given), and the next round opens after them.

/** What an evaluation step needs of the job's program. */
export interface EvaluationDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  brain: EyeBrain;
  registry: LegRegistry;
  sandbox: import("@oraknid/os").Sandbox;
  legsDir: string;
  now: () => number;
  reviews?: ReviewPort;
  /** How long an app may take to answer (tests make it short). */
  appWaitMs?: number;
}

// ── Settings: the project's, and a job's own ─────────────────────────

export const projectWorkKey = (projectId: string) => `project.work.${projectId}`;
export const projectWork = (db: Db, projectId: string): ProjectWorkSettings =>
  readSetting(db, projectWorkKey(projectId), ProjectWorkSettings, DEFAULT_PROJECT_WORK);

/** A job's own choice on New work or in the chat; null: the project's. */
export const jobEvaluationsKey = (jobId: string) => `job.evaluations.${jobId}`;
export const jobEvaluationsOwn = (db: Db, jobId: string): Evaluations | null =>
  readSetting(db, jobEvaluationsKey(jobId), Evaluations.nullable(), null);

/** The evaluation steps a job gets: its own choice, else its project's. */
export function jobEvaluations(db: Db, jobId: string): Evaluations {
  const own = jobEvaluationsOwn(db, jobId);
  if (own) return own;
  const job = db.select({ projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, jobId)).get();
  return job ? projectWork(db, job.projectId).evaluations : DEFAULT_PROJECT_WORK.evaluations;
}

// ── An evaluation step's own state ────────────────────────────────────

export const EvaluationState = z.object({
  kind: EvaluationKind,
  why: z.string(),
  run: z.string().nullable().default(null),
  round: z.number().int().positive().default(1),
  reviewId: z.string().nullable().default(null),
  url: z.string().nullable().default(null),
  /** The app's port, while its review is open. */
  port: z.number().int().nullable().default(null),
  openedAt: z.number().nullable().default(null),
  passAt: z.number().nullable().default(null),
  outcome: z.enum(["approved", "auto-passed", "skipped"]).nullable().default(null),
});
export type EvaluationState = z.infer<typeof EvaluationState>;

export const evaluationKey = (taskId: string) => `task.evaluation.${taskId}`;
export const readEvaluation = (db: Db, taskId: string): EvaluationState | null =>
  readSetting(db, evaluationKey(taskId), EvaluationState.nullable(), null);
const writeEvaluation = (db: Db, taskId: string, s: EvaluationState) =>
  writeSetting(db, evaluationKey(taskId), EvaluationState, s);

/** A new evaluation node's state, written when it enters The Web. */
export function rememberEvaluation(db: Db, taskId: string, e: PlannedEvaluation) {
  writeEvaluation(
    db,
    taskId,
    EvaluationState.parse({ kind: e.kind, why: e.why, run: e.run ?? null }),
  );
}

/** The step as the job's page shows it. */
export function evaluationView(db: Db, taskId: string, state: string): TaskEvaluation | null {
  const s = readEvaluation(db, taskId);
  if (!s) return null;
  return {
    kind: s.kind,
    why: s.why,
    round: s.round,
    reviewId: s.reviewId,
    url: s.url,
    waiting: !!s.reviewId && !s.outcome && state !== "done" && state !== "skipped",
    passAt: s.passAt,
    outcome: s.outcome,
  };
}

const what = (kind: EvaluationKind) => EVALUATION_WORDS[kind].does;
export const waitingWords = (kind: EvaluationKind, url: string | null) =>
  `Waiting for your review of ${what(kind)}${url ? ` — Open ${url}` : ""}`;

/** The port the daemon gave, else the inbox's (one per daemon parts). */
const fallback = new WeakMap<object, ReviewPort>();
export function reviewPortOf(d: EvaluationDeps): ReviewPort {
  if (d.reviews) return d.reviews;
  let p = fallback.get(d.inbox);
  if (!p) {
    p = inboxReviews({ bus: d.bus, inbox: d.inbox });
    fallback.set(d.inbox, p);
  }
  return p;
}

function setState(d: EvaluationDeps, jobId: string, taskId: string, state: string, reason: string) {
  d.bus.atomically(() => {
    d.db.update(tasks).set({ state, leaseUntil: null }).where(eq(tasks.id, taskId)).run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${jobId}`,
      jobId,
      payload: { taskId, to: state, reason },
    });
  });
}

type Row = ReturnType<typeof taskRows>[number];
type JobRow = typeof jobs.$inferSelect;

/** The design's folder in the job's folder: the reviewed design task's, else `design/`. */
function designFolder(rows: Row[], step: Row): string {
  const reviewed = rows.filter((r) => step.dependsOn.includes(r.id));
  for (const g of reviewed.flatMap((r) => r.scope)) {
    const parts = g.replace(/^\.\//, "").split("/");
    const at = parts.findIndex((p) => /^design$/i.test(p));
    if (at >= 0) return parts.slice(0, at + 1).join("/");
  }
  return "design";
}

/** Where a step stands after one look: settled (done, or more work before it), or waiting for me. */
export type Advance =
  | { kind: "settled" }
  | { kind: "waiting"; taskId: string; reviewId: string; reason: string; passAt: number | null };

/**
 * One look at an evaluation step that is ready: its round's review opened
 * once (journaled), the app started for an app review, then what I said
 * applied. Called again on each pass of the job's loop and after a restart.
 */
export async function advanceEvaluation(
  d: EvaluationDeps,
  ctx: JobContext,
  job: JobRow,
  step: Row,
  cwd: string,
): Promise<Advance> {
  const port = reviewPortOf(d);
  let st =
    readEvaluation(d.db, step.id) ?? EvaluationState.parse({ kind: "checkpoint", why: step.title });
  if (!st.reviewId) {
    const round = st.round;
    const opened = await ctx.step(
      `evaluation:${step.id}:${round}:open`,
      { round },
      async (signal) => openRound(d, job, step, st, cwd, port, signal),
    );
    st = { ...st, ...opened };
    writeEvaluation(d.db, step.id, st);
    d.bus.publish({
      type: "task.review-opened",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId: step.id, kind: st.kind, round, reviewId: st.reviewId, url: st.url },
    });
  } else if (st.port && !runningApp(step.id)) {
    // Oraknid restarted while the review was open: the app runs again on its port.
    const run = detectRun(cwd, st.run);
    if (run)
      await startApp({
        stepTaskId: step.id,
        cwd,
        run,
        port: st.port,
        plan: planFor(d, job),
        waitMs: d.appWaitMs ?? 90_000,
        signal: ctx.signal,
      }).catch(() => null);
  }
  const reviewId = st.reviewId as string;
  let outcome: ReviewOutcome | null = port.outcome(reviewId);
  let auto = false;
  if (!outcome && st.passAt !== null && d.now() >= st.passAt) {
    outcome = { kind: "approved" };
    auto = true;
  }
  if (!outcome)
    return {
      kind: "waiting",
      taskId: step.id,
      reviewId,
      reason: waitingWords(st.kind, st.url),
      passAt: st.passAt,
    };
  const round = st.round;
  if (outcome.kind === "approved") {
    await ctx.step(`evaluation:${step.id}:${round}:approved`, { round, auto }, async () => {
      stopApp(step.id);
      writeEvaluation(d.db, step.id, {
        ...st,
        port: null,
        outcome: auto ? "auto-passed" : "approved",
      });
      d.silk.add({
        jobId: job.id,
        taskId: step.id,
        kind: "progress",
        title: auto ? `Passed by itself: ${step.title}` : `Approved: ${step.title}`,
        body: auto
          ? `No word from the owner on ${what(st.kind)} in the time the project allows: it passed by itself (round ${round}).`
          : `The owner approved ${what(st.kind)} (round ${round}). The work after it goes on.`,
        authoredBy: auto ? "eye" : "owner",
      });
      setState(d, job.id, step.id, "done", auto ? "Passed by itself." : "Approved by me.");
      return null;
    });
    return { kind: "settled" };
  }
  const notes = outcome.notes;
  await ctx.step(
    `evaluation:${step.id}:${round}:notes`,
    { round, notes: notes.length },
    async () => {
      stopApp(step.id);
      const added = await notesToWork(d, job, step, st, notes);
      writeEvaluation(d.db, step.id, {
        ...st,
        round: round + 1,
        reviewId: null,
        url: null,
        port: null,
        openedAt: null,
        passAt: null,
      });
      setState(
        d,
        job.id,
        step.id,
        "pending",
        added
          ? `My notes came back as ${added === 1 ? "a task" : `${added} tasks`}; round ${round + 1} opens after ${added === 1 ? "it" : "them"}.`
          : `Round ${round + 1} opens now.`,
      );
      return added;
    },
  );
  return { kind: "settled" };
}

const planFor = (d: EvaluationDeps, job: JobRow) => {
  const leg = d.registry.all()[0];
  return job.unsandboxed || !leg
    ? null
    : sandboxPlan(leg, d.sandbox, d.legsDir, projectPorts(d.db, job.projectId), job.id);
};

/** A round's review opened: the design's folder made sure of, or the app started on a free port. */
async function openRound(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  cwd: string,
  port: ReviewPort,
  signal: AbortSignal,
): Promise<Pick<EvaluationState, "reviewId" | "url" | "port" | "openedAt" | "passAt">> {
  const rows = taskRows(d.db, job.id);
  let target: ReviewTarget;
  let appPort: number | null = null;
  let note = "";
  const design = join(cwd, designFolder(rows, step));
  if (st.kind === "design") {
    mkdirSync(design, { recursive: true });
    target = { kind: "folder", path: design };
  } else {
    const run = detectRun(cwd, st.run);
    if (run) {
      try {
        const p = await freePort();
        await startApp({
          stepTaskId: step.id,
          cwd,
          run,
          port: p,
          plan: planFor(d, job),
          waitMs: d.appWaitMs ?? 90_000,
          signal,
        });
        appPort = p;
        target = { kind: "port", port: p };
      } catch (error) {
        if (signal.aborted) throw error;
        note = `The app didn't start (${run.from}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}); the review shows the job's folder.`;
        target = { kind: "folder", path: cwd };
      }
    } else {
      note =
        st.kind === "app"
          ? "Nothing says how the app runs (no dev script, no README command): the review shows the job's folder."
          : "";
      target = { kind: "folder", path: cwd };
    }
  }
  if (note)
    d.silk.add({
      jobId: job.id,
      taskId: step.id,
      kind: "issue",
      title: `Review of ${what(st.kind)}: not running`,
      body: note,
      authoredBy: "eye",
    });
  const opened = await port.open({
    jobId: job.id,
    stepTaskId: step.id,
    projectId: job.projectId,
    kind: target.kind === "port" ? "app" : "design",
    target,
    round: st.round,
    title: `${step.title}: ${st.why}`,
  });
  const minutes = projectWork(d.db, job.projectId).autoPassMinutes;
  const at = d.now();
  return {
    reviewId: opened.reviewId,
    url: opened.url,
    port: appPort,
    openedAt: at,
    passAt: minutes ? at + Math.round(minutes * 60_000) : null,
  };
}

/** Tasks after a task, through the graph: what must never come before it. */
function after(rows: Row[], id: string): Set<string> {
  const out = new Set<string>();
  const visit = (x: string) => {
    for (const r of rows)
      if (r.dependsOn.includes(x) && !out.has(r.id)) {
        out.add(r.id);
        visit(r.id);
      }
  };
  visit(id);
  return out;
}

const noteLine = (n: ReviewNote) =>
  `- **${n.kind}**: ${n.text}${n.element ? ` (on ${n.element})` : ""}${n.device ? ` [${n.device}]` : ""}`;

/**
 * My notes as work (ADR-064 §2): keep-notes kept in Silk as decisions,
 * given to every later task; the rest planned as tasks that come before
 * the step's next round (The Eye's planning call when it has one, else one
 * task with the notes). Returns how many tasks were added.
 */
async function notesToWork(
  d: EvaluationDeps,
  job: JobRow,
  step: Row,
  st: EvaluationState,
  notes: ReviewNote[],
): Promise<number> {
  const round = st.round;
  for (const n of notes.filter((x) => x.kind === "keep"))
    d.silk.add({
      jobId: job.id,
      taskId: step.id,
      kind: "decision",
      title: `Keep: ${n.text.slice(0, 100)}`,
      body: `From my review of ${what(st.kind)} (round ${round})${n.element ? `, on ${n.element}` : ""}${n.device ? ` [${n.device}]` : ""}: keep this as it is, whatever else changes. ${n.text}`,
      authoredBy: "owner",
    });
  const work = notes.filter((x) => x.kind !== "keep");
  if (!work.length) return 0;
  const rows = taskRows(d.db, job.id);
  const later = after(rows, step.id);
  const reviewed = rows.filter((r) => step.dependsOn.includes(r.id) && !isEvaluation(r));
  const text = `My notes on ${what(st.kind)}, round ${round}:\n${work.map(noteLine).join("\n")}`;
  let plan: WebPlan;
  const live = rows.filter((t) => t.state !== "skipped" && t.id !== step.id && !later.has(t.id));
  if (d.brain.extend) {
    try {
      plan = await d.brain.extend({
        jobId: job.id,
        cwd: job.worktree ?? process.cwd(),
        goal: job.goal,
        skill: "",
        silk: d.silk
          .current(job.id)
          .filter((e) => e.kind === "decision" || e.kind === "architecture")
          .slice(-30)
          .map((e) => `## ${e.title}\n${e.body.slice(0, 600)}`)
          .join("\n\n"),
        digest: "",
        verify: job.verify,
        request: `${text}\n\nPlan the work these notes ask for, on ${what(st.kind)}: it is done before the owner looks again. Never undo what a "Keep:" decision keeps.`,
        tasks: live.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          state: t.state,
          dependsOn: t.dependsOn,
        })),
        suggested: "",
      });
    } catch (error) {
      if (error instanceof BrainStopped) throw error;
      plan = notesTask(job, reviewed, st, text);
    }
  } else plan = notesTask(job, reviewed, st, text);
  // Before the next round: never after the step, nor after what waits for it.
  plan = {
    ...plan,
    tasks: plan.tasks
      .filter((t) => !isEvaluation(t))
      .map((t) => ({
        ...t,
        dependsOn: t.dependsOn.filter((x) => x !== step.id && !later.has(x)),
      })),
  };
  if (!plan.tasks.length) plan = notesTask(job, reviewed, st, text);
  const stored = storeWeb(d, job.id, plan, {
    keyPrefix: `rv-${step.id.slice(-6).toLowerCase()}-${round}-`,
    title: `Plan, version ${job.webVersion + 1}: my notes on ${what(st.kind)} (round ${round})`,
    evaluations: false,
  });
  const before = [...new Set([...stored.added, ...stored.knownIds])];
  for (const id of before)
    if (id !== step.id && !later.has(id))
      d.db.insert(taskEdges).values({ taskId: step.id, dependsOn: id }).onConflictDoNothing().run();
  return stored.added.length;
}

/** The notes as one task on what the step reviewed, when no planning call is at hand. */
function notesTask(job: JobRow, reviewed: Row[], st: EvaluationState, text: string): WebPlan {
  const scope = [...new Set(reviewed.flatMap((r) => r.scope))];
  const verify = [...new Set([...reviewed.flatMap((r) => r.verify), ...job.verify])];
  return {
    summary: `The owner's notes on ${what(st.kind)} (round ${st.round}), as work.`,
    tasks: [
      {
        key: "notes",
        title: `Apply my notes on ${what(st.kind)} (round ${st.round})`,
        instructions: `${text}\n\nDo what each note asks; keep everything a "Keep:" decision keeps. Done when every note is addressed and the checks pass.`,
        kind: "implement",
        dependsOn: [],
        scope: scope.length ? scope : st.kind === "design" ? ["design/**"] : ["**"],
        verify: verify.length ? verify : [st.kind === "design" ? "test -d design" : "true"],
        requiredCapabilities: st.kind === "design" ? ["ui"] : ["implementation", "ui"],
        difficulty: "medium",
      },
    ],
    jobVerify: [],
  };
}

// ── The chat edits the plan: "add a review after X", "skip reviews" ──

type ReviewEdit = EvaluationEdit;

const SKIP =
  /\b(?:skip|without|no|drop|remove|turn off)\b(?:\s+\w+){0,3}\s+(?:reviews?|evaluations?|evaluation steps?)\b|\breviews?\s+off\b/i;
const ADD =
  /\badd (?:an? |one )?(design |app |final |checkpoint )?(?:review|evaluation(?: step)?|checkpoint) (?:step )?(?:after|once|when) (?:the |my )?(.+?)\s*(?:is done|is built)?\s*[.!?]?$/i;

/** My words as an edit of the plan's reviews, when they plainly are one; null otherwise. */
export function reviewEditOf(text: string): ReviewEdit | null {
  const t = text.trim();
  const m = t.match(ADD);
  if (m?.[2]) {
    const k = m[1]?.trim().toLowerCase();
    const kind = k === "design" ? "design" : k === "app" || k === "final" ? "app" : "checkpoint";
    return { skip: false, add: [{ after: m[2], kind, why: null }] };
  }
  if (SKIP.test(t)) return { skip: true, add: [] };
  return null;
}

/** The job's task my words name: by its id, else the title most like them. */
function taskNamed(rows: Row[], words: string): Row | null {
  const byId = rows.find((r) => r.id === words.trim());
  if (byId) return byId;
  const want = meaningWords(words);
  if (!want.size) return null;
  let best: { r: Row; score: number } | null = null;
  for (const r of rows.filter((x) => !isEvaluation(x))) {
    const have = meaningWords(r.title);
    const hit = [...want].filter((w) => have.has(w) || [...have].some((h) => h.startsWith(w)));
    const score =
      hit.length / want.size + (r.title.toLowerCase().includes(words.toLowerCase().trim()) ? 1 : 0);
    if (!best || score > best.score) best = { r, score };
  }
  return best && best.score >= 0.5 ? best.r : null;
}

/**
 * Applies my edit to the job's evaluation steps: "skip reviews" skips
 * every one not done (and the job plans none again); "add a review after
 * X" puts one after that task, the tasks after X waiting for it. Returns
 * what was done, in words, and whether a waiting job may go on.
 */
export function editReviews(
  d: Pick<EvaluationDeps, "db" | "bus" | "silk" | "now">,
  jobId: string,
  edit: ReviewEdit,
): { did: string[]; reply: string; unblocks: boolean } {
  const did: string[] = [];
  const said: string[] = [];
  let unblocks = false;
  if (edit.skip) {
    const open = taskRows(d.db, jobId).filter(
      (t) => isEvaluation(t) && t.state !== "done" && t.state !== "skipped",
    );
    for (const t of open) {
      stopApp(t.id);
      const s = readEvaluation(d.db, t.id);
      if (s) writeEvaluation(d.db, t.id, { ...s, port: null, outcome: "skipped" });
      setState(d as EvaluationDeps, jobId, t.id, "skipped", "Skipped: I said to skip reviews.");
    }
    writeSetting(d.db, jobEvaluationsKey(jobId), Evaluations.nullable(), {
      mode: "none",
      kinds: [],
    });
    did.push(
      open.length
        ? `Skipped ${open.length === 1 ? "a review" : `${open.length} reviews`}`
        : "No reviews in this job",
    );
    said.push(
      open.length
        ? `I skipped ${open.map((t) => `“${t.title}”`).join(", ")}; the work goes on without waiting for you.`
        : "This job plans no reviews from now on.",
    );
    unblocks = open.length > 0;
  }
  for (const a of edit.add) {
    const rows = taskRows(d.db, jobId);
    const target = taskNamed(rows, a.after);
    if (!target) {
      said.push(`I couldn't tell which task “${a.after}” is, so I added no review.`);
      continue;
    }
    const w = EVALUATION_WORDS[a.kind];
    const planned = evaluationTask(
      "review",
      { kind: a.kind, why: a.why ?? `I asked for a look after “${target.title}”.` },
      [target.id],
    );
    const stored = storeWeb(
      d,
      jobId,
      {
        summary: `A review after “${target.title}”, as I asked.`,
        tasks: [{ ...planned, title: `${w.title} after “${target.title.slice(0, 60)}”` }],
        jobVerify: [],
      },
      {
        keyPrefix: `ask-${target.id.slice(-6).toLowerCase()}-${a.kind}-`,
        evaluations: false,
      },
    );
    const id = stored.added[0];
    if (!id) {
      said.push(`There is a review after “${target.title}” already.`);
      continue;
    }
    // What came after the task now waits for the review too.
    for (const r of rows)
      if (
        r.id !== id &&
        r.dependsOn.includes(target.id) &&
        r.state !== "done" &&
        r.state !== "skipped"
      )
        d.db.insert(taskEdges).values({ taskId: r.id, dependsOn: id }).onConflictDoNothing().run();
    // Reviews are back on for this job when I ask for one.
    const own = jobEvaluationsOwn(d.db, jobId);
    if (own?.mode === "none" || (own?.mode === "some" && !own.kinds.includes(a.kind)))
      writeSetting(d.db, jobEvaluationsKey(jobId), Evaluations.nullable(), {
        mode: "some",
        kinds: [...new Set([...(own.mode === "some" ? own.kinds : []), a.kind])],
      });
    did.push("Added a review");
    said.push(
      `I added “${w.title}” after “${target.title}”; what comes after it waits for your approval.`,
    );
  }
  return { did, reply: said.join(" "), unblocks };
}

/** A job that ended (cancelled, say) stops the apps its reviews ran. */
export function stopJobApps(db: Db, jobId: string) {
  for (const t of db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.kind, "evaluation")))
    .all())
    stopApp(t.id);
}

/** Evaluation steps of a job that wait for me now, with when each passes by itself. */
export function waitingReviews(db: Db, jobId: string) {
  return db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(and(eq(tasks.jobId, jobId), eq(tasks.kind, "evaluation")))
    .all()
    .filter((t) => t.state !== "done" && t.state !== "skipped")
    .map((t) => ({ id: t.id, s: readEvaluation(db, t.id) }))
    .filter((x) => x.s?.reviewId && !x.s.outcome);
}
