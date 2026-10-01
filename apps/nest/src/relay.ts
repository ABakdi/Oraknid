import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

// The Nest (Nest-Protocol): a relay I host myself. Daemons connect out to
// it; my devices connect to it; it moves opaque frames between the two
// sockets of each connection, and stores and reads nothing.

export interface NestOptions {
  /** The daemons it accepts: id → secret. */
  daemons: Map<string, string>;
  /** The loader (a page and its script), served as files. */
  publicDir?: string;
  limits?: Partial<Limits>;
}

interface Limits {
  devicesPerAddress: number;
  devicesPerDaemon: number;
  frameBytes: number;
  idleMs: number;
}

const DEFAULTS: Limits = {
  devicesPerAddress: 10,
  devicesPerDaemon: 50,
  frameBytes: 4 * 1024 * 1024,
  idleMs: 60_000,
};

interface DaemonLink {
  ws: WebSocket;
  devices: Map<number, WebSocket>;
  next: number;
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function createNest(o: NestOptions): { server: Server; close(): Promise<void> } {
  const limits = { ...DEFAULTS, ...o.limits };
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  if (o.publicDir && existsSync(o.publicDir)) app.use(express.static(o.publicDir));
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes });
  const daemons = new Map<string, DaemonLink>();
  const perAddress = new Map<string, number>();

  const address = (req: IncomingMessage) =>
    String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?")
      .split(",")[0]
      ?.trim() ?? "?";

  // Sockets that stop answering pings are dropped.
  const alive = new WeakMap<WebSocket, boolean>();
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, limits.idleMs / 2);
  heartbeat.unref();
  wss.on("connection", (ws) => {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://nest");
    const refuse = (code: number, why: string) => {
      socket.write(`HTTP/1.1 ${code} ${why}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname === "/daemon") {
      const id = url.searchParams.get("id") ?? "";
      const secret = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      const expected = o.daemons.get(id);
      if (!expected || !same(secret, expected)) return refuse(401, "Unauthorized");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        onDaemon(id, ws);
      });
      return;
    }
    if (url.pathname === "/device") {
      const link = daemons.get(url.searchParams.get("daemon") ?? "");
      if (!link) return refuse(404, "Not Found");
      const from = address(req);
      if ((perAddress.get(from) ?? 0) >= limits.devicesPerAddress)
        return refuse(429, "Too Many Requests");
      if (link.devices.size >= limits.devicesPerDaemon) return refuse(503, "Service Unavailable");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        onDevice(link, ws, from);
      });
      return;
    }
    refuse(404, "Not Found");
  });

  function onDaemon(id: string, ws: WebSocket) {
    // A daemon that reconnects replaces its old link; that link's devices are closed.
    daemons.get(id)?.ws.close(4000, "replaced");
    const link: DaemonLink = { ws, devices: new Map(), next: 1 };
    daemons.set(id, link);
    ws.on("message", (data) => {
      let m: { c?: number; f?: string; close?: boolean };
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      const device = typeof m.c === "number" ? link.devices.get(m.c) : undefined;
      if (!device) return;
      if (m.close) device.close(1000, "closed by the daemon");
      else if (typeof m.f === "string" && device.readyState === WebSocket.OPEN) device.send(m.f);
    });
    ws.on("close", () => {
      if (daemons.get(id) === link) daemons.delete(id);
      for (const d of link.devices.values()) d.close(1001, "the daemon went away");
    });
  }

  function onDevice(link: DaemonLink, ws: WebSocket, from: string) {
    const c = link.next++;
    link.devices.set(c, ws);
    perAddress.set(from, (perAddress.get(from) ?? 0) + 1);
    const toDaemon = (m: object) => {
      if (link.ws.readyState === WebSocket.OPEN) link.ws.send(JSON.stringify(m));
    };
    toDaemon({ c, open: true });
    ws.on("message", (data) => toDaemon({ c, f: String(data) }));
    ws.on("close", () => {
      link.devices.delete(c);
      perAddress.set(from, Math.max(0, (perAddress.get(from) ?? 1) - 1));
      toDaemon({ c, close: true });
    });
  }

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
