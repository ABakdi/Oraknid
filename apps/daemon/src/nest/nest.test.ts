import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNest } from "@oraknid/nest/relay";
import { DeviceEnd, type KeyPair, ready } from "@oraknid/tunnel";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Router } from "../api/router.ts";
import { remoteAllowed } from "../auth/lock.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";

let daemon: Daemon | undefined;
let nest: ReturnType<typeof createNest> | undefined;
afterEach(async () => {
  await daemon?.close();
  await nest?.close();
  daemon = undefined;
  nest = undefined;
});

interface Bundle {
  nest: string;
  daemon: string;
  daemonPublicKey: string;
  deviceId: string;
  keys: KeyPair;
  token: string;
}

/** A phone away from home: it opens the tunnel through The Nest, as the loader does. */
async function phone(b: Bundle) {
  await ready();
  const ws = new WebSocket(`${b.nest.replace(/^http/, "ws")}/device?daemon=${b.daemon}`);
  await new Promise((r, e) => {
    ws.once("open", r);
    ws.once("error", e);
  });
  const end = new DeviceEnd({
    deviceId: b.deviceId,
    keys: b.keys,
    daemonPublicKey: b.daemonPublicKey,
  });
  const inbox: Record<string, unknown>[] = [];
  const opened = new Promise<void>((resolve, reject) => {
    ws.on("message", (data) => {
      try {
        const r = end.receive(String(data));
        for (const f of r.replies) ws.send(f);
        inbox.push(...(r.messages as Record<string, unknown>[]));
        if (end.ready) resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  ws.send(end.hello());
  await opened;
  const wait = async (pred: (m: Record<string, unknown>) => boolean, ms = 3000) => {
    const until = Date.now() + ms;
    for (;;) {
      const i = inbox.findIndex(pred);
      if (i >= 0) return inbox.splice(i, 1)[0] as Record<string, unknown>;
      if (Date.now() > until) throw new Error(`nothing came: ${JSON.stringify(inbox)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  return { ws, end, send: (m: unknown) => ws.send(end.seal(m)), wait };
}

describe("away from home, through The Nest (Phase 4)", () => {
  it("pairs a phone for away and reaches the API and the live socket end to end", async () => {
    nest = createNest({ daemons: new Map([["home-1", "a-long-daemon-secret"]]) });
    await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
    const nestUrl = `http://127.0.0.1:${(nest.server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "oraknid-nest-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    await api.nest.configure({ url: nestUrl, secret: "a-long-daemon-secret", daemonId: "home-1" });
    const end = Date.now() + 3000;
    while (!(await api.nest.status()).connected && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    expect((await api.nest.status()).connected).toBe(true);

    // No phone for away without a PIN (ADR-029).
    await expect(api.nest.pairAway({ name: "x" })).rejects.toThrow(/Set your PIN/);
    await api.lock.setPin({ current: null, pin: "583920" });
    const { link } = await api.nest.pairAway({ name: "My phone, away" });
    expect(link.startsWith(`${nestUrl}/app/#oraknid=`)).toBe(true);
    const b = JSON.parse(
      Buffer.from(link.split("#oraknid=")[1] as string, "base64url").toString(),
    ) as Bundle;
    const p = await phone(b);

    // Locked until the PIN, through the tunnel.
    p.send({
      t: "req",
      id: 10,
      method: "POST",
      path: "/api/system/status",
      headers: { authorization: `Bearer ${b.token}` },
      body: "{}",
    });
    expect((await p.wait((m) => m.t === "res" && m.id === 10)).status).toBe(423);
    p.send({
      t: "req",
      id: 11,
      method: "POST",
      path: "/api/lock/unlock",
      headers: { authorization: `Bearer ${b.token}` },
      body: JSON.stringify({ json: { pin: "583920" } }),
    });
    const unlocked = await p.wait((m) => m.t === "res" && m.id === 11);
    const session = JSON.parse(String(unlocked.body)).json.session as string;
    const auth = { authorization: `Bearer ${b.token}`, "x-oraknid-unlock": session };
    p.send({
      t: "req",
      id: 1,
      method: "POST",
      path: "/api/system/status",
      headers: auth,
      body: "{}",
    });
    const res = await p.wait((m) => m.t === "res" && m.id === 1);
    expect(res.status).toBe(200);
    // Unlocked away from home, still nothing that opens a new way in.
    p.send({
      t: "req",
      id: 12,
      method: "POST",
      path: "/api/settings/setTerminal",
      headers: { ...auth, "x-oraknid-remote": "0" },
      body: JSON.stringify({ json: { enabled: true } }),
    });
    const refused = await p.wait((m) => m.t === "res" && m.id === 12);
    expect(refused.status).toBe(403);
    expect(String(refused.body)).toMatch(/not away from home/);
    expect(JSON.parse(String(res.body)).json.pid).toBe(process.pid);

    // Another device's token can't ride this device's tunnel.
    p.send({
      t: "req",
      id: 2,
      method: "POST",
      path: "/api/system/status",
      headers: { authorization: `Bearer ${daemon.cliToken}` },
      body: "{}",
    });
    expect((await p.wait((m) => m.t === "res" && m.id === 2)).status).toBe(401);

    p.send({ t: "live-open", token: b.token, unlock: session });
    const hello = await p.wait((m) => m.t === "live" && String(m.frame).includes('"hello"'));
    expect(String(hello.frame)).toContain('"type":"hello"');

    // The terminal through the tunnel: closed without full rights, a shell with them (ADR-030).
    await api.settings.setTerminal({ enabled: true });
    p.send({
      t: "term-open",
      id: 50,
      token: b.token,
      unlock: session,
      target: "local",
      cols: 80,
      rows: 24,
    });
    await p.wait((m) => m.t === "term-close" && m.id === 50);
    await api.devices.setRights({ id: b.deviceId, full: true, pin: "583920" });
    p.send({
      t: "term-open",
      id: 51,
      token: b.token,
      unlock: session,
      target: "local",
      cols: 80,
      rows: 24,
    });
    p.send({ t: "term-in", id: 51, f: JSON.stringify({ t: "in", d: "echo away-$((40+2))\r" }) });
    await p.wait((m) => m.t === "term" && m.id === 51 && String(m.d).includes("away-42"), 15_000);
    p.send({ t: "term-close", id: 51 });
    await api.settings.setTerminal({ enabled: false });

    // A revoked device's tunnel ends at once, and it is refused at its next handshake.
    const ended = new Promise((ok) => p.ws.once("close", ok));
    await api.devices.revoke({ id: b.deviceId });
    await ended;
    await expect(phone(b)).rejects.toThrow(/isn't paired, or was revoked/);
  }, 30_000);

  it("registers itself on a public Nest and connects, and only from home (ADR-031)", async () => {
    nest = createNest({ daemons: new Map(), mode: "public", invite: "garden-gate" });
    await new Promise<void>((r) => nest?.server.listen(0, "127.0.0.1", () => r()));
    const nestUrl = `http://127.0.0.1:${(nest.server.address() as { port: number }).port}`;
    const dir = mkdtempSync(join(tmpdir(), "oraknid-nest-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs({ keychain: true }).os,
    });
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );

    await expect(api.nest.register({ url: nestUrl, invite: "wrong" })).rejects.toThrow(
      /invite code/,
    );
    // Away from home, nothing moves this daemon to another Nest.
    expect(remoteAllowed("/nest/register")).toBe(false);
    const { daemonId } = await api.nest.register({ url: `${nestUrl}/`, invite: "garden-gate" });
    expect(daemonId).toMatch(/^d-/);
    const end = Date.now() + 3000;
    while (!(await api.nest.status()).connected && Date.now() < end)
      await new Promise((r) => setTimeout(r, 20));
    const s = await api.nest.status();
    expect(s).toMatchObject({ connected: true, url: nestUrl, daemonId });
  });
});
