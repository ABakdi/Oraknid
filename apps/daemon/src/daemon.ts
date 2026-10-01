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

  mkdirSync(paths.dataDir, { recursive: true });
  const db = await openDatabase({ file: options.dbFile ?? paths.db, backupsDir: paths.backups });
  const bus = new EventBus(db, now);

  const app = express();
  app.disable("x-powered-by");
  const server = createServer(app);
  let port = options.port ?? DEFAULT_PORT;

  app.use((req, res, next) => {
    if (isLocalRequest(req, port)) return next();
    res.status(403).json({ message: "Oraknid only accepts requests from this machine for now." });
  });

  const rpc = new RPCHandler(router);
  app.use("/api", async (req, res, next) => {
    const { matched } = await rpc.handle(req, res, {
      prefix: "/api",
      context: { startedAt, paths, bus, now },
    });
    if (!matched) next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, version: VERSION });
  });

  const live = attachLive({
    server,
    bus,
    allow: (req) => isLocalRequest(req, port),
    ...(options.heartbeatMs ? { heartbeatMs: options.heartbeatMs } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const url = `http://${host}:${port}`;

  const info: RuntimeInfo = { pid: process.pid, url, version: VERSION, startedAt };
  if (options.writeRuntimeFile) writeFileSync(paths.runtimeFile, `${JSON.stringify(info)}\n`);

  bus.publish({
    type: "system.started",
    topic: "overview",
    jobId: null,
    payload: { version: VERSION },
  });

  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      bus.publish({ type: "system.stopping", topic: "overview", jobId: null, payload: null });
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

  return { url, port, info, bus, db, live, close };
}

export type Daemon = Awaited<ReturnType<typeof startDaemon>>;
export { DEFAULT_PORT };
