import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-pair-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
    writeRuntimeFile: true,
  });
  const client = (token?: string) =>
    createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon?.url}/api`,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      }),
    );
  return { d: daemon, dir, client };
}

describe("paired devices", () => {
  it("refuses a client without a token, with what to do", async () => {
    const { client } = await start();
    await expect(client().system.status()).rejects.toThrow();
    const res = await fetch(`${daemon?.url}/api/system/status`, { method: "POST" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/oraknid pair/);
  });

  it("gives the CLI its token through a file only I can read", async () => {
    const { d, dir, client } = await start();
    const file = join(dir, "daemon.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, "utf8")).token).toBe(d.cliToken);
    expect((await client(d.cliToken).system.status()).pid).toBe(process.pid);
  });

  it("pairs a device with a one-time code, and stops trusting it once revoked", async () => {
    const { d, client } = await start();
    const { code } = await client(d.cliToken).devices.pairStart();
    const paired = await client().devices.pairComplete({ code, name: "My phone" });
    await expect(client().devices.pairComplete({ code, name: "Again" })).rejects.toThrow(
      /wrong or has expired/,
    );
    expect((await client(paired.token).system.status()).pid).toBe(process.pid);
    const list = await client(d.cliToken).devices.list();
    expect(list.map((x) => x.name)).toEqual(["My phone"]);
    expect(JSON.stringify(d.db.$client.prepare("select * from devices").all())).not.toContain(
      paired.token,
    );
    await client(d.cliToken).devices.revoke({ id: paired.deviceId });
    await expect(client(paired.token).system.status()).rejects.toThrow();
  });

  it("refuses the live socket without a valid token", async () => {
    const { d } = await start();
    const bad = new WebSocket(`${d.url.replace("http", "ws")}/live?token=nope`);
    await expect(
      new Promise((ok, fail) => {
        bad.once("open", ok);
        bad.once("unexpected-response", (_q, r) => fail(new Error(`HTTP ${r.statusCode}`)));
      }),
    ).rejects.toThrow(/403/);
    const good = new WebSocket(`${d.url.replace("http", "ws")}/live?token=${d.cliToken}`);
    await new Promise((ok) => good.once("open", ok));
    good.close();
  });
});
