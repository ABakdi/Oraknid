import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { LegKind } from "@oraknid/contracts";
import { createClaudeCodeAdapter } from "@oraknid/leg-claude-code";
import { createOpenAICompatibleAdapter } from "@oraknid/leg-openai-compatible";
import type { LegAdapter } from "@oraknid/leg-sdk";
import { RPCHandler } from "@orpc/server/node";
import express from "express";
import { router } from "./api/router.ts";
import { closeDatabase, openDatabase } from "./db/open.ts";
import { SideEffects } from "./engine/effects.ts";
import { JobStore } from "./engine/jobs.ts";
import { StepJournal } from "./engine/journal.ts";
import { recover } from "./engine/recovery.ts";
import { type JobProgram, JobRunner } from "./engine/runner.ts";
import { EventBus } from "./events/bus.ts";
import { isLocalRequest } from "./http/guard.ts";
import { InboxStore } from "./inbox/store.ts";
import { startHealthChecks } from "./legs/health.ts";
import { LegRegistry } from "./legs/registry.ts";
import { LegSupervisor } from "./legs/supervisor.ts";
import { attachLive } from "./live/server.ts";
import { Notifications } from "./notify/notifications.ts";
import { linuxOs, type OsDeps } from "./os/context.ts";
import { countActiveJobs, createInhibitController } from "./os/inhibit-controller.ts";
import { startMetricsLoop } from "./os/metrics-loop.ts";
import { Secrets } from "./os/secrets.ts";
import { DEFAULT_HOST, DEFAULT_PORT, type Paths } from "./paths.ts";
import { VERSION } from "./version.ts";

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
  /** What runs a job. The Eye takes this over in M1.6. */
  program?: JobProgram;
  /** Leg adapters by kind (tests replace them). */
  adapters?: Partial<Record<LegKind, LegAdapter>>;
  healthIntervalMs?: number;
}

/** Until The Eye exists (M1.6), a started job stops with an honest reason. */
const notYet: JobProgram = async () => {
  throw new Error("Oraknid cannot plan jobs yet: The Eye arrives in milestone M1.6.");
};

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
  const bus = new EventBus(db, now);

  const secrets = new Secrets(paths.dataDir, os.keychain);
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
  });

  // Recovery comes first, before the API answers anyone (Durability spec).
  const jobsStore = new JobStore(db, bus, now);
  const journal = new StepJournal(db, now);
  const inbox = new InboxStore(db, bus, now);
  const effects = new SideEffects(db, bus, inbox, now);
  const runner = new JobRunner({
    jobs: jobsStore,
    journal,
    effects,
    inbox,
    bus,
    program: options.program ?? notYet,
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

  const live = attachLive({
    server,
    bus,
    allow: (req) => isLocalRequest(req, port),
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
      },
    });
    if (!matched) next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

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
  if (options.writeRuntimeFile) writeFileSync(paths.runtimeFile, `${JSON.stringify(info)}\n`);

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
      await supervisor.killAll();
      await inhibit.stop();
      await live.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Idle keep-alive connections would otherwise hold close() open.
        server.closeAllConnections();
      });
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
    inbox,
    effects,
    recovery,
    close,
  };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;
export { DEFAULT_PORT };
