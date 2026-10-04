import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeApp, fakeGitHub, fakeLauncher, release } from "../testing/fake-updates.ts";
import { seedJob } from "../testing/fixtures.ts";
import type { Router } from "./router.ts";

// The updates' procedures (ADR-048): who may update, and a refusal while jobs run.

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const PIN = "739204";

async function start() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-updates-api-"));
  const gh = fakeGitHub();
  gh.releases = [release("v0.2.0")];
  const launcher = fakeLauncher();
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    adapters: {},
    updates: {
      appDir: fakeApp({ ref: "main", channel: "stable" }),
      version: "0.1.0",
      fetch: gh.fetch,
      launcher,
      underSystemd: false,
      firstCheckMs: 3600_000,
    },
  });
  const d = daemon;
  const client = (headers: Record<string, string> = {}) =>
    createORPCClient<RouterClient<Router>>(new RPCLink({ url: `${d.url}/api`, headers }));
  const cli = client({ authorization: `Bearer ${d.cliToken}` });
  const pair = async (name: string) => {
    const { code } = await cli.devices.pairStart();
    return (await client().devices.pairComplete({ code, name })).token;
  };
  const as = (tok: string, session?: string, remote = false) =>
    client({
      authorization: `Bearer ${tok}`,
      ...(session ? { "x-oraknid-unlock": session } : {}),
      ...(remote ? { "x-oraknid-remote": "1" } : {}),
    });
  const laptop = await pair("Laptop");
  const { session } = await as(laptop).lock.setPin({ current: null, pin: PIN });
  return { d, cli, pair, as, laptop, session, launcher, gh };
}

describe("updates through the API (ADR-048)", () => {
  it("lets the CLI and a device at home check and update", async () => {
    const { cli, as, laptop, session, launcher } = await start();
    const v = await cli.updates.check();
    expect(v).toMatchObject({
      version: "0.1.0",
      available: true,
      target: "v0.2.0",
      canUpdate: true,
    });
    expect((await as(laptop, session).updates.status()).canUpdate).toBe(true);
    const run = await as(laptop, session).updates.run({ confirm: false });
    expect(run).toMatchObject({ state: "running", target: "v0.2.0" });
    expect(launcher.detached.length).toBe(1);
  });

  it("away from home: reading only, unless the device has full rights (ADR-030)", async () => {
    const { cli, as, pair, laptop, session, launcher } = await start();
    await cli.updates.check();
    const phone = await pair("Phone");
    const { session: ps } = await as(phone).lock.unlock({ pin: PIN });
    const away = as(phone, ps, true);
    const v = await away.updates.status();
    expect(v).toMatchObject({ available: true, canUpdate: false });
    expect(v.whyNot).toMatch(/full rights/);
    await expect(away.updates.run({ confirm: true })).rejects.toThrow(/not away from home/);
    expect(launcher.detached).toEqual([]);
    const id = (await as(laptop, session).devices.list()).find((x) => x.name === "Phone")
      ?.id as string;
    await as(laptop, session).devices.setRights({ id, full: true, pin: PIN });
    expect((await away.updates.status()).canUpdate).toBe(true);
    await away.updates.run({ confirm: true });
    expect(launcher.detached.length).toBe(1);
  });

  it("refuses while jobs run unless confirmed, saying how many", async () => {
    const { d, cli, launcher } = await start();
    seedJob(d.db, "running");
    await cli.updates.check();
    expect((await cli.updates.status()).runningJobs).toBe(1);
    await expect(cli.updates.run({ confirm: false })).rejects.toThrow(
      /1 job is running\. They pause at a safe point while Oraknid restarts and go on after it/,
    );
    expect(launcher.detached).toEqual([]);
    await cli.updates.run({ confirm: true });
    expect(launcher.detached.length).toBe(1);
  });
});
