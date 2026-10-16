import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type Event,
  type ServerProxies,
  type ServerView,
  type SiteCheck,
} from "@oraknid/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../db/open.ts";
import { siteChecks, sites as sitesTable } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { siteLine } from "../helper/sites-actions.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Notifications } from "../notify/notifications.ts";
import { startNotificationRouter } from "../notify/router.ts";
import { checkUrl, type Resolver, readCert, readDns } from "./probes.ts";
import { askScript, readAddress, Sites, siteName } from "./service.ts";

// Sites, domains, certificates and uptime (ADR-060), against stand-ins on
// 127.0.0.1: an HTTP server, a TLS server with a certificate made here, and
// a resolver that answers from a table. Nothing leaves this computer.

const closing: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closing.splice(0).reverse()) await c();
});

/** An HTTP server answering with the status `status()` says. */
async function web(status: () => number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const s: Server = createServer((_req, res) => {
    hits++;
    res.statusCode = status();
    res.end("ok");
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closing.push(() => new Promise<void>((r) => s.close(() => r())));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/`, hits: () => hits };
}

/** A TLS server presenting a self-signed certificate for `name`, good `days`. */
async function tlsServer(name: string, days: number): Promise<number> {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-sites-cert-"));
  closing.push(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      String(days),
      "-subj",
      `/O=Test CA/CN=${name}`,
      "-addext",
      `subjectAltName=DNS:${name}`,
    ],
    { stdio: "ignore" },
  );
  const s = tls.createServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    },
    (socket) => socket.end(),
  );
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closing.push(() => new Promise<void>((r) => s.close(() => r())));
  return (s.address() as { port: number }).port;
}

/** A resolver answering from a table; a name not in it is ENOTFOUND. */
function table(t: Record<string, { a?: string[]; aaaa?: string[]; cname?: string[] }>): Resolver {
  const get = (h: string, k: "a" | "aaaa" | "cname") => {
    const e = t[h];
    if (!e) return Promise.reject(Object.assign(new Error("not found"), { code: "ENOTFOUND" }));
    const v = e[k];
    return v?.length
      ? Promise.resolve(v)
      : Promise.reject(Object.assign(new Error("no data"), { code: "ENODATA" }));
  };
  return {
    resolve4: (h) => get(h, "a"),
    resolve6: (h) => get(h, "aaaa"),
    resolveCname: (h) => get(h, "cname"),
    lookup: async (h) => [...(t[h]?.a ?? []), ...(t[h]?.aaaa ?? [])],
  };
}

describe("the probes (ADR-060)", () => {
  it("reads DNS: A, AAAA, CNAME, and whether it points at its server", async () => {
    const r = table({
      "shop.example.com": { a: ["203.0.113.5"], aaaa: ["2001:db8::5"] },
      "blog.example.com": { a: ["198.51.100.9"], cname: ["blog.host.example"] },
      "vps.example.net": { a: ["203.0.113.5"] },
    });
    expect(await readDns(r, "shop.example.com", "vps.example.net")).toEqual({
      a: ["203.0.113.5"],
      aaaa: ["2001:db8::5"],
      cname: [],
      pointsHere: true,
      error: null,
    });
    expect(await readDns(r, "blog.example.com", "203.0.113.5")).toMatchObject({
      cname: ["blog.host.example"],
      pointsHere: false,
    });
    expect(await readDns(r, "gone.example.com", "203.0.113.5")).toMatchObject({
      pointsHere: null,
      error: "No such domain: DNS doesn't know it.",
    });
  });

  it("reads a certificate from a handshake: its end, issuer and names; an untrusted or wrong one says why", async () => {
    const port = await tlsServer("shop.example.com", 10);
    const c = await readCert("shop.example.com", { connectHost: "127.0.0.1", port });
    expect(c.names).toEqual(["shop.example.com"]);
    expect(c.issuer).toContain("Test CA");
    expect(c.expiresAt).toBeGreaterThan(Date.now() + 9 * 86_400_000);
    expect(c.expiresAt).toBeLessThan(Date.now() + 11 * 86_400_000);
    // Self-signed: read, but not trusted.
    expect(c.valid).toBe(false);
    expect(c.error).toMatch(/isn't trusted/);
    const other = await readCert("other.example.com", { connectHost: "127.0.0.1", port });
    expect(other.error).toMatch(/isn't for other.example.com/);
    const none = await readCert("x.example.com", { connectHost: "127.0.0.1", port: 1 });
    expect(none.expiresAt).toBeNull();
    expect(none.error).toMatch(/refused/);
  });

  it("an uptime check: up below 500, down on a 5xx or no answer, redirects not followed", async () => {
    let status = 301;
    const w = await web(() => status);
    expect(await checkUrl(w.url)).toMatchObject({ up: true, status: 301, error: null });
    status = 503;
    expect(await checkUrl(w.url)).toMatchObject({ up: false, status: 503 });
    expect(await checkUrl("http://127.0.0.1:1/")).toMatchObject({
      up: false,
      status: null,
      error: "The connection was refused: nothing listens there.",
    });
  });

  it("knows a domain from what isn't one", () => {
    expect(siteName("Shop.Example.com.")).toBe("shop.example.com");
    for (const n of ["_", "localhost", "*.example.com", "10.0.0.1", "intranet", "~^x$", "a.local"])
      expect(siteName(n)).toBeNull();
    expect(readAddress("example.com")).toEqual({
      host: "example.com",
      url: "https://example.com/",
    });
    expect(readAddress("http://127.0.0.1:8080/health")).toEqual({
      host: "127.0.0.1:8080",
      url: "http://127.0.0.1:8080/health",
    });
    expect(() => readAddress("not a domain")).toThrow(/isn't a domain/);
  });
});

describe("sites across my servers (ADR-060)", () => {
  let db: Db;
  let bus: EventBus;
  let now: number;
  const events: Event[] = [];
  const server = { id: "01J00000000000000000000001", name: "vps", host: "vps.example.net" };
  const proxies: ServerProxies = {
    proxies: [
      {
        kind: "nginx",
        source: "service",
        name: "nginx",
        state: "active",
        version: "1.18",
        check: null,
        sites: [
          {
            names: ["shop.example.com", "www.shop.example.com"],
            listen: ["443 ssl"],
            upstreams: ["127.0.0.1:3000"],
            root: null,
            redirect: null,
            certificate: "/etc/ssl/shop.pem",
            accessLog: null,
          },
          {
            names: ["_", "localhost"],
            listen: ["80"],
            upstreams: [],
            root: "/var/www/html",
            redirect: null,
            certificate: null,
            accessLog: null,
          },
        ],
        certificates: [],
        accessLogs: [],
        errorLogs: [],
        notes: [],
      },
    ],
    notes: [],
  } as unknown as ServerProxies;

  beforeEach(async () => {
    db = await openDatabase({ file: ":memory:" });
    now = Date.parse("2026-10-07T12:00:00Z");
    bus = new EventBus(db, () => now);
    events.length = 0;
    bus.subscribe((e) => events.push(e));
  });

  const make = (o: { tlsPort?: number } = {}) =>
    new Sites({
      db,
      bus,
      now: () => now,
      servers: {
        list: () => [{ ...server, setup: "ready" } as unknown as ServerView],
        insight: {
          part: async () => ({ at: now, data: proxies }),
        } as never,
        run: async () => {
          throw new Error("no SSH in this test");
        },
      },
      resolver: table({
        "shop.example.com": { a: ["203.0.113.5"] },
        "www.shop.example.com": { a: ["198.51.100.1"] },
        "vps.example.net": { a: ["203.0.113.5"] },
      }),
      ...(o.tlsPort ? { tls: () => ({ host: "127.0.0.1", port: o.tlsPort as number }) } : {}),
      timeoutMs: 2000,
      retryDelaysMs: [0, 0],
    });

  it("finds the proxies' sites once per domain, reads DNS and the certificate, keeps a removed one hidden", async () => {
    const port = await tlsServer("shop.example.com", 5);
    const s = make({ tlsPort: port });
    const found = await s.find();
    expect(found.added).toEqual(["shop.example.com", "www.shop.example.com"]);
    expect((await s.find()).added).toEqual([]);
    const shop = s.list().find((x) => x.host === "shop.example.com");
    expect(shop).toMatchObject({
      url: "https://shop.example.com/",
      serverName: "vps",
      source: "nginx",
      upstream: "127.0.0.1:3000",
    });
    // The https check goes to the real domain: here only DNS and the certificate are read.
    await s.tick().catch(() => {});
    const read = s.view(shop?.id as string);
    expect(read.dns).toMatchObject({ a: ["203.0.113.5"], pointsHere: true });
    expect(read.cert.names).toEqual(["shop.example.com"]);
    expect(read.cert.expiresAt).toBeGreaterThan(Date.now());
    const www = s.list().find((x) => x.host === "www.shop.example.com");
    expect(www?.dns?.pointsHere).toBe(false);

    s.remove(www?.id as string);
    expect(s.list().map((x) => x.host)).toEqual(["shop.example.com"]);
    expect((await s.find()).added).toEqual([]);
    expect(s.list().map((x) => x.host)).toEqual(["shop.example.com"]);
  });

  it("down after two failed checks, said once; up again said with how long; checks kept 7 days", async () => {
    let status = 200;
    const w = await web(() => status);
    const s = make();
    const site = await s.add(w.url);
    expect(site).toMatchObject({ up: true, source: "owner", serverId: null, lastStatus: 200 });
    expect(site.cert.error).toMatch(/http/);
    expect(() => s.update({ id: site.id, intervalMin: 1 })).not.toThrow();

    status = 502;
    now += 60_000;
    await s.tick();
    expect(events.filter((e) => e.type === "site.down")).toHaveLength(0);
    now += 60_000;
    await s.tick();
    now += 60_000;
    await s.tick();
    const down = events.filter((e) => e.type === "site.down");
    expect(down).toHaveLength(1);
    expect(down[0]?.payload).toMatchObject({ host: site.host, error: "It answered 502." });
    expect(s.view(site.id).downSince).toBe(now - 120_000);

    status = 200;
    now += 60_000;
    await s.tick();
    const up = events.filter((e) => e.type === "site.up");
    expect(up).toHaveLength(1);
    expect(up[0]?.payload).toMatchObject({ downForMs: 180_000 });
    const v = s.view(site.id);
    expect(v.downSince).toBeNull();
    expect(v.uptime24h).toBeCloseTo(2 / 5);
    expect(v.recent).toHaveLength(5);
    expect(siteLine(v, now)).toContain("uptime 24 h 40.0%");

    // Not due yet: no check.
    const before = w.hits();
    await s.tick();
    expect(w.hits()).toBe(before);

    // A week on, the old checks go.
    now += 8 * 86_400_000;
    await s.tick();
    expect(db.select().from(siteChecks).all()).toHaveLength(1);
    // Turned off: no checks.
    s.update({ id: site.id, checkEnabled: false });
    now += 3_600_000;
    await s.tick();
    expect(w.hits()).toBe(before + 1);
    s.remove(site.id);
    expect(db.select().from(sitesTable).all()).toHaveLength(0);
  });
});

// A site is down only when it is down (ADR-071). The owner's day, 2026-10-16:
// 18 sites on one server, every check from this computer losing about 40% of
// its connections, 300 notifications. Here the network and SSH are stand-ins:
// a probe that fails as told, and a server whose `run` answers from a table.
describe("a site is down only when it is down (ADR-071)", () => {
  let db: Db;
  let bus: EventBus;
  let now: number;
  const events: Event[] = [];
  const sent: { title: string; body: string; urgency?: string; channels: string[] }[] = [];
  let router: { stop(): void } | undefined;
  const server = {
    id: "01J00000000000000000000001",
    name: "staging",
    host: "203.0.113.5",
    setup: "ready",
    hostKeyOffered: null,
  } as unknown as ServerView;
  const NO_ANSWER = { up: false, status: null, latencyMs: null, error: "No answer in 10 seconds." };
  const UP = { up: true, status: 200, latencyMs: 80, error: null };

  beforeEach(async () => {
    db = await openDatabase({ file: ":memory:" });
    now = Date.parse("2026-10-16T00:00:00Z");
    bus = new EventBus(db, () => now);
    events.length = 0;
    sent.length = 0;
    bus.subscribe((e) => events.push(e));
    router = startNotificationRouter({
      db,
      bus,
      inbox: {} as InboxStore,
      notifications: {
        settings: () => DEFAULT_NOTIFICATION_SETTINGS,
        send: async (n: { title: string; body: string; urgency?: string }, channels: string[]) => {
          sent.push({ title: n.title, body: n.body, urgency: n.urgency, channels });
          return [];
        },
      } as unknown as Notifications,
      uiUrl: () => "http://127.0.0.1:1",
    });
  });
  afterEach(() => router?.stop());

  /** n sites on the server (or on none), checked every 5 minutes; their certificates read already. */
  const seed = (n: number, serverId: string | null = server.id) =>
    Array.from({ length: n }, (_, i) => {
      const id = `01J0000000000000000000S${String(i).padStart(3, "0")}`;
      db.insert(sitesTable)
        .values({
          id,
          host: `s${i}.example.com`,
          url: `https://s${i}.example.com/`,
          serverId,
          source: serverId ? "nginx" : "owner",
          createdAt: now,
          certAt: now + 365 * 86_400_000,
          dns: { a: ["203.0.113.5"], aaaa: [], cname: [], pointsHere: true, error: null },
        })
        .run();
      return id;
    });

  const make = (o: {
    probe: (url: string) => Omit<SiteCheck, "at">;
    run?: (command: string) => string;
  }) => {
    const asked: string[] = [];
    const probed: string[] = [];
    const s = new Sites({
      db,
      bus,
      now: () => now,
      servers: {
        list: () => [server],
        insight: { part: async () => ({ at: now, data: { proxies: [], notes: [] } }) } as never,
        run: async (_id: string, command: string) => {
          asked.push(command);
          if (!o.run) throw new Error("staging couldn't be reached over SSH: timed out");
          return { code: 0, stdout: o.run(command), stderr: "" };
        },
      },
      probe: async (url) => {
        probed.push(url);
        return o.probe(url);
      },
      retryDelaysMs: [0, 0],
    });
    return { s, asked, probed };
  };

  /** What a server answers for each site its script asks about. */
  const answering = (status: (host: string) => number) => (command: string) =>
    [...command.matchAll(/^ask '(\S+)' 'https:\/\/([^/]+)\//gm)]
      .map((m) => `${m[1]} ${String(status(m[2] as string)).padStart(3, "0")}`)
      .join("\n");

  const settle = () => new Promise((r) => setTimeout(r, 0));
  const of = (type: string) => events.filter((e) => e.type === type);

  it("the owner's day: 18 sites, connections lost from here, the server says they answer: one notification", async () => {
    seed(18);
    // Seeded, so the day is the same each run: most rounds lose 40% of the
    // connections, a quarter lose 90% (most of the 18 failing at once).
    let x = 20261016;
    const random = () => {
      x = (x * 1103515245 + 12345) % 2 ** 31;
      return x / 2 ** 31;
    };
    let loss = 0.4;
    const { s, asked, probed } = make({
      probe: () => (random() < loss ? NO_ANSWER : UP),
      run: answering(() => 200),
    });
    let fromHere = 0;
    for (let round = 0; round < 288; round++) {
      loss = round % 8 === 3 || round % 8 === 4 ? 0.9 : 0.4;
      now += 5 * 60_000;
      await s.tick();
      fromHere += s.list().filter((v) => v.downReason === "path").length;
    }
    await settle();
    // Each check was tried again: far fewer failures counted than connections lost.
    const failed = db
      .select()
      .from(siteChecks)
      .all()
      .filter((c) => !c.up).length;
    expect(probed.length).toBeGreaterThan(288 * 18);
    expect(failed).toBeLessThan((288 * 18) / 4);
    expect(fromHere).toBeGreaterThan(0);
    expect(asked.length).toBeGreaterThan(0);
    // No site said down or up: the server answered for each.
    expect(of("site.down")).toHaveLength(0);
    expect(of("site.up")).toHaveLength(0);
    // One incident said, about the server, not about 18 sites.
    expect(of("site.path")).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      title: "This computer is losing its connection to staging",
      urgency: "normal",
      channels: ["desktop"],
    });
    expect(sent[0]?.body).toMatch(
      /^\d+ of its 18 sites didn't answer from here; from the server they answer\./,
    );
  });

  it("a real outage: the server gets no answer either, said down once and up once", async () => {
    const [shop] = seed(3);
    let broken = true;
    const { s, asked } = make({
      probe: (url) => (broken && url.includes("s0.") ? NO_ANSWER : UP),
      run: answering((host) => (broken && host === "s0.example.com" ? 0 : 200)),
    });
    for (let i = 0; i < 6; i++) {
      now += 5 * 60_000;
      await s.tick();
    }
    expect(of("site.down")).toHaveLength(1);
    expect(of("site.down")[0]?.payload).toMatchObject({
      host: "s0.example.com",
      why: "staging gets no answer from it either.",
    });
    expect(s.view(shop as string)).toMatchObject({ downReason: "site" });
    // Asked once, at the second failure; said, it isn't asked again.
    expect(asked).toHaveLength(1);
    broken = false;
    now += 5 * 60_000;
    await s.tick();
    await settle();
    expect(of("site.up")).toHaveLength(1);
    expect(of("site.path")).toHaveLength(0);
    expect(sent.map((n) => [n.title, n.urgency])).toEqual([
      ["Down: s0.example.com", "critical"],
      ["Up again: s0.example.com", "normal"],
    ]);
    expect(sent[0]?.body).toBe("No answer in 10 seconds. staging gets no answer from it either.");
  });

  it("a domain gone from DNS is down without asking; a 5xx too; said once each, not tried again", async () => {
    seed(3);
    const { s, asked, probed } = make({
      probe: (url) =>
        url.includes("s0.")
          ? {
              up: false,
              status: null,
              latencyMs: null,
              error: "No such domain: DNS doesn't know it.",
            }
          : url.includes("s1.")
            ? { up: false, status: 502, latencyMs: 40, error: "It answered 502." }
            : UP,
      run: answering(() => 200),
    });
    for (let i = 0; i < 10; i++) {
      now += 5 * 60_000;
      await s.tick();
    }
    expect(of("site.down").map((e) => (e.payload as { host: string }).host)).toEqual(
      expect.arrayContaining(["s0.example.com", "s1.example.com"]),
    );
    expect(of("site.down")).toHaveLength(2);
    expect(asked).toHaveLength(0);
    // An answer is an answer: 3 sites, 10 rounds, one try each.
    expect(probed).toHaveLength(30);
  });

  it("the server can't be reached either: one incident about the server, no site down; its end is quiet", async () => {
    const ids = seed(4);
    let lost = true;
    const { s } = make({ probe: () => (lost ? NO_ANSWER : UP) });
    for (let i = 0; i < 4; i++) {
      now += 5 * 60_000;
      await s.tick();
    }
    await settle();
    expect(of("site.down")).toHaveLength(0);
    expect(s.view(ids[0] as string).downReason).toBe("server");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.title).toBe("Can't reach staging from this computer");
    expect(sent[0]?.body).toMatch(
      /^4 of its 4 sites didn't answer from here, and neither did staging over SSH/,
    );
    lost = false;
    now += 5 * 60_000;
    await s.tick();
    await settle();
    expect(of("site.path-ok")).toHaveLength(1);
    expect(of("site.up")).toHaveLength(0);
    expect(sent).toHaveLength(1);
    expect(s.view(ids[0] as string)).toMatchObject({ downSince: null, downReason: null });
    // Again within the day: not said again.
    lost = true;
    for (let i = 0; i < 3; i++) {
      now += 5 * 60_000;
      await s.tick();
    }
    await settle();
    expect(of("site.path")).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("flap damping: back less than 30 minutes ago, it is said again only after failing for 15 minutes", async () => {
    const [id] = seed(1, null);
    let up = false;
    const { s } = make({ probe: () => (up ? UP : NO_ANSWER) });
    const round = async () => {
      now += 5 * 60_000;
      await s.tick();
    };
    // A short down never said: its comeback isn't said either.
    await round();
    up = true;
    await round();
    expect(of("site.down")).toHaveLength(0);
    expect(of("site.up")).toHaveLength(0);
    // Down (no server to ask: said after two), then back.
    up = false;
    await round();
    await round();
    expect(of("site.down")).toHaveLength(1);
    up = true;
    await round();
    expect(of("site.up")).toHaveLength(1);
    // Fails again at once: held while it came back less than 30 minutes ago.
    up = false;
    await round();
    await round();
    await round();
    expect(of("site.down")).toHaveLength(1);
    await round();
    expect(of("site.down")).toHaveLength(2);
    expect(s.view(id as string).downSince).toBe(now - 15 * 60_000);
  });

  it("the server's script fetches each site at home, the domain resolved to the server", async () => {
    const w = await web(() => 204);
    const port = new URL(w.url).port;
    const script = askScript([
      {
        id: "01J0000000000000000000S001",
        url: `http://shop.example.com:${port}/`,
        dns: { a: ["127.0.0.1"], aaaa: [], cname: [], pointsHere: true, error: null },
      },
      { id: "01J0000000000000000000S002", url: "http://gone.example.com:1/", dns: null },
    ]);
    // Run here with sh, as the server would: --resolve keeps it on 127.0.0.1.
    const out = await new Promise<string>((done, fail) =>
      execFile("sh", ["-c", script], (e, stdout) => (e ? fail(e) : done(stdout))),
    );
    expect(out.trim().split("\n").sort()).toEqual([
      "01J0000000000000000000S001 204",
      "01J0000000000000000000S002 000",
    ]);
    expect(w.hits()).toBe(1);
  });
});
