import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonEnd, DeviceEnd, newKeyPair, ready } from "@oraknid/tunnel";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createNest } from "./relay.ts";

let nest: ReturnType<typeof createNest> | undefined;
beforeAll(() => ready());
afterEach(async () => {
  await nest?.close();
  nest = undefined;
});

async function start(limits = {}) {
  nest = createNest({ daemons: new Map([["home", "s3cret"]]), limits });
  await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
  const port = (nest.server.address() as { port: number }).port;
  return `ws://127.0.0.1:${port}`;
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("unexpected-response", (_q, res) => reject(new Error(String(res.statusCode))));
    ws.once("error", reject);
  });

describe("The Nest (Nest-Protocol)", () => {
  it("carries an end-to-end tunnel between a device and its daemon, seeing only ciphertext", async () => {
    const base = await start();
    const daemonKeys = await newKeyPair();
    const deviceKeys = await newKeyPair();
    const daemon = new WebSocket(`${base}/daemon?id=home`, {
      headers: { authorization: "Bearer s3cret" },
    });
    await opened(daemon);
    const ends = new Map<number, DaemonEnd>();
    const got: unknown[] = [];
    daemon.on("message", (data) => {
      const m = JSON.parse(String(data)) as { c: number; open?: boolean; f?: string };
      if (m.open) {
        ends.set(
          m.c,
          new DaemonEnd({ keys: daemonKeys, devicePublicKey: () => deviceKeys.publicKey }),
        );
        return;
      }
      if (!m.f) return;
      const end = ends.get(m.c) as DaemonEnd;
      const r = end.receive(m.f);
      for (const f of r.replies) daemon.send(JSON.stringify({ c: m.c, f }));
      for (const msg of r.messages) {
        got.push(msg);
        daemon.send(JSON.stringify({ c: m.c, f: end.seal({ echo: msg }) }));
      }
    });
    const device = new WebSocket(`${base}/device?daemon=home`);
    await opened(device);
    const me = new DeviceEnd({
      deviceId: "phone",
      keys: deviceKeys,
      daemonPublicKey: daemonKeys.publicKey,
    });
    const answers: unknown[] = [];
    const isOpen = new Promise<void>((resolve) => {
      device.on("message", (data) => {
        const r = me.receive(String(data));
        for (const f of r.replies) device.send(f);
        answers.push(...r.messages);
        if (me.ready) resolve();
      });
    });
    device.send(me.hello());
    await isOpen;
    device.send(me.seal({ approve: "item 7" }));
    const end = Date.now() + 2000;
    while (answers.length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ approve: "item 7" }]);
    expect(answers).toEqual([{ echo: { approve: "item 7" } }]);
    device.close();
    daemon.close();
  });

  it("refuses a daemon with the wrong secret, a device for a daemon that isn't there, and too many devices", async () => {
    const base = await start({ devicesPerAddress: 1 });
    await expect(
      opened(
        new WebSocket(`${base}/daemon?id=home`, { headers: { authorization: "Bearer nope" } }),
      ),
    ).rejects.toThrow("401");
    await expect(opened(new WebSocket(`${base}/device?daemon=home`))).rejects.toThrow("404");
    const daemon = new WebSocket(`${base}/daemon?id=home`, {
      headers: { authorization: "Bearer s3cret" },
    });
    await opened(daemon);
    const first = new WebSocket(`${base}/device?daemon=home`);
    await opened(first);
    await expect(opened(new WebSocket(`${base}/device?daemon=home`))).rejects.toThrow("429");
    first.close();
    daemon.close();
  });
});

describe("A public Nest (ADR-031)", () => {
  async function startPublic(o: Partial<Parameters<typeof createNest>[0]> = {}) {
    nest = createNest({ daemons: new Map(), mode: "public", ...o });
    await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(nest.server.address() as { port: number }).port}`;
  }
  const register = (base: string, body: object = {}) =>
    fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const daemon = (base: string, id: string, secret: string) =>
    new WebSocket(`${base.replace(/^http/, "ws")}/daemon?id=${id}`, {
      headers: { authorization: `Bearer ${secret}` },
    });

  it("lets a daemon register itself, keeps only its secret's hash, and knows it after a restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-nest-"));
    let base = await startPublic({ dataDir: dir });
    expect(await (await fetch(`${base}/info`)).json()).toEqual({
      mode: "public",
      inviteRequired: false,
    });
    const res = await register(base);
    expect(res.status).toBe(201);
    const { id, secret } = (await res.json()) as { id: string; secret: string };
    expect(secret.length).toBeGreaterThanOrEqual(32);
    const kept = readFileSync(join(dir, "daemons.json"), "utf8");
    expect(kept).toContain(id);
    expect(kept).not.toContain(secret);
    await expect(opened(daemon(base, id, "x".repeat(43)))).rejects.toThrow("401");
    const d = daemon(base, id, secret);
    await opened(d);
    d.close();

    await nest?.close();
    base = await startPublic({ dataDir: dir });
    const again = daemon(base, id, secret);
    await opened(again);
    again.close();
  });

  it("refuses to register when private, or without the right invite code", async () => {
    const http = (await start()).replace(/^ws/, "http");
    expect(await (await fetch(`${http}/info`)).json()).toEqual({
      mode: "private",
      inviteRequired: false,
    });
    expect((await register(http)).status).toBe(404);
    await nest?.close();

    const base = await startPublic({ invite: "garden-gate" });
    expect(await (await fetch(`${base}/info`)).json()).toEqual({
      mode: "public",
      inviteRequired: true,
    });
    expect((await register(base)).status).toBe(403);
    expect((await register(base, { invite: "garden-gat" })).status).toBe(403);
    expect((await register(base, { invite: "garden-gate" })).status).toBe(201);
    // Another site's page can't register its visitors.
    const foreign = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://elsewhere.example" },
      body: JSON.stringify({ invite: "garden-gate" }),
    });
    expect(foreign.status).toBe(403);
  });

  it("limits registrations per address, daemons, devices and bytes per daemon", async () => {
    let base = await startPublic({ limits: { registrationsPerAddressHour: 2 } });
    expect((await register(base)).status).toBe(201);
    expect((await register(base)).status).toBe(201);
    expect((await register(base)).status).toBe(429);
    await nest?.close();

    base = await startPublic({ limits: { maxDaemons: 1 } });
    expect((await register(base)).status).toBe(201);
    expect((await register(base)).status).toBe(503);
    await nest?.close();

    base = await startPublic({ limits: { devicesPerRegistered: 1, bytesPerDaemonDay: 100 } });
    const { id, secret } = (await (await register(base)).json()) as { id: string; secret: string };
    const d = daemon(base, id, secret);
    await opened(d);
    const ws = base.replace(/^http/, "ws");
    const first = new WebSocket(`${ws}/device?daemon=${id}`);
    await opened(first);
    await expect(opened(new WebSocket(`${ws}/device?daemon=${id}`))).rejects.toThrow("503");
    // Past its share for the day, the device is closed and no other opens.
    const closed = new Promise<number>((r) => first.once("close", (code) => r(code)));
    first.send("x".repeat(101));
    expect(await closed).toBe(4029);
    await expect(opened(new WebSocket(`${ws}/device?daemon=${id}`))).rejects.toThrow("429");
    d.close();
  });

  it("forgets a daemon unseen for thirty days", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-nest-"));
    const old = Date.now() - 31 * 24 * 3600_000;
    const hash = createHash("sha256").update("s".repeat(43)).digest("hex");
    writeFileSync(
      join(dir, "daemons.json"),
      JSON.stringify({ "d-old": { hash, createdAt: old, lastSeen: old } }),
    );
    const base = await startPublic({ dataDir: dir });
    await expect(opened(daemon(base, "d-old", "s".repeat(43)))).rejects.toThrow("401");
    expect(readFileSync(join(dir, "daemons.json"), "utf8")).not.toContain("d-old");
  });
});

describe("What a Nest shows (ADR-035)", () => {
  const site = () => {
    const dir = mkdtempSync(join(tmpdir(), "nest-site-"));
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "index.html"), "<title>Oraknid site</title>");
    writeFileSync(join(dir, "app", "index.html"), "<title>Oraknid loader</title>");
    return dir;
  };
  const serve = async (mode: "public" | "private") => {
    nest = createNest({ daemons: new Map([["home", "s3cret"]]), mode, publicDir: site() });
    await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(nest.server.address() as { port: number }).port}`;
  };

  it("a public Nest shows its site to search engines, not its loader", async () => {
    const base = await serve("public");
    const home = await fetch(`${base}/`);
    expect(await home.text()).toContain("Oraknid site");
    expect(home.headers.get("x-robots-tag")).toBeNull();
    const loader = await fetch(`${base}/app/`);
    expect(await loader.text()).toContain("Oraknid loader");
    expect(loader.headers.get("x-robots-tag")).toContain("noindex");
    expect(await (await fetch(`${base}/robots.txt`)).text()).toContain("Disallow: /app/");
  });

  it("a private Nest has no site: only its loader, a bare not-found elsewhere, indexed nowhere", async () => {
    const base = await serve("private");
    for (const path of ["/", "/index.html", "/docs/", "/anything"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.status).toBe(404);
      const body = await r.text();
      expect(body).toBe("Not found");
      expect(r.headers.get("x-robots-tag")).toContain("noindex");
    }
    const loader = await fetch(`${base}/app/`);
    expect(await loader.text()).toContain("Oraknid loader");
    expect(loader.headers.get("x-robots-tag")).toContain("noindex");
    expect(await (await fetch(`${base}/robots.txt`)).text()).toBe("User-agent: *\nDisallow: /\n");
  });
});
