import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { RPCHandler } from "@orpc/server/node";
import express from "express";
import { router } from "./api/router.ts";
import { closeDatabase, openDatabase } from "./db/open.ts";
import { EventBus } from "./events/bus.ts";
import { isLocalRequest } from "./http/guard.ts";
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
}

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
    watched: () => [{ id: "daemon", label: "Oraknid daemon", pid: process.pid }],
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
  os.serviceNotifier.ready();
  const stopWatchdog = os.serviceNotifier.startWatchdog();

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      os.serviceNotifier.stopping();
      stopWatchdog();
      bus.publish({ type: "system.stopping", topic: "overview", jobId: null, payload: null });
      metricsLoop.stop();
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

  return { url, port, info, bus, db, live, inhibit, notifications, secrets, metricsLoop, close };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;
export { DEFAULT_PORT };
