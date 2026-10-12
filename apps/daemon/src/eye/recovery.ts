import { spawnSync } from "node:child_process";
import { desc, eq, max } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, tasks } from "../db/schema.ts";
import { AwaitingOwner, EffectDenied } from "../engine/effects.ts";
import { NonDeterministicStep } from "../engine/journal.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { AttemptLog } from "../harness/log.ts";
import type { AttemptOutcome } from "../harness/types.ts";
import { newId } from "../ids.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import { BrainStopped } from "./brain.ts";

// Self-recovery (ADR-067 §3): before a job blocks for anything that isn't
// mine to decide, an agent session in the job's own tree is given the
// exact failure and asked to make the work able to go on without losing
// any of it; Oraknid then does again what failed. Twice at most, the
// second told what the first found; only then the job blocks, saying in
// plain words what is wrong, what was tried, and the one thing I must do.

/** The job waits for me: tasks I took over (Jobs-and-Projects → Controls). Mine, never recovered. */
export class OwnerHolds extends Error {}

/** No Leg can take the work now (quota, paused, none fits): it waits for one, never recovered. */
export class WaitsForLegs extends Error {}

/** A recovery that couldn't fix it, twice: the job blocks with its diagnosis. */
export class RecoveryFailed extends Error {}

/** No model can think for The Eye: a recovery couldn't think either. */
const NO_LEG = /^No Leg can (think|take)|There are no Legs|no Legs\b/i;

/**
 * Whether a failure is mine to decide (ADR-067 §3): approvals, questions,
 * my decisions, what I took over, a stop, and quota with no model free;
 * a recovery that already failed; a journal that no longer matches. All
 * else is recovered before the job blocks.
 */
export function ownersToDecide(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return (
    error instanceof AwaitingOwner ||
    error instanceof EffectDenied ||
    error instanceof BrainStopped ||
    error instanceof OwnerHolds ||
    error instanceof WaitsForLegs ||
    error instanceof RecoveryFailed ||
    error instanceof NonDeterministicStep ||
    (error instanceof Error && error.message.startsWith("stop: ")) ||
    (error instanceof Error && NO_LEG.test(error.message))
  );
}

/** What failed: the step, its error in full, the task it was about. */
export interface Failure {
  /** In words: "merging “Build the parser” into the job's branch", "the job's next step". */
  step: string;
  error: string;
  taskId?: string | null;
}

export interface RecoveryDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  now: () => number;
}

export interface RecoveryResult {
  ok: boolean;
  /** What was found and done, in words, attempt by attempt. */
  findings: string[];
  /** When it couldn't: the one thing the owner must decide or do. */
  forOwner: string | null;
}

/** A recovery task's title starts so; it is never a task of the plan. */
export const RECOVERY_TITLE = "Recover: ";

/** The facts a recovery is given (ADR-067 §3): the tree's state and the last of the work's log. */
export function recoveryFacts(db: Db, cwd: string, failure: Failure): string {
  const run = (args: string[]) => {
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = (r.stdout || r.stderr || "").trim();
    return out.length > 2500 ? `${out.slice(0, 2500)}\n… (cut)` : out || "(nothing)";
  };
  const log = new AttemptLog(db);
  const taskId =
    failure.taskId ??
    db
      .select({ t: attempts.taskId })
      .from(attempts)
      .innerJoin(tasks, eq(tasks.id, attempts.taskId))
      .orderBy(desc(attempts.startedAt))
      .get()?.t ??
    null;
  const events = taskId
    ? log
        .task(taskId, {
          kinds: ["AgentText", "ChecksRan", "Outcome", "Signal", "CommitFiltered"],
          limit: 8,
        })
        .map((e) => `- ${e.kind}: ${JSON.stringify(e.data).slice(0, 400)}`)
        .join("\n")
    : "";
  return [
    `# git status (the job's folder)\n${run(["status", "--short", "--branch"])}`,
    `# The last commits\n${run(["log", "--oneline", "-8"])}`,
    events ? `# The last events of the work that failed\n${events}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The recovery agent's instructions: the failure, the facts, what was tried, my words. */
export function recoveryPrompt(i: {
  failure: Failure;
  facts: string;
  tried: string[];
  owner?: string | null;
  /** More of the failure: both sides of a merge, the tasks' goals. */
  context?: string;
}): string {
  return `Oraknid's work on this job stopped, and it isn't something the owner must decide. Make it possible for the work to continue without losing any work: diagnose why it failed, fix the cause (the environment, the repository's state, its configuration, the tooling), then check that what failed would now work, as far as you can from here. Oraknid does the failed step again after you.

# What failed
${i.failure.step}

The error, as it was said:
${JSON.stringify(i.failure.error.slice(0, 3000))}

${i.facts}${i.context ? `\n\n${i.context}` : ""}
${
  i.tried.length
    ? `\n# Tried before, and it wasn't enough\n${i.tried.map((t, n) => `${n + 1}. ${t}`).join("\n")}\nTry another approach.\n`
    : ""
}${i.owner ? `\n# The owner said, as a JSON string\n${JSON.stringify(i.owner.slice(0, 1500))}\n` : ""}
# Rules
- Never lose work: what isn't generated stays, committed or not; move a file aside rather than delete it.
- Files the project's tools make (installed dependencies, build output, caches) aren't work: untrack them (\`git rm -r --cached <folder>\`, the files stay on disk), add them to .gitignore, or restore them (\`git checkout -- <path>\`).
- A merge in progress (conflict markers in files): resolve each file so it does what both sides meant, never by dropping one side's work; remove every conflict marker and \`git add\` the file. A lockfile in conflict is never merged by hand: take either side, then let its package manager write it again (\`pnpm install --lockfile-only\`, \`npm install --package-lock-only\`, \`yarn install --mode update-lockfile\`, \`cargo generate-lockfile\`, \`uv lock\`, \`poetry lock --no-update\`, \`bundle lock\`, \`go mod tidy\`) and \`git add\` it. Oraknid commits the merge and runs the task's checks after you: only a merge whose checks pass is kept.
- Don't switch branches, start or abort a merge, rebase, push or reset the branch: Oraknid does those.
- Say plainly what was wrong and what you changed. If you couldn't fix it, end with one line "FOR THE OWNER: " and the one thing the owner must decide or do.`;
}

/**
 * Runs up to two recoveries of a failure (ADR-067 §3): each a task in the
 * job's tree run like any attempt (routing to the strongest model allowed,
 * the Gate, the attempt log), then `retry` does again what failed (null:
 * it worked; else what failed now). Each is a step of the job, so a pause
 * or a restart neither loses nor repeats one.
 */
export async function recover(
  d: RecoveryDeps,
  ctx: JobContext,
  o: {
    jobId: string;
    cwd: string;
    failure: Failure;
    owner?: string | null;
    /** One attempt at the recovery task: Oraknid's own attempt runner. */
    attempt: (taskId: string) => Promise<AttemptOutcome>;
    /** Does again what failed (given the recovery task, whose report it may read); null: it works now. */
    retry: (recoveryTaskId: string) => Promise<string | null>;
    tries?: number;
    /** What earlier recoveries of this job found: the next is told, to try another way. */
    tried?: string[];
    /** Sets the scene before each try (a merge started, its conflicts left for the agent). */
    prepare?: () => Promise<void>;
    /** More of the failure for the agent, read before each try. */
    context?: () => string;
  },
): Promise<RecoveryResult> {
  const findings: string[] = [];
  let forOwner: string | null = null;
  let failure = o.failure;
  const tries = o.tries ?? 2;
  for (let n = 1; n <= tries; n++) {
    // A key of its own each time: the same failure again after a resume is recovered again.
    const seqKey = `eye.recoverySeq.${o.jobId}`;
    const seq = readSetting(d.db, seqKey, z.number(), 0) + 1;
    writeSetting(d.db, seqKey, z.number(), seq);
    const r = await ctx.step(`recover:${seq}`, { failure: failure.step, n }, async () => {
      const taskId = newId(d.now());
      const position =
        (d.db
          .select({ p: max(tasks.position) })
          .from(tasks)
          .where(eq(tasks.jobId, o.jobId))
          .get()?.p ?? 0) + 1;
      const title = `${RECOVERY_TITLE}${failure.step.replace(/^./, (c) => c.toUpperCase())}`.slice(
        0,
        200,
      );
      await o.prepare?.();
      const context = o.context?.();
      d.db
        .insert(tasks)
        .values({
          id: taskId,
          jobId: o.jobId,
          title,
          instructions: recoveryPrompt({
            failure,
            facts: recoveryFacts(d.db, o.cwd, failure),
            tried: [...(o.tried ?? []), ...findings],
            owner: o.owner ?? null,
            ...(context ? { context } : {}),
          }),
          kind: "implement",
          scope: ["**"],
          verify: [],
          requiredCapabilities: ["debugging"],
          difficulty: "high",
          // The ladder: the second try goes a rung higher (ADR-052 §3).
          stepUp: n > 1 ? 2 : 0,
          state: "running",
          position,
          planKey: null,
        })
        .run();
      d.bus.publish({
        type: "job.recovery",
        topic: `job:${o.jobId}`,
        jobId: o.jobId,
        payload: { taskId, step: failure.step, error: failure.error.slice(0, 500), n },
      });
      let outcome: AttemptOutcome;
      try {
        outcome = await o.attempt(taskId);
      } catch (error) {
        if (
          ownersToDecide(error, ctx.signal) &&
          !(error instanceof Error && NO_LEG.test(error.message))
        )
          throw error;
        outcome = { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
      }
      const said =
        new AttemptLog(d.db).lastOf(taskId, "AgentText")?.data.text.trim() ??
        ("reason" in outcome ? outcome.reason : "");
      const owner = /FOR THE OWNER:\s*(.+)/.exec(said)?.[1]?.trim() ?? null;
      const report = said.replace(/FOR THE OWNER:.*/s, "").trim();
      let again: string | null =
        outcome.kind === "done"
          ? null
          : `the recovery agent didn't finish (${"reason" in outcome ? outcome.reason : outcome.kind})`;
      // Done or not, what failed is tried again: the agent may have fixed it and stumbled after.
      try {
        again = await o.retry(taskId);
      } catch (error) {
        if (ownersToDecide(error, ctx.signal)) throw error;
        again = error instanceof Error ? error.message : String(error);
      }
      d.db
        .update(tasks)
        .set({ state: again ? "skipped" : "done", leaseUntil: null })
        .where(eq(tasks.id, taskId))
        .run();
      d.bus.publish({
        type: "task.state",
        topic: `job:${o.jobId}`,
        jobId: o.jobId,
        payload: {
          taskId,
          to: again ? "skipped" : "done",
          reason: again ? `Recovery ${n} didn't fix it: ${again.slice(0, 300)}` : "It works again.",
        },
      });
      const finding = `${brief(report) || "the agent said nothing"}${again ? `; ${failure.step} still failed: ${brief(again)}` : ""}`;
      d.silk.add({
        jobId: o.jobId,
        taskId,
        kind: again ? "issue" : "progress",
        title: again ? `Recovery ${n} didn't fix it` : "Recovered",
        body: `What failed: ${failure.step}: ${brief(failure.error, 600)}\n\nWhat the recovery found and did: ${brief(report, 1500) || "nothing said"}${
          again
            ? `\n\nDone again, it still failed: ${brief(again, 600)}`
            : "\n\nDone again, it worked: the job goes on."
        }`,
        authoredBy: "eye",
      });
      return { ok: !again, finding, owner, again };
    });
    findings.push(r.finding);
    if (r.owner) forOwner = r.owner;
    if (r.ok) return { ok: true, findings, forOwner: null };
    failure = { ...failure, error: r.again ?? failure.error };
  }
  return { ok: false, findings, forOwner };
}

const brief = (s: string, n = 300) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/**
 * The block after recoveries that couldn't fix it (ADR-067 §3): what is
 * wrong in plain words, what was tried, and the one thing I must do;
 * never a counter.
 */
export function blockedAfterRecovery(failure: Failure, r: RecoveryResult): string {
  const tried = r.findings.map((f, i) => `${i === 0 ? "first" : "then"}, ${f}`).join("; ");
  const ask =
    r.forOwner ??
    "Tell me here what should change, or fix it yourself and say “fix it” or resume the job.";
  return `${failure.step.replace(/^./, (c) => c.toUpperCase())} failed: ${brief(failure.error, 500)}. I tried to fix it ${r.findings.length === 1 ? "once" : `${r.findings.length} times`} and couldn't: ${tried}. ${ask}`;
}
