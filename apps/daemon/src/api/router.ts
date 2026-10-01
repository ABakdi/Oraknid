import {
  Autonomy,
  Budget,
  ChannelTestResult,
  DoctorCheck,
  EmailSettings,
  Event,
  EyeMessage,
  InboxFilter,
  InboxItem,
  JobResult,
  JobView,
  LegView,
  MetricsSample,
  NewJob,
  NewLeg,
  NewProject,
  NotificationChannel,
  NotificationSettings,
  ProfileOverrides,
  ProjectView,
  PruneRequest,
  PushSubscriptionInput,
  QuietHours,
  SessionLogPage,
  SessionView,
  SilkEntry,
  SilkKind,
  StorageUsage,
  SystemStatus,
  type TaskView,
} from "@oraknid/contracts";
import {
  type InhibitorState,
  type SandboxStatus,
  SecretStoreUnavailable,
  type ServiceManager,
} from "@oraknid/os";
import { ORPCError, os } from "@orpc/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { AuditQuery, searchAudit } from "../audit/audit.ts";
import type { Devices } from "../auth/devices.ts";
import {
  attempts as attemptsTable,
  jobs as jobsTable,
  legModels,
  legs as legsTable,
  sessions as sessionsTable,
  taskEdges,
  tasks as tasksTable,
} from "../db/schema.ts";
import { runDoctor } from "../doctor.ts";
import type { JobStore } from "../engine/jobs.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { SAME_PROVIDER_FALLBACK } from "../eye/attempt.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { setBudget } from "../eye/budgets.ts";
import {
  editWeb,
  handBack,
  pin,
  redirect,
  rollbackTask,
  takeOver,
  WebEdit,
} from "../eye/controls.ts";
import {
  GlobalPolicy,
  readGlobalPolicy,
  readProjectPolicy,
  writeGlobalPolicy,
  writeProjectPolicy,
} from "../eye/policy.ts";
import { conversation, talk } from "../eye/talk.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { readSessionLog } from "../legs/session-log.ts";
import type { Notifications } from "../notify/notifications.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import { pruneLogs, storageUsage } from "../storage/storage.ts";
import { VERSION } from "../version.ts";
import type { Projects } from "../workspace/projects.ts";
import { jobResult, mergeJob } from "../workspace/result.ts";
import {
  Activity,
  activity,
  StatsScope,
  Summary,
  summary as statsSummary,
  TokenBucket,
  tokensOverTime,
} from "./stats.ts";

export interface ApiContext {
  /** The paired device making this call; null for the CLI. */
  device: string | null;
  startedAt: number;
  paths: Paths;
  bus: EventBus;
  now: () => number;
  inhibitor: () => InhibitorState;
  secrets: Secrets;
  sandbox: () => SandboxStatus;
  service: ServiceManager;
  notifications: Notifications;
  recentMetrics: (since: number) => MetricsSample[];
  jobs: JobStore;
  runner: JobRunner;
  registry: LegRegistry;
  health: { check(id: string): Promise<void> };
  silk: SilkStore;
  inbox: InboxStore;
  projects: Projects;
  skills: SkillStore;
  devices: Devices;
  brain: EyeBrain;
  /** Opens a folder on this machine (xdg-open). */
  openPath: (path: string) => void;
  tmpDir: string;
}

const base = os.$context<ApiContext>();

const GatedActionSchema = z.enum([
  "send",
  "push",
  "merge",
  "deploy",
  "delete",
  "spend",
  "external-write",
  "install",
]);

/** Errors carry a sentence for the UI (BR-17). */
const userError = (message: string) => new ORPCError("BAD_REQUEST", { message });

const SkillSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  source: z.enum(["built-in", "uploaded"]),
  version: z.number(),
  interview: z.boolean(),
  requiredTools: z.array(z.string()),
  verify: z.array(z.string()),
});
const SkillFull = SkillSummary.extend({ body: z.string() });
const summary = (s: {
  id: string;
  name: string;
  description: string;
  source: string;
  version: number;
  interview: boolean;
  requiredTools: string[];
  verify: string[];
}) => SkillSummary.parse(s);

const controls = (c: ApiContext) => ({
  db: c.jobs.db,
  bus: c.bus,
  runner: c.runner,
  silk: c.silk,
  tmpDir: c.tmpDir,
});

function jobView(c: ApiContext, id: string): JobView {
  const job = c.jobs.require(id);
  // Only this job's edges (Audit 1 → Q1-07).
  const edges = c.jobs.db
    .select({ taskId: taskEdges.taskId, dependsOn: taskEdges.dependsOn })
    .from(taskEdges)
    .innerJoin(tasksTable, eq(tasksTable.id, taskEdges.taskId))
    .where(eq(tasksTable.jobId, id))
    .all();
  const tasks = c.jobs.db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.jobId, id))
    .orderBy(asc(tasksTable.position))
    .all()
    .map((t) => ({
      id: t.id,
      jobId: t.jobId,
      title: t.title,
      instructions: t.instructions,
      dependsOn: edges.filter((e) => e.taskId === t.id).map((e) => e.dependsOn),
      kind: t.kind,
      scope: t.scope,
      verify: t.verify,
      requiredCapabilities: t.requiredCapabilities,
      difficulty: t.difficulty,
      state: t.state,
      assignedLegId: t.assignedLegId,
      assignedModelId: t.assignedModelId,
      effort: t.effort,
      attemptCount: t.attemptCount,
      budget: null,
      routing: (t.routing as TaskView["routing"]) ?? null,
      pinnedModelId: t.pinnedModelId,
      ownerHeld: t.ownerHeld,
    }));
  return JobView.parse({ ...job, tasks, worktree: job.worktree, branch: job.branch });
}

/** Turns a refusal (an illegal move, an unknown job) into a sentence for the UI. */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw userError(error instanceof Error ? error.message : String(error));
  }
}

// Procedures follow docs/02-Architecture/API-Contract.md. Later milestones add the rest.
export const router = {
  system: {
    status: base.output(SystemStatus).handler(({ context: c }) => ({
      version: VERSION,
      startedAt: c.startedAt,
      uptimeMs: Math.max(0, c.now() - c.startedAt),
      pid: process.pid,
      dataDir: c.paths.dataDir,
      lastSeq: c.bus.lastSeq(),
      inhibitor: c.inhibitor(),
      secrets: c.secrets.status(),
      sandbox: c.sandbox(),
      service: c.service.status(),
    })),
    doctor: base.output(z.array(DoctorCheck)).handler(({ context: c }) =>
      runDoctor(c.paths, {
        sandbox: c.sandbox(),
        secrets: c.secrets.status(),
        service: c.service.status(),
      }),
    ),
  },
  secrets: {
    unlock: base.input(z.object({ passphrase: z.string() })).handler(({ context: c, input }) => {
      try {
        return c.secrets.unlock(input.passphrase);
      } catch (error) {
        if (error instanceof SecretStoreUnavailable) throw userError(error.message);
        throw error;
      }
    }),
  },
  projects: {
    /** My command rules for one project (Approvals → Rules, M1.9). */
    policy: base
      .input(z.object({ id: z.string() }))
      .output(GlobalPolicy)
      .handler(({ context: c, input }) => readProjectPolicy(c.jobs.db, input.id)),
    setPolicy: base
      .input(GlobalPolicy.extend({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          writeProjectPolicy(c.jobs.db, c.bus, input.id, { allow: input.allow, deny: input.deny });
        }),
      ),
    create: base
      .input(NewProject)
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(() => ({ ...c.projects.create(input), jobCount: 0 })),
      ),
    list: base.output(z.array(ProjectView)).handler(({ context: c }) => c.projects.list()),
  },
  skills: {
    list: base
      .output(z.array(SkillSummary))
      .handler(({ context: c }) => c.skills.list().map(summary)),
    get: base
      .input(z.object({ id: z.string(), version: z.number().int().positive().optional() }))
      .output(SkillFull)
      .handler(({ context: c, input }) =>
        guard(() => {
          const s = input.version
            ? c.skills.version(input.id, input.version)
            : c.skills.latest(input.id);
          if (!s) throw new Error(`No skill ${input.id}.`);
          return { ...summary(s), body: s.body };
        }),
      ),
    /** Never refused for bad front matter: what was ignored is said (Skills → Format). */
    upload: base
      .input(z.object({ name: z.string().min(1), markdown: z.string().min(1) }))
      .output(z.object({ skill: SkillSummary, ignored: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          const r = c.skills.upload(input.markdown, input.name);
          return { skill: summary(r.skill), ignored: r.ignored };
        }),
      ),
    edit: base
      .input(z.object({ id: z.string(), markdown: z.string().min(1) }))
      .output(z.object({ skill: SkillSummary, ignored: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          const r = c.skills.edit(input.id, input.markdown);
          return { skill: summary(r.skill), ignored: r.ignored };
        }),
      ),
    remove: base.input(z.object({ id: z.string() })).handler(({ context: c, input }) =>
      guard(() =>
        c.skills.remove(input.id, (id) =>
          c.jobs.db
            .select({ title: jobsTable.title, state: jobsTable.state })
            .from(jobsTable)
            .where(eq(jobsTable.skillId, id))
            .all()
            .filter((j) => j.state !== "completed" && j.state !== "cancelled")
            .map((j) => j.title),
        ),
      ),
    ),
  },
  stats: {
    tokens: base
      .input(
        StatsScope.extend({
          since: z.number(),
          bucketMs: z.number().int().positive().default(3600_000),
        }),
      )
      .output(z.array(TokenBucket))
      .handler(({ context: c, input }) => tokensOverTime(c.jobs.db, input)),
    summary: base
      .input(StatsScope)
      .output(Summary)
      .handler(({ context: c, input }) => statsSummary(c.jobs.db, input)),
    activity: base.output(z.array(Activity)).handler(({ context: c }) => activity(c.jobs.db)),
  },
  tasks: {
    pin: base
      .input(z.object({ taskId: z.string(), legModelId: z.string().nullable() }))
      .handler(({ context: c, input }) =>
        guard(() => pin(controls(c), input.taskId, input.legModelId)),
      ),
    takeOver: base
      .input(z.object({ taskId: z.string() }))
      .handler(({ context: c, input }) => guard(() => takeOver(controls(c), input.taskId))),
    handBack: base
      .input(z.object({ taskId: z.string(), finished: z.boolean() }))
      .handler(({ context: c, input }) =>
        guard(() => handBack(controls(c), input.taskId, input.finished)),
      ),
    rollback: base
      .input(z.object({ taskId: z.string(), attempt: z.number().int().positive() }))
      .handler(({ context: c, input }) =>
        guard(() => rollbackTask(controls(c), input.taskId, input.attempt)),
      ),
    attempts: base
      .input(z.object({ taskId: z.string() }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            legModelId: z.string(),
            effort: z.string().nullable(),
            startedAt: z.number(),
            endedAt: z.number().nullable(),
            outcome: z.string().nullable(),
            escalations: z.array(z.string()),
          }),
        ),
      )
      .handler(({ context: c, input }) =>
        c.jobs.db
          .select()
          .from(attemptsTable)
          .where(eq(attemptsTable.taskId, input.taskId))
          .orderBy(asc(attemptsTable.startedAt))
          .all(),
      ),
  },
  web: {
    edit: base
      .input(z.object({ jobId: z.string(), edits: z.array(WebEdit).min(1) }))
      .handler(({ context: c, input }) =>
        guard(() => editWeb(controls(c), input.jobId, input.edits)),
      ),
  },
  devices: {
    /** A short code for a new device to enter (Security → pairing). */
    pairStart: base
      .output(z.object({ code: z.string(), expiresAt: z.number() }))
      .handler(({ context: c }) => c.devices.startPairing()),
    /** The only procedure that needs no token: the code is the proof. */
    pairComplete: base
      .input(z.object({ code: z.string().regex(/^\d{6}$/), name: z.string().min(1).max(60) }))
      .output(z.object({ deviceId: z.string(), token: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.devices.completePairing(input.code, input.name)),
      ),
    list: base
      .output(
        z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            pairedAt: z.number(),
            lastSeenAt: z.number().nullable(),
            revokedAt: z.number().nullable(),
          }),
        ),
      )
      .handler(({ context: c }) => c.devices.list()),
    revoke: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.devices.revoke(input.id))),
  },
  audit: {
    search: base
      .input(AuditQuery)
      .output(z.array(Event))
      .handler(({ context: c, input }) => searchAudit(c.jobs.db, input)),
  },
  policies: {
    get: base.output(GlobalPolicy).handler(({ context: c }) => readGlobalPolicy(c.jobs.db)),
    update: base
      .input(GlobalPolicy)
      .handler(({ context: c, input }) => guard(() => writeGlobalPolicy(c.jobs.db, c.bus, input))),
  },
  settings: {
    /** ADR-009: which providers may fall back to another of my accounts after a usage limit. Audited. */
    sameProviderFallback: base
      .output(z.array(z.string()))
      .handler(({ context: c }) =>
        readSetting(c.jobs.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []),
      ),
    setSameProviderFallback: base
      .input(z.object({ kind: z.string(), enabled: z.boolean() }))
      .handler(({ context: c, input }) => {
        const now = new Set(
          readSetting(c.jobs.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), []),
        );
        if (input.enabled) now.add(input.kind);
        else now.delete(input.kind);
        writeSetting(c.jobs.db, SAME_PROVIDER_FALLBACK, z.array(z.string()), [...now]);
        c.bus.publish({
          type: "policy.same-provider-fallback",
          topic: "overview",
          jobId: null,
          payload: input,
          actor: "owner",
        });
      }),
    /** The Leg model The Eye borrows for reasoning (first-run setup); null lets routing choose. */
    setEyeLeg: base
      .input(z.object({ legModelId: z.string().nullable() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          if (input.legModelId && !c.registry.model(input.legModelId))
            throw new Error(`No Leg model ${input.legModelId}.`);
          writeSetting(c.jobs.db, "eye.legModelId", z.string().nullable(), input.legModelId);
        }),
      ),
  },
  jobs: {
    create: base
      .input(NewJob)
      .output(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => ({ id: c.projects.createJob(input) }))),
    start: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.runner.start(input.id))),
    get: base
      .input(z.object({ id: z.string() }))
      .output(JobView)
      .handler(({ context: c, input }) => guard(() => jobView(c, input.id))),
    list: base.output(z.array(JobView)).handler(({ context: c }) =>
      c.jobs.db
        .select({ id: jobsTable.id })
        .from(jobsTable)
        .orderBy(asc(jobsTable.id))
        .all()
        .map((j) => jobView(c, j.id)),
    ),
    /** Where the work is and what it holds (Checkpoint 1 → F1-5). */
    result: base
      .input(z.object({ id: z.string() }))
      .output(JobResult)
      .handler(({ context: c, input }) => guard(() => jobResult(c.jobs.db, input.id))),
    merge: base
      .input(z.object({ id: z.string() }))
      .output(
        z.union([
          z.object({ ok: z.literal(true), commit: z.string() }),
          z.object({ ok: z.literal(false), reason: z.string(), conflicts: z.array(z.string()) }),
        ]),
      )
      .handler(({ context: c, input }) => guard(() => mergeJob(c.jobs.db, c.bus, input.id))),
    openFolder: base.input(z.object({ id: z.string() })).handler(({ context: c, input }) =>
      guard(() => {
        const folder = jobResult(c.jobs.db, input.id).folder;
        if (!folder) throw new Error("The job has no folder yet.");
        c.openPath(folder);
      }),
    ),
    /** Talking to The Eye (Checkpoint 1 → F1-4): its reply arrives as `eye.replied`. */
    talk: base
      .input(z.object({ id: z.string(), text: z.string().min(1).max(8000) }))
      .output(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => ({
          id: talk(
            {
              db: c.jobs.db,
              bus: c.bus,
              silk: c.silk,
              runner: c.runner,
              brain: c.brain,
              tmpDir: c.tmpDir,
              now: c.now,
            },
            input.id,
            input.text.trim(),
          ),
        })),
      ),
    conversation: base
      .input(z.object({ id: z.string() }))
      .output(z.array(EyeMessage))
      .handler(({ context: c, input }) => conversation(c.jobs.db, input.id)),
    redirect: base
      .input(z.object({ id: z.string(), instruction: z.string().min(1) }))
      .handler(({ context: c, input }) =>
        guard(() => redirect(controls(c), input.id, input.instruction)),
      ),
    /** Changeable while the job runs: the next decision uses it. */
    /** My new budget, while the job runs or before (Budgets-and-Quotas). */
    setBudget: base
      .input(z.object({ id: z.string(), budget: Budget }))
      .output(z.object({ changed: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => setBudget(c.jobs.db, c.bus, input.id, input.budget)),
      ),
    setAutonomy: base
      .input(z.object({ id: z.string(), autonomy: Autonomy }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.jobs.require(input.id);
          c.jobs.db
            .update(jobsTable)
            .set({ autonomy: input.autonomy })
            .where(eq(jobsTable.id, input.id))
            .run();
          c.bus.publish({
            type: "job.autonomy",
            topic: `job:${input.id}`,
            jobId: input.id,
            payload: { autonomy: input.autonomy },
            actor: "owner",
          });
        }),
      ),
    /** Waive gates for this job; audited (Approvals → Overrides). */
    setWaivers: base
      .input(z.object({ id: z.string(), waived: z.array(GatedActionSchema) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.jobs.require(input.id);
          c.jobs.db
            .update(jobsTable)
            .set({ waived: input.waived })
            .where(eq(jobsTable.id, input.id))
            .run();
          c.bus.publish({
            type: "policy.waived",
            topic: `job:${input.id}`,
            jobId: input.id,
            payload: { waived: input.waived },
            actor: "owner",
          });
        }),
      ),
    setRules: base
      .input(z.object({ id: z.string(), allow: z.array(z.string()), deny: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.jobs.require(input.id);
          for (const src of [...input.allow, ...input.deny]) new RegExp(src);
          c.jobs.db
            .update(jobsTable)
            .set({ allowRules: input.allow, denyRules: input.deny })
            .where(eq(jobsTable.id, input.id))
            .run();
          c.bus.publish({
            type: "policy.updated",
            topic: `job:${input.id}`,
            jobId: input.id,
            payload: { level: "job", allow: input.allow, deny: input.deny },
            actor: "owner",
          });
        }),
      ),
    pause: base
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .handler(({ context: c, input }) =>
        guard(() => c.runner.pause(input.id, input.reason ?? "Paused by me.")),
      ),
    resume: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.runner.resume(input.id))),
    cancel: base
      .input(z.object({ id: z.string(), reason: z.string().optional() }))
      .handler(({ context: c, input }) =>
        guard(() => c.runner.cancel(input.id, input.reason ?? "Cancelled by me.")),
      ),
  },
  legs: {
    list: base
      .output(z.array(LegView))
      .handler(({ context: c }) => c.registry.all().map((l) => c.registry.view(l))),
    get: base
      .input(z.object({ id: z.string() }))
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(() => c.registry.view(c.registry.require(input.id))),
      ),
    /** Adds a Leg and tests it straight away (Legs spec → Adding a Leg). */
    create: base
      .input(NewLeg)
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(async () => {
          const leg = await c.registry.create(input);
          await c.health.check(leg.id);
          return c.registry.view(c.registry.require(leg.id));
        }),
      ),
    test: base
      .input(z.object({ id: z.string() }))
      .output(LegView)
      .handler(({ context: c, input }) =>
        guard(async () => {
          await c.health.check(input.id);
          return c.registry.view(c.registry.require(input.id));
        }),
      ),
    update: base
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          enabled: z.boolean().optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(async () => {
          const { id, ...patch } = input;
          c.registry.update(id, patch);
          await c.health.check(id);
        }),
      ),
    pause: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.update(input.id, { paused: true })),
      ),
    resume: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.update(input.id, { paused: false })),
      ),
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.registry.remove(input.id))),
    setModelHidden: base
      .input(z.object({ modelId: z.string(), hidden: z.boolean() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.setModelHidden(input.modelId, input.hidden)),
      ),
    setProfile: base
      .input(z.object({ modelId: z.string(), overrides: ProfileOverrides }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.setOverrides(input.modelId, input.overrides)),
      ),
  },
  silk: {
    list: base
      .input(z.object({ jobId: z.string(), includeSuperseded: z.boolean().default(false) }))
      .output(z.array(SilkEntry))
      .handler(({ context: c, input }) =>
        input.includeSuperseded ? c.silk.all(input.jobId) : c.silk.current(input.jobId),
      ),
    /** I add an entry: marked mine, never superseded automatically. */
    add: base
      .input(
        z.object({
          jobId: z.string(),
          taskId: z.string().nullable().default(null),
          kind: SilkKind,
          title: z.string(),
          body: z.string(),
        }),
      )
      .output(SilkEntry)
      .handler(({ context: c, input }) =>
        guard(() => c.silk.add({ ...input, authoredBy: "owner" })),
      ),
    /** I edit an entry: a new entry of mine supersedes it. */
    edit: base
      .input(z.object({ id: z.string(), title: z.string(), body: z.string() }))
      .output(SilkEntry)
      .handler(({ context: c, input }) =>
        guard(() => {
          const old = c.silk.get(input.id);
          if (!old) throw new Error(`No Silk entry ${input.id}.`);
          return c.silk.add({
            jobId: old.jobId,
            taskId: old.taskId,
            kind: old.kind,
            title: input.title,
            body: input.body,
            authoredBy: "owner",
            supersedes: old.id,
          });
        }),
      ),
    /** Look at the mirror now for hand edits, instead of within 30 s. */
    importMirror: base
      .input(z.object({ jobId: z.string() }))
      .output(z.array(z.string()))
      .handler(({ context: c, input }) => c.silk.checkMirror(input.jobId)),
  },
  inbox: {
    // Routing, notifications and the full inbox come in M1.7.
    list: base
      .input(InboxFilter)
      .output(z.array(InboxItem))
      .handler(({ context: c, input }) => c.inbox.list(input)),
    answer: base
      .input(z.object({ id: z.string(), answer: z.string().min(1) }))
      .handler(({ context: c, input }) =>
        guard(() => c.inbox.answer(input.id, input.answer, c.device)),
      ),
  },
  /** Storage use and pruning (Persistence-and-Recovery → Backups and pruning, M1.9). */
  storage: {
    usage: base.output(StorageUsage).handler(({ context: c }) => storageUsage(c.jobs.db, c.paths)),
    prune: base
      .input(PruneRequest)
      .output(z.object({ files: z.number(), bytes: z.number() }))
      .handler(({ context: c, input }) => guard(() => pruneLogs(c.jobs.db, c.bus, c.paths, input))),
  },
  /** Each agent's sessions and what they did (Checkpoint 1 → F1-3). */
  sessions: {
    list: base
      .input(z.object({ jobId: z.string() }))
      .output(z.array(SessionView))
      .handler(({ context: c, input }) =>
        c.jobs.db
          .select({
            s: sessionsTable,
            taskTitle: tasksTable.title,
            legName: legsTable.name,
            model: legModels.displayName,
          })
          .from(sessionsTable)
          .innerJoin(legsTable, eq(legsTable.id, sessionsTable.legId))
          .innerJoin(legModels, eq(legModels.id, sessionsTable.legModelId))
          .leftJoin(tasksTable, eq(tasksTable.id, sessionsTable.taskId))
          .where(eq(sessionsTable.jobId, input.jobId))
          .orderBy(desc(sessionsTable.startedAt), desc(sessionsTable.id))
          .all()
          .map(({ s, taskTitle, legName, model }) => ({
            id: s.id,
            jobId: s.jobId,
            taskId: s.taskId,
            taskTitle,
            purpose: s.attemptId?.startsWith("eye:") ? s.attemptId.slice(4) : "task",
            legId: s.legId,
            legName,
            model,
            effort: s.effort,
            startedAt: s.startedAt,
            endedAt: s.endedAt,
            endReason: s.endReason,
            tokens: s.inputTokens + s.outputTokens + s.cacheWriteTokens,
          })),
      ),
    log: base
      .input(z.object({ id: z.string(), after: z.number().int().nonnegative().default(0) }))
      .output(SessionLogPage)
      .handler(({ context: c, input }) => {
        const s = c.jobs.db
          .select()
          .from(sessionsTable)
          .where(eq(sessionsTable.id, input.id))
          .get();
        if (!s) throw new ORPCError("NOT_FOUND", { message: "No such session." });
        return { ...readSessionLog(s.logFile, input.after), live: s.endedAt === null };
      }),
  },
  metrics: {
    recent: base
      .input(z.object({ since: z.number().int().nonnegative().default(0) }))
      .output(z.array(MetricsSample))
      .handler(({ context: c, input }) => c.recentMetrics(input.since)),
  },
  notifications: {
    get: base.output(NotificationSettings).handler(({ context: c }) => c.notifications.settings()),
    update: base
      .input(
        z
          .object({
            desktop: z.boolean(),
            push: z.boolean(),
            email: z.boolean(),
            routes: NotificationSettings.shape.routes,
            quietHours: QuietHours.nullable(),
          })
          .partial(),
      )
      .output(NotificationSettings)
      .handler(({ context: c, input }) => {
        try {
          return c.notifications.update(input);
        } catch (error) {
          throw userError((error as Error).message);
        }
      }),
    configureEmail: base
      .input(z.object({ server: EmailSettings, password: z.string().min(1).optional() }))
      .output(NotificationSettings)
      .handler(async ({ context: c, input }) => {
        try {
          return await c.notifications.configureEmail(input.server, input.password);
        } catch (error) {
          if (error instanceof SecretStoreUnavailable) throw userError(error.message);
          throw error;
        }
      }),
    test: base
      .input(z.object({ channel: NotificationChannel.optional() }))
      .output(z.array(ChannelTestResult))
      .handler(({ context: c, input }) => c.notifications.test(input.channel)),
    vapidPublicKey: base.output(z.string()).handler(async ({ context: c }) => {
      try {
        return await c.notifications.vapidPublicKey();
      } catch (error) {
        if (error instanceof SecretStoreUnavailable) throw userError(error.message);
        throw error;
      }
    }),
    subscribe: base.input(PushSubscriptionInput).handler(({ context: c, input }) => {
      c.notifications.subscribe(input);
    }),
    unsubscribe: base
      .input(z.object({ endpoint: z.string() }))
      .handler(({ context: c, input }) => c.notifications.unsubscribe(input.endpoint)),
  },
};

export type Router = typeof router;
