import { createHash } from "node:crypto";
import type { Autonomy, Budget, Difficulty, TaskKind } from "@oraknid/contracts";
import {
  allowRuleFor,
  buildContextPack,
  claimsDone,
  correctivePrompt,
  DEFAULT_THRESHOLDS,
  type Drift,
  type DriftCode,
  decide,
  detect,
  type GatedAction,
  HANDOFF_REQUEST,
  inScope,
  nextEscalation,
  type Observed,
  type PolicyVerdict,
  type RouteCandidate,
  record,
  route,
  skillExcerpt,
} from "@oraknid/core";
import type {
  LegEvent,
  PermissionDecision,
  PermissionRequest,
  UsageSnapshot,
} from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import { attempts, jobs, sessions, tasks } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { InboxStore } from "../inbox/store.ts";
import { sandboxPlan } from "../legs/plan.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor, Supervised } from "../legs/supervisor.ts";
import { readSetting } from "../settings.ts";
import { handoffFromLog } from "../silk/handoff.ts";
import type { SilkStore } from "../silk/store.ts";
import {
  changedSince,
  checkpoint,
  commitAll,
  diffStatSince,
  type Git,
  restorePaths,
  rollback,
} from "../workspace/git.ts";
import { waitForAnswer } from "./approvals.ts";
import type { EyeBrain } from "./brain.ts";

/** The providers (Leg kinds) for which I allowed same-provider fallback (ADR-009). */
export const SAME_PROVIDER_FALLBACK = "fallback.sameProvider";

import { approveAllLikeThis, policyFor } from "./policy.ts";

/** The third answer to a Leg's permission request (Approvals → The inbox). */
export const ALL_LIKE_THIS = "Approve all like this for this job";

import { summarizeShortened } from "../silk/summarize.ts";
import { guidanceMark, takeGuidance } from "./talk.ts";
import { runVerify, verifyRefusal } from "./verify.ts";

export type TaskRow = typeof tasks.$inferSelect;

export interface AttemptDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  sandbox: Sandbox;
  legsDir: string;
  now: () => number;
  /** Auto approval (ADR-014); without one, a classify verdict asks me. */
  brain?: EyeBrain;
  /** Session rotation (BR-3): share of the context window. */
  rotateAt?: number;
  /** How often to look for a stall while waiting for a Leg. */
  stallCheckMs?: number;
  maxTurns?: number;
}

export interface AttemptJob {
  id: string;
  title: string;
  goal: string;
  autonomy: Autonomy;
  allowedLegIds: string[];
  moneyAllowed: boolean;
  waived: GatedAction[];
  unsandboxed: boolean;
  skillBody: string;
  /** The job's inputs, rendered for context packs. */
  inputs: string;
}

export type AttemptOutcome =
  | { kind: "done"; commit: string | null }
  | { kind: "retry"; reason: string }
  | { kind: "blocked"; reason: string; until: number | null }
  | { kind: "skipped" }
  | { kind: "owner-held" }
  | { kind: "cancel-job"; reason: string };

/** Ladder steps that end the attempt, and why. */
class EndAttempt extends Error {
  constructor(readonly outcome: AttemptOutcome) {
    super(outcome.kind);
  }
}

const SEVERITY: DriftCode[] = ["D8", "D7", "D1", "D4", "D3", "D2", "D6", "D5"];
const PREFIX: Record<TaskKind, string> = {
  plan: "docs",
  research: "docs",
  implement: "feat",
  test: "test",
  review: "refactor",
  mechanical: "chore",
  external: "chore",
};

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/**
 * One attempt at one task (The-Eye → The loop): route, checkpoint, run
 * the Leg from a context pack, apply the permission policy, verify the
 * work itself, self-prompt, watch for drift and climb the ladder, rotate
 * sessions, and on success commit and record progress in Silk.
 */
export async function runAttempt(
  d: AttemptDeps,
  job: AttemptJob,
  taskId: string,
  ws: { cwd: string; g: Git; tmpDir: string; trash: string },
  attemptNo: number,
  signal: AbortSignal,
): Promise<AttemptOutcome> {
  const task = d.db.select().from(tasks).where(eq(tasks.id, taskId)).get() as TaskRow;
  const now = d.now;

  // ── Route ───────────────────────────────────────────────────────
  // ADR-009: after a usage limit, another account of the same provider is not a fallback unless I allowed it.
  const sameProvider = new Set(readSetting(d.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []));
  // Entries are "kind:legId": the account that hit the limit may come back after its reset; others may not.
  const limited = task.limitedKinds
    .map((e) => e.split(":") as [string, string])
    .filter(([k]) => !sameProvider.has(k));
  const blockedKinds = new Set(limited.map(([k]) => k));
  const limitedLegs = new Set(limited.map(([, id]) => id));
  const all = candidatesFor(d.registry, job.allowedLegIds);
  const candidates = all.filter(
    (c) => !blockedKinds.has(d.registry.require(c.legId).kind) || limitedLegs.has(c.legId),
  );
  const heldBack = all.length - candidates.length;
  // Read now, so a budget I changed while the job runs applies to the next task.
  const quotaShare =
    (
      d.db.select({ budget: jobs.budget }).from(jobs).where(eq(jobs.id, job.id)).get()?.budget as
        | Budget
        | undefined
    )?.quotaShare ?? null;
  const estimatedTokens = 20_000 + Math.ceil(task.instructions.length / 4);
  const routed = route(
    {
      kind: task.kind as TaskKind,
      difficulty: task.difficulty as Difficulty,
      requiredCapabilities: task.requiredCapabilities as never,
      estimatedTokens,
      stepUp: task.stepUp,
      pinnedModelId: task.pinnedModelId,
      avoid: task.avoid,
    },
    candidates,
    { moneyAllowed: job.moneyAllowed, quotaShare },
  );
  const pick = routed.ranked[0];
  if (!pick) {
    // The earliest reset that frees a Leg: a used-up window, or one past this job's quota share.
    const share = quotaShare?.hard ? quotaShare.limit : null;
    const until = [
      ...d.registry.all().map((l) => l.limitedUntil),
      ...(share === null
        ? []
        : candidates.flatMap((c) =>
            c.windows.filter((w) => (w.utilization ?? 0) >= share).map((w) => w.resetsAt),
          )),
    ]
      .filter((t): t is number => !!t && t > now())
      .sort((a, b) => a - b)[0];
    const resets = until ? ` until ${new Date(until).toISOString()}` : "";
    return {
      kind: "blocked",
      reason: heldBack
        ? `"${task.title}" hit a usage limit on ${[...blockedKinds].join(", ")}; other accounts of the same provider are not used as fallback (ADR-009). It waits${resets}, for another provider, or for my setting.`
        : until
          ? `All allowed Legs are out of quota${resets}${routed.excluded.length ? `: ${routed.excluded.map((e) => e.why).join(" ")}` : "."}`
          : `No Leg can take "${task.title}": ${routed.excluded.map((e) => e.why).join(" ") || "there are no Legs."}`,
      until: until ?? null,
    };
  }
  const leg = pick.candidate;
  const routing = {
    leg: leg.legName,
    model: leg.model,
    effort: pick.effort,
    score: pick.score,
    reasons: pick.reasons,
    excluded: routed.excluded,
  };
  const attemptId = newId(now());
  d.bus.atomically(() => {
    d.db
      .update(tasks)
      .set({
        state: "running",
        assignedLegId: leg.legId,
        assignedModelId: leg.legModelId,
        effort: pick.effort,
        attemptCount: task.attemptCount + 1,
        routing,
      })
      .where(eq(tasks.id, taskId))
      .run();
    d.db
      .insert(attempts)
      .values({
        id: attemptId,
        taskId,
        jobId: job.id,
        legId: leg.legId,
        legModelId: leg.legModelId,
        effort: pick.effort,
        startedAt: now(),
        escalations: [],
      })
      .run();
    d.bus.publish({
      type: "task.state",
      topic: `job:${job.id}`,
      jobId: job.id,
      payload: { taskId, to: "running", routing },
    });
  });

  const ckpt = `refs/oraknid/${job.id}/${taskId}/${attemptNo}`;
  checkpoint(ws.g, ckpt, `oraknid: before ${task.title} (attempt ${attemptNo})`, ws.tmpDir);

  const escalations: string[] = [];
  const started = now();
  /** Tokens of the current session when progress was last made or a drift was acted on (D6 counts from here). */
  let tokensBaseline = 0;
  let sessionTokens = 0;
  /** Waiting for my answer is not a stall (Audit 1 → Q1-02). */
  let waitingOnOwner = 0;
  let level = task.escalation;
  // Only messages written after this attempt began: older ones are in Silk, in its context pack.
  let guidanceSeen = guidanceMark();
  // Typed by assertion: they change inside closures, which narrowing cannot follow.
  let session = null as Supervised | null;
  let sessionLog: string | null = null;
  const deniedGates = new Set<string>();
  /** Approvals this attempt asked for: withdrawn if it ends before I answer. */
  const asked: string[] = [];
  /** Commands waiting for their result, by tool call id. */
  const pending = new Map<string, string>();
  let usage = null as UsageSnapshot | null;

  const observed: Observed = {
    scope: task.scope,
    changedPaths: [],
    commands: [],
    verifyFailures: [],
    falseClaim: null,
    lastActivityAt: now(),
    tokensSinceProgress: 0,
    taskBudgetTokens: null,
    forbidden: [],
    gateBypass: [],
    local: leg.profile.costModel === "local",
  };

  const event = (type: string, payload: Record<string, unknown>) =>
    d.bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload: { taskId, ...payload } });

  const onPermission = async (r: PermissionRequest): Promise<PermissionDecision> => {
    const first = decide(r, policyFor(d.db, job.id, ws.cwd));
    const v =
      first.verdict === "classify"
        ? await classify(d, job.id, ws.cwd, task.title, r, first)
        : first;
    if (v.verdict === "allow") return { allow: true };
    if (v.verdict === "deny") {
      observed.forbidden.push(`tried \`${r.command ?? r.tool}\` (${v.reason})`);
      return { allow: false, message: `Not allowed: ${v.reason}.` };
    }
    // Asked once; trying the same refused action again is a gate bypass attempt (D8).
    const key = `${r.tool}:${r.command ?? r.path}`;
    if (deniedGates.has(key)) {
      observed.gateBypass.push(`tried \`${r.command ?? r.tool}\` again after I refused it`);
      return { allow: false, message: "I already refused that." };
    }
    const itemId = d.inbox.open({
      kind: "approval",
      jobId: job.id,
      taskId,
      raisedBy: { legId: leg.legId },
      title: `${leg.legName} wants to ${r.command ? `run \`${r.command.slice(0, 80)}\`` : `use ${r.tool}`}`,
      detail: `Task: ${task.title}\nWhy it asks: ${v.reason}.\n\n${r.command ? `\`\`\`\n${r.command}\n\`\`\`` : JSON.stringify(r.input)}`,
      options: ["Approve", "Deny", ALL_LIKE_THIS],
      defaultOption: null,
    });
    asked.push(itemId);
    event("task.waiting", { itemId, reason: v.reason });
    let answer: string;
    waitingOnOwner++;
    try {
      answer = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    } catch {
      // Paused or stopped while waiting: a permission hook always answers; the attempt stops anyway.
      return { allow: false, message: "Oraknid is pausing this session." };
    } finally {
      waitingOnOwner--;
    }
    observed.lastActivityAt = now();
    if (answer === ALL_LIKE_THIS) {
      approveAllLikeThis(
        d.db,
        d.bus,
        job.id,
        v.gated ? { gated: v.gated } : { allowRule: allowRuleFor(r.command ?? r.tool) },
      );
      return { allow: true };
    }
    if (answer === "Approve") return { allow: true };
    deniedGates.add(key);
    return { allow: false, message: "I denied it. Find another way, or say what you need." };
  };

  const pack = (): string => {
    const window = leg.profile.contextWindow ?? 200_000;
    const built = buildContextPack({
      task: {
        id: task.id,
        title: task.title,
        instructions: task.instructions,
        scope: task.scope,
        verify: task.verify,
      },
      goal: job.goal,
      skill: skillExcerpt(job.skillBody, `${task.title} ${task.kind}`),
      entries: d.silk.all(job.id),
      digest: "",
      inputs: job.inputs,
      capTokens: Math.floor(window * 0.15),
    });
    // What had to be shortened is summarised in the background for the next pack.
    if (built.shortened.length >= 2)
      void summarizeShortened(d, job.id, ws.cwd, built.shortened).catch((e) =>
        console.error("silk summary failed", e),
      );
    return built.text;
  };

  const openSession = async (prompt: string) => {
    observed.lastActivityAt = now();
    // A new session counts its tokens from zero.
    sessionTokens = 0;
    tokensBaseline = 0;
    session = await d.supervisor.start({
      legId: leg.legId,
      legModelId: leg.legModelId,
      effort: pick.effort,
      jobId: job.id,
      taskId,
      attemptId,
      cwd: ws.cwd,
      systemPrompt: pack(),
      prompt,
      unsandboxed: job.unsandboxed,
      onPermission,
    });
    const row = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.id, session.id))
      .get();
    sessionLog = row?.logFile ?? null;
    return session;
  };

  /** Writes a handoff to Silk: asked of the Leg when it can still answer, rebuilt from its log otherwise. */
  const handOff = async (askLeg: boolean) => {
    let body = "";
    if (askLeg && session) {
      try {
        await session.session.send(HANDOFF_REQUEST);
        body = (await nextTurnEnd(session, signal, 120_000))?.text ?? "";
      } catch {}
    }
    if (!/## Goal of the task/.test(body)) {
      body = sessionLog
        ? handoffFromLog({ goal: task.instructions, logFile: sessionLog, cwd: ws.cwd, since: ckpt })
        : "No session ran yet.";
    }
    d.silk.add({
      jobId: job.id,
      taskId,
      kind: "handoff",
      title: `Handoff: ${task.title}`,
      body,
      authoredBy: session ? { legId: leg.legId } : "eye",
    });
  };

  const closeSession = async (how: "close" | "kill" | "stop" = "close") => {
    if (session)
      await (how === "kill"
        ? session.session.kill()
        : d.supervisor.close(session, how === "stop" ? "stopped" : "closed"));
    session = null;
  };

  const ask = async (drift: Drift): Promise<never> => {
    const itemId = d.inbox.open({
      kind: "question",
      jobId: job.id,
      taskId,
      raisedBy: "eye",
      title: `"${task.title}" keeps going wrong`,
      detail: `${leg.legName} · ${leg.model}: ${drift.evidence}.\nEscalations so far: ${escalations.join(", ") || "none"}.\nAnswer with guidance to retry, or choose another option.`,
      options: ["Retry", "Take it over", "Skip it", "Cancel the job"],
      defaultOption: "Retry",
    });
    // Withdrawn if the attempt stops before I answer (Audit 1 → D1-07).
    asked.push(itemId);
    const answer = await waitForAnswer(d.inbox, d.bus, itemId, signal);
    if (answer === "Take it over") throw new EndAttempt({ kind: "owner-held" });
    if (answer === "Skip it") throw new EndAttempt({ kind: "skipped" });
    if (answer === "Cancel the job")
      throw new EndAttempt({
        kind: "cancel-job",
        reason: `Cancelled by me after "${task.title}" kept going wrong.`,
      });
    if (answer !== "Retry") {
      d.silk.add({
        jobId: job.id,
        taskId,
        kind: "decision",
        title: `Guidance for ${task.title}`,
        body: answer,
        authoredBy: "owner",
      });
    }
    d.db
      .update(tasks)
      .set({ stepUp: 0, escalation: 0, avoid: [] })
      .where(eq(tasks.id, taskId))
      .run();
    throw new EndAttempt({ kind: "retry", reason: "retrying with my guidance" });
  };

  /** Climbs one step of the ladder for the worst drift seen. `failure` is the last check's output, if it failed. */
  const escalate = async (drifts: Drift[], failure = "") => {
    const drift = [...drifts].sort(
      (a, b) => SEVERITY.indexOf(a.code) - SEVERITY.indexOf(b.code),
    )[0] as Drift;
    const next = nextEscalation(level, drift.code);
    level = next.level;
    escalations.push(`${drift.code}:${next.step}`);
    d.db.update(tasks).set({ escalation: level }).where(eq(tasks.id, taskId)).run();
    event("task.drift", { code: drift.code, evidence: drift.evidence, step: next.step, level });
    // Detections are consumed: the same evidence doesn't trigger twice (Audit 1 → Q1-01).
    observed.forbidden = [];
    observed.gateBypass = [];
    observed.falseClaim = null;
    observed.commands = [];
    observed.verifyFailures = [];
    tokensBaseline = sessionTokens;
    observed.tokensSinceProgress = 0;
    observed.lastActivityAt = now();

    switch (next.step) {
      case "correct": {
        if (drift.code === "D1") {
          const outside = changedSince(ws.g, ckpt, ws.tmpDir).filter(
            (p) => !inTaskScope(p, task.scope),
          );
          restorePaths(ws.g, ckpt, outside, ws.trash);
        }
        await session?.session.send(
          `${correctivePrompt(drift, task.scope, task.verify)}${failure ? `\n\n${failure}` : ""}`,
        );
        return;
      }
      case "reset":
        await handOff(true);
        await closeSession();
        await openSession(
          "Continue the task. The handoff above says where the last session stopped.",
        );
        return;
      case "step-up":
        await handOff(true);
        await closeSession();
        d.db
          .update(tasks)
          .set({ stepUp: task.stepUp + 1 })
          .where(eq(tasks.id, taskId))
          .run();
        throw new EndAttempt({ kind: "retry", reason: `stepping up after ${drift.code}` });
      case "reassign":
        await handOff(true);
        await closeSession();
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        throw new EndAttempt({ kind: "retry", reason: `reassigning after ${drift.code}` });
      case "kill":
        await closeSession("kill");
        rollback(ws.g, ckpt, ws.tmpDir, ws.trash);
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        await handOff(false);
        throw new EndAttempt({ kind: "retry", reason: `killed after ${drift.code}` });
      case "ask":
        await closeSession();
        await ask(drift);
    }
  };

  const finish = (
    outcome: "succeeded" | "failed" | "reassigned" | "abandoned",
    success: boolean,
  ) => {
    for (const id of asked) d.inbox.withdraw(id);
    d.db
      .update(attempts)
      .set({ endedAt: now(), outcome, escalations })
      .where(eq(attempts.id, attemptId))
      .run();
    const m = d.registry.model(leg.legModelId);
    if (m) {
      const stored = record(d.registry.storedProfile(m), task.kind as TaskKind, {
        success,
        tokens: observed.tokensSinceProgress,
        ms: now() - started,
        escalations: escalations.length,
      });
      d.registry.saveProfile(m.id, stored);
    }
  };

  try {
    const handoff = d.silk.current(job.id).some((e) => e.kind === "handoff" && e.taskId === taskId);
    await openSession(
      handoff
        ? "Continue the task. The handoff above says where the last session stopped. Say DONE when it is finished."
        : "Do the task described above. When it is finished, say DONE and summarise what you changed.",
    );
    let turns = 0;
    for (;;) {
      if (!session) throw new Error("no session");
      const end = await nextTurnEnd(session, signal, d.stallCheckMs ?? 30_000, (e) => {
        observed.lastActivityAt = now();
        if (e.type === "tool.called" && typeof e.input.command === "string")
          pending.set(e.id, e.input.command);
        if (e.type === "tool.result" && pending.has(e.id)) {
          observed.commands.push({
            command: pending.get(e.id) as string,
            outputHash: hash(`${e.ok}:${e.output}`),
          });
          pending.delete(e.id);
        }
        if (e.type === "usage") {
          sessionTokens = e.usage.inputTokens + e.usage.outputTokens;
          observed.tokensSinceProgress = Math.max(0, sessionTokens - tokensBaseline);
          usage = e.usage;
        }
      });
      if (!end) {
        // No turn end yet: look for a stall or burn. Waiting for me is neither.
        if (waitingOnOwner > 0) {
          observed.lastActivityAt = now();
          continue;
        }
        const drifts = detect(observed, now(), DEFAULT_THRESHOLDS);
        if (drifts.length) await escalate(drifts);
        continue;
      }
      turns++;
      if (end.reason === "rate-limited") {
        await handOff(false);
        await closeSession();
        d.db
          .update(tasks)
          .set({
            avoid: [...new Set([...task.avoid, leg.legModelId])],
            limitedKinds: [
              ...new Set([
                ...task.limitedKinds,
                `${d.registry.require(leg.legId).kind}:${leg.legId}`,
              ]),
            ],
          })
          .where(eq(tasks.id, taskId))
          .run();
        finish("reassigned", false);
        return { kind: "retry", reason: `${leg.legName} hit a usage limit` };
      }
      if (end.reason === "error") {
        await handOff(false);
        await closeSession();
        d.db
          .update(tasks)
          .set({ avoid: [...new Set([...task.avoid, leg.legModelId])] })
          .where(eq(tasks.id, taskId))
          .run();
        finish("failed", false);
        return { kind: "retry", reason: `${leg.legName} failed: ${end.error ?? "unknown error"}` };
      }

      // My messages to The Eye for the work now (Talking to The Eye) go on before any check.
      const told = takeGuidance(job.id, guidanceSeen);
      if (told.text && session) {
        guidanceSeen = told.mark;
        event("task.guided", {});
        await session.session.send(told.text);
        continue;
      }

      observed.changedPaths = changedSince(ws.g, ckpt, ws.tmpDir);
      let verified = task.verify.length === 0;
      let failure = "";
      if (task.verify.length) {
        event("task.verifying", {});
        const plan = job.unsandboxed
          ? null
          : sandboxPlan(d.registry.require(leg.legId), d.sandbox, d.legsDir);
        const results = await runVerify(task.verify, ws.cwd, plan, {
          signal,
          refuse: (command) =>
            verifyRefusal(
              decide({ tool: "Bash", command, path: null }, policyFor(d.db, job.id, ws.cwd)),
            ),
        });
        const failed = results.find((r) => !r.ok);
        verified = !failed;
        event("task.verified", {
          ok: verified,
          results: results.map((r) => ({ command: r.command, ok: r.ok, exitCode: r.exitCode })),
        });
        if (failed) {
          failure = `\`${failed.command}\` failed (exit ${failed.exitCode}):\n\`\`\`\n${failed.output.slice(-3000)}\n\`\`\``;
          observed.verifyFailures.push(failed.signature ?? "");
          if (claimsDone(end.text))
            observed.falseClaim = `said it was done, but \`${failed.command}\` failed`;
        }
      }

      // No verify command (research, plan): a second reasoning look decides (The-Eye → Planning).
      if (!task.verify.length && d.brain) {
        event("task.evaluating", {});
        try {
          const review = await d.brain.evaluate({
            jobId: job.id,
            cwd: ws.cwd,
            task: { title: task.title, instructions: task.instructions, kind: task.kind },
            report: end.text,
            changes: diffStatSince(ws.g, ckpt, ws.tmpDir),
          });
          verified = review.accepted;
          event("task.evaluated", { accepted: review.accepted, reason: review.reason });
          if (!review.accepted) {
            failure = `The Eye reviewed the work: ${review.reason}${review.missing.length ? `\nStill missing:\n${review.missing.map((m) => `- ${m}`).join("\n")}` : ""}`;
            observed.verifyFailures.push(`evaluate:${review.missing.join("|") || review.reason}`);
            if (claimsDone(end.text))
              observed.falseClaim = "said it was done, but the review found work missing";
          }
        } catch (error) {
          // No Leg could review it: accepted as before, and said so.
          event("task.evaluated", {
            accepted: true,
            reason: `not reviewed: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const drifts = detect(observed, now(), DEFAULT_THRESHOLDS);
      if (verified && !drifts.some((x) => x.code === "D1")) {
        await closeSession();
        const commit = commitAll(
          ws.g,
          `${PREFIX[task.kind as TaskKind]}: ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}`,
        );
        d.silk.add({
          jobId: job.id,
          taskId,
          kind: "progress",
          title: `Done: ${task.title}`,
          body: `${task.verify.length ? `Verified by ${task.verify.map((v) => `\`${v}\``).join(", ")}` : "No verify command (a planning task)"} on ${leg.legName} · ${leg.model}${pick.effort ? ` (${pick.effort})` : ""}.${commit ? ` Commit ${commit.slice(0, 10)}.` : ""}\n\n${diffStatSince(ws.g, ckpt, ws.tmpDir).trim() || "No file changes."}`,
          authoredBy: "eye",
        });
        d.db.update(tasks).set({ escalation: 0 }).where(eq(tasks.id, taskId)).run();
        finish("succeeded", true);
        return { kind: "done", commit };
      }
      if (drifts.length) {
        await escalate(drifts, failure);
        continue;
      }
      if (turns >= (d.maxTurns ?? 25)) {
        await escalate([
          { code: "D6", evidence: `took ${turns} turns without passing verification` },
        ]);
        continue;
      }
      // Self-prompting (The-Eye → Self-prompting): the exact failure goes back.
      await session?.session.send(
        `Oraknid ran the checks and the task is not done yet.\n${failure}\nFix it, then say DONE.`,
      );
      if (shouldRotate(usage, d.rotateAt ?? 0.6)) {
        event("task.rotating", {
          contextTokens: usage?.contextTokens,
          contextWindow: usage?.contextWindow,
        });
        await nextTurnEnd(session as Supervised, signal, 600_000);
        await handOff(true);
        await closeSession();
        await openSession(
          "Continue the task. The handoff above says where the last session stopped. Say DONE when it is finished.",
        );
      }
    }
  } catch (error) {
    if (error instanceof EndAttempt) {
      finish(error.outcome.kind === "retry" ? "reassigned" : "abandoned", false);
      return error.outcome;
    }
    // Stopped (pause, cancel, shutdown) or failed: leave a handoff behind, then let the engine decide.
    const open = session as Supervised | null;
    if (open) {
      try {
        await open.session.interrupt();
      } catch {}
      await closeSession("stop");
      try {
        await handOff(false);
      } catch {}
    }
    finish("abandoned", false);
    // Nothing runs it any more: shown as ready at once, not "running" until the job resumes.
    d.bus.atomically(() => {
      d.db
        .update(tasks)
        .set({ state: "ready", leaseUntil: null })
        .where(
          and(eq(tasks.id, taskId), inArray(tasks.state, ["assigned", "running", "verifying"])),
        )
        .run();
      d.bus.publish({
        type: "task.state",
        topic: `job:${job.id}`,
        jobId: job.id,
        payload: {
          taskId,
          to: "ready",
          reason: "Stopped at a safe point; it starts again on resume.",
        },
      });
    });
    throw error;
  }
}

/** A job that ended keeps nothing in memory here (Audit 1 → Q1-19). */
export function forgetJob(jobId: string) {
  verdicts.delete(jobId);
}

/** Per job, the classifier's "allow" for one exact command (ADR-014: cached; per command since Audit 1 → S1-07). */
const verdicts = new Map<string, Map<string, { decision: "allow" | "ask"; reason: string }>>();

async function classify(
  d: AttemptDeps,
  jobId: string,
  cwd: string,
  task: string,
  r: PermissionRequest,
  v: Extract<PolicyVerdict, { verdict: "classify" }>,
): Promise<Exclude<PolicyVerdict, { verdict: "classify" }>> {
  // The whole command, not its programs: allowing one `curl` must not allow every other.
  const key = (r.command ?? r.tool).trim().replace(/\s+/g, " ");
  const cache = verdicts.get(jobId) ?? new Map();
  verdicts.set(jobId, cache);
  let verdict = cache.get(key);
  let cached = true;
  if (!verdict) {
    cached = false;
    try {
      verdict = d.brain
        ? await d.brain.classifyCommand({
            jobId,
            cwd,
            task,
            command: r.command ?? r.tool,
            why: v.reason,
          })
        : { decision: "ask" as const, reason: "no classifier is available" };
    } catch (error) {
      // Fail safe: when nothing can judge, I'm asked.
      verdict = {
        decision: "ask",
        reason: `the classifier could not answer (${error instanceof Error ? error.message : String(error)})`,
      };
    }
    if (verdict.decision === "allow") cache.set(key, verdict);
  }
  d.bus.publish({
    type: "policy.auto",
    topic: `job:${jobId}`,
    jobId,
    payload: {
      command: (r.command ?? r.tool).slice(0, 300),
      programs: v.programs,
      decision: verdict.decision,
      reason: verdict.reason,
      cached,
    },
    actor: "eye",
  });
  return verdict.decision === "allow"
    ? { verdict: "allow", reason: `auto-approved: ${verdict.reason}` }
    : {
        verdict: "ask",
        reason: `${v.reason}, and the classifier says: ${verdict.reason}`,
        gated: null,
      };
}

function shouldRotate(u: UsageSnapshot | null, at: number): boolean {
  return !!u?.contextTokens && !!u.contextWindow && u.contextTokens > u.contextWindow * at;
}

/** Reads events until a turn ends; null when `ms` pass first (time to look for a stall). */
async function nextTurnEnd(
  s: Supervised,
  signal: AbortSignal,
  ms: number,
  onEvent?: (e: LegEvent) => void,
): Promise<Extract<LegEvent, { type: "turn.ended" }> | null> {
  const it = iterators.get(s) ?? s.events[Symbol.asyncIterator]();
  iterators.set(s, it);
  const deadline = Date.now() + ms;
  for (;;) {
    if (signal.aborted) throw signal.reason;
    const left = deadline - Date.now();
    if (left <= 0) return null;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const next = await Promise.race([
      it.next(),
      new Promise<"timeout">((r) => {
        timer = setTimeout(() => r("timeout"), left);
      }),
      new Promise<"abort">((r) => {
        onAbort = () => r("abort");
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    });
    if (next === "timeout") return null;
    if (next === "abort") throw signal.reason;
    if (next.done)
      return { type: "turn.ended", reason: "error", text: "", error: "The session ended." };
    onEvent?.(next.value);
    if (next.value.type === "turn.ended") return next.value;
  }
}

const iterators = new WeakMap<Supervised, AsyncIterator<LegEvent>>();

const inTaskScope = (path: string, scope: string[]) =>
  path.startsWith(".oraknid/") || inScope(path, scope);

/** Every visible Leg model the job may use, as routing candidates. */
export function candidatesFor(registry: LegRegistry, allowed: string[]): RouteCandidate[] {
  const out: RouteCandidate[] = [];
  for (const leg of registry.all()) {
    if (allowed.length && !allowed.includes(leg.id)) continue;
    const view = registry.view(leg);
    for (const m of view.models.filter((x) => !x.hidden)) {
      out.push({
        legId: leg.id,
        legModelId: m.id,
        model: m.model,
        legName: leg.name,
        health: view.health,
        paused: view.paused,
        effortLevels: m.effortLevels,
        profile: m.profile,
        windows: [...view.quota, ...m.quota],
      });
    }
  }
  return out;
}
