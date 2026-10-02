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
import { scrubSecrets } from "@oraknid/core";
import { createAntigravityAdapter } from "@oraknid/leg-antigravity";
import { createClaudeCodeAdapter } from "@oraknid/leg-claude-code";
import { createOpenAICompatibleAdapter } from "@oraknid/leg-openai-compatible";
import { createOpenCodeAdapter } from "@oraknid/leg-opencode";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { RPCHandler } from "@orpc/server/node";
import { eq } from "drizzle-orm";
import express from "express";
import { z } from "zod";
import { router } from "./api/router.ts";
import { startAuditExport } from "./audit/audit.ts";
import { Devices, tokenOf } from "./auth/devices.ts";
import { Chats } from "./chats/service.ts";
import { closeDatabase, openDatabase } from "./db/open.ts";
import { jobs as jobsTable } from "./db/schema.ts";
import { SideEffects } from "./engine/effects.ts";
import { JobStore } from "./engine/jobs.ts";
import { StepJournal } from "./engine/journal.ts";
import { recover } from "./engine/recovery.ts";
import { type JobProgram, JobRunner } from "./engine/runner.ts";
import { EventBus } from "./events/bus.ts";
import { forgetJob } from "./eye/attempt.ts";
import { type EyeBrain, PoolLegBrain } from "./eye/brain.ts";
import { startBudgetWatch } from "./eye/budgets.ts";
import { EyeDecisions } from "./eye/decisions.ts";
import { eyeProgram } from "./eye/program.ts";
import { forgetGuidance, resumeConversations } from "./eye/talk.ts";
import { Helper } from "./helper/service.ts";
import { isLocalRequest } from "./http/guard.ts";
import { InboxStore } from "./inbox/store.ts";
import { startHealthChecks } from "./legs/health.ts";
import { LegLogins } from "./legs/login.ts";
import { LegRegistry } from "./legs/registry.ts";
import { LegSupervisor } from "./legs/supervisor.ts";
import { attachLive } from "./live/server.ts";
import { NestLink } from "./nest/link.ts";
import { Notifications } from "./notify/notifications.ts";
import { startNotificationRouter } from "./notify/router.ts";
import { linuxOs, type OsDeps } from "./os/context.ts";
import { countActiveJobs, createInhibitController } from "./os/inhibit-controller.ts";
import { startMetricsLoop } from "./os/metrics-loop.ts";
import { Secrets } from "./os/secrets.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type Paths } from "./paths.ts";
import { Servers } from "./servers/service.ts";
import { MAX_RUNNING_JOBS, readSetting } from "./settings.ts";
import { SilkStore } from "./silk/store.ts";
import { SkillStore } from "./skills/store.ts";
import { startNightlyBackups } from "./storage/storage.ts";
import { attachTerminal, TERMINAL_SETTING } from "./term/server.ts";
import { McpBroker } from "./tools/broker.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { VERSION } from "./version.ts";
import { setShadowRoot } from "./workspace/git.ts";
import { GitHub } from "./workspace/github.ts";
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
  /** Seconds between oraknid-monitor readings (tests: shorter). */
  serverSampleSec?: number;
  /** GitHub's addresses, for tests against a stand-in. */
  github?: { api?: string; web?: string };
  /** What runs a job: The Eye, unless a test replaces it. */
  program?: JobProgram;
  /** The Eye's reasoning (tests replace it). */
  brain?: EyeBrain;
  /** Opens a folder on this machine; tests replace it. */
  openPath?: (path: string) => void;
  stallCheckMs?: number;
  budgetIntervalMs?: number;
  emailDelayMs?: number;
  /** Leg adapters by kind (tests replace them). */
  adapters?: Partial<Record<LegKind, LegAdapter>>;
  healthIntervalMs?: number;
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
  const db = await openDatabase({ file: options.dbFile ?? paths.db, backupsDir: paths.backups });
  const secrets = new Secrets(paths.dataDir, os.keychain);
  const bus = new EventBus(db, now);
  // Secrets never reach the event log (BR-13).
  bus.scrub = (text) => scrubSecrets(text, secrets.known());

  await secrets.init();
  const adapters: Partial<Record<LegKind, LegAdapter>> = options.adapters ?? {
    "claude-code": createClaudeCodeAdapter(),
    "openai-compatible": createOpenAICompatibleAdapter(),
    opencode: createOpenCodeAdapter(),
    antigravity: createAntigravityAdapter(),
  };
  const registry = new LegRegistry(db, bus, secrets, paths.legs, now);
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
  const effects = new SideEffects(db, bus, inbox, now);
  const silk = new SilkStore(db, bus, inbox, now);
  const skills = new SkillStore(db, now);
  skills.seedBuiltIns();
  const projectsService = new Projects(db, bus, skills, now);
  // Tools for skills: MCP servers the daemon runs, never the Legs (ADR-021).
  const toolRegistry = new ToolRegistry(db, bus, secrets, now);
  const broker = new McpBroker({ registry: toolRegistry, sandbox: os.sandbox });
  // GitHub through a token I paste (ADR-023).
  const github = new GitHub(secrets, options.github ?? {});
  // Chats with my models: talk and research (ADR-025).
  const chats = new Chats({ db, bus, registry, supervisor, dataDir: paths.dataDir, now });
  // A model per kind of decision, and the shadow planner (ADR-022).
  const decisions = new EyeDecisions(db, bus, now);
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
    });
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
    try {
      silk.answerImport(id, answer);
    } catch (error) {
      console.error("silk import failed", error);
    }
  });
  // The last ten seconds of the machine, for resource-aware scheduling (ADR-016).
  let recentMachine: () => MetricsSample[] = () => [];
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
  const runner = new JobRunner({
    // How many jobs run at once; the rest queue by priority (ADR-016).
    maxRunning: () => readSetting(db, MAX_RUNNING_JOBS, z.number().int().min(1), 2),
    jobs: jobsStore,
    journal,
    effects,
    inbox,
    bus,
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
        effects,
        // Set once the metrics loop runs; until then nothing holds work back.
        machine: () => recentMachine(),
        legsDir: paths.legs,
        tmpDir: join(paths.dataDir, "tmp"),
        now,
        ...(options.stallCheckMs ? { stallCheckMs: options.stallCheckMs } : {}),
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
    logsDir: paths.logs,
    workDir: join(paths.dataDir, "helper"),
    now,
  });
  // Notifications start before recovery, so "Oraknid recovered" and its questions reach me (Audit 1 → D1-03).
  let url = "";
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
    ...(options.emailDelayMs ? { emailDelayMs: options.emailDelayMs } : {}),
  });
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
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  let port = options.port ?? DEFAULT_PORT;

  app.use((req, res, next) => {
    if (isLocalRequest(req, port)) return next();
    res.status(403).json({ message: "Oraknid only accepts requests from this machine for now." });
  });

  // Every client is a paired device, or the CLI (Security → The daemon's own surface).
  app.use("/api", (req, res, next) => {
    if (req.path === "/devices/pairComplete") return next();
    // A token in the address only for the live socket, which cannot send headers (Audit 1 → S1-14).
    const who = devices.identify(tokenOf(req.headers));
    if (who) {
      res.locals.device = who === "cli" ? null : who;
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
      isLocalRequest(req, port) && devices.identify(tokenOf(req.headers, req.url)) !== null,
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
  });

  // The terminal: off until I turn it on, paired devices only (ADR-028).
  attachTerminal({
    server,
    bus,
    servers: serverService,
    device: (req) =>
      isLocalRequest(req, port) ? devices.identify(tokenOf(req.headers, req.url)) : null,
    enabled: () => readSetting(db, TERMINAL_SETTING, z.boolean(), false),
  });

  const metricsLoop = startMetricsLoop({
    metrics: os.metrics,
    watched: () => [
      { id: "daemon", label: "Oraknid daemon", pid: process.pid },
      ...supervisor.watched(),
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

  os.inhibitor.onChange((state) =>
    bus.publish({ type: "system.inhibitor", topic: "overview", jobId: null, payload: state }),
  );
  const inhibit = createInhibitController({
    inhibitor: os.inhibitor,
    activeJobs: countActiveJobs(db),
  });
  // Any job state change may start or end the need to stay awake.
  bus.subscribe((e) => {
    if (e.type === "job.state")
      void inhibit.reconcile().catch((err) => console.error("inhibitor failed", err));
    // An ended job asks me nothing any more (Audit 1 → Q1-12).
    const to = (e.payload as { to?: string } | null)?.to;
    if (e.type === "job.state" && e.jobId && (to === "completed" || to === "cancelled")) {
      for (const item of inbox.list({ jobId: e.jobId, state: "open" })) inbox.withdraw(item.id);
      forgetJob(e.jobId);
      forgetGuidance(e.jobId);
    }
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
        void runner.resume(j.id).catch((e) => console.error("auto-resume failed", e));
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

  const rpc = new RPCHandler(router);
  app.use("/api", async (req, res, next) => {
    const { matched } = await rpc.handle(req, res, {
      prefix: "/api",
      context: {
        device: (res.locals.device as string | null | undefined) ?? null,
        startedAt,
        paths,
        bus,
        now,
        inhibitor: () => os.inhibitor.state(),
        secrets,
        sandbox: () => sandboxStatus,
        service: os.service,
        notifications,
        recentMetrics: metricsLoop.recent,
        jobs: jobsStore,
        runner,
        registry,
        health,
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
        helper,
        servers: serverService,
        devices,
        brain,
        openPath:
          options.openPath ??
          ((path) => spawn("xdg-open", [path], { detached: true, stdio: "ignore" }).unref()),
        tmpDir: join(paths.dataDir, "tmp"),
      },
    });
    if (!matched) next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  // The web UI (apps/web), when it has been built: static files, and the app for every other path.
  const web = webDist();
  if (web) {
    app.use(express.static(web, { index: false, maxAge: "1h" }));
    app.get(/^\/(?!api\/|live$).*/, (_req, res) => res.sendFile(join(web, "index.html")));
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
  resumeConversations({ db, bus, silk, runner, brain, tmpDir: join(paths.dataDir, "tmp"), now });
  os.serviceNotifier.ready();
  const stopWatchdog = os.serviceNotifier.startWatchdog();

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      os.serviceNotifier.stopping();
      stopWatchdog();
      bus.publish({ type: "system.stopping", topic: "overview", jobId: null, payload: null });
      metricsLoop.stop();
      // Nothing may start a run once shutdown begins: timers and watchers go first (Audit 1 → D1-08).
      health.stop();
      clearInterval(mirrorTimer);
      clearInterval(blockedTimer);
      budgets.stop();
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
      nest.stop();
      await supervisor.killAll();
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
    jobs: jobsStore,
    runner,
    registry,
    supervisor,
    health,
    silk,
    skills,
    budgets,
    projects: projectsService,
    servers: serverService,
    devices,
    cliToken: devices.cliToken,
    inbox,
    effects,
    recovery,
    close,
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;

/** The Nest's loader script as built in this checkout (apps/nest/public/assets), if it was. */
function nestLoader(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const assets = join(dir, "nest", "public", "assets");
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
