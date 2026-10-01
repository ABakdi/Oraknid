import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { LegKind } from "@oraknid/contracts";
import { scrubSecrets } from "@oraknid/core";
import { createClaudeCodeAdapter } from "@oraknid/leg-claude-code";
import { createOpenAICompatibleAdapter } from "@oraknid/leg-openai-compatible";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { RPCHandler } from "@orpc/server/node";
import { eq } from "drizzle-orm";
import express from "express";
import { z } from "zod";
import { router } from "./api/router.ts";
import { startAuditExport } from "./audit/audit.ts";
import { Devices, tokenOf } from "./auth/devices.ts";
import { closeDatabase, openDatabase } from "./db/open.ts";
import { jobs as jobsTable } from "./db/schema.ts";
import { SideEffects } from "./engine/effects.ts";
import { JobStore } from "./engine/jobs.ts";
import { StepJournal } from "./engine/journal.ts";
import { recover } from "./engine/recovery.ts";
import { type JobProgram, JobRunner } from "./engine/runner.ts";
import { EventBus } from "./events/bus.ts";
import { type EyeBrain, PoolLegBrain } from "./eye/brain.ts";
import { startBudgetWatch } from "./eye/budgets.ts";
import { eyeProgram } from "./eye/program.ts";
import { isLocalRequest } from "./http/guard.ts";
import { InboxStore } from "./inbox/store.ts";
import { startHealthChecks } from "./legs/health.ts";
import { LegRegistry } from "./legs/registry.ts";
import { LegSupervisor } from "./legs/supervisor.ts";
import { attachLive } from "./live/server.ts";
import { Notifications } from "./notify/notifications.ts";
import { startNotificationRouter } from "./notify/router.ts";
import { linuxOs, type OsDeps } from "./os/context.ts";
import { countActiveJobs, createInhibitController } from "./os/inhibit-controller.ts";
import { startMetricsLoop } from "./os/metrics-loop.ts";
import { Secrets } from "./os/secrets.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type Paths } from "./paths.ts";
import { readSetting } from "./settings.ts";
import { SilkStore } from "./silk/store.ts";
import { SkillStore } from "./skills/store.ts";
import { VERSION } from "./version.ts";
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
  /** What runs a job: The Eye, unless a test replaces it. */
  program?: JobProgram;
  /** The Eye's reasoning (tests replace it). */
  brain?: EyeBrain;
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

  mkdirSync(paths.dataDir, { recursive: true });
  const db = await openDatabase({ file: options.dbFile ?? paths.db, backupsDir: paths.backups });
  const secrets = new Secrets(paths.dataDir, os.keychain);
  const bus = new EventBus(db, now);
  // Secrets never reach the event log (BR-13).
  bus.scrub = (text) => scrubSecrets(text, secrets.known());

  await secrets.init();
  const adapters: Partial<Record<LegKind, LegAdapter>> = options.adapters ?? {
    "claude-code": createClaudeCodeAdapter(),
    "openai-compatible": createOpenAICompatibleAdapter(),
  };
  const registry = new LegRegistry(db, bus, secrets, paths.legs, now);
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
  const brain =
    options.brain ??
    new PoolLegBrain({
      registry,
      supervisor,
      pinnedModelId: () => readSetting(db, EYE_LEG_SETTING, z.string().nullable(), null),
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
  const runner = new JobRunner({
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
        legsDir: paths.legs,
        tmpDir: join(paths.dataDir, "tmp"),
        now,
        ...(options.stallCheckMs ? { stallCheckMs: options.stallCheckMs } : {}),
      }),
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
  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  let port = options.port ?? DEFAULT_PORT;
  let url = "";

  const notifications = new Notifications({
    db,
    secrets,
    uiUrl: () => url,
    channels: os.channels,
    now,
  });

  app.use((req, res, next) => {
    if (isLocalRequest(req, port)) return next();
    res.status(403).json({ message: "Oraknid only accepts requests from this machine for now." });
  });

  // Every client is a paired device, or the CLI (Security → The daemon's own surface).
  app.use("/api", (req, res, next) => {
    if (req.path === "/devices/pairComplete") return next();
    if (devices.identify(tokenOf(req.headers, req.originalUrl))) return next();
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

  const metricsLoop = startMetricsLoop({
    metrics: os.metrics,
    watched: () => [
      { id: "daemon", label: "Oraknid daemon", pid: process.pid },
      ...supervisor.watched(),
    ],
    onSample: (sample) => live.broadcastMetrics(sample),
    ...(options.metricsIntervalMs ? { intervalMs: options.metricsIntervalMs } : {}),
  });

  os.inhibitor.onChange((state) =>
    bus.publish({ type: "system.inhibitor", topic: "overview", jobId: null, payload: state }),
  );
  const inhibit = createInhibitController({
    inhibitor: os.inhibitor,
    activeJobs: countActiveJobs(db),
  });
  // Any job state change may start or end the need to stay awake.
  bus.subscribe((e) => {
    if (e.type === "job.state") void inhibit.reconcile();
  });

  const notifyRouter = startNotificationRouter({
    db,
    bus,
    inbox,
    notifications,
    uiUrl: () => url,
    ...(options.emailDelayMs ? { emailDelayMs: options.emailDelayMs } : {}),
  });
  const audit = startAuditExport(db, join(paths.logs, "audit"));
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
        silk,
        inbox,
        projects: projectsService,
        skills,
        devices,
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
  void health.checkAll();
  os.serviceNotifier.ready();
  const stopWatchdog = os.serviceNotifier.startWatchdog();

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      os.serviceNotifier.stopping();
      stopWatchdog();
      bus.publish({ type: "system.stopping", topic: "overview", jobId: null, payload: null });
      metricsLoop.stop();
      // Jobs reach a safe point and keep their state for the next start.
      await runner.shutdown();
      health.stop();
      clearInterval(mirrorTimer);
      clearInterval(blockedTimer);
      budgets.stop();
      notifyRouter.stop();
      audit.stop();
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
    devices,
    cliToken: devices.cliToken,
    inbox,
    effects,
    recovery,
    close,
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;

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
