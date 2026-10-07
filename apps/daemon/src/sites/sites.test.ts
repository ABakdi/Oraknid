import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import type { Event, ServerProxies, ServerView } from "@oraknid/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Db, openDatabase } from "../db/open.ts";
import { siteChecks, sites as sitesTable } from "../db/schema.ts";
import { EventBus } from "../events/bus.ts";
import { siteLine } from "../helper/sites-actions.ts";
import { checkUrl, type Resolver, readCert, readDns } from "./probes.ts";
import { readAddress, Sites, siteName } from "./service.ts";

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
      },
      resolver: table({
        "shop.example.com": { a: ["203.0.113.5"] },
        "www.shop.example.com": { a: ["198.51.100.1"] },
        "vps.example.net": { a: ["203.0.113.5"] },
      }),
      ...(o.tlsPort ? { tls: () => ({ host: "127.0.0.1", port: o.tlsPort as number }) } : {}),
      timeoutMs: 2000,
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
