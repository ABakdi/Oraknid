import {
  Autonomy,
  ChannelTestResult,
  DoctorCheck,
  EmailSettings,
  InboxItem,
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
  PushSubscriptionInput,
  SilkEntry,
  SilkKind,
  SystemStatus,
} from "@oraknid/contracts";
import {
  type InhibitorState,
  type SandboxStatus,
  SecretStoreUnavailable,
  type ServiceManager,
} from "@oraknid/os";
import { ORPCError, os } from "@orpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { jobs as jobsTable, taskEdges, tasks as tasksTable } from "../db/schema.ts";
import { runDoctor } from "../doctor.ts";
import type { JobStore } from "../engine/jobs.ts";
import type { JobRunner } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import { GlobalPolicy, readGlobalPolicy, writeGlobalPolicy } from "../eye/policy.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { Notifications } from "../notify/notifications.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import { VERSION } from "../version.ts";
import type { Projects } from "../workspace/projects.ts";

export interface ApiContext {
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

function jobView(c: ApiContext, id: string): JobView {
  const job = c.jobs.require(id);
  const edges = c.jobs.db.select().from(taskEdges).all();
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
    create: base
      .input(NewProject)
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(() => ({ ...c.projects.create(input), jobCount: 0 })),
      ),
    list: base.output(z.array(ProjectView)).handler(({ context: c }) => c.projects.list()),
  },
  policies: {
    get: base.output(GlobalPolicy).handler(({ context: c }) => readGlobalPolicy(c.jobs.db)),
    update: base
      .input(GlobalPolicy)
      .handler(({ context: c, input }) => guard(() => writeGlobalPolicy(c.jobs.db, c.bus, input))),
  },
  settings: {
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
    /** Changeable while the job runs: the next decision uses it. */
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
      .input(z.object({ state: z.enum(["open", "answered", "expired", "withdrawn"]).optional() }))
      .output(z.array(InboxItem))
      .handler(({ context: c, input }) => c.inbox.list(input.state)),
    answer: base
      .input(z.object({ id: z.string(), answer: z.string().min(1) }))
      .handler(({ context: c, input }) => guard(() => c.inbox.answer(input.id, input.answer))),
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
      .input(z.object({ desktop: z.boolean(), push: z.boolean(), email: z.boolean() }).partial())
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
