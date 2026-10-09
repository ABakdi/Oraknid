import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegKind, MetricsSample } from "@oraknid/contracts";
import { type MachineReading, readingOf, scrubSecrets } from "@oraknid/core";
import { configureSafetyNet, initParser } from "@oraknid/guard";
import { createAntigravityAdapter } from "@oraknid/leg-antigravity";
import { createClaudeCodeAdapter } from "@oraknid/leg-claude-code";
import { createCodexAdapter } from "@oraknid/leg-codex";
import { createOpenAICompatibleAdapter } from "@oraknid/leg-openai-compatible";
import { createOpenCodeAdapter } from "@oraknid/leg-opencode";
import { createOraknidAgentAdapter } from "@oraknid/leg-oraknid-agent";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { call, ORPCError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/node";
import { eq } from "drizzle-orm";
import express from "express";
import { z } from "zod";
import { type ApiContext, router } from "./api/router.ts";
import { startAuditExport } from "./audit/audit.ts";
import { Devices, tokenOf } from "./auth/devices.ts";
import { AppLock, LOCK_FREE, needsFullRights, remoteAllowed, unlockOf } from "./auth/lock.ts";
import { Backups } from "./backups/service.ts";
import { Chats } from "./chats/service.ts";
import { attachCloudRoutes, Downloads } from "./cloud/routes.ts";
import { Cloud } from "./cloud/service.ts";
import { STORAGE_TOOL, storageServer } from "./cloud/tool.ts";
import { closeDatabase, openDatabase, startIdleCheckpoint } from "./db/open.ts";
import { jobs as jobsTable, projects as projectsTable, tasks as tasksTable } from "./db/schema.ts";
import { clipOversizedRows } from "./db/upkeep.ts";
import { SideEffects } from "./engine/effects.ts";
import { JobStore } from "./engine/jobs.ts";
import { StepJournal } from "./engine/journal.ts";
import { recover } from "./engine/recovery.ts";
import { type JobProgram, JobRunner, noSandboxRefusal } from "./engine/runner.ts";
import { EventBus } from "./events/bus.ts";
import { type EyeBrain, PoolLegBrain } from "./eye/brain.ts";
import { startBudgetWatch } from "./eye/budgets.ts";
import { EyeDecisions } from "./eye/decisions.ts";
import { readExperience } from "./eye/experience.ts";
import { pauseForRoom } from "./eye/leg-work.ts";
import { serverAdded } from "./eye/links.ts";
import { type NamingDeps, startJobNaming } from "./eye/naming.ts";
import { eyeProgram } from "./eye/program.ts";
import { startEyeReports } from "./eye/reports.ts";
import { forgetGuidance, recordAnswer, resumeConversations } from "./eye/talk.ts";
import { EyeThinking } from "./eye/thinking.ts";
import { forgetJob } from "./harness/gate.ts";
import { chromiumRenderer, type VisualDeps, visionJudge } from "./harness/visual.ts";
import { Helper, type HelperWho } from "./helper/service.ts";
import { isLocalRequest } from "./http/guard.ts";
import { requestIds, tagConsoleWithRequestIds } from "./http/request-id.ts";
import { InboxStore } from "./inbox/store.ts";
import { startHealthChecks } from "./legs/health.ts";
import { removeJobHomes } from "./legs/job-home.ts";
import { LegLogins } from "./legs/login.ts";
import { codexHomeOf } from "./legs/plan.ts";
import { PlanUsage } from "./legs/plan-usage.ts";
import { LegRegistry } from "./legs/registry.ts";
import { LegSupervisor } from "./legs/supervisor.ts";
import { attachLive } from "./live/server.ts";
import { type MailOptions, MailService } from "./mail/service.ts";
import { EMAIL_TOOL, emailServer } from "./mail/tool.ts";
import { LocalModels, type LocalModelsOptions } from "./models/service.ts";
import { MODELS_TOOL, modelsServer } from "./models/tool.ts";
import { applyPendingImport } from "./moving/move.ts";
import { attachMovingRoutes } from "./moving/routes.ts";
import { NestLink } from "./nest/link.ts";
import { Notifications } from "./notify/notifications.ts";
import { startNotificationRouter } from "./notify/router.ts";
import { linuxOs, type OsDeps } from "./os/context.ts";
import { countActiveJobs, createInhibitController } from "./os/inhibit-controller.ts";
import { startMetricsLoop } from "./os/metrics-loop.ts";
import { Secrets } from "./os/secrets.ts";
import { DEFAULT_HOST, DEFAULT_PORT, isDefaultDataDir, type Paths } from "./paths.ts";
import { diskSpace } from "./resources/disks.ts";
import { startGuard } from "./resources/guard.ts";
import { thresholdsOf, Work } from "./resources/work.ts";
import { reviewFrames, reviewKeyOf } from "./reviews/frame.ts";
import { Reviews } from "./reviews/service.ts";
import { ProjectSecrets } from "./secrets/service.ts";
import { ENV_TOOL_NAME, envServer, envTool } from "./secrets/tool.ts";
import { startRefreshAfterStop } from "./servers/after-end.ts";
import { resumeServerConversations, serverJobsDir } from "./servers/server-jobs.ts";
import { Servers } from "./servers/service.ts";
import { DEFAULT_RUNNING_JOBS, MAX_RUNNING_JOBS, readSetting } from "./settings.ts";
import { SilkStore } from "./silk/store.ts";
import { Sites, type SitesDeps } from "./sites/service.ts";
import { SkillStore } from "./skills/store.ts";
import { startNightlyBackups } from "./storage/storage.ts";
import { attachTerminal, TERMINAL_SETTING } from "./term/server.ts";
import { type BuiltInServer, McpBroker } from "./tools/broker.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { findAppDir, readInstall } from "./updates/install.ts";
import { Updates, type UpdatesOptions } from "./updates/service.ts";
import { VERSION } from "./version.ts";
import { startCiWatch } from "./workspace/ci-watch.ts";
import { setShadowRoot } from "./workspace/git.ts";
import { GitHub } from "./workspace/github.ts";
import { ciOf } from "./workspace/github-ci.ts";
import { Repos } from "./workspace/github-repos.ts";
import { githubServer, githubTool } from "./workspace/github-tool.ts";
import { GitHosts } from "./workspace/hosts/registry.ts";
import { Projects } from "./workspace/projects.ts";

export interface DaemonOptions {
  paths: Paths;
  host?: string;
  /** 0 picks a free port (tests). */
  port?: number;
  /** ":memory:" for tests. Defaults to paths.db. */
  dbFile?: string;
  /** Write the runtime file the CLI uses to find the daemon. */
  writeRuntimeFile?: boolean;
  now?: () => number;
  heartbeatMs?: number;
  /** OS pieces to replace (tests). */
  os?: Partial<OsDeps>;
  metricsIntervalMs?: number;
  /** The guard's pace (ADR-050; tests: shorter or never). */
  guardIntervalMs?: number;
  /** How long a danger must be gone before its incident closes, and the pace of pauses (tests). */
  guardClearMs?: number;
  guardPauseEveryMs?: number;
  /** The machine as admission and the guard read it (tests give fake readings). */
  machineReading?: () => MachineReading | null;
  /** Seconds between oraknid-monitor readings (tests: shorter). */
  serverSampleSec?: number;
  /** Sites: where DNS and certificates are read, and the pace (tests; ADR-060). */
  sites?: Partial<Pick<SitesDeps, "resolver" | "tls" | "tickMs" | "timeoutMs">>;
  /** How often backup plans are looked at (ms; tests). */
  backupTickMs?: number;
  /** rclone's binary (tests); found on the PATH otherwise (ADR-046). */
  rclone?: () => string | null;
  /** GitHub's addresses, for tests against a stand-in. */
  github?: { api?: string; web?: string };
  /** The other git hosts' requests, for tests (ADR-062). */
  hosts?: { fetch?: typeof fetch };
  /** The CI watcher's timings (ADR-058; tests), or false: none. */
  ciWatch?: { intervalMs?: number; firstMs?: number; now?: () => number } | false;
  /** What runs a job: The Eye, unless a test replaces it. */
  program?: JobProgram;
  /** The Eye's reasoning (tests replace it). */
  brain?: EyeBrain;
  /** The visual check's renderer and judge (tests give stand-ins; ADR-064 §5). */
  visual?: Partial<Pick<VisualDeps, "renderer" | "judge">>;
  /** Naming jobs' timings (tests): the backfill's start (-1: never) and pace. */
  naming?: Pick<NamingDeps, "gapMs" | "retryMs" | "draftDelayMs" | "backfillDelayMs">;
  /** Opens a folder on this machine; tests replace it. */
  openPath?: (path: string) => void;
  stallCheckMs?: number;
  /** How long the drift judge may take (tests); 30 s otherwise (ADR-056). */
  driftJudgeMs?: number;
  budgetIntervalMs?: number;
  emailDelayMs?: number;
  /** Leg adapters by kind (tests replace them). */
  adapters?: Partial<Record<LegKind, LegAdapter>>;
  healthIntervalMs?: number;
  /** The web UI's built folder; null: none, as on a terminal-only install (tests; found otherwise). */
  webDir?: string | null;
  /** Updates (ADR-048): the app's folder, GitHub and how the update starts (tests). */
  updates?: Partial<
    Pick<
      UpdatesOptions,
      | "appDir"
      | "fetch"
      | "api"
      | "launcher"
      | "underSystemd"
      | "env"
      | "version"
      | "checkEveryMs"
      | "firstCheckMs"
    >
  >;
  /** Local models: the sources, Ollama's address and the programs (tests). */
  models?: Partial<
    Pick<
      LocalModelsOptions,
      "fetch" | "catalog" | "ollamaUrl" | "programs" | "spawn" | "idleCheckMs" | "loadTimeoutMs"
    >
  >;
  /** Mail timings and the providers' servers (tests). */
  mail?: Pick<
    MailOptions,
    | "syncEveryMs"
    | "popEveryMs"
    | "idleDelayMs"
    | "initialLimit"
    | "presets"
    | "resolveMx"
    | "oauthEndpoints"
    | "devicePollMs"
  >;
}

export const EYE_LEG_SETTING = "eye.legModelId";

export interface RuntimeInfo {
  pid: number;
  url: string;
  version: string;
  startedAt: number;
}

export async function startDaemon(options: DaemonOptions) {
  const { paths } = options;
  const now = options.now ?? Date.now;
  const host = options.host ?? DEFAULT_HOST;
  const startedAt = now();
  const os = linuxOs(options.os);

  // Job contents, logs and Silk are mine alone (Audit 1 → S1-12).
  mkdirSync(paths.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(paths.dataDir, 0o700);
  setShadowRoot(join(paths.dataDir, "shadow"));
  // Auto mode's rules (ADR-053): CC Safety Net reads a home of Oraknid's own; the bash grammar loads once.
  configureSafetyNet(join(paths.dataDir, "guard"));
  void initParser().catch((e) => console.error("auto mode: the command parser did not load", e));
  // An archive imported from another computer waits here for this start (ADR-061).
  const imported = options.dbFile ? false : await applyPendingImport(paths);
  const db = await openDatabase({ file: options.dbFile ?? paths.db, backupsDir: paths.backups });
  // Rows from before the size caps cut short once, their originals archived (migration 0043).
  const clipped = clipOversizedRows(db, join(paths.dataDir, "archive"), now);
  if (clipped?.archive)
    console.log(
      `Cut short oversized rows (${Object.entries(clipped.cut)
        .map(([k, n]) => `${k}: ${n}`)
        .join(", ")}); the originals are in ${clipped.archive}`,
    );
  // The keychain entries of before belong to the default data folder alone (Audit 2, S2-23).
  const secrets = new Secrets(paths.dataDir, os.keychain, {
    ownsLegacy: isDefaultDataDir(paths.dataDir),
    log: (m) => console.log(m),
  });
  const bus = new EventBus(db, now);
  // Secrets never reach the event log (BR-13).
  bus.scrub = (text) => scrubSecrets(text, secrets.known());

  await secrets.init();
  const registry = new LegRegistry(db, bus, secrets, paths.legs, now);
  const adapters: Partial<Record<LegKind, LegAdapter>> = options.adapters ?? {
    "claude-code": createClaudeCodeAdapter(),
    "openai-compatible": createOpenAICompatibleAdapter(),
    opencode: createOpenCodeAdapter(),
    antigravity: createAntigravityAdapter(),
    // OpenAI's Codex CLI, headless, its hooks through Oraknid's policy (ADR-057).
    codex: createCodexAdapter(),
    // Oraknid's own agent (ADR-052 §6): its sessions kept for resume beside the Legs' homes.
    "oraknid-agent": createOraknidAgentAdapter({
      sessionsDir: join(paths.legs, "oraknid-agent-sessions"),
      credentialOf: async (leg) => {
        const row = registry.get(leg.id);
        return row ? registry.credential(row) : null;
      },
    }),
  };
  const logins = new LegLogins(paths.legs, os.sandbox);
  // No Leg keeps my own ~/.claude as its config folder (Audit 1 → S1-02).
  registry.ownConfigFolders();
  const supervisor = new LegSupervisor({
    db,
    bus,
    registry,
    adapters,
    sandbox: os.sandbox,
    legsDir: paths.legs,
    logsDir: join(paths.logs, "jobs"),
    now,
    scrub: (text) => scrubSecrets(text, secrets.known()),
  });

  // Recovery comes first, before the API answers anyone (Durability spec).
  const jobsStore = new JobStore(db, bus, now);
  const journal = new StepJournal(db, now);
  const inbox = new InboxStore(db, bus, now);
  // Reviews (ADR-064): a design or the running app annotated per device; the frame on its own origin.
  const reviews = new Reviews({ db, bus, inbox, dataDir: paths.dataDir, port: () => port, now });
  const effects = new SideEffects(db, bus, inbox, now);
  const silk = new SilkStore(db, bus, inbox, now);
  const skills = new SkillStore(db, now);
  skills.seedBuiltIns();
  const projectsService = new Projects(db, bus, skills, now);
  // Tools for skills: MCP servers the daemon runs, never the Legs (ADR-021).
  const toolRegistry = new ToolRegistry(db, bus, secrets, now);
  // The daemon's own address, known once it listens.
  let url = "";
  // My mail (ADR-032): synced by the daemon, reached by agents through the email tool.
  const mail = new MailService({
    db,
    bus,
    secrets,
    inbox,
    dataDir: paths.dataDir,
    now,
    // Where the browser sign-in with Google or Microsoft comes back (ADR-063).
    baseUrl: () => url,
    // The email tool appears with the first account.
    hasAccounts: () => {
      try {
        toolRegistry.ensureBuiltIn(EMAIL_TOOL);
      } catch (error) {
        // A tool of mine named "email" stays as it is.
        console.warn(error instanceof Error ? error.message : error);
      }
    },
    ...options.mail,
  });
  // GitHub through tokens I paste, several accounts (ADR-023, ADR-038).
  const github = new GitHub(secrets, db, options.github ?? {});
  // My repositories, read through its API (ADR-040).
  const repos = new Repos(github, projectsService);
  // GitLab, Gitea and Forgejo beside GitHub (ADR-062): a project's link names its host.
  const hosts = new GitHosts({ db, secrets, github, repos, ...(options.hosts ?? {}) });
  // Their GitHub Actions (ADR-058); a failing run on a release or work branch is told.
  const ci = ciOf(github);
  const ciWatch =
    options.ciWatch === false
      ? null
      : startCiWatch({ db, bus, ci, projects: projectsService, ...options.ciWatch });
  // Oraknid's own github tool: a project's GitHub work with its linked account (ADR-038).
  const githubToolDecl = githubTool(db);
  try {
    toolRegistry.ensureBuiltIn(githubToolDecl);
  } catch (error) {
    // A tool of mine named "github" stays as it is.
    console.warn(error instanceof Error ? error.message : error);
  }
  // Local models (ADR-054): found, downloaded, run, and their roles a tool for every agent.
  const models = new LocalModels({
    db,
    bus,
    registry,
    checkLeg: (id) => health.check(id),
    dataDir: paths.dataDir,
    now,
    reading: () => work.d.reading?.() ?? null,
    thresholds: () => thresholdsOf(work.settings()),
    danger: () => work.danger(),
    inUse: () =>
      new Set(
        registry
          .all()
          .filter((l) => l.kind === "oraknid-agent")
          .flatMap((l) => [...supervisor.modelsInUse(l.id)]),
      ),
    processOf: (pid) => {
      const p = metricsLoop
        .recent(now() - 10_000)
        .at(-1)
        ?.processes.find((x) => x.pid === pid);
      return p ? { rssBytes: p.rssBytes, vramBytes: p.vramBytes } : null;
    },
    jobFolders: (jobId) => {
      if (!jobId) return [];
      const project = db
        .select({ path: projectsTable.workspacePath })
        .from(projectsTable)
        .innerJoin(jobsTable, eq(jobsTable.projectId, projectsTable.id))
        .where(eq(jobsTable.id, jobId))
        .get();
      return project ? [project.path] : [];
    },
    // Under test, never the Ollama this computer may run, unless a test gives one.
    ...(process.env.VITEST ? { ollamaUrl: null } : {}),
    ...options.models,
  });
  // A project's secrets per environment: its jobs' variables, its servers' env files (ADR-059).
  const projectSecrets = new ProjectSecrets({ db, bus, secrets, now });
  supervisor.attachJobEnv((jobId) => projectSecrets.envForJob(jobId));
  try {
    toolRegistry.ensureBuiltIn(envTool(projectSecrets));
  } catch (error) {
    // A tool of mine named "env" stays as it is.
    console.warn(error instanceof Error ? error.message : error);
  }
  // Oraknid's own tools, answered in the daemon; the storage tool joins once cloud storage is made.
  const builtIns = new Map<string, BuiltInServer>([
    [ENV_TOOL_NAME, envServer(projectSecrets)],
    [EMAIL_TOOL.name, emailServer(mail)],
    [githubToolDecl.name, githubServer({ db, bus, github, projects: projectsService })],
    [MODELS_TOOL.name, modelsServer(models)],
  ]);
  const broker = new McpBroker({
    registry: toolRegistry,
    sandbox: os.sandbox,
    builtIns,
  });
  // The roles' tool appears once a model is downloaded (ADR-054), like the email tool with an account.
  const offerModelsTool = () => {
    if (!models.list().some((m) => m.state === "ready" || m.state === "loaded")) return;
    try {
      toolRegistry.ensureBuiltIn(MODELS_TOOL);
    } catch (error) {
      // A tool of mine named "local-models" stays as it is.
      console.warn(error instanceof Error ? error.message : error);
    }
  };
  offerModelsTool();
  bus.subscribe((e) => {
    if (e.type === "model.state" && (e.payload as { state?: string }).state === "ready")
      offerModelsTool();
  });
  // Chats with my models: talk and research (ADR-025).
  const chats = new Chats({ db, bus, registry, supervisor, dataDir: paths.dataDir, now });
  // A model per kind of decision, and the shadow planner (ADR-022).
  const decisions = new EyeDecisions(db, bus, now);
  // The Eye thinking out loud in the conversation, stopped or redone by me (M13.25).
  const thinking = new EyeThinking({ db, bus, now });
  const brain =
    options.brain ??
    new PoolLegBrain({
      registry,
      supervisor,
      pinnedModelId: () => readSetting(db, EYE_LEG_SETTING, z.string().nullable(), null),
      pins: () => decisions.pins(),
      record: (r) => decisions.record(r),
      answered: (jobId, call, model) =>
        bus.publish({
          type: "eye.answered",
          topic: `job:${jobId}`,
          jobId,
          payload: { call, model },
        }),
      thinking,
    });
  // The visual check (ADR-064 §5): headless Chromium, judged by a model that reads images.
  const visual: VisualDeps = {
    renderer: options.visual?.renderer ?? chromiumRenderer(),
    judge: options.visual?.judge ?? visionJudge({ brain, local: models }),
    experience: (jobId) => readExperience(db, jobId),
    publish: (jobId, payload) =>
      bus.publish({ type: "task.visual-check", topic: `job:${jobId}`, jobId, payload }),
  };
  // My answer to "import my edits?" goes back to Silk.
  bus.subscribe((e) => {
    if (e.type !== "inbox.answered") return;
    // A job waiting for me goes on as soon as I answer (Approvals → The inbox).
    if (e.jobId && jobsStore.get(e.jobId)?.state === "waiting") {
      void runner
        .resume(e.jobId)
        .catch((error) => console.error("resume after answer failed", error));
    }
    const { id, answer } = e.payload as { id: string; answer: string };
    // An answer to questions The Eye asked in the project's conversation joins it as a short list (ADR-037).
    try {
      recordAnswer({ db, bus, now }, id);
    } catch (error) {
      console.error("recording the answer in the conversation failed", error);
    }
    // A review's item answered in words (the chat answered it): a general note of the review.
    const review = reviews.reviewOfItem(id);
    if (review?.state === "open" && answer.trim()) {
      try {
        reviews.addNote(
          {
            reviewId: review.id,
            kind: "general",
            text: answer.slice(0, 4000),
            device: null,
            element: null,
          },
          { source: "chat" },
        );
      } catch (error) {
        console.error("adding the answer to the review failed", error);
      }
    }
    try {
      silk.answerImport(id, answer);
    } catch (error) {
      console.error("silk import failed", error);
    }
  });
  // The last ten seconds of the machine, for resource-aware scheduling (ADR-016).
  let recentMachine: () => MetricsSample[] = () => [];
  // Where every job's tasks ask to start: the machine, the Legs and my cap, shared (ADR-050).
  const work = new Work({
    db,
    bus,
    registry,
    supervisor,
    now,
    reading: () => options.machineReading?.() ?? readingOf(recentMachine(), disks()),
  });
  // The data folder's disk and each running job's project's, read at most every 30 s.
  let diskCache: { at: number; disks: MachineReading["disks"] } = { at: 0, disks: [] };
  const disks = (): MachineReading["disks"] => {
    if (now() - diskCache.at < 30_000) return diskCache.disks;
    const places = [{ label: "the data folder", path: paths.dataDir }];
    for (const r of work.running()) {
      const project = db
        .select({ name: projectsTable.name, path: projectsTable.workspacePath })
        .from(projectsTable)
        .innerJoin(jobsTable, eq(jobsTable.projectId, projectsTable.id))
        .where(eq(jobsTable.id, r.jobId))
        .get();
      if (project) places.push({ label: `the project “${project.name}”`, path: project.path });
    }
    diskCache = { at: now(), disks: diskSpace(places) };
    return diskCache.disks;
  };
  // My servers: SSH with Oraknid's own key, a state document, oraknid-monitor (ADR-026/027).
  const serverService = new Servers({
    db,
    bus,
    secrets,
    brain,
    workDir: join(paths.dataDir, "servers"),
    now,
    ...(options.serverSampleSec ? { sampleEverySec: options.serverSampleSec } : {}),
  });
  serverService.start();
  projectSecrets.attachServers(serverService);
  // Cloud storage through rclone, my providers as one pool (ADR-046).
  const cloud = new Cloud({
    db,
    bus,
    secrets,
    dataDir: paths.dataDir,
    now,
    ...(options.rclone ? { rclone: options.rclone } : {}),
    // A provider a backup plan or a kept backup needs stays.
    usedBy: (id) => backupPlans.cloudUse(id),
  });
  // rclone's list of backends, read once per version, so the add dialog opens on it.
  cloud.preloadBackends();
  // The storage tool (ADR-046): for a job whose skill asks for it, once there is a provider.
  builtIns.set(STORAGE_TOOL.name, storageServer({ db, cloud }));
  const offerStorageTool = () => {
    if (!cloud.providers().length) return;
    try {
      toolRegistry.ensureBuiltIn(STORAGE_TOOL);
    } catch (error) {
      // A tool of mine named "storage" stays as it is.
      console.warn(error instanceof Error ? error.message : error);
    }
  };
  offerStorageTool();
  bus.subscribe((e) => {
    if (e.type === "cloud.provider.added") offerStorageTool();
  });
  const downloads = new Downloads(now);
  // Scheduled, encrypted database backups (ADR-044); the schedule starts once notifications do.
  const backupPlans = new Backups({
    db,
    bus,
    secrets,
    servers: serverService,
    cloud,
    now,
    ...(options.backupTickMs ? { tickMs: options.backupTickMs } : {}),
  });
  // Database sizes with the plans' logins, in a server's Databases tab (ADR-043).
  serverService.insight.sizes = (id) => backupPlans.databaseSizes(id);
  // A server job that failed or was cancelled refreshes its servers' documents too (ADR-026).
  startRefreshAfterStop({ db, bus, servers: serverService, now });
  // Sites across my servers: DNS, certificates, uptime from here (ADR-060).
  const sites = new Sites({ db, bus, servers: serverService, now, ...options.sites });
  sites.start();
  // A server added while The Eye waits for one: it asks again with it (ADR-042).
  bus.subscribe((e) => {
    if (e.type === "server.added") serverAdded(inbox);
  });
  const runner = new JobRunner({
    // How many jobs run at once; the rest queue by priority (ADR-016).
    maxRunning: () =>
      readSetting(db, MAX_RUNNING_JOBS, z.number().int().min(1), DEFAULT_RUNNING_JOBS),
    jobs: jobsStore,
    journal,
    effects,
    inbox,
    bus,
    // No sandbox here: a job starts only if I chose to run it without one (ADR-006).
    refuseStart: (job) => noSandboxRefusal(job, os.sandbox.status()),
    program:
      options.program ??
      eyeProgram({
        db,
        bus,
        silk,
        inbox,
        skills,
        registry,
        supervisor,
        sandbox: os.sandbox,
        brain,
        tools: { registry: toolRegistry, broker },
        servers: serverService,
        github,
        projects: projectsService,
        effects,
        // Set once the metrics loop runs; until then nothing holds work back.
        machine: () => recentMachine(),
        work,
        legsDir: paths.legs,
        tmpDir: join(paths.dataDir, "tmp"),
        now,
        reviews,
        ...(options.stallCheckMs ? { stallCheckMs: options.stallCheckMs } : {}),
        ...(options.driftJudgeMs ? { driftJudgeMs: options.driftJudgeMs } : {}),
        visual,
      }),
  });
  // The Oraknid helper: what I ask in words, through Oraknid's own services (ADR-024).
  const helper = new Helper({
    db,
    bus,
    brain,
    projects: projectsService,
    github,
    registry,
    skills,
    runner,
    tools: toolRegistry,
    drafts: { db, bus, silk, skills, brain, now },
    // What it reads of mine, as the pages do (ADR-041).
    mail,
    servers: serverService,
    backups: backupPlans,
    sites,
    cloud,
    dataDir: paths.dataDir,
    inbox,
    decisions,
    logsDir: paths.logs,
    workDir: join(paths.dataDir, "helper"),
    now,
    // Its actions that are the UI's procedures, called with my device's rights (ADR-024).
    api: (path, input, who) => helperApi(path, input, who),
  });
  // Notifications start before recovery, so "Oraknid recovered" and its questions reach me (Audit 1 → D1-03).
  const notifications = new Notifications({
    db,
    secrets,
    uiUrl: () => url,
    channels: os.channels,
    now,
  });
  const notifyRouter = startNotificationRouter({
    db,
    bus,
    inbox,
    notifications,
    uiUrl: () => url,
    // A review's item opens the review itself (ADR-064).
    reviewOf: (itemId) => {
      const r = reviews.reviewOfItem(itemId);
      return r ? { id: r.id, kind: r.kind } : null;
    },
    ...(options.emailDelayMs ? { emailDelayMs: options.emailDelayMs } : {}),
  });
  backupPlans.start();
  const recovery = await recover({
    db,
    bus,
    jobs: jobsStore,
    journal,
    effects,
    runner,
    hooks: [() => void supervisor.recoverOrphans()],
  });
  const sandboxStatus = os.sandbox.status();

  const devices = new Devices(db, bus, now);
  // Oraknid's own updates, from its releases on GitHub (ADR-048).
  const updates = new Updates({
    db,
    bus,
    paths,
    now,
    runningJobs: countActiveJobs(db),
    ...options.updates,
  });
  // A pairing link for away left unused expires (ADR-029).
  const unclaimed = setInterval(() => devices.expireUnclaimed(10 * 60_000), 60_000);
  unclaimed.unref();
  // The PIN and each device's unlocked session (ADR-029).
  const lock = new AppLock(db, bus, (id) => devices.revoke(id), now);
  /** A socket's device, if it is also unlocked; "cli" needs no unlocking. A socket isn't activity. */
  // A revoked device loses its sessions and its push subscription at once (Audit 2).
  bus.subscribe((e) => {
    if (e.type !== "device.revoked") return;
    const id = (e.payload as { id?: string }).id;
    if (id) {
      lock.lock(id);
      notifications.forgetDevice(id);
    }
  });
  const unlocked = (token: string | undefined, session: string | undefined) => {
    const who = devices.identify(token);
    if (!who) return null;
    return who === "cli" || lock.check(who, session, false) ? who : null;
  };
  // The link to The Nest (Phase 4): connects once configured and listening.
  const nest = new NestLink({
    db,
    bus,
    secrets,
    devices,
    dataDir: paths.dataDir,
    localUrl: () => url,
    remoteUi: () => {
      const file = webRemote();
      return file ? readFileSync(file, "utf8") : null;
    },
    loaderScript: () => {
      const file = nestLoader();
      return file ? readFileSync(file) : null;
    },
  });
  // The web UI (apps/web), when it has been built; a terminal-only install has none (ADR-055).
  const web = options.webDir === undefined ? webDist() : options.webDir;
  // Terminal only: the install record says so (a clone serving its web UI from Vite is not), or a test.
  const webUi =
    options.webDir === undefined
      ? installedWithGui(options.updates?.appDir ?? findAppDir())
      : options.webDir !== null;
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  let port = options.port ?? DEFAULT_PORT;

  // A review's frame (ADR-064): its own origin, rv-<key>.localhost, answered before anything else.
  const frames = reviewFrames({ reviews, port: () => port });
  app.use((req, res, next) => {
    if (!frames.http(req, res)) next();
  });
  server.on("upgrade", (req, socket, head) => {
    frames.upgrade(req, socket, head);
  });

  app.use((req, res, next) => {
    if (isLocalRequest(req, port)) return next();
    res.status(403).json({ message: "Oraknid only accepts requests from this machine for now." });
  });

  // No other site may frame the UI or run anything in it (Audit 2).
  app.use((req, res, next) => {
    res.setHeader("Content-Security-Policy", uiCsp(port));
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  });

  // An id for every API call: in its response, its errors and its log lines (API-Contract).
  tagConsoleWithRequestIds();
  app.use("/api", requestIds);

  // Every client is a paired device, or the CLI (Security → The daemon's own surface).
  app.use("/api", (req, res, next) => {
    if (req.path === "/devices/pairComplete") return next();
    // A token in the address only for the live socket, which cannot send headers (Audit 1 → S1-14).
    const who = devices.identify(tokenOf(req.headers));
    if (who) {
      // Only the tunnel sets it; anyone else setting it only restricts themselves.
      const remote = req.headers["x-oraknid-remote"] === "1";
      const session = unlockOf(req.headers);
      res.locals.device = who === "cli" ? null : who;
      res.locals.remote = remote;
      res.locals.session = session;
      if (who === "cli" || LOCK_FREE.has(req.path)) return next();
      if (req.path === "/lock/setPin" && !remote && !lock.hasPin()) return next();
      if (!lock.check(who, session)) {
        rpcError(
          res,
          423,
          "LOCKED",
          lock.hasPin()
            ? "Locked: enter your PIN."
            : "Set your PIN first, on the computer running Oraknid.",
        );
        return;
      }
      // Away from home, nothing that could open a new way in (ADR-029, Audit 2).
      if (remote && !remoteAllowed(req.path, devices.isFull(who))) {
        rpcError(
          res,
          403,
          "FORBIDDEN",
          "That can only be done on the computer running Oraknid, not away from home.",
        );
        return;
      }
      // A use of full rights away from home is in the audit log (ADR-030).
      if (remote && needsFullRights(req.path))
        bus.publish({
          type: "device.awayUse",
          topic: "overview",
          jobId: null,
          payload: { device: who, path: req.path },
          actor: "owner",
        });
      return next();
    }
    res.status(401).json({
      message: "Pair this device first: run `oraknid pair` on the machine running Oraknid.",
    });
  });

  const live = attachLive({
    server,
    bus,
    allow: (req) =>
      isLocalRequest(req, port) &&
      unlocked(tokenOf(req.headers, req.url), unlockOf(req.headers, req.url)) !== null,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
    // A review frame's websockets are the app's own (ADR-064).
    skip: (req) => reviewKeyOf(req.headers.host, port) !== null,
    // A server's log, followed while its screen is open (ADR-043).
    followLog: (id, source, push, end) => serverService.insight.follow(id, source, push, end),
  });

  // The terminal: off until I turn it on, paired devices only (ADR-028).
  attachTerminal({
    server,
    bus,
    servers: serverService,
    device: (req) => {
      if (!isLocalRequest(req, port)) return null;
      const who = unlocked(tokenOf(req.headers, req.url), unlockOf(req.headers, req.url));
      // Away from home, only for a device with full rights (Audit 2, ADR-030).
      const away = new URL(req.url ?? "/", "http://x").searchParams.get("via") === "nest";
      return away && !devices.isFull(who) ? null : who;
    },
    active: (req) => {
      const who = devices.identify(tokenOf(req.headers, req.url));
      if (who && who !== "cli") lock.check(who, unlockOf(req.headers, req.url));
    },
    enabled: () => readSetting(db, TERMINAL_SETTING, z.boolean(), false),
    projectFolder: (id) => {
      try {
        return projectsService.require(id).workspacePath;
      } catch {
        return null;
      }
    },
  });

  const metricsLoop = startMetricsLoop({
    metrics: os.metrics,
    watched: () => [
      { id: "daemon", label: "Oraknid daemon", pid: process.pid },
      ...supervisor.watched(),
      ...models.watched(),
    ],
    onSample: (sample) => live.broadcastMetrics(sample),
    busy: () => live.metricsWatchers() > 0 || supervisor.watched().length > 0,
    ...(options.metricsIntervalMs ? { intervalMs: options.metricsIntervalMs } : {}),
  });
  recentMachine = () => {
    const recent = metricsLoop.recent(now() - 10_000);
    // A task waiting for room keeps the samples fresh, even with nothing else running.
    if ((recent.at(-1)?.at ?? 0) < now() - 2000) void metricsLoop.tick();
    return recent;
  };

  // The guard: danger on the machine paused for, and told once per incident (ADR-050).
  const guard = startGuard({
    work,
    bus,
    now,
    reading: () => work.d.reading?.() ?? null,
    lastSample: () => metricsLoop.recent(now() - 10_000).at(-1) ?? null,
    sessions: () => supervisor.about(),
    task: (taskId) =>
      db
        .select({
          title: tasksTable.title,
          kind: tasksTable.kind,
          verify: tasksTable.verify,
          instructions: tasksTable.instructions,
        })
        .from(tasksTable)
        .where(eq(tasksTable.id, taskId))
        .get() ?? null,
    pause: (jobId, taskId, why) => pauseForRoom(jobId, taskId, why),
    // Idle local models are unloaded before any task is paused (ADR-054).
    relieve: () => models.relieve(),
    ...(options.guardIntervalMs ? { intervalMs: options.guardIntervalMs } : {}),
    ...(options.guardClearMs !== undefined ? { clearMs: options.guardClearMs } : {}),
    ...(options.guardPauseEveryMs !== undefined ? { pauseEveryMs: options.guardPauseEveryMs } : {}),
  });
  // Room may have come back: waiting tasks look again.
  bus.subscribe((e) => {
    if (e.type === "machine.recovered" || e.type === "settings.updated") work.wake();
  });

  os.inhibitor.onChange((state) =>
    bus.publish({ type: "system.inhibitor", topic: "overview", jobId: null, payload: state }),
  );
  // The WAL folded back when no job is active (ADR-002).
  const checkpoint = startIdleCheckpoint(db, {
    idle: () => countActiveJobs(db)() === 0,
    log: (m) => console.error(m),
  });
  const inhibit = createInhibitController({
    inhibitor: os.inhibitor,
    activeJobs: countActiveJobs(db),
  });
  const legConfigDir = (legId: string) => {
    const c = registry.get(legId)?.config as { configDir?: unknown } | undefined;
    return typeof c?.configDir === "string" ? c.configDir : null;
  };
  /** A Codex Leg's CODEX_HOME, where a job's sign-in refresh goes back to (ADR-057). */
  const legCodexHome = (legId: string) => {
    const leg = registry.get(legId);
    return leg?.kind === "codex" ? codexHomeOf(leg, paths.legs) : null;
  };
  // Any job state change may start or end the need to stay awake.
  bus.subscribe((e) => {
    if (e.type === "job.state")
      void inhibit.reconcile().catch((err) => console.error("inhibitor failed", err));
    // An ended job asks me nothing any more (Audit 1 → Q1-12).
    const to = (e.payload as { to?: string } | null)?.to;
    if (e.type === "job.state" && e.jobId && (to === "completed" || to === "cancelled")) {
      for (const item of inbox.list({ jobId: e.jobId, state: "open" })) inbox.withdraw(item.id);
      // Its reviews wait for nothing any more (ADR-064).
      reviews.withdrawJob(e.jobId);
      forgetJob(db, e.jobId);
      forgetGuidance(e.jobId);
      // Its homes on the Legs go, keys and files (Audit 2, S2-08).
      removeJobHomes(paths.legs, e.jobId, legConfigDir, legCodexHome);
    }
  });

  // The Eye speaks up in each project's conversation: a task done, the job done, blocked (ADR-045).
  startEyeReports({
    db,
    bus,
    inbox,
    brain,
    now,
    // A server job's report: its state document's changes, its backup plans (ADR-049).
    servers: serverService,
    backupPlans: (serverId) => backupPlans.plans(serverId),
  });
  // Jobs named by what they are, and described: what for, then what they did.
  const naming = startJobNaming({
    db,
    bus,
    brain,
    now,
    tmpDir: join(paths.dataDir, "tmp", "naming"),
    ...options.naming,
  });
  const audit = startAuditExport(db, join(paths.logs, "audit"));
  const backups = startNightlyBackups(db, paths.backups, now);
  const budgets = startBudgetWatch({
    db,
    bus,
    inbox,
    runner,
    now,
    ...(options.budgetIntervalMs ? { intervalMs: options.budgetIntervalMs } : {}),
  });

  // A job blocked on quota resumes on its own once the window resets (Jobs-and-Projects → Blocked).
  const blockedTimer = setInterval(() => {
    for (const j of db.select().from(jobsTable).where(eq(jobsTable.state, "blocked")).all()) {
      if (j.blockedUntil && j.blockedUntil <= now()) {
        db.update(jobsTable).set({ blockedUntil: null }).where(eq(jobsTable.id, j.id)).run();
        void runner
          .resume(j.id)
          .then(() =>
            // I'm told it goes on, as I was told it stopped (Budgets-and-Quotas).
            bus.publish({
              type: "job.auto-resumed",
              topic: `job:${j.id}`,
              jobId: j.id,
              payload: { reason: "Its agents have quota again; it goes on by itself." },
              actor: "oraknid",
            }),
          )
          .catch((e) => console.error("auto-resume failed", e));
      }
    }
  }, 30_000);
  blockedTimer.unref();

  // Hand edits to the mirror are noticed within 30 s.
  const mirrorTimer = setInterval(() => {
    for (const { id } of db.select({ id: jobsTable.id }).from(jobsTable).all()) {
      try {
        silk.checkMirror(id);
      } catch (error) {
        console.error("silk mirror check failed", error);
      }
    }
  }, 30_000);
  mirrorTimer.unref();

  const health = startHealthChecks({
    registry,
    adapters,
    sandbox: os.sandbox,
    legsDir: paths.legs,
    now,
    ...(options.healthIntervalMs ? { intervalMs: options.healthIntervalMs } : {}),
  });
  void models.start().catch((err) => console.error("local models failed to start", err));
  // A Leg's plan usage in view, read while someone looks (ADR-039).
  const planUsage = new PlanUsage({
    db,
    registry,
    supervisor,
    adapters,
    sandbox: os.sandbox,
    legsDir: paths.legs,
    dataDir: paths.dataDir,
    now,
  });

  // Files in and out of the pool, and one-time downloads (ADR-046): before the procedures.
  attachCloudRoutes(app, cloud, downloads);
  // The API described (ADR-010, ADR-058): paired devices only, like every /api call.
  app.get("/api/openapi.json", (_req, res) => {
    // Loaded when first asked for: the generator costs nothing at start.
    import("./api/openapi.ts")
      .then((m) => m.openApiDocument())
      .then(
        (doc) => res.json(doc),
        (error) => {
          console.error("openapi document failed", error);
          res
            .status(500)
            .json({ message: "The API's description couldn't be made: see oraknid logs." });
        },
      );
  });
  // A zip of jobs or a project, and a whole Oraknid's archive, imported (ADR-061).
  attachMovingRoutes(app, { db, bus, paths, secrets, known: () => secrets.known() });
  if (imported)
    bus.publish({
      type: "oraknid.imported",
      topic: "overview",
      jobId: null,
      payload: { applied: true },
      actor: "owner",
    });
  cloud.onTransfer((t) => live.broadcastTransfer(t));

  /** What every procedure is called with: the device asking, and Oraknid's services. */
  const apiContext = (
    device: string | null,
    remote: boolean,
    session: string | undefined,
  ): ApiContext => ({
    device,
    remote,
    session,
    lock,
    startedAt,
    webUi,
    paths,
    bus,
    now,
    inhibitor: () => os.inhibitor.state(),
    secrets,
    sandbox: () => sandboxStatus,
    service: os.service,
    notifications,
    recentMetrics: metricsLoop.recent,
    work,
    machineHealth: () => guard.health(),
    jobs: jobsStore,
    runner,
    registry,
    health,
    planUsage,
    logins,
    nest,
    silk,
    inbox,
    projects: projectsService,
    skills,
    tools: toolRegistry,
    decisions,
    chats,
    github,
    repos,
    hosts,
    ci,
    helper,
    servers: serverService,
    backups: backupPlans,
    sites,
    cloud,
    downloads,
    mail,
    devices,
    updates,
    models,
    projectSecrets,
    reviews,
    brain,
    thinking,
    openPath:
      options.openPath ??
      ((path) => spawn("xdg-open", [path], { detached: true, stdio: "ignore" }).unref()),
    tmpDir: join(paths.dataDir, "tmp"),
  });

  /** A procedure by its dotted path, for the helper; what the input got wrong said in words. */
  async function helperApi(path: string, input: unknown, who: HelperWho) {
    let proc: unknown = router;
    for (const k of path.split(".")) proc = (proc as Record<string, unknown> | undefined)?.[k];
    if (!proc) throw new Error(`No procedure ${path}.`);
    try {
      return await call(proc as never, input as never, {
        context: apiContext(who.device, who.remote, undefined),
      });
    } catch (error) {
      if (!(error instanceof ORPCError)) throw error;
      const issues = (
        error.data as { issues?: { path?: unknown[]; message: string }[] } | undefined
      )?.issues;
      throw new Error(
        issues?.length
          ? `Its input was wrong: ${issues
              .map(
                (x) =>
                  `${(x.path ?? []).map((p) => (typeof p === "object" && p ? (p as { key: unknown }).key : p)).join(".")}: ${x.message}`,
              )
              .join("; ")}`
          : error.message,
      );
    }
  }

  const rpc = new RPCHandler(router);
  app.use("/api", async (req, res, next) => {
    const { matched } = await rpc.handle(req, res, {
      prefix: "/api",
      context: apiContext(
        (res.locals.device as string | null | undefined) ?? null,
        res.locals.remote === true,
        res.locals.session as string | undefined,
      ),
    });
    if (!matched) next();
  });

  // Back from Google's or Microsoft's sign-in (ADR-063): only a sign-in started here is accepted.
  app.get("/oauth/mail/callback", async (req, res) => {
    const q = (k: string) =>
      typeof req.query[k] === "string" ? (req.query[k] as string) : undefined;
    const page = (title: string, text: string) =>
      `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;
    const esc = (s: string) =>
      s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    try {
      const { email } = await mail.oauthCallback({
        ...(q("state") ? { state: q("state") } : {}),
        ...(q("code") ? { code: q("code") } : {}),
        ...(q("error") ? { error: q("error") } : {}),
      });
      res
        .type("html")
        .send(page("Connected", `${esc(email)} is connected to Oraknid. You can close this tab.`));
    } catch (error) {
      res
        .status(400)
        .type("html")
        .send(page("Not connected", esc(error instanceof Error ? error.message : String(error))));
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // The web UI: static files, and the app for every other path.
  if (web) {
    app.use(express.static(web, { index: false, maxAge: "1h" }));
    // Relative to its folder: a path with a hidden folder in it (~/.local/…) is served all the same.
    app.get(/^\/(?!api\/|live$).*/, (_req, res) => res.sendFile("index.html", { root: web }));
  } else {
    // Terminal only (ADR-055): a few lines saying so, which a browser shows as they are.
    app.get(/^\/(?!api\/|live$).*/, (req, res) => {
      res
        .status(req.path === "/" ? 200 : 404)
        .type("text/plain")
        .send(NO_WEB_UI);
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  url = `http://${host}:${port}`;
  void nest.connect().catch((err) => console.error("nest link failed", err));
  mail.start();
  updates.start();

  const info: RuntimeInfo = { pid: process.pid, url, version: VERSION, startedAt };
  // Readable by my user only: it holds the CLI's token.
  if (options.writeRuntimeFile) {
    writeFileSync(paths.runtimeFile, `${JSON.stringify({ ...info, token: devices.cliToken })}\n`, {
      mode: 0o600,
    });
  }

  bus.publish({
    type: "system.started",
    topic: "overview",
    jobId: null,
    payload: { version: VERSION },
  });
  // Recovery may have left jobs active: take the lock straight away if so.
  await inhibit.reconcile();
  void health.checkAll().catch((err) => console.error("health check failed", err));
  resumeConversations({
    db,
    bus,
    silk,
    runner,
    brain,
    inbox,
    thinking,
    tmpDir: join(paths.dataDir, "tmp"),
    now,
  });
  // A server's conversation too (ADR-049): a question no job took is answered now.
  resumeServerConversations({
    db,
    bus,
    silk,
    runner,
    brain,
    inbox,
    tmpDir: join(paths.dataDir, "tmp"),
    now,
    servers: serverService,
    projects: projectsService,
    dir: serverJobsDir(paths.dataDir),
    newJob: (projectId, goal) =>
      projectsService.createJob({
        projectId,
        goal,
        inputs: [],
        autonomy: "auto",
        allowedLegIds: [],
        verify: [],
        unsandboxed: false,
      }),
    startJob: async (id) => {
      await runner.start(id);
    },
  });
  os.serviceNotifier.ready();
  const stopWatchdog = os.serviceNotifier.startWatchdog();

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      os.serviceNotifier.stopping();
      stopWatchdog();
      bus.publish({ type: "system.stopping", topic: "overview", jobId: null, payload: null });
      metricsLoop.stop();
      guard.stop();
      // Nothing may start a run once shutdown begins: timers and watchers go first (Audit 1 → D1-08).
      health.stop();
      clearInterval(mirrorTimer);
      clearInterval(unclaimed);
      clearInterval(blockedTimer);
      checkpoint.stop();
      updates.stop();
      budgets.stop();
      naming.stop();
      ciWatch?.stop();
      // Jobs reach a safe point and keep their state for the next start, within systemd's stop timeout.
      await Promise.race([
        runner.shutdown(),
        new Promise((resolve) => setTimeout(resolve, 140_000).unref()),
      ]);
      notifyRouter.stop();
      audit.stop();
      backups.stop();
      logins.stopAll();
      chats.stopAll();
      serverService.stop();
      sites.stop();
      backupPlans.stop();
      cloud.stop();
      await mail.stop();
      nest.stop();
      await supervisor.killAll();
      // Every model's server stops with the daemon.
      await models.stop();
      await inhibit.stop();
      await live.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive connections would otherwise hold close() open.
        server.closeAllConnections();
      });
      bus.close();
      closeDatabase(db);
      if (options.writeRuntimeFile) rmSync(paths.runtimeFile, { force: true });
    })();
    return closing;
  };

  return {
    url,
    port,
    info,
    bus,
    db,
    live,
    inhibit,
    notifications,
    secrets,
    metricsLoop,
    work,
    guard,
    jobs: jobsStore,
    runner,
    registry,
    supervisor,
    health,
    planUsage,
    silk,
    skills,
    budgets,
    projects: projectsService,
    servers: serverService,
    backups: backupPlans,
    sites,
    cloud,
    mail,
    github,
    hosts,
    devices,
    updates,
    models,
    cliToken: devices.cliToken,
    inbox,
    helper,
    effects,
    recovery,
    naming,
    thinking,
    ciWatch,
    reviews,
    close,
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** The Nest's loader script as built in this checkout (apps/nest/public/assets), if it was. */
function nestLoader(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const assets = join(dir, "nest", "public", "app", "assets");
    if (existsSync(assets)) {
      const js = readdirSync(assets).find((f) => f.endsWith(".js"));
      if (js) return join(assets, js);
    }
    dir = dirname(dir);
  }
  return null;
}

/** The remote UI, one self-contained page (apps/web/dist-remote), if it was built. */
function webRemote(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "web", "dist-remote", "index.html");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/** An error the API's clients read like any other (oRPC's shape). */
function rpcError(res: express.Response, status: number, code: string, message: string) {
  const requestId = res.locals.requestId as string | undefined;
  res.status(status).json({
    json: { defined: false, code, status, message, ...(requestId ? { data: { requestId } } : {}) },
  });
}

/**
 * The UI's content policy: its own scripts only, no framing. Images may
 * come from the web for mail I allowed them in (ADR-032); a message's own
 * frame blocks them until I do. The review page frames a review's own
 * origin on this port, rv-<key>.localhost (ADR-064).
 */
const uiCsp = (port: number) =>
  [...UI_CSP_BASE, `frame-src 'self' http://*.localhost:${port}`].join("; ");

const UI_CSP_BASE = [
  "default-src 'self'",
  "script-src 'self'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
];

/** What a browser reads from an Oraknid without its web UI built (ADR-055). */
export const NO_WEB_UI = `This Oraknid has no web UI here: it was installed for the terminal only
(or, in a clone, the web UI isn't built).

Use it in a terminal on this machine:  oraknid
Add the web UI:                        oraknid install --gui
`;

/** Whether the install record (if any) says the web UI was installed; a clone has it. */
function installedWithGui(appDir: string | null): boolean {
  if (!appDir) return true;
  const i = readInstall(appDir);
  return i.mode !== "script" || i.gui;
}

/** apps/web/dist, found from this module (src/ or dist/), if it was built. */
function webDist(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "web", "dist");
    if (existsSync(join(candidate, "index.html"))) return candidate;
    dir = dirname(dir);
  }
  return null;
}

export { DEFAULT_PORT };
