import { mkdtempSync } from "node:fs";
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

const PIN = "739204";

/** A daemon with a clock I move, a paired device, and the PIN set from it. */
async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-lock-"));
  let t = 1_000_000;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
    now: () => t,
  });
  const d = daemon;
  const client = (headers: Record<string, string> = {}) =>
    createORPCClient<RouterClient<Router>>(new RPCLink({ url: `${d.url}/api`, headers }));
  const cli = client({ authorization: `Bearer ${d.cliToken}` });
  const pair = async (name: string) => {
    const { code } = await cli.devices.pairStart();
    return (await client().devices.pairComplete({ code, name })).token;
  };
  const token = await pair("Laptop");
  const as = (tok: string, session?: string, remote = false) =>
    client({
      authorization: `Bearer ${tok}`,
      ...(session ? { "x-oraknid-unlock": session } : {}),
      ...(remote ? { "x-oraknid-remote": "1" } : {}),
    });
  const { session } = await as(token).lock.setPin({ current: null, pin: PIN });
  return {
    d,
    cli,
    pair,
    token,
    session,
    as,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("the lock (ADR-029)", () => {
  it("opens a device only with its token and an unlocked session", async () => {
    const { token, session, as, pair } = await start();
    expect((await as(token, session).system.status()).pid).toBe(process.pid);
    await expect(as(token).system.status()).rejects.toThrow(/Locked/);
    await expect(as(token, "made-up").system.status()).rejects.toThrow(/Locked/);
    // Another device's session doesn't open this one.
    const phone = await pair("Phone");
    await expect(as(phone, session).system.status()).rejects.toThrow(/Locked/);
    const s = await as(phone).lock.status();
    expect(s).toMatchObject({ pinSet: true, unlocked: false, triesLeft: 10 });
    const { session: mine } = await as(phone).lock.unlock({ pin: PIN });
    expect((await as(phone, mine).lock.status()).unlocked).toBe(true);
  });

  it("slows wrong PINs from the fifth, and unpairs the device at the tenth", async () => {
    const { as, pair, cli, advance } = await start();
    const phone = await pair("Phone");
    for (let i = 1; i <= 4; i++)
      await expect(as(phone).lock.unlock({ pin: "000000" })).rejects.toThrow(
        new RegExp(`${10 - i} tries left`),
      );
    await expect(as(phone).lock.unlock({ pin: "000000" })).rejects.toThrow(/5 tries left/);
    // Now even the right PIN waits.
    await expect(as(phone).lock.unlock({ pin: PIN })).rejects.toThrow(/try again in 30 s/);
    for (let i = 6; i <= 9; i++) {
      advance(10 * 60_000);
      await expect(as(phone).lock.unlock({ pin: "111111" })).rejects.toThrow(/left/);
    }
    advance(60 * 60_000);
    await expect(as(phone).lock.unlock({ pin: "222222" })).rejects.toThrow(/unpaired/);
    // Gone: its token opens nothing, not even the lock.
    await expect(as(phone).lock.status()).rejects.toThrow();
    const phoneRow = (await cli.devices.list()).find((x) => x.name === "Phone");
    expect(phoneRow?.revokedAt).not.toBeNull();
  });

  it("locks a session left idle, and every session on Lock now", async () => {
    const { token, session, as, advance } = await start();
    advance(14 * 60_000);
    expect((await as(token, session).lock.status()).unlocked).toBe(true);
    advance(16 * 60_000);
    await expect(as(token, session).system.status()).rejects.toThrow(/Locked/);
    const { session: again } = await as(token).lock.unlock({ pin: PIN });
    await as(token, again).lock.lock({ everywhere: true });
    await expect(as(token, again).system.status()).rejects.toThrow(/Locked/);
  });

  it("keeps away from home out of what opens new ways in", async () => {
    const { token, session, as } = await start();
    const away = as(token, session, true);
    expect((await away.jobs.list()).length).toBe(0);
    await expect(away.settings.setTerminal({ enabled: true })).rejects.toThrow(/not away/);
    await expect(away.nest.pairAway({ name: "x" })).rejects.toThrow(/not away/);
    await expect(away.devices.pairStart()).rejects.toThrow(/not away/);
    await expect(away.policies.update({ allow: [], deny: [], gate: [] } as never)).rejects.toThrow(
      /not away/,
    );
    await expect(away.lock.setPin({ current: PIN, pin: "123456789" })).rejects.toThrow(/not away/);
    // A project's repos change at home only (ADR-042).
    await expect(
      away.projects.updateRepo({ id: "01J00000000000000000000000", name: "web", rename: "site" }),
    ).rejects.toThrow(/not away/);
  });

  it("gives full rights only at home with the PIN, and then opens what away from home was closed (ADR-030)", async () => {
    const { token, session, as, pair } = await start();
    const phone = await pair("Phone");
    const { session: ps } = await as(phone).lock.unlock({ pin: PIN });
    const away = as(phone, ps, true);
    await expect(away.settings.setTerminal({ enabled: true })).rejects.toThrow(/not away/);
    const id = (await as(token, session).devices.list()).find((x) => x.name === "Phone")
      ?.id as string;
    // Not from away, not without the PIN.
    await expect(away.devices.setRights({ id, full: true, pin: PIN })).rejects.toThrow(/not away/);
    await expect(
      as(token, session).devices.setRights({ id, full: true, pin: "000000" }),
    ).rejects.toThrow(/Wrong PIN/);
    await as(token, session).devices.setRights({ id, full: true, pin: PIN });
    expect((await away.lock.status()).full).toBe(true);
    await away.settings.setTerminal({ enabled: false });
    // Still home only, whatever the rights: a device can't widen itself or mint others.
    await expect(away.devices.pairStart()).rejects.toThrow(/not away/);
    await expect(away.devices.setRights({ id, full: true, pin: PIN })).rejects.toThrow(/not away/);
    await expect(away.lock.setPin({ current: PIN, pin: "123456789" })).rejects.toThrow(/not away/);
    await as(token, session).devices.setRights({ id, full: false, pin: PIN });
    await expect(away.settings.setTerminal({ enabled: true })).rejects.toThrow(/not away/);
  });

  it("closes the live socket when its device locks", async () => {
    const { d, token, session, as } = await start();
    const ws = new WebSocket(
      `${d.url.replace("http", "ws")}/live?token=${token}&unlock=${encodeURIComponent(session)}`,
    );
    await new Promise((ok) => ws.once("open", ok));
    const closed = new Promise<number>((ok) => ws.once("close", (code) => ok(code)));
    await as(token, session).lock.lock({ everywhere: false });
    expect(await closed).toBe(4401);
    const refused = new WebSocket(
      `${d.url.replace("http", "ws")}/live?token=${token}&unlock=${encodeURIComponent(session)}`,
    );
    await expect(
      new Promise((ok, fail) => {
        refused.once("open", ok);
        refused.once("unexpected-response", (_q, r) => fail(new Error(`HTTP ${r.statusCode}`)));
      }),
    ).rejects.toThrow(/403/);
  });

  it("resets the PIN only from the CLI", async () => {
    const { token, session, as, cli } = await start();
    await expect(as(token, session).lock.reset()).rejects.toThrow(/oraknid pin reset/);
    await cli.lock.reset();
    expect((await as(token).lock.status()).pinSet).toBe(false);
    await expect(as(token, session).system.status()).rejects.toThrow(/Set your PIN/);
  });
});
