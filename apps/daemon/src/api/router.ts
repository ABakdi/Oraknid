import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import {
  Autonomy,
  Budget,
  ChannelTestResult,
  ChatMessage,
  ChatView,
  DoctorCheck,
  DraftPatch,
  EmailSettings,
  Event,
  EyeMessage,
  EyeModels,
  FoundAgent,
  HelperAction,
  HelperMessage,
  InboxFilter,
  InboxItem,
  JobResult,
  JobView,
  LegView,
  MetricsSample,
  NewChat,
  NewJob,
  NewLeg,
  NewProject,
  NewProjectFrom,
  NewServer,
  NewTool,
  NotificationChannel,
  NotificationSettings,
  PlanComparison,
  PlanOutcome,
  ProfileOverrides,
  ProjectView,
  PruneRequest,
  PushSubscriptionInput,
  QuietHours,
  ServerSample,
  ServerState,
  ServerView,
  SessionLogPage,
  SessionView,
  SilkEntry,
  SilkKind,
  StorageUsage,
  SystemStatus,
  type TaskView,
  ToolView,
  UpdateTool,
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
import { type AppLock, IDLE_CHOICES, Pin } from "../auth/lock.ts";
import type { Chats } from "../chats/service.ts";
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
import type { EyeDecisions } from "../eye/decisions.ts";
import { draftStart, draftTalk, isThinking } from "../eye/draft.ts";
import {
  GlobalPolicy,
  readGlobalPolicy,
  readProjectPolicy,
  writeGlobalPolicy,
  writeProjectPolicy,
} from "../eye/policy.ts";
import { conversation, talk } from "../eye/talk.ts";
import type { Helper } from "../helper/service.ts";
import type { InboxStore } from "../inbox/store.ts";
import { discoverAgents } from "../legs/discover.ts";
import type { LegLogins } from "../legs/login.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { readSessionLog } from "../legs/session-log.ts";
import type { NestLink } from "../nest/link.ts";
import type { Notifications } from "../notify/notifications.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import type { Servers } from "../servers/service.ts";
import { MAX_RUNNING_JOBS, MAX_TASKS_PER_JOB, readSetting, writeSetting } from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import { pruneLogs, storageUsage } from "../storage/storage.ts";
import { TERMINAL_SETTING } from "../term/server.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { VERSION } from "../version.ts";
import type { GitHub } from "../workspace/github.ts";
import type { Projects } from "../workspace/projects.ts";
import { jobResult, mergeJob, taskDiff } from "../workspace/result.ts";
import { projectFrom } from "../workspace/sources.ts";
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
  /** Whether it came through The Nest (ADR-029). */
  remote: boolean;
  /** Its unlocked session, if any (ADR-029). */
  session: string | undefined;
  lock: AppLock;
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
  /** Logging Claude Code Legs in from the UI. */
  logins: LegLogins;
  /** The link to The Nest (Phase 4). */
  nest: NestLink;
  silk: SilkStore;
  inbox: InboxStore;
  projects: Projects;
  skills: SkillStore;
  /** Tools for skills (ADR-021). */
  tools: ToolRegistry;
  /** The Eye's decision models and plan comparisons (ADR-022). */
  decisions: EyeDecisions;
  /** Chats with my models (ADR-025). */
  chats: Chats;
  /** GitHub through my token (ADR-023). */
  github: GitHub;
  /** The Oraknid helper (ADR-024). */
  helper: Helper;
  /** My servers (ADR-026). */
  servers: Servers;
  devices: Devices;
  brain: EyeBrain;
  /** Opens a folder on this machine (xdg-open). */
  openPath: (path: string) => void;
  tmpDir: string;
}

const base = os.$context<ApiContext>();

const drafts = (c: ApiContext) => ({
  db: c.jobs.db,
  bus: c.bus,
  silk: c.silk,
  skills: c.skills,
  brain: c.brain,
  now: c.now,
});

/** The last `n` lines of a file, reading at most its last 512 KB. */
function tailFile(file: string, n: number): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const length = Math.min(size, 512 * 1024);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, size - length);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (size > length) lines.shift(); // a partial first line
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

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
  return JobView.parse({
    ...job,
    tasks,
    worktree: job.worktree,
    branch: job.branch,
    missingTools: c.tools.missing(job.tools),
  });
}

/** Turns a refusal (an illegal move, an unknown job) into a sentence for the UI. */
/**
 * Errors carry a code and a sentence (API-Contract, BR-17; Audit 1 → Q1-14).
 * Oraknid's own sentences (a plain Error) reach me as they are; anything
 * else (SQLite, git, a bug) gets a generic sentence, and its details go
 * to the daemon's log, not to the UI.
 */
async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof Error && error.constructor === Error) {
      const code =
        /^No (such |[a-z]+ )?\w*\s*[0-9A-HJKMNP-TV-Z]{26}\b|^No (job|task|project|device|session|inbox item)\b/.test(
          error.message,
        )
          ? "NOT_FOUND"
          : /already|is running|has ended|was withdrawn/.test(error.message)
            ? "CONFLICT"
            : "BAD_REQUEST";
      throw new ORPCError(code, { message: error.message });
    }
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
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
    /** A new project from a folder, a new empty one, a new GitHub repo or a cloned one (Phase 8). */
    createFrom: base
      .input(NewProjectFrom)
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(async () => ({ ...(await projectFrom(c, input)), jobCount: 0 })),
      ),
    list: base.output(z.array(ProjectView)).handler(({ context: c }) => c.projects.list()),
    /** The servers its jobs may use (Servers → Servers in projects). */
    setServers: base
      .input(z.object({ id: z.string(), serverIds: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => c.projects.setServers(input.id, input.serverIds)),
      ),
    /** The skills its jobs may use (Skills → Skills per project). */
    setSkills: base
      .input(z.object({ id: z.string(), skillIds: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => c.projects.setSkills(input.id, input.skillIds)),
      ),
    /** Hidden from the lists, kept for stats; or back again. */
    archive: base
      .input(z.object({ id: z.string(), archived: z.boolean() }))
      .handler(({ context: c, input }) =>
        guard(() => c.projects.setArchived(input.id, input.archived)),
      ),
    /** Gone from Oraknid with its jobs' history; my folder is left as it is. */
    delete: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ jobs: z.number(), folder: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.projects.remove(input.id, c.paths.logs))),
  },
  /** My servers: SSH, a state document, oraknid-monitor (ADR-026/027). */
  servers: {
    list: base.output(z.array(ServerView)).handler(({ context: c }) => c.servers.list()),
    add: base
      .input(NewServer)
      .output(ServerView)
      .handler(({ context: c, input }) => guard(() => c.servers.add(input))),
    update: base
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).optional(),
          description: z.string().optional(),
        }),
      )
      .handler(({ context: c, input }) => {
        const { id, ...patch } = input;
        return guard(() => c.servers.update(id, patch));
      }),
    /** Oraknid's key, discovery, the state document and oraknid-monitor, with my click. */
    setup: base
      .input(z.object({ id: z.string() }))
      .output(ServerView)
      .handler(({ context: c, input }) => guard(() => c.servers.setup(input.id))),
    discover: base
      .input(z.object({ id: z.string() }))
      .output(ServerState)
      .handler(({ context: c, input }) => guard(() => c.servers.discover(input.id))),
    acceptHostKey: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.servers.acceptHostKey(input.id))),
    state: base
      .input(z.object({ id: z.string(), version: z.number().int().optional() }))
      .output(ServerState.nullable())
      .handler(({ context: c, input }) => guard(() => c.servers.state(input.id, input.version))),
    editState: base
      .input(z.object({ id: z.string(), body: z.string().min(1) }))
      .output(ServerState)
      .handler(({ context: c, input }) => guard(() => c.servers.editState(input.id, input.body))),
    samples: base
      .input(z.object({ id: z.string(), since: z.number() }))
      .output(z.array(ServerSample))
      .handler(({ context: c, input }) => guard(() => c.servers.samples(input.id, input.since))),
    remove: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ cleaned: z.boolean() }))
      .handler(({ context: c, input }) => guard(() => c.servers.remove(input.id))),
  },
  /** The Oraknid helper: what I ask in words, done through this API (ADR-024). */
  helper: {
    conversation: base
      .output(z.array(HelperMessage))
      .handler(({ context: c }) => c.helper.conversation()),
    thinking: base.output(z.boolean()).handler(({ context: c }) => c.helper.thinking()),
    send: base
      .input(z.object({ text: z.string().min(1).max(8000) }))
      .handler(({ context: c, input }) => guard(() => c.helper.send(input.text))),
    decide: base
      .input(
        z.object({ messageId: z.string(), index: z.number().int().min(0), confirm: z.boolean() }),
      )
      .output(HelperAction)
      .handler(({ context: c, input }) =>
        guard(() =>
          c.helper.decide(
            input.messageId,
            input.index,
            input.confirm,
            c.remote && !c.devices.isFull(c.device),
          ),
        ),
      ),
    clear: base.handler(({ context: c }) => guard(() => c.helper.clear())),
  },
  /** GitHub through a token I paste (ADR-023). */
  github: {
    status: base
      .output(
        z.object({
          connected: z.boolean(),
          login: z.string().nullable(),
          error: z.string().nullable(),
        }),
      )
      .handler(({ context: c }) => c.github.status()),
    setToken: base
      .input(z.object({ token: z.string().min(10) }))
      .output(z.object({ login: z.string() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const login = await c.github.setToken(input.token);
          c.bus.publish({
            type: "github.connected",
            topic: "overview",
            jobId: null,
            payload: { login },
            actor: "owner",
          });
          return { login };
        }),
      ),
    removeToken: base.handler(({ context: c }) =>
      guard(async () => {
        await c.github.removeToken();
        c.bus.publish({
          type: "github.disconnected",
          topic: "overview",
          jobId: null,
          payload: {},
          actor: "owner",
        });
      }),
    ),
    repos: base
      .output(
        z.array(
          z.object({
            fullName: z.string(),
            name: z.string(),
            private: z.boolean(),
            description: z.string().nullable(),
            updatedAt: z.string(),
          }),
        ),
      )
      .handler(({ context: c }) => guard(() => c.github.repos())),
  },
  /** Chats with my models: talk and research (ADR-025). */
  chats: {
    list: base.output(z.array(ChatView)).handler(({ context: c }) => c.chats.list()),
    get: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ chat: ChatView, messages: z.array(ChatMessage) }))
      .handler(({ context: c, input }) => guard(() => c.chats.get(input.id))),
    create: base
      .input(NewChat)
      .output(ChatView)
      .handler(({ context: c, input }) => guard(() => c.chats.create(input))),
    send: base
      .input(z.object({ id: z.string(), text: z.string().min(1) }))
      .handler(({ context: c, input }) => guard(() => c.chats.send(input.id, input.text))),
    stop: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.chats.stop(input.id))),
    rename: base
      .input(z.object({ id: z.string(), title: z.string().min(1).max(120) }))
      .handler(({ context: c, input }) => guard(() => c.chats.rename(input.id, input.title))),
    setProjects: base
      .input(z.object({ id: z.string(), projectIds: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => c.chats.setProjects(input.id, input.projectIds)),
      ),
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.chats.remove(input.id))),
  },
  /** Tools for skills: MCP servers the daemon runs for a job's sessions (ADR-021). */
  tools: {
    list: base.output(z.array(ToolView)).handler(async ({ context: c }) => {
      const skills = c.skills.list();
      return Promise.all(
        c.tools.all().map((t) =>
          c.tools.view(
            t,
            skills.filter((s) => s.requiredTools.includes(t.name)).map((s) => s.name),
          ),
        ),
      );
    }),
    create: base
      .input(NewTool)
      .output(ToolView)
      .handler(({ context: c, input }) =>
        guard(async () => c.tools.view(await c.tools.create(input), [])),
      ),
    update: base
      .input(UpdateTool)
      .output(ToolView)
      .handler(({ context: c, input }) =>
        guard(async () => c.tools.view(await c.tools.update(input), [])),
      ),
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.tools.remove(input.id))),
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
    /** The task's work as a patch (Phase 2 → M2.0). */
    diff: base
      .input(z.object({ taskId: z.string() }))
      .output(
        z.object({
          text: z.string(),
          from: z.enum(["commit", "work", "none"]),
          truncated: z.boolean(),
        }),
      )
      .handler(({ context: c, input }) => guard(() => taskDiff(c.jobs.db, input.taskId, c.tmpDir))),
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
  /** Reaching me away from home through The Nest (Phase 4, Nest-Protocol). */
  nest: {
    status: base
      .output(
        z.object({
          configured: z.boolean(),
          url: z.string().nullable(),
          daemonId: z.string().nullable(),
          connected: z.boolean(),
          publicKey: z.string().nullable(),
          error: z.string().nullable(),
          loaderHash: z.string().nullable(),
        }),
      )
      .handler(({ context: c }) => c.nest.status()),
    configure: base
      .input(
        z.object({
          url: z.url(),
          secret: z.string().min(16),
          daemonId: z.string().min(1).optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(() => c.nest.configure(input.url, input.secret, input.daemonId)),
      ),
    /** A device for away: its link carries its keys in the fragment, never through The Nest. */
    pairAway: base
      .input(
        z.object({
          name: z.string().min(1).max(60),
          /** Full rights from the start (ADR-030): the PIN again. */
          full: z.boolean().default(false),
          pin: z.string().max(128).optional(),
        }),
      )
      .output(z.object({ link: z.string(), deviceId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          // A phone away from home opens only with the PIN (ADR-029).
          if (!c.lock.hasPin()) throw new Error("Set your PIN first (Settings → Security).");
          if (input.full) await c.lock.verify(c.device ?? "cli", input.pin ?? "", false);
          const r = await c.nest.pairAway(input.name);
          if (input.full) c.devices.setRights(r.deviceId, true);
          return r;
        }),
      ),
  },
  /** The PIN that unlocks every device (ADR-029). */
  lock: {
    status: base
      .output(
        z.object({
          pinSet: z.boolean(),
          unlocked: z.boolean(),
          idleMinutes: z.number(),
          triesLeft: z.number(),
          waitUntil: z.number().nullable(),
          remote: z.boolean(),
          /** This device has full rights (ADR-030). */
          full: z.boolean(),
        }),
      )
      .handler(({ context: c }) => {
        if (c.device === null)
          return { ...c.lock.status("cli", undefined), unlocked: true, remote: false, full: true };
        return {
          ...c.lock.status(c.device, c.session),
          remote: c.remote,
          full: c.devices.isFull(c.device),
        };
      }),
    unlock: base
      .input(z.object({ pin: z.string().min(1).max(128) }))
      .output(z.object({ session: z.string(), expiresAt: z.number() }))
      .handler(({ context: c, input }) =>
        guard(() => c.lock.unlock(c.device ?? "cli", input.pin, c.remote)),
      ),
    /** The first PIN, or a new one with the current one; at home only. */
    setPin: base
      .input(z.object({ current: z.string().max(128).nullable(), pin: Pin }))
      .output(z.object({ session: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.lock.setPin(c.device ?? "cli", input.current, input.pin, c.remote)),
      ),
    /** Lock this device, or every device. */
    lock: base
      .input(z.object({ everywhere: z.boolean().default(false) }))
      .handler(({ context: c, input }) =>
        c.lock.lock(
          input.everywhere ? null : (c.device ?? "cli"),
          input.everywhere ? undefined : c.session,
        ),
      ),
    /** `oraknid pin reset`: the CLI only, which is me on this computer. */
    reset: base.handler(({ context: c }) => {
      if (c.device !== null)
        throw new ORPCError("FORBIDDEN", {
          message: "Only `oraknid pin reset`, on this computer, resets the PIN.",
        });
      c.lock.resetPin();
    }),
    setIdle: base
      .input(
        z.object({
          minutes: z.number().refine((m) => (IDLE_CHOICES as readonly number[]).includes(m)),
        }),
      )
      .handler(({ context: c, input }) => c.lock.setIdleMinutes(input.minutes)),
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
            rights: z.enum(["standard", "full"]),
          }),
        ),
      )
      .handler(({ context: c }) => c.devices.list()),
    /** Full rights, away from home too (ADR-030): at home, with the PIN again. */
    setRights: base
      .input(z.object({ id: z.string(), full: z.boolean(), pin: z.string().max(128) }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          if (c.remote) throw new Error("Rights are given at home.");
          await c.lock.verify(c.device ?? "cli", input.pin, false);
          c.devices.setRights(input.id, input.full);
        }),
      ),
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
    /** How many jobs run at once (ADR-016). */
    maxRunningJobs: base
      .output(z.number().int())
      .handler(({ context: c }) =>
        readSetting(c.jobs.db, MAX_RUNNING_JOBS, z.number().int().min(1), 2),
      ),
    setMaxRunningJobs: base
      .input(z.object({ max: z.number().int().min(1).max(20) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          writeSetting(c.jobs.db, MAX_RUNNING_JOBS, z.number().int().min(1), input.max);
          c.bus.publish({
            type: "settings.updated",
            topic: "overview",
            jobId: null,
            payload: { maxRunningJobs: input.max },
            actor: "owner",
          });
          // Room now? Queued jobs start.
          c.runner.admit();
        }),
      ),
    /** How many tasks of one job run at once (ADR-016). */
    maxTasksPerJob: base
      .output(z.number().int())
      .handler(({ context: c }) =>
        readSetting(c.jobs.db, MAX_TASKS_PER_JOB, z.number().int().min(1), 1),
      ),
    setMaxTasksPerJob: base
      .input(z.object({ max: z.number().int().min(1).max(8) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          writeSetting(c.jobs.db, MAX_TASKS_PER_JOB, z.number().int().min(1), input.max);
          c.bus.publish({
            type: "settings.updated",
            topic: "overview",
            jobId: null,
            payload: { maxTasksPerJob: input.max },
            actor: "owner",
          });
        }),
      ),
    /** The terminal in the web UI: off until I turn it on (ADR-028). */
    terminal: base
      .output(z.boolean())
      .handler(({ context: c }) => readSetting(c.jobs.db, TERMINAL_SETTING, z.boolean(), false)),
    setTerminal: base.input(z.object({ enabled: z.boolean() })).handler(({ context: c, input }) =>
      guard(() => {
        writeSetting(c.jobs.db, TERMINAL_SETTING, z.boolean(), input.enabled);
        c.bus.publish({
          type: "settings.updated",
          topic: "overview",
          jobId: null,
          payload: { terminal: input.enabled },
          actor: "owner",
        });
      }),
    ),
    /** The Eye's Leg, a model per kind of decision, and the shadow planner (ADR-022). */
    eyeModels: base.output(EyeModels).handler(({ context: c }) => c.decisions.models()),
    setEyeModels: base
      .input(EyeModels)
      .output(EyeModels)
      .handler(({ context: c, input }) =>
        guard(() => {
          for (const id of Object.values(input))
            if (id && !c.registry.model(id)) throw new Error(`No Leg model ${id}.`);
          c.decisions.setModels(input);
          return c.decisions.models();
        }),
      ),
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
      .handler(({ context: c, input }) =>
        guard(() => {
          // Outside the sandbox only from home (ADR-029).
          if (c.remote && input.unsandboxed && !c.devices.isFull(c.device))
            throw new Error(
              "A job outside the sandbox can only be made on the computer running Oraknid.",
            );
          return { id: c.projects.createJob(input) };
        }),
      ),
    start: base.input(z.object({ id: z.string() })).handler(({ context: c, input }) =>
      guard(async () => {
        // A job's tools are set up before it starts (ADR-021).
        const job = c.jobs.get(input.id);
        const missing = job ? c.tools.missing(job.tools) : [];
        if (missing.length)
          throw new Error(
            `Set up ${missing.map((m) => `"${m}"`).join(", ")} in Settings → Tools first: the skill needs ${missing.length === 1 ? "it" : "them"}.`,
          );
        for (const row of job ? c.tools.byNames(job.tools) : []) {
          const view = await c.tools.view(row, []);
          if (view.missingSecrets.length)
            throw new Error(
              `The tool "${row.name}" is missing its secret ${view.missingSecrets.join(", ")}: set it in Settings → Tools.`,
            );
        }
        return c.runner.start(input.id);
      }),
    ),
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
    /** Its plans and their shadows', side by side, and how the plans that ran fared (ADR-022). */
    planComparisons: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ comparisons: z.array(PlanComparison), outcome: PlanOutcome }))
      .handler(({ context: c, input }) =>
        guard(() => ({
          comparisons: c.decisions.comparisons(input.id),
          outcome: c.decisions.outcome(input.id),
        })),
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
    /** A draft's options, changed as I go (New work page). */
    updateDraft: base
      .input(DraftPatch)
      .handler(({ context: c, input }) => guard(() => c.projects.updateDraft(input))),
    /** A draft, or a job that has ended, gone (its branch stays in my repo). */
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.projects.removeJob(input.id, c.paths.logs)),
      ),
    /** The Eye opens a draft's conversation: its first interview round, or a word. */
    draftStart: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => draftStart(drafts(c), input.id))),
    /** My message before the start: an interview answer, or context. */
    draftTalk: base
      .input(z.object({ id: z.string(), text: z.string().min(1) }))
      .handler(({ context: c, input }) => guard(() => draftTalk(drafts(c), input.id, input.text))),
    /** Whether The Eye is answering a draft now. */
    draftThinking: base
      .input(z.object({ id: z.string() }))
      .output(z.boolean())
      .handler(({ input }) => isThinking(input.id)),
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
    /** Higher runs first among queued jobs (ADR-016). */
    setPriority: base
      .input(z.object({ id: z.string(), priority: z.number().int().min(-10).max(10) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.jobs.require(input.id);
          c.jobs.db
            .update(jobsTable)
            .set({ priority: input.priority })
            .where(eq(jobsTable.id, input.id))
            .run();
          c.bus.publish({
            type: "job.priority",
            topic: `job:${input.id}`,
            jobId: input.id,
            payload: { priority: input.priority },
            actor: "owner",
          });
        }),
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
    /** Agents and model servers found on this machine, ready to add (Legs → Finding agents). */
    discover: base
      .output(z.array(FoundAgent))
      .handler(({ context: c }) => guard(() => discoverAgents(c.registry.all()))),
    /** Starts the official sign-in for a Claude Code Leg; the UI shows the link. */
    loginStart: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ url: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.logins.start(c.registry.require(input.id))),
      ),
    /** The code shown after signing in; the Leg is tested again. */
    loginFinish: base
      .input(z.object({ id: z.string(), code: z.string().min(1).max(2000) }))
      .output(z.object({ ok: z.boolean(), detail: z.string() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const r = await c.logins.finish(c.registry.require(input.id), input.code);
          if (r.ok) await c.health.check(input.id);
          return r;
        }),
      ),
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
          /** How many task sessions it runs at once (ADR-016). */
          maxSessions: z.number().int().min(1).max(10).optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(async () => {
          const { id, maxSessions, ...patch } = input;
          if (Object.keys(patch).length) c.registry.update(id, patch);
          if (maxSessions !== undefined) c.registry.setConfig(id, { maxSessions });
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
  /** The daemon's own log, its last lines (Phase 2 → M2.0). */
  logs: {
    tail: base
      .input(z.object({ lines: z.number().int().positive().max(2000).default(300) }))
      .output(z.object({ file: z.string(), lines: z.array(z.string()) }))
      .handler(({ context: c, input }) => ({
        file: c.paths.daemonLog,
        lines: tailFile(c.paths.daemonLog, input.lines),
      })),
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
      c.notifications.subscribe(input, c.device);
    }),
    unsubscribe: base
      .input(z.object({ endpoint: z.string() }))
      .handler(({ context: c, input }) => c.notifications.unsubscribe(input.endpoint)),
  },
};

export type Router = typeof router;
