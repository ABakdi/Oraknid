import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

// The Nest (Nest-Protocol): a relay I host myself. Daemons connect out to
// it; my devices connect to it; it moves opaque frames between the two
// sockets of each connection, and reads nothing. A public Nest (ADR-031)
// also lets daemons register themselves, and keeps only their ids and
// their secrets' hashes.

export interface NestOptions {
  /** The daemons it accepts: id → secret. */
  daemons: Map<string, string>;
  /** Public: other daemons register themselves (ADR-031). Private by default. */
  mode?: "private" | "public";
  /** When set, registering needs this code. */
  invite?: string;
  /** Where a public Nest keeps its registered daemons (only their secrets' hashes). In memory without it. */
  dataDir?: string;
  /** The loader (a page and its script), served as files. */
  publicDir?: string;
  limits?: Partial<Limits>;
}

interface Limits {
  devicesPerAddress: number;
  devicesPerDaemon: number;
  frameBytes: number;
  idleMs: number;
  /** How long a device has to be answered by its daemon (its handshake), and how much it may send before. */
  handshakeMs: number;
  preHandshakeFrames: number;
  preHandshakeBytes: number;
  /** A public Nest's limits (ADR-031), for daemons that registered themselves. */
  registrationsPerAddressHour: number;
  maxDaemons: number;
  devicesPerRegistered: number;
  bytesPerDaemonDay: number;
  forgetAfterMs: number;
}

const DEFAULTS: Limits = {
  devicesPerAddress: 10,
  devicesPerDaemon: 50,
  frameBytes: 4 * 1024 * 1024,
  idleMs: 60_000,
  handshakeMs: 10_000,
  preHandshakeFrames: 3,
  preHandshakeBytes: 4096,
  registrationsPerAddressHour: 5,
  maxDaemons: 1000,
  devicesPerRegistered: 10,
  bytesPerDaemonDay: 2 * 1024 ** 3,
  forgetAfterMs: 30 * 24 * 3600_000,
};

/** A daemon that registered itself: only a hash of its secret is kept. */
interface Registered {
  hash: string;
  createdAt: number;
  lastSeen: number;
}

interface DaemonLink {
  id: string;
  /** A daemon that registered itself: its devices and bytes are counted (ADR-031). */
  metered: boolean;
  ws: WebSocket;
  devices: Map<number, WebSocket>;
  next: number;
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
// The secrets are long and random, so a plain hash is enough to keep them.
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export function createNest(o: NestOptions): { server: Server; close(): Promise<void> } {
  const limits = { ...DEFAULTS, ...o.limits };
  const publicNest = o.mode === "public";
  const app = express();
  app.disable("x-powered-by");
  // Its page is never framed by another site, and loads nothing it doesn't name (Audit 2).
  app.use((_req, res, next) => {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "base-uri 'none'; object-src 'none'; form-action 'none'",
    );
    next();
  });
  const daemons = new Map<string, DaemonLink>();
  const perAddress = new Map<string, number>();
  const answered = new WeakMap<WebSocket, { answered: boolean; frames: number }>();

  // An IPv6 address counts by its /64: one machine has a whole one (Audit 2).
  const address = (req: IncomingMessage) => {
    const a =
      String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "?")
        .split(",")[0]
        ?.trim() ?? "?";
    return a.includes(":") && !a.startsWith("::ffff:")
      ? `${a.split(":").slice(0, 4).join(":")}::/64`
      : a;
  };
  // Only its own page talks to it from a browser: another site's visitors can't use it (Audit 2).
  const foreign = (req: IncomingMessage) => {
    const origin = req.headers.origin;
    return (
      !!origin &&
      origin !== `https://${req.headers.host}` &&
      origin !== `http://${req.headers.host}`
    );
  };

  // The daemons that registered themselves (ADR-031), kept in one small file.
  const file = publicNest && o.dataDir ? join(o.dataDir, "daemons.json") : null;
  const registered = new Map<string, Registered>(
    file && existsSync(file)
      ? Object.entries(JSON.parse(readFileSync(file, "utf8")) as Record<string, Registered>)
      : [],
  );
  let dirty = false;
  const save = () => {
    dirty = false;
    if (!file || !o.dataDir) return;
    mkdirSync(o.dataDir, { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify(Object.fromEntries(registered))}\n`, {
      mode: 0o600,
    });
    renameSync(`${file}.tmp`, file);
  };
  const registrations = new Map<string, number[]>();
  const usage = new Map<string, { day: string; bytes: number }>();
  const today = () => new Date().toISOString().slice(0, 10);
  // Hourly: a daemon unseen for thirty days is forgotten; one connected now is seen now.
  const tidy = () => {
    const now = Date.now();
    for (const [id, r] of registered) {
      if (daemons.has(id)) {
        r.lastSeen = now;
        dirty = true;
      } else if (now - r.lastSeen > limits.forgetAfterMs) {
        registered.delete(id);
        dirty = true;
      }
    }
    for (const [from, times] of registrations)
      if (times.every((t) => now - t >= 3600_000)) registrations.delete(from);
    for (const [id, u] of usage) if (u.day !== today()) usage.delete(id);
    if (dirty) save();
  };
  tidy();
  const tidying = setInterval(tidy, 3600_000);
  tidying.unref();

  /** Counts what a registered daemon relays today; false once its day's share is used up. */
  const carry = (link: DaemonLink, bytes: number) => {
    if (!link.metered) return true;
    let u = usage.get(link.id);
    if (!u || u.day !== today()) {
      u = { day: today(), bytes: 0 };
      usage.set(link.id, u);
    }
    u.bytes += bytes;
    return u.bytes <= limits.bytesPerDaemonDay;
  };

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  // What kind of Nest this is, for its page and for Oraknid at home.
  app.get("/info", (_req, res) => {
    res.json({ mode: publicNest ? "public" : "private", inviteRequired: publicNest && !!o.invite });
  });
  if (publicNest)
    app.post("/register", express.json({ limit: "1kb" }), (req, res) => {
      const fail = (status: number, message: string) => {
        res.status(status).json({ message });
      };
      if (foreign(req)) return fail(403, "Register from Oraknid, not from a web page.");
      // Every try counts, a wrong invite code too.
      const from = address(req);
      const now = Date.now();
      const recent = (registrations.get(from) ?? []).filter((t) => now - t < 3600_000);
      if (recent.length >= limits.registrationsPerAddressHour)
        return fail(429, "Too many registrations from this address; try again in an hour.");
      recent.push(now);
      registrations.set(from, recent);
      const invite: unknown = req.body?.invite;
      if (o.invite && !same(sha256(typeof invite === "string" ? invite : ""), sha256(o.invite)))
        return fail(403, "This Nest needs an invite code, and that one isn't right.");
      if (registered.size >= limits.maxDaemons)
        return fail(503, "This Nest is full. Try another one, or run your own.");
      let id: string;
      do id = `d-${randomBytes(8).toString("hex")}`;
      while (registered.has(id) || o.daemons.has(id));
      const secret = randomBytes(32).toString("base64url");
      registered.set(id, { hash: sha256(secret), createdAt: now, lastSeen: now });
      save();
      res.status(201).json({ id, secret });
    });
  if (o.publicDir && existsSync(o.publicDir)) app.use(express.static(o.publicDir));
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.frameBytes });

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
      const self = expected === undefined ? registered.get(id) : undefined;
      const ok = expected ? same(secret, expected) : !!self && same(sha256(secret), self.hash);
      if (!ok) return refuse(401, "Unauthorized");
      if (self) {
        self.lastSeen = Date.now();
        dirty = true;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        onDaemon(id, ws, !!self);
      });
      return;
    }
    if (url.pathname === "/device") {
      // Only its own page opens device sockets: another site's visitors can't fill them (Audit 2).
      if (foreign(req)) return refuse(403, "Forbidden");
      const link = daemons.get(url.searchParams.get("daemon") ?? "");
      if (!link) return refuse(404, "Not Found");
      const from = address(req);
      if ((perAddress.get(from) ?? 0) >= limits.devicesPerAddress)
        return refuse(429, "Too Many Requests");
      const most = link.metered ? limits.devicesPerRegistered : limits.devicesPerDaemon;
      if (link.devices.size >= most) return refuse(503, "Service Unavailable");
      if (!carry(link, 0)) return refuse(429, "Too Many Requests");
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
        onDevice(link, ws, from);
      });
      return;
    }
    refuse(404, "Not Found");
  });

  function onDaemon(id: string, ws: WebSocket, metered: boolean) {
    // A daemon that reconnects replaces its old link; that link's devices are closed.
    daemons.get(id)?.ws.close(4000, "replaced");
    const link: DaemonLink = { id, metered, ws, devices: new Map(), next: 1 };
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
      else if (typeof m.f === "string" && device.readyState === WebSocket.OPEN) {
        if (!carry(link, m.f.length))
          return device.close(4029, "the daemon's share for today is used");
        const s = answered.get(device);
        if (s) s.answered = true;
        device.send(m.f);
      }
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
    // Until its daemon answers (the handshake), a device sends a few small frames, and has ten seconds.
    const state = { answered: false, frames: 0 };
    answered.set(ws, state);
    const deadline = setTimeout(() => {
      if (!state.answered) ws.close(4008, "no handshake");
    }, limits.handshakeMs);
    ws.on("message", (data) => {
      const f = String(data);
      if (
        !state.answered &&
        (++state.frames > limits.preHandshakeFrames || f.length > limits.preHandshakeBytes)
      ) {
        ws.close(4009, "too much before the handshake");
        return;
      }
      if (!carry(link, f.length)) return ws.close(4029, "the daemon's share for today is used");
      toDaemon({ c, f });
    });
    ws.on("close", () => {
      clearTimeout(deadline);
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
        clearInterval(tidying);
        if (dirty) save();
        for (const ws of wss.clients) ws.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
