import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
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
  EyeThought,
  FolderList,
  FolderListInput,
  FoundAgent,
  GitHubAccount,
  GitHubBranch,
  GitHubCommitDetail,
  GitHubCommitSummary,
  GitHubFile,
  GitHubLimit,
  GitHubLinkInput,
  GitHubName,
  GitHubPullDetail,
  GitHubPullSummary,
  GitHubRepoDetail,
  GitHubRepoList,
  GitHubRepoRef,
  GitHubTree,
  githubPage,
  HelperAction,
  HelperContext,
  HelperMessage,
  InboxFilter,
  InboxItem,
  Insight,
  JobExport,
  JobRename,
  JobResult,
  JobView,
  LegPlanUsage,
  LegView,
  LogSource,
  MachineHealth,
  MailAccountView,
  MailCompose,
  MailDetected,
  MailDraftView,
  MailFolderView,
  MailMessageView,
  MailTestResult,
  MailThreadPage,
  MetricsSample,
  NewChat,
  NewFolderInput,
  NewJob,
  NewLeg,
  NewMailAccount,
  NewProject,
  NewProjectFrom,
  NewProjectRepo,
  NewServer,
  NewTool,
  NotificationChannel,
  NotificationSettings,
  PlanComparison,
  PlanHistory,
  PlanOutcome,
  ProfileOverrides,
  ProjectArchive,
  ProjectBudget,
  ProjectBudgetView,
  ProjectDelete,
  ProjectRepo,
  ProjectRepoPatch,
  ProjectView,
  PruneRequest,
  PushSubscriptionInput,
  QuestionAnswers,
  QuietHours,
  RemovalPreview,
  RemovalResult,
  ResourceSettings,
  ServerDatabases,
  ServerDocker,
  ServerLogSource,
  ServerLogs,
  ServerPatch,
  ServerProxies,
  ServerRestart,
  ServerRole,
  ServerSample,
  ServerState,
  ServerStateVersion,
  ServerTest,
  ServerTestResult,
  ServerTraffic,
  ServerView,
  SessionLogPage,
  SessionView,
  SilkByJob,
  SilkEntry,
  SilkKind,
  StorageUsage,
  SystemStatus,
  TalkMode,
  type TaskView,
  TextPolish,
  ToolView,
  UpdateRun,
  UpdatesView,
  UpdateTool,
} from "@oraknid/contracts";
import { scrubDeep, scrubSecrets } from "@oraknid/core";
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
import type { Backups } from "../backups/service.ts";
import type { Chats } from "../chats/service.ts";
import type { Downloads } from "../cloud/routes.ts";
import type { Cloud } from "../cloud/service.ts";
import {
  attempts as attemptsTable,
  events as eventsTable,
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
import { jobTokens, projectBudgetView, setBudget, setProjectBudget } from "../eye/budgets.ts";
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
import { draftAnswer, draftStart, draftTalk, isThinking } from "../eye/draft.ts";
import { endSteps } from "../eye/ending.ts";
import { interviewRounds } from "../eye/interview.ts";
import { cancelLegWork, pauseLegSessions, readLegWork } from "../eye/leg-work.ts";
import {
  GlobalPolicy,
  readGlobalPolicy,
  readProjectPolicy,
  writeGlobalPolicy,
  writeProjectPolicy,
} from "../eye/policy.ts";
import { polishText } from "../eye/polish.ts";
import {
  answerInProject,
  conversation,
  projectConversation,
  stopThinking,
  talk,
  talkInProject,
} from "../eye/talk.ts";
import type { EyeThinking } from "../eye/thinking.ts";
import type { Helper } from "../helper/service.ts";
import { currentRequestId } from "../http/request-id.ts";
import type { InboxStore } from "../inbox/store.ts";
import { discoverAgents } from "../legs/discover.ts";
import type { LegLogins } from "../legs/login.ts";
import type { PlanUsage } from "../legs/plan-usage.ts";
import type { LegRegistry } from "../legs/registry.ts";
import { readSessionLog } from "../legs/session-log.ts";
import type { MailService } from "../mail/service.ts";
import type { NestLink } from "../nest/link.ts";
import type { Notifications } from "../notify/notifications.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { readResources, type Work, writeResources } from "../resources/work.ts";
import {
  ensureServerProject,
  serverConversation,
  serverJobsDir,
  serverOf,
  talkToServer,
} from "../servers/server-jobs.ts";
import type { Servers } from "../servers/service.ts";
import {
  DEFAULT_RUNNING_JOBS,
  followUpKey,
  INTERVIEW_ROUNDS,
  MAX_RUNNING_JOBS,
  MAX_TASKS_PER_JOB,
  projectPorts,
  projectPortsKey,
  readSetting,
  writeSetting,
} from "../settings.ts";
import type { SilkStore } from "../silk/store.ts";
import type { SkillStore } from "../skills/store.ts";
import { pruneLogs, storageUsage } from "../storage/storage.ts";
import { TERMINAL_SETTING } from "../term/server.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Asker, Updates } from "../updates/service.ts";
import { VERSION } from "../version.ts";
import { listFolders, makeFolder } from "../workspace/folders.ts";
import { type GitHub, GitHubError } from "../workspace/github.ts";
import type { Repos } from "../workspace/github-repos.ts";
import { NotAGitRepo, type Projects } from "../workspace/projects.ts";
import { ProjectRemoval } from "../workspace/removal.ts";
import { jobResult, mergeJob, taskDiff } from "../workspace/result.ts";
import { projectFrom } from "../workspace/sources.ts";
import { backupsRouter } from "./backups.ts";
import { cloudRouter } from "./cloud.ts";
import {
  Activity,
  activity,
  Charts,
  ChartsInput,
  StatsScope,
  Summary,
  charts as statsCharts,
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
  /** Where every job's tasks ask to start (ADR-050): why a ready task waits. */
  work: Work;
  /** The machine's health as the guard sees it (ADR-050). */
  machineHealth: () => MachineHealth;
  jobs: JobStore;
  runner: JobRunner;
  registry: LegRegistry;
  health: { check(id: string): Promise<void> };
  /** A Leg's plan usage in view (ADR-039). */
  planUsage: PlanUsage;
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
  /** My repositories, read through GitHub's API (ADR-040). */
  repos: Repos;
  /** The Oraknid helper (ADR-024). */
  helper: Helper;
  /** My servers (ADR-026). */
  servers: Servers;
  /** Scheduled, encrypted database backups (ADR-044). */
  backups: Backups;
  /** Cloud storage, and one-time download links (ADR-046). */
  cloud: Cloud;
  downloads: Downloads;
  /** My mail (ADR-032). */
  mail: MailService;
  devices: Devices;
  /** Oraknid's own updates (ADR-048). */
  updates: Updates;
  brain: EyeBrain;
  /** What The Eye is thinking now, and what it thought (M13.25). */
  thinking?: EyeThinking;
  /** Opens a folder on this machine (xdg-open). */
  openPath: (path: string) => void;
  tmpDir: string;
}

/**
 * Every call's error carries its request id (`data.requestId`), the one in
 * the response's `x-request-id` header and the daemon's log lines for it.
 */
const base = os.$context<ApiContext>().use(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    const requestId = currentRequestId();
    if (!requestId) throw error;
    if (error instanceof ORPCError) {
      const data =
        error.data && typeof error.data === "object" && !Array.isArray(error.data)
          ? error.data
          : {};
      throw new ORPCError(error.code, {
        status: error.status,
        message: error.message,
        data: { ...data, requestId },
        cause: error.cause,
      });
    }
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
      data: { requestId },
    });
  }
});

/** Archiving and deleting a project with my choices (its folder, its GitHub repos). */
const removal = (c: ApiContext) =>
  new ProjectRemoval({
    projects: c.projects,
    github: c.github,
    bus: c.bus,
    logsDir: c.paths.logs,
    keep: [c.paths.dataDir, c.paths.configDir],
    cancelJob: (id) => c.runner.cancel(id, "Cancelled to archive or delete its project."),
  });

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

/** A job started: its tools are set up first (ADR-021). */
async function startJob(c: ApiContext, id: string) {
  const job = c.jobs.get(id);
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
  return c.runner.start(id);
}

/**
 * New work on an ended job (Jobs-and-Projects → Follow-up jobs): a job in
 * the same project, with the same skill and choices, starting from the
 * ended job's branch, started at once.
 */
async function followUp(c: ApiContext, fromId: string, goal: string): Promise<string> {
  const from = c.jobs.db.select().from(jobsTable).where(eq(jobsTable.id, fromId)).get();
  if (!from) throw new Error(`No job ${fromId}.`);
  const id = c.projects.createJob({
    projectId: from.projectId,
    goal: `${goal}\n\nThis continues the job “${from.title}”: start from what it built${from.branch ? ` (its branch ${from.branch}, where this job starts)` : ""}.`,
    skillId: from.skillId,
    autonomy: from.autonomy,
    allowedLegIds: from.allowedLegIds as string[],
    verify: [],
    inputs: [],
    unsandboxed: false,
    budget: from.budget,
  } as never);
  if (from.branch) writeSetting(c.jobs.db, followUpKey(id), z.string(), from.branch);
  await startJob(c, id);
  return id;
}

/** What talking to The Eye needs, from a job or from its project (ADR-034). */
/** A project's jobs, by id. */
const projectJobIds = (c: ApiContext, projectId: string) =>
  c.jobs.db
    .select({ id: jobsTable.id })
    .from(jobsTable)
    .where(eq(jobsTable.projectId, projectId))
    .all()
    .map((j) => j.id);

const talkDeps = (c: ApiContext) => ({
  db: c.jobs.db,
  bus: c.bus,
  silk: c.silk,
  runner: c.runner,
  brain: c.brain,
  tmpDir: c.tmpDir,
  now: c.now,
  // My message can answer what the job waits on, or end its interview.
  inbox: c.inbox,
  followUp: (from: string, goal: string) => followUp(c, from, goal),
  // A project's first job, from my first message there: the project's skills and budget.
  newJob: (projectId: string, goal: string) =>
    c.projects.createJob({
      projectId,
      goal,
      inputs: [],
      autonomy: "standard",
      allowedLegIds: [],
      verify: [],
      unsandboxed: false,
    }),
  startJob: async (id: string) => {
    await startJob(c, id);
  },
  endNow: (id: string) =>
    endSteps({ db: c.jobs.db, bus: c.bus, github: c.github, projects: c.projects }, id),
  ...(c.thinking ? { thinking: c.thinking } : {}),
});

/** Talking to a server's Eye (ADR-049): talking's deps, and the server's own. */
const serverTalkDeps = (c: ApiContext) => ({
  ...talkDeps(c),
  servers: c.servers,
  projects: c.projects,
  dir: serverJobsDir(c.paths.dataDir),
});

/**
 * Work on a server is asked from home on a standard device, as every
 * server action (ADR-049): its own project's conversation is the server's.
 */
function awayFromServer(c: ApiContext, projectId: string) {
  if (c.remote && !c.devices.isFull(c.device) && serverOf(c.jobs.db, projectId))
    throw new Error(
      "Work on a server is asked from the computer running Oraknid, or from a device with full rights.",
    );
}

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
  const legWork = readLegWork(c.jobs.db, id);
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
      waitingForLegId: legWork.waitFor[t.id] ?? null,
      waitingReason:
        t.state === "ready" || t.state === "pending" ? c.work.reasonOf(id, t.id) : null,
      avoidLegIds: [...new Set([...legWork.avoid, ...(legWork.taskAvoid[t.id] ?? [])])],
    }));
  return JobView.parse({
    ...job,
    tasks,
    worktree: job.worktree,
    branch: job.branch,
    missingTools: c.tools.missing(job.tools),
    tokens: jobTokens(c.jobs.db, id),
  });
}

/** Each Leg session of a job, newest first (Checkpoint 1). */
function sessionViews(c: ApiContext, jobId: string): SessionView[] {
  return c.jobs.db
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
    .where(eq(sessionsTable.jobId, jobId))
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
    }));
}

/**
 * A job's full record (`jobs.export`): everything the job's screens show,
 * in one JSON. Each string is scrubbed of known secret values and
 * secret-shaped text (BR-13); keychain values and tokens are never read.
 */
function jobExport(c: ApiContext, id: string): JobExport {
  const job = jobView(c, id);
  let result: JobResult | null = null;
  try {
    result = jobResult(c.jobs.db, id);
  } catch {}
  const record: JobExport = {
    format: "oraknid.job-export",
    version: 1,
    exportedAt: c.now(),
    job,
    attempts: c.jobs.db
      .select()
      .from(attemptsTable)
      .where(eq(attemptsTable.jobId, id))
      .orderBy(asc(attemptsTable.startedAt), asc(attemptsTable.id))
      .all()
      .map((a) => ({
        id: a.id,
        taskId: a.taskId,
        legId: a.legId,
        legModelId: a.legModelId,
        effort: a.effort,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        outcome: a.outcome,
        escalations: a.escalations,
      })),
    sessions: sessionViews(c, id),
    events: c.jobs.db
      .select()
      .from(eventsTable)
      .where(eq(eventsTable.jobId, id))
      .orderBy(asc(eventsTable.seq))
      .all(),
    silk: c.silk.all(id),
    conversation: conversation(c.jobs.db, id),
    result,
  };
  const known = [...c.secrets.known()];
  return scrubDeep(record, (text) => scrubSecrets(text, known));
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
    // GitHub's refusals, already in words (ADR-040).
    if (error instanceof GitHubError)
      throw new ORPCError(
        error.status === 404
          ? "NOT_FOUND"
          : error.status === 403 || error.status === 429
            ? "TOO_MANY_REQUESTS"
            : "BAD_REQUEST",
        { message: error.message },
      );
    // A folder that isn't a git repo: its message says what to choose (Jobs-and-Projects).
    if (error instanceof NotAGitRepo)
      throw new ORPCError("BAD_REQUEST", { message: error.message });
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

/** Who asks for an update: the CLI and a device at home, or away from home with its rights (ADR-030). */
const asker = (c: ApiContext): Asker => ({
  remote: c.remote,
  full: c.device === null || c.devices.isFull(c.device),
});

// Procedures follow docs/02-Architecture/API-Contract.md. Later milestones add the rest.
/** What runs on a server (ADR-043): each part read while its screen asks; restarting asked first. */
const ServerPart = z.object({ id: z.string(), fresh: z.boolean().optional() });
const serverInsightRoutes = {
  docker: base
    .input(ServerPart)
    .output(Insight(ServerDocker))
    .handler(({ context: c, input }) =>
      guard(() => c.servers.insight.part(input.id, "docker", input.fresh)),
    ),
  databases: base
    .input(ServerPart)
    .output(Insight(ServerDatabases))
    .handler(({ context: c, input }) =>
      guard(() => c.servers.insight.part(input.id, "databases", input.fresh)),
    ),
  proxy: base
    .input(ServerPart)
    .output(Insight(ServerProxies))
    .handler(({ context: c, input }) =>
      guard(() => c.servers.insight.part(input.id, "proxy", input.fresh)),
    ),
  traffic: base
    .input(ServerPart)
    .output(Insight(ServerTraffic))
    .handler(({ context: c, input }) =>
      guard(() => c.servers.insight.part(input.id, "traffic", input.fresh)),
    ),
  logSources: base
    .input(z.object({ id: z.string() }))
    .output(z.array(ServerLogSource))
    .handler(({ context: c, input }) => guard(() => c.servers.insight.logSources(input.id))),
  /** A log's last lines or a search; following one is on the live socket. */
  logs: base
    .input(
      z.object({
        id: z.string(),
        source: LogSource,
        lines: z.number().int().min(1).max(2000).optional(),
        search: z.string().max(200).optional(),
      }),
    )
    .output(ServerLogs)
    .handler(({ context: c, input }) =>
      guard(() =>
        c.servers.insight.logs(input.id, input.source, {
          ...(input.lines ? { lines: input.lines } : {}),
          ...(input.search ? { search: input.search } : {}),
        }),
      ),
    ),
  restart: base
    .input(ServerRestart)
    .output(z.object({ ok: z.literal(true) }))
    .handler(({ context: c, input }) => guard(() => c.servers.insight.restart(input))),
};

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
  /** Oraknid's own updates (ADR-048). */
  updates: {
    status: base.output(UpdatesView).handler(({ context: c }) => c.updates.view(asker(c))),
    /** Check now: asks GitHub at once; a failure is in the view, in words. */
    check: base.output(UpdatesView).handler(async ({ context: c }) => {
      await c.updates.check();
      return c.updates.view(asker(c));
    }),
    /** Update now; `confirm` when jobs are running (they pause and go on after the restart). */
    run: base
      .input(z.object({ confirm: z.boolean().default(false) }))
      .output(UpdateRun)
      .handler(({ context: c, input }) =>
        guard(() => {
          const who = asker(c);
          if (who.remote && !who.full)
            throw new ORPCError("FORBIDDEN", {
              message: "Updating Oraknid away from home needs a device with full rights.",
            });
          return c.updates.run(who, input);
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
    /** Opens a project's folder in this computer's file manager (xdg-open). */
    openFolder: base.input(z.object({ id: z.string() })).handler(({ context: c, input }) =>
      guard(() => {
        const folder = c.projects.require(input.id).workspacePath;
        if (!existsSync(folder)) throw new Error(`The project's folder isn't here: ${folder}.`);
        c.openPath(folder);
      }),
    ),
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
    /** My projects; with `servers`, the servers' own too (ADR-049), which are hidden otherwise. */
    list: base
      .input(z.object({ servers: z.boolean().optional() }).optional())
      .output(z.array(ProjectView))
      .handler(({ context: c, input }) =>
        c.projects.list().filter((p) => input?.servers || !p.serverId),
      ),
    /** One project's view, as `list` gives it (Audit 1 → Q1-15); a server's own too. */
    get: base
      .input(z.object({ id: z.string() }))
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(() => {
          const p = c.projects.list().find((x) => x.id === input.id);
          if (!p) throw new ORPCError("NOT_FOUND", { message: "No such project." });
          return p;
        }),
      ),
    /** Ports on this computer its jobs may reach, like a local database (Sandboxing → network). */
    localPorts: base
      .input(z.object({ id: z.string() }))
      .output(z.array(z.number().int()))
      .handler(({ context: c, input }) => projectPorts(c.jobs.db, input.id)),
    setLocalPorts: base
      .input(
        z.object({ id: z.string(), ports: z.array(z.number().int().min(1).max(65535)).max(32) }),
      )
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          writeSetting(c.jobs.db, projectPortsKey(input.id), z.array(z.number().int()), [
            ...new Set(input.ports),
          ]);
          c.bus.publish({
            type: "project.localPorts",
            topic: "overview",
            jobId: null,
            payload: { projectId: input.id, ports: input.ports },
            actor: "owner",
          });
        }),
      ),
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
    /**
     * The project's conversation with The Eye (ADR-034): its messages from
     * every job, in order. Each names the job it was about.
     */
    conversation: base
      .input(z.object({ id: z.string() }))
      .output(z.array(EyeMessage))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          return projectConversation(c.jobs.db, input.id);
        }),
      ),
    /**
     * My message to the project's Eye: to the job going now, else to the
     * newest ended one (new work starts a follow-up), else a new job from it.
     */
    talk: base
      .input(
        z.object({
          id: z.string(),
          text: z.string().min(1).max(8000),
          /** While The Eye thinks (M13.25): stop and redo with it, add it, or let Oraknid choose. */
          mode: TalkMode.optional(),
        }),
      )
      .output(z.object({ id: z.string(), jobId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          awayFromServer(c, input.id);
          return talkInProject(
            talkDeps(c),
            input.id,
            input.text.trim(),
            {},
            input.mode ?? "context",
          );
        }),
      ),
    /**
     * What The Eye thought and is thinking in the project (M13.25): each
     * reasoning call of its jobs, oldest first; what it wrote is its
     * session's log (`sessions.log`).
     */
    thinking: base
      .input(z.object({ id: z.string() }))
      .output(z.array(EyeThought))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          return c.thinking?.list(projectJobIds(c, input.id)) ?? [];
        }),
      ),
    /** Stop: what The Eye is thinking in the project ends now (M13.25). */
    stopThinking: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ stopped: z.number().int().nonnegative() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          return { stopped: stopThinking(talkDeps(c), projectJobIds(c, input.id)) };
        }),
      ),
    /**
     * My answers to The Eye's questions in the project's conversation
     * (ADR-037): to the inbox item they belong to, or as my next message.
     */
    answer: base
      .input(z.object({ id: z.string(), messageId: z.string(), answers: QuestionAnswers }))
      .output(z.object({ id: z.string(), jobId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          awayFromServer(c, input.id);
          return answerInProject(
            { ...talkDeps(c), inbox: c.inbox },
            input.id,
            input.messageId,
            input.answers,
            c.device,
          );
        }),
      ),
    /**
     * Its GitHub link (ADR-038): the account and repository Oraknid uses for
     * it, or none. In a project of several repos, one repo's (ADR-042).
     */
    setGitHub: base
      .input(
        z.object({
          id: z.string(),
          link: GitHubLinkInput.nullable(),
          repo: z.string().optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(async () => {
          if (input.link) {
            const logins = (await c.github.accounts()).map((a) => a.login);
            if (!logins.includes(input.link.account))
              throw new Error(`No GitHub account ${input.link.account} in Oraknid.`);
          }
          c.projects.setGitHub(input.id, input.link, "owner", input.repo ?? null);
        }),
      ),
    /** A server's role in the project (ADR-042): testing, staging, production… */
    setServerRole: base
      .input(z.object({ id: z.string(), serverId: z.string(), role: ServerRole }))
      .handler(({ context: c, input }) =>
        guard(() => c.projects.setServerRole(input.id, input.serverId, input.role)),
      ),
    /** Looks again for the git repositories in its folder (ADR-042). */
    detectRepos: base
      .input(z.object({ id: z.string() }))
      .output(z.array(ProjectRepo))
      .handler(({ context: c, input }) => guard(() => c.projects.detectRepos(input.id))),
    /** A repo added to it: a folder of it, a new empty one, or a clone (ADR-042). */
    addRepo: base
      .input(NewProjectRepo)
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(async () => {
          const p = await c.projects.addRepo(
            input,
            (url, dest, login) => c.github.clone(url, dest, login),
            (fullName) => c.github.cloneUrl(fullName),
          );
          return { ...p, jobCount: c.projects.list().find((x) => x.id === p.id)?.jobCount ?? 0 };
        }),
      ),
    /** A repo renamed, or its release and work branches changed (ADR-042). */
    updateRepo: base
      .input(ProjectRepoPatch)
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(() => {
          const p = c.projects.updateRepo(input);
          return { ...p, jobCount: c.projects.list().find((x) => x.id === p.id)?.jobCount ?? 0 };
        }),
      ),
    /** A repo no longer part of it; its folder stays (ADR-042). */
    removeRepo: base
      .input(z.object({ id: z.string(), name: z.string() }))
      .output(ProjectView)
      .handler(({ context: c, input }) =>
        guard(() => {
          const p = c.projects.removeRepo(input.id, input.name);
          return { ...p, jobCount: c.projects.list().find((x) => x.id === p.id)?.jobCount ?? 0 };
        }),
      ),
    /** Its budget across its jobs, and what they used (ADR-034). */
    budget: base
      .input(z.object({ id: z.string() }))
      .output(ProjectBudgetView)
      .handler(({ context: c, input }) =>
        guard(() => {
          c.projects.require(input.id);
          return projectBudgetView(c.jobs.db, input.id);
        }),
      ),
    setBudget: base
      .input(z.object({ id: z.string(), budget: ProjectBudget }))
      .output(z.object({ changed: z.array(z.string()) }))
      .handler(({ context: c, input }) =>
        guard(() => setProjectBudget(c.jobs.db, c.bus, input.id, input.budget)),
      ),
    /**
     * What deleting or archiving would touch (Jobs-and-Projects → Archiving
     * and deleting a project): the folder and its size, its running jobs,
     * its repos with their GitHub repos and the token's scopes, and what
     * deleting the folder would lose (changes not committed, commits not
     * pushed), so archiving may delete it only when nothing would be.
     */
    removalPreview: base
      .input(z.object({ id: z.string() }))
      .output(RemovalPreview)
      .handler(({ context: c, input }) => guard(() => removal(c).preview(input.id))),
    /**
     * Hidden from the lists, kept for stats, its GitHub repos archived and
     * its folder deleted when I tick them; or back again, its repos
     * unarchived when I tick them and its folder cloned back if it went.
     */
    archive: base
      .input(ProjectArchive)
      .output(RemovalResult)
      .handler(({ context: c, input }) => guard(() => removal(c).archive(input))),
    /**
     * Gone from Oraknid with its jobs' history; its folder and its GitHub
     * repos too when I tick them. Each step is said, done or not.
     */
    delete: base
      .input(ProjectDelete)
      .output(RemovalResult)
      .handler(({ context: c, input }) => guard(() => removal(c).delete(input))),
  },
  /**
   * The folder picker (Web-UI → The folder picker): this machine's folders by
   * name, never a file; a folder made in one I chose. Home only for a
   * standard device, like making a project.
   */
  files: {
    folders: base
      .input(FolderListInput.default({ showHidden: false }))
      .output(FolderList)
      .handler(({ input }) => guard(() => listFolders(input))),
    makeFolder: base
      .input(NewFolderInput)
      .output(z.object({ path: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          const made = makeFolder(input);
          c.bus.publish({
            type: "folder.created",
            topic: "overview",
            jobId: null,
            payload: { path: made.path },
            actor: "owner",
          });
          return made;
        }),
      ),
  },
  /** My servers: SSH, a state document, oraknid-monitor (ADR-026/027). */
  servers: {
    list: base.output(z.array(ServerView)).handler(({ context: c }) => c.servers.list()),
    add: base
      .input(NewServer)
      .output(ServerView)
      .handler(({ context: c, input }) => guard(() => c.servers.add(input))),
    /** Anything about it: name, description, address, user, or new credentials (empty: the kept ones). */
    update: base
      .input(ServerPatch)
      .output(ServerView)
      .handler(({ context: c, input }) => {
        const { id, ...patch } = input;
        return guard(() => c.servers.update(id, patch));
      }),
    /** Test connection: the form as it is, nothing saved; with `id`, missing credentials are the kept ones. */
    test: base
      .input(ServerTest)
      .output(ServerTestResult)
      .handler(({ context: c, input }) => guard(() => c.servers.test(input))),
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
    /** Every version of its state document, newest first; the job whose end wrote each (ADR-049). */
    history: base
      .input(z.object({ id: z.string() }))
      .output(z.array(ServerStateVersion))
      .handler(({ context: c, input }) => guard(() => c.servers.history(input.id))),
    /** My Production mark on the server itself: every job that reaches it asks before a change (ADR-049). */
    setProduction: base
      .input(z.object({ id: z.string(), production: z.boolean() }))
      .output(ServerView)
      .handler(({ context: c, input }) =>
        guard(() => c.servers.setProduction(input.id, input.production)),
      ),
    /**
     * The server's conversation with The Eye (ADR-049): its own project's,
     * questions answered without a job and its jobs' messages, in order.
     */
    conversation: base
      .input(z.object({ id: z.string() }))
      .output(z.array(EyeMessage))
      .handler(({ context: c, input }) =>
        guard(() => {
          c.servers.row(input.id);
          return serverConversation(c.jobs.db, input.id);
        }),
      ),
    /**
     * My message to the server's Eye: to the job going on it; else a
     * question answered from its state document, or a new server job.
     */
    talk: base
      .input(z.object({ id: z.string(), text: z.string().min(1).max(8000) }))
      .output(z.object({ id: z.string(), jobId: z.string().nullable(), projectId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          const r = talkToServer(serverTalkDeps(c), input.id, input.text.trim());
          return { ...r, projectId: ensureServerProject(serverTalkDeps(c), input.id) };
        }),
      ),
    /** My answers to The Eye's questions in the server's conversation (ADR-037). */
    answer: base
      .input(z.object({ id: z.string(), messageId: z.string(), answers: QuestionAnswers }))
      .output(z.object({ id: z.string(), jobId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() =>
          answerInProject(
            { ...talkDeps(c), inbox: c.inbox },
            ensureServerProject(serverTalkDeps(c), input.id),
            input.messageId,
            input.answers,
            c.device,
          ),
        ),
      ),
    ...serverInsightRoutes,
  },
  /** Database backups: plans, runs, keys, Verify, Restore (ADR-044). */
  backups: backupsRouter,
  /** Cloud storage: providers and the pool (ADR-046). */
  cloud: cloudRouter,
  /** A text of mine rephrased by a quick model, for any textarea (Chats-and-Helper → Fix wording). */
  text: {
    polish: base
      .input(TextPolish)
      .output(z.object({ text: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => polishText(c.brain, join(c.tmpDir, "polish"), input)),
      ),
  },
  /** The Oraknid helper: what I ask in words, done through this API (ADR-024). */
  helper: {
    conversation: base
      .output(z.array(HelperMessage))
      .handler(({ context: c }) => c.helper.conversation()),
    thinking: base.output(z.boolean()).handler(({ context: c }) => c.helper.thinking()),
    send: base
      // With what the web app knows: where I am, the guide, the screens (ADR-041).
      .input(z.object({ text: z.string().min(1).max(8000), context: HelperContext.optional() }))
      .handler(({ context: c, input }) =>
        guard(() => c.helper.send(input.text, input.context ?? {})),
      ),
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
    /** What became of an action shown in my browser: not shown, and why (ADR-041). */
    shown: base
      .input(
        z.object({
          messageId: z.string(),
          index: z.number().int().min(0),
          ok: z.boolean(),
          why: z.string().max(500).optional(),
        }),
      )
      .output(HelperAction)
      .handler(({ context: c, input }) =>
        guard(() => c.helper.shown(input.messageId, input.index, input.ok, input.why)),
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
    /** My accounts (ADR-038); `check` asks GitHub whether each token still works. */
    accounts: base
      .input(z.object({ check: z.boolean().default(false) }).default({ check: false }))
      .output(z.array(GitHubAccount))
      .handler(({ context: c, input }) => guard(() => c.github.accounts(input.check))),
    /** A token checked against GitHub and kept under its account's name. */
    addAccount: base
      .input(z.object({ token: z.string().min(10) }))
      .output(z.object({ login: z.string() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const login = await c.github.addAccount(input.token);
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
    removeAccount: base.input(z.object({ login: z.string() })).handler(({ context: c, input }) =>
      guard(async () => {
        await c.github.removeAccount(input.login);
        c.bus.publish({
          type: "github.disconnected",
          topic: "overview",
          jobId: null,
          payload: { login: input.login },
          actor: "owner",
        });
      }),
    ),
    repos: base
      .input(z.object({ login: z.string().optional() }).optional())
      .output(
        z.array(
          z.object({
            fullName: z.string(),
            name: z.string(),
            private: z.boolean(),
            description: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
        ),
      )
      .handler(({ context: c, input }) => guard(() => c.github.repos(input?.login ?? null))),
    // ── Repos (ADR-040): reads through an account's token, kept a minute.
    /** The repositories of one account, or of all, with the project linking each. */
    repoList: base
      .input(z.object({ account: z.string().optional() }).default({}))
      .output(GitHubRepoList)
      .handler(({ context: c, input }) => guard(() => c.repos.list(input.account ?? null))),
    repoInfo: base
      .input(GitHubRepoRef)
      .output(GitHubRepoDetail)
      .handler(({ context: c, input }) => guard(() => c.repos.info(input))),
    branches: base
      .input(GitHubRepoRef.extend({ page: z.number().int().positive().default(1) }))
      .output(githubPage(GitHubBranch))
      .handler(({ context: c, input }) => guard(() => c.repos.branches(input, input.page))),
    /** A directory at a ref, or every path (`recursive`). */
    tree: base
      .input(
        GitHubRepoRef.extend({
          ref: z.string().min(1),
          path: z.string().default(""),
          recursive: z.boolean().default(false),
        }),
      )
      .output(GitHubTree)
      .handler(({ context: c, input }) =>
        guard(() => c.repos.tree(input, input.ref, input.path, input.recursive)),
      ),
    /** A file's text at a ref (512 KB at most), or that it is binary or too large. */
    file: base
      .input(GitHubRepoRef.extend({ ref: z.string().min(1), path: z.string().min(1) }))
      .output(GitHubFile)
      .handler(({ context: c, input }) => guard(() => c.repos.file(input, input.ref, input.path))),
    readme: base
      .input(GitHubRepoRef.extend({ ref: z.string().min(1) }))
      .output(GitHubFile.nullable())
      .handler(({ context: c, input }) => guard(() => c.repos.readme(input, input.ref))),
    commits: base
      .input(
        GitHubRepoRef.extend({
          branch: z.string().min(1),
          page: z.number().int().positive().default(1),
        }),
      )
      .output(githubPage(GitHubCommitSummary))
      .handler(({ context: c, input }) =>
        guard(() => c.repos.commits(input, input.branch, input.page)),
      ),
    commit: base
      .input(GitHubRepoRef.extend({ sha: z.string().regex(/^[0-9a-fA-F]{4,64}$/) }))
      .output(GitHubCommitDetail)
      .handler(({ context: c, input }) => guard(() => c.repos.commit(input, input.sha))),
    pulls: base
      .input(
        GitHubRepoRef.extend({
          state: z.enum(["open", "closed"]).default("open"),
          page: z.number().int().positive().default(1),
        }),
      )
      .output(githubPage(GitHubPullSummary))
      .handler(({ context: c, input }) =>
        guard(() => c.repos.pulls(input, input.state, input.page)),
      ),
    pull: base
      .input(GitHubRepoRef.extend({ number: z.number().int().positive() }))
      .output(GitHubPullDetail)
      .handler(({ context: c, input }) => guard(() => c.repos.pull(input, input.number))),
    /** Each account's hourly allowance as GitHub last said it, in words too. */
    limits: base.output(z.array(GitHubLimit)).handler(({ context: c }) => c.github.limits()),
    /** A new repository of mine (with a README, so it can be cloned at once); audited. */
    createRepo: base
      .input(
        z.object({
          account: z.string().optional(),
          name: GitHubName,
          private: z.boolean().default(true),
          description: z.string().max(350).optional(),
        }),
      )
      .output(z.object({ account: z.string(), owner: z.string(), name: z.string() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const login = input.account ?? (await c.github.accounts())[0]?.login ?? null;
          const repo = await c.github.createRepo(
            {
              name: input.name,
              private: input.private,
              ...(input.description ? { description: input.description } : {}),
            },
            login,
          );
          c.bus.publish({
            type: "github.repo-created",
            topic: "overview",
            jobId: null,
            payload: { fullName: repo.fullName, private: input.private },
            actor: "owner",
          });
          const [owner, name] = repo.fullName.split("/") as [string, string];
          return { account: login ?? owner, owner, name };
        }),
      ),
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
  /** My mail: accounts, folders, threads, drafts (ADR-032). */
  mail: {
    accounts: base.output(z.array(MailAccountView)).handler(({ context: c }) => c.mail.accounts()),
    addAccount: base
      .input(NewMailAccount)
      .output(MailAccountView)
      .handler(({ context: c, input }) => guard(() => c.mail.addAccount(input))),
    /** Who hosts an address's mail and its servers, from its MX records; null when unknown. */
    detect: base
      .input(z.object({ email: z.string() }))
      .output(MailDetected.nullable())
      .handler(({ context: c, input }) => c.mail.detect(input.email)),
    /** Checks an account's servers without saving anything. */
    testAccount: base
      .input(NewMailAccount)
      .output(MailTestResult)
      .handler(({ context: c, input }) => guard(() => c.mail.testAccount(input))),
    updateAccount: base
      .input(
        z.object({
          id: z.string(),
          name: z.string().min(1).max(60).optional(),
          autoSend: z.boolean().optional(),
          appendSent: z.boolean().optional(),
          deleteFromServer: z.boolean().optional(),
        }),
      )
      .handler(({ context: c, input }) => {
        const { id, ...patch } = input;
        return guard(() => c.mail.update(id, patch));
      }),
    removeAccount: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.mail.removeAccount(input.id))),
    /** Connecting again ("Reconnect"): with a new password, or the one kept after a network failure. */
    reconnect: base
      .input(z.object({ id: z.string(), password: z.string().min(1).optional() }))
      .handler(({ context: c, input }) => guard(() => c.mail.reconnect(input.id, input.password))),
    sync: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.mail.syncNow(input.id))),
    folders: base
      .input(z.object({ accountId: z.string() }))
      .output(z.array(MailFolderView))
      .handler(({ context: c, input }) => guard(() => c.mail.folders(input.accountId))),
    threads: base
      .input(
        z.object({
          accountId: z.string(),
          folderId: z.string().nullable().optional(),
          query: z.string().max(200).optional(),
          offset: z.number().int().min(0).default(0),
          limit: z.number().int().min(1).max(500).default(100),
        }),
      )
      .output(MailThreadPage)
      .handler(({ context: c, input }) => guard(() => c.mail.threads(input))),
    thread: base
      .input(z.object({ accountId: z.string(), threadId: z.string() }))
      .output(z.object({ messages: z.array(MailMessageView), drafts: z.array(MailDraftView) }))
      .handler(({ context: c, input }) =>
        guard(() => c.mail.thread(input.accountId, input.threadId)),
      ),
    flag: base
      .input(
        z.object({
          ids: z.array(z.string()).min(1),
          seen: z.boolean().optional(),
          flagged: z.boolean().optional(),
        }),
      )
      .handler(({ context: c, input }) =>
        guard(() =>
          c.mail.flag(
            input.ids,
            {
              ...(input.seen !== undefined ? { seen: input.seen } : {}),
              ...(input.flagged !== undefined ? { flagged: input.flagged } : {}),
            },
            { kind: "owner", device: c.device },
          ),
        ),
      ),
    move: base
      .input(z.object({ ids: z.array(z.string()).min(1), folderId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.mail.move(input.ids, input.folderId, { kind: "owner", device: c.device })),
      ),
    archive: base
      .input(z.object({ ids: z.array(z.string()).min(1) }))
      .handler(({ context: c, input }) =>
        guard(() => c.mail.archive(input.ids, { kind: "owner", device: c.device })),
      ),
    delete: base
      .input(z.object({ ids: z.array(z.string()).min(1) }))
      .handler(({ context: c, input }) =>
        guard(() => c.mail.remove(input.ids, { kind: "owner", device: c.device })),
      ),
    /** Allowed remote images, fetched by the daemon and given inline. */
    images: base
      .input(z.object({ id: z.string() }))
      .output(z.record(z.string(), z.string()))
      .handler(({ context: c, input }) => guard(() => c.mail.images(input.id))),
    allowImages: base
      .input(z.object({ id: z.string(), sender: z.boolean().default(false) }))
      .handler(({ context: c, input }) => guard(() => c.mail.allowImages(input.id, input.sender))),
    attachment: base
      .input(z.object({ id: z.string(), index: z.number().int().min(0) }))
      .output(z.object({ filename: z.string(), contentType: z.string(), base64: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.mail.attachment(input.id, input.index))),
    drafts: base
      .input(z.object({ accountId: z.string().optional() }))
      .output(z.array(MailDraftView))
      .handler(({ context: c, input }) => c.mail.drafts(input.accountId)),
    /** A reply, addressed and quoted, to finish in the composer. */
    replyTemplate: base
      .input(z.object({ id: z.string(), all: z.boolean().default(false) }))
      .output(MailCompose)
      .handler(({ context: c, input }) =>
        guard(() => c.mail.replyTemplate(input.id, input.all, "")),
      ),
    saveDraft: base
      .input(MailCompose.extend({ id: z.string().optional() }))
      .output(MailDraftView)
      .handler(({ context: c, input }) =>
        guard(() => c.mail.saveDraft(input, { kind: "owner", device: c.device })),
      ),
    send: base
      .input(MailCompose.extend({ id: z.string().optional() }))
      .output(MailDraftView)
      .handler(({ context: c, input }) => guard(() => c.mail.sendNow(input, c.device))),
    /** I approve a draft, an agent's included: it is sent now. */
    approve: base
      .input(z.object({ id: z.string() }))
      .output(MailDraftView)
      .handler(({ context: c, input }) => guard(() => c.mail.approve(input.id, c.device))),
    discard: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.mail.discard(input.id))),
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
    /** Throughput, success by Leg and task kind, per verified task, money, burn (Web-UI → Charts). */
    charts: base
      .input(ChartsInput)
      .output(Charts)
      .handler(({ context: c, input }) => statsCharts(c.jobs.db, input)),
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
    /** On a public Nest: this daemon registers itself and connects (ADR-031). */
    register: base
      .input(z.object({ url: z.url(), invite: z.string().max(200).optional() }))
      .output(z.object({ daemonId: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.nest.register(input.url, input.invite || undefined)),
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
        readSetting(c.jobs.db, MAX_RUNNING_JOBS, z.number().int().min(1), DEFAULT_RUNNING_JOBS),
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
    /** How many tasks of one job run at once (ADR-016): null, as many as are admitted (ADR-050). */
    maxTasksPerJob: base
      .output(z.number().int().nullable())
      .handler(({ context: c }) =>
        readSetting(c.jobs.db, MAX_TASKS_PER_JOB, z.number().int().min(1).nullable(), null),
      ),
    setMaxTasksPerJob: base
      .input(z.object({ max: z.number().int().min(1).max(16).nullable() }))
      .handler(({ context: c, input }) =>
        guard(() => {
          writeSetting(c.jobs.db, MAX_TASKS_PER_JOB, z.number().int().min(1).nullable(), input.max);
          c.bus.publish({
            type: "settings.updated",
            topic: "overview",
            jobId: null,
            payload: { maxTasksPerJob: input.max },
            actor: "owner",
          });
        }),
      ),
    /** Tasks at once across every job, my thresholds, pausing for my own work (ADR-050). */
    resources: base.output(ResourceSettings).handler(({ context: c }) => readResources(c.jobs.db)),
    setResources: base.input(ResourceSettings.partial()).handler(({ context: c, input }) =>
      guard(() => {
        writeResources(c.jobs.db, input);
        c.bus.publish({
          type: "settings.updated",
          topic: "overview",
          jobId: null,
          payload: { resources: input },
          actor: "owner",
        });
      }),
    ),
    /** How many rounds The Eye's interview may take (Skills → The interview). */
    interviewRounds: base
      .output(z.number().int())
      .handler(({ context: c }) => interviewRounds(c.jobs.db)),
    setInterviewRounds: base
      .input(z.object({ rounds: z.number().int().min(1).max(12) }))
      .handler(({ context: c, input }) =>
        guard(() => {
          writeSetting(c.jobs.db, INTERVIEW_ROUNDS, z.number().int().min(1).max(12), input.rounds);
          c.bus.publish({
            type: "settings.updated",
            topic: "overview",
            jobId: null,
            payload: { interviewRounds: input.rounds },
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
    start: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => startJob(c, input.id))),
    get: base
      .input(z.object({ id: z.string() }))
      .output(JobView)
      .handler(({ context: c, input }) => guard(() => jobView(c, input.id))),
    list: base
      .input(z.object({ projectId: z.string().optional() }).optional())
      .output(z.array(JobView))
      .handler(({ context: c, input }) =>
        c.jobs.db
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(input?.projectId ? eq(jobsTable.projectId, input.projectId) : undefined)
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
    /** A job's full record as JSON for a download, secrets scrubbed (Audit 1 → Q1-15). */
    export: base
      .input(z.object({ id: z.string() }))
      .output(JobExport)
      .handler(({ context: c, input }) => guard(() => jobExport(c, input.id))),
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
      .input(
        z.object({ id: z.string(), text: z.string().min(1).max(8000), mode: TalkMode.optional() }),
      )
      .output(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => ({
          id: talk(talkDeps(c), input.id, input.text.trim(), {}, input.mode ?? "context"),
        })),
      ),
    /** What The Eye thought and is thinking in this job (M13.25). */
    thinking: base
      .input(z.object({ id: z.string() }))
      .output(z.array(EyeThought))
      .handler(({ context: c, input }) => c.thinking?.list([input.id]) ?? []),
    /** Stop: what The Eye is thinking in this job ends now (M13.25). */
    stopThinking: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ stopped: z.number().int().nonnegative() }))
      .handler(({ context: c, input }) =>
        guard(() => ({ stopped: stopThinking(talkDeps(c), [input.id]) })),
      ),
    /** A draft's options, changed as I go (New work page). */
    updateDraft: base
      .input(DraftPatch)
      .handler(({ context: c, input }) => guard(() => c.projects.updateDraft(input))),
    /** My name or description for a job, kept from then on (Jobs-and-Projects → A job's name). */
    rename: base
      .input(JobRename)
      .handler(({ context: c, input }) => guard(() => c.projects.renameJob(input))),
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
    /** My answers to The Eye's questions before the start (ADR-037). */
    draftAnswer: base
      .input(z.object({ id: z.string(), messageId: z.string(), answers: QuestionAnswers }))
      .handler(({ context: c, input }) =>
        guard(() => draftAnswer(drafts(c), input.id, input.messageId, input.answers)),
      ),
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
    /**
     * Cancels what one Leg does in this job (or on one of its tasks): its
     * sessions there end at a safe point, their tasks go back to ready and
     * don't use that Leg again here. Also how a task waiting for a paused
     * Leg is reassigned. Answers once they have stopped.
     */
    cancelLegWork: base
      .input(z.object({ id: z.string(), legId: z.string(), taskId: z.string().optional() }))
      .output(z.object({ stopped: z.number().int() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const job = c.jobs.require(input.id);
          const leg = c.registry.require(input.legId);
          if (input.taskId) {
            const t = c.jobs.db
              .select({ jobId: tasksTable.jobId })
              .from(tasksTable)
              .where(eq(tasksTable.id, input.taskId))
              .get();
            if (t?.jobId !== job.id) throw new Error("That task is not in this job.");
          }
          const stopped = await cancelLegWork(c.jobs.db, job.id, leg.id, leg.name, input.taskId);
          c.bus.publish({
            type: "job.leg-cancelled",
            topic: `job:${job.id}`,
            jobId: job.id,
            payload: { legId: leg.id, taskId: input.taskId ?? null, stopped },
            actor: "owner",
          });
          return { stopped };
        }),
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
    /**
     * No new sessions on it, and the ones it runs pause in place at a safe
     * point (BR-7); their tasks wait for it. Answers once they have stopped.
     */
    pause: base
      .input(z.object({ id: z.string() }))
      .output(z.object({ stopped: z.number().int() }))
      .handler(({ context: c, input }) =>
        guard(async () => {
          const leg = c.registry.require(input.id);
          c.registry.update(input.id, { paused: true });
          return { stopped: await pauseLegSessions(c.jobs.db, leg.id, leg.name) };
        }),
      ),
    resume: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) =>
        guard(() => c.registry.update(input.id, { paused: false })),
      ),
    remove: base
      .input(z.object({ id: z.string() }))
      .handler(({ context: c, input }) => guard(() => c.registry.remove(input.id))),
    /** Every Leg's plan windows, fullest first, with Oraknid's tokens in each (ADR-039). */
    planUsage: base.output(z.array(LegPlanUsage)).handler(({ context: c }) => c.planUsage.view()),
    /**
     * Asks for fresh readings where due (at most every 5 minutes for the
     * backend's own reading, every 15 for the health prompt), then answers
     * like planUsage. The Overview and a Leg's details call it while open.
     */
    refreshPlanUsage: base.output(z.array(LegPlanUsage)).handler(({ context: c }) =>
      guard(async () => {
        await c.planUsage.refresh();
        return c.planUsage.view();
      }),
    ),
    /** How a Leg's windows moved: readings, fills and resets, over `days` (ADR-039). */
    planHistory: base
      .input(z.object({ id: z.string(), days: z.number().int().min(1).max(31).default(8) }))
      .output(PlanHistory)
      .handler(({ context: c, input }) =>
        guard(() => {
          c.registry.require(input.id);
          return c.planUsage.history(input.id, c.now() - input.days * 86400_000);
        }),
      ),
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
    /** A project's Silk, kept by job: newest job first (ADR-034). */
    byProject: base
      .input(z.object({ projectId: z.string(), includeSuperseded: z.boolean().default(false) }))
      .output(z.array(SilkByJob))
      .handler(({ context: c, input }) =>
        c.silk.byProject(input.projectId, input.includeSuperseded),
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
    /** One of its options, my words, or my answers to its questions (ADR-037). */
    answer: base
      .input(
        z
          .object({
            id: z.string(),
            answer: z.string().min(1).optional(),
            answers: QuestionAnswers.optional(),
          })
          .refine((x) => x.answer || x.answers, "an answer"),
      )
      .handler(({ context: c, input }) =>
        guard(() => c.inbox.answer(input.id, input.answer ?? "", c.device, input.answers ?? null)),
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
      .handler(({ context: c, input }) => sessionViews(c, input.jobId)),
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
  machine: {
    /** Danger, what Oraknid did, tasks at once and those paused for room (ADR-050). */
    health: base.output(MachineHealth).handler(({ context: c }) => c.machineHealth()),
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
