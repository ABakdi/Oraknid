import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Confirmation,
  type Confirming,
  condensed,
  conventionsSaid,
  type DriftJudgeInput,
  driftJudgePrompt,
  ecosystemsOf,
  learnable,
  outsideScope,
  readDriftAnswer,
  type Signal,
  signalKey,
  suspicionQuestion,
} from "@oraknid/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { jobs } from "../db/schema.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { AttemptCtx, AttemptState, Turn } from "./facts.ts";

// Monitors suspect, a model confirms (ADR-056): the attempt's side of it.
// The fast path's facts (the project's ecosystems from its marker files,
// what its ignore rules ignore, the by-products learned for it), the drift
// judge asked when the decision says so (`Confirm`: stage 1 on the quick
// model, stage 2 on the strongest on drift or unsure, cached per task, a
// judge too slow or failing is "unjudged"), the agent asked once when the
// judge is unsure and its answer heard. Nothing here is said to me: the
// attempt log, and a line in the job's activity.

/** What the judge said in this attempt, and what the agent was asked. */
export interface ConfirmState {
  judged: Map<string, Confirmation>;
  /** By code: the question asked, of which suspicion, and the agent's answer once heard. */
  asked: Map<string, { key: string; question: string; answer: string | null }>;
}

export const confirmState = (st: AttemptState): ConfirmState => {
  st.confirm ??= { judged: new Map(), asked: new Map() };
  return st.confirm;
};

/** How long the judge may take, both stages together: past it, unjudged (ADR-056). */
export const DRIFT_JUDGE_MS = 30_000;

// ── The fast path ───────────────────────────────────────────────────

/** A project's by-products learned from the judge's verdicts (globs), kept as a setting. */
export const byProductsKey = (projectId: string) => `project.byProducts.${projectId}`;
const Learned = z.array(z.object({ pattern: z.string(), reason: z.string(), at: z.number() }));

export function learnedByProducts(db: AttemptCtx["d"]["db"], projectId: string | null): string[] {
  if (!projectId) return [];
  return readSetting(db, byProductsKey(projectId), Learned, []).map((l) => l.pattern);
}

const projectOf = (x: AttemptCtx): string | null =>
  x.d.db.select({ projectId: jobs.projectId }).from(jobs).where(eq(jobs.id, x.job.id)).get()
    ?.projectId ?? null;

/** Folders never looked in for marker files: what tools write, and version control. */
const SKIP = /^(?:\.|node_modules$|vendor$|target$|dist$|build$|out$|bin$|obj$|_build$|deps$)/;

/** The project's files at its top and two folders down: where its marker files are. */
function topFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length > 3000) return;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (depth < 2 && !SKIP.test(e.name)) walk(join(dir, e.name), path, depth + 1);
      } else out.push(path);
    }
  };
  walk(cwd, "", 0);
  return out;
}

/** The paths the project's own ignore rules ignore; none when that can't be told. */
function ignoredBy(cwd: string, paths: string[]): string[] {
  const r = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd,
    input: paths.join("\n"),
    encoding: "utf8",
    timeout: 10_000,
  });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter(Boolean);
}

/**
 * The fast path's facts for what changed (ADR-056 → Monitors suspect, 1):
 * the project's ecosystems (its marker files and what changed), the
 * by-products learned for it, and what its ignore rules ignore among what
 * would be suspected. The monitors read them; no model is asked.
 */
export function knowConventions(x: AttemptCtx, changed: string[]) {
  const o = x.st.observed;
  o.ecosystems = ecosystemsOf([...topFiles(x.ws.cwd), ...changed]);
  o.learned = learnedByProducts(x.d.db, projectOf(x));
  const left = outsideScope(changed, { ...o, ignored: [] });
  o.ignored = left.length ? ignoredBy(x.ws.cwd, left) : [];
}

function learn(x: AttemptCtx, patterns: string[], reason: string) {
  const projectId = projectOf(x);
  if (!projectId || !patterns.length) return;
  const key = byProductsKey(projectId);
  const known = readSetting(x.d.db, key, Learned, []);
  const fresh = patterns.filter((p) => !known.some((k) => k.pattern === p));
  if (!fresh.length) return;
  const now = x.d.now();
  writeSetting(
    x.d.db,
    key,
    Learned,
    [
      ...known,
      ...fresh.map((pattern) => ({ pattern, reason: reason.slice(0, 200), at: now })),
    ].slice(-200),
    now,
  );
  const o = x.st.observed;
  o.learned = [...new Set([...(o.learned ?? []), ...fresh])];
}

// ── The judge ───────────────────────────────────────────────────────

/** Verdicts by task and suspicion (and the agent's answer), across the task's attempts. */
const verdicts = new Map<string, Confirmation>();
const CACHE = 2000;

/** A task settled: its drift verdicts go. */
export function forgetDriftVerdicts(jobId: string, taskId: string) {
  const prefix = `${jobId}:${taskId}\0`;
  for (const k of verdicts.keys()) if (k.startsWith(prefix)) verdicts.delete(k);
}

/** The decision's view: null with no judge (the monitors act as before). */
export function confirming(x: AttemptCtx, t: Turn): Confirming | null {
  if (!x.d.brain?.judgeDrift) return null;
  const cs = confirmState(x.st);
  // The agent was asked: its words at this turn's end are its answer, and the judge looks again.
  if (t.end)
    for (const [code, a] of cs.asked) {
      if (a.answer !== null) continue;
      a.answer = t.text;
      cs.judged.delete(a.key);
      x.trail.append("SuspicionAnswered", { key: a.key, code, answer: t.text.slice(0, 2000) });
    }
  return { judged: Object.fromEntries(cs.judged), asked: [...cs.asked.keys()] };
}

/** The agent is asked about a suspicion, once, in its session. */
export function askAgent(x: AttemptCtx, c: { key: string; code: string }, question: string) {
  confirmState(x.st).asked.set(c.code, { key: c.key, question, answer: null });
  x.trail.append("SuspicionAsked", { key: c.key, code: c.code, question });
}

/** The suspicions the decision needs confirmed, judged (ADR-056 → Monitors suspect, 3). */
export async function confirm(x: AttemptCtx, t: Turn, signals: Signal[]) {
  const cs = confirmState(x.st);
  for (const s of signals) {
    const key = signalKey(s);
    if (cs.judged.has(key)) continue;
    const a = cs.asked.get(s.code);
    const asked = a?.answer != null ? { question: a.question, answer: a.answer } : null;
    const cacheKey = `${x.job.id}:${x.task.id}\0${key}\0${asked?.answer ?? ""}`;
    const hit = verdicts.get(cacheKey);
    const judged = hit
      ? { c: hit, stage: null, learned: [] as string[] }
      : await judge(x, t, s, asked);
    if (!hit && judged.c.verdict !== "unjudged") {
      if (verdicts.size >= CACHE) verdicts.delete(verdicts.keys().next().value as string);
      verdicts.set(cacheKey, judged.c);
    }
    cs.judged.set(key, judged.c);
    x.trail.append("Judged", {
      key,
      code: s.code,
      evidence: s.evidence,
      verdict: judged.c.verdict,
      reason: judged.c.reason,
      stage: judged.stage,
      cached: !!hit,
      learned: judged.learned,
    });
    // The job's activity only: a suspicion is no problem of mine (no chat, inbox or notification).
    x.event("task.suspicion", {
      code: s.code,
      evidence: s.evidence,
      verdict: judged.c.verdict,
      reason: judged.c.reason,
    });
  }
}

class Timeout extends Error {}

async function within<T>(ms: number, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Timeout()), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One suspicion before the judge: stage 1, then stage 2 on drift or unsure. */
async function judge(
  x: AttemptCtx,
  t: Turn,
  s: Signal,
  asked: { question: string; answer: string } | null,
): Promise<{ c: Confirmation; stage: 1 | 2 | null; learned: string[] }> {
  const brain = x.d.brain;
  const o = x.st.observed;
  const scope = x.scope();
  const paths = s.kind === "drift" ? (s.paths ?? []) : [];
  const last =
    t.text || (x.log.attempt(x.attemptId, { kinds: ["AgentText"], limit: 1 })[0]?.data.text ?? "");
  const input: DriftJudgeInput = {
    goal: x.job.goal,
    task: {
      title: x.task.title,
      instructions: x.task.instructions,
      kind: x.task.kind,
      scope,
    },
    suspicion: { kind: s.kind, code: s.code, evidence: s.evidence, paths },
    commands: condensed(o.commands.map((c) => c.command)),
    lastMessage: last,
    conventions: conventionsSaid(o.ecosystems ?? []),
    learned: o.learned ?? [],
    asked,
  };
  const ask = async (stage: 1 | 2) =>
    readDriftAnswer(
      await brain?.judgeDrift?.({
        jobId: x.job.id,
        cwd: x.ws.cwd,
        stage,
        prompt: driftJudgePrompt(input, stage),
      }),
    );
  const ms = x.d.driftJudgeMs ?? DRIFT_JUDGE_MS;
  try {
    const { answer, stage } = await within(ms, async () => {
      const first = await ask(1);
      if (first.verdict === "expected") return { answer: first, stage: 1 as const };
      return { answer: await ask(2), stage: 2 as const };
    });
    // What tools wrote by themselves is learned for the project, whatever the verdict.
    const learned = learnable(answer.byProducts ?? [], paths);
    learn(x, learned, answer.reason);
    const c: Confirmation =
      answer.verdict === "unsure"
        ? { verdict: "unsure", reason: answer.reason, question: suspicionQuestion(s, scope) }
        : { verdict: answer.verdict, reason: answer.reason };
    return { c, stage, learned };
  } catch (error) {
    const reason =
      error instanceof Timeout
        ? `the judge did not answer within ${Math.round(ms / 1000)} s`
        : `the judge could not answer (${error instanceof Error ? error.message : String(error)})`;
    return { c: { verdict: "unjudged", reason: reason.slice(0, 300) }, stage: null, learned: [] };
  }
}
