import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "./api/router.ts";
import { type Daemon, NO_WEB_UI, startDaemon } from "./daemon.ts";
import { resolvePaths } from "./paths.ts";
import { fakeOs } from "./testing/fake-os.ts";
import { RECORD_FILE } from "./updates/install.ts";

// A terminal-only install (ADR-055): the daemon serves the API and no
// pages; a browser reads why, and a phone can't be paired.

let daemon: Daemon | undefined;
afterEach(() => daemon?.close());

async function start(webDir: string | null | undefined, appDir?: string) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-noweb-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    ...(webDir === undefined ? {} : { webDir }),
    ...(appDir ? { updates: { appDir, firstCheckMs: 3600_000 } } : {}),
  });
  const client = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { daemon, client };
}

describe("an Oraknid without its web UI (ADR-055)", () => {
  it("answers / with a few words: use `oraknid` in a terminal, or add the web UI", async () => {
    const { daemon: d, client } = await start(null);
    const res = await fetch(`${d.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await res.text();
    expect(body).toBe(NO_WEB_UI);
    expect(body).toContain("no web UI");
    expect(body).toContain("oraknid install --gui");
    // Any other page is not there either; the API still is.
    expect((await fetch(`${d.url}/jobs/x`)).status).toBe(404);
    expect((await fetch(`${d.url}/health`)).status).toBe(200);
    expect((await client.system.status()).webUi).toBe(false);
  });

  it("says a phone needs the web UI when one is paired for away", async () => {
    const { client } = await start(null);
    await client.lock.setPin({ current: null, pin: "739204" });
    await expect(client.nest.pairAway({ name: "phone" })).rejects.toThrow(/phone needs it/);
  });

  it("knows a terminal-only install by its record; a clone has the web UI (served by Vite in development)", async () => {
    const app = mkdtempSync(join(tmpdir(), "oraknid-app-"));
    writeFileSync(
      join(app, RECORD_FILE),
      JSON.stringify({
        ref: "main",
        channel: "stable",
        commit: "1".repeat(40),
        version: "0.1.0",
        installedAt: "2026-10-07T09:00:00Z",
        from: "https://github.com/ABakdi/Oraknid.git",
        service: true,
        gui: false,
      }),
    );
    const { client } = await start(undefined, app);
    expect((await client.system.status()).webUi).toBe(false);
    await daemon?.close();
    daemon = undefined;
    const clone = mkdtempSync(join(tmpdir(), "oraknid-clone-"));
    const again = await start(undefined, clone);
    expect((await again.client.system.status()).webUi).toBe(true);
  });

  it("serves the web UI when it is built", async () => {
    const web = mkdtempSync(join(tmpdir(), "oraknid-web-"));
    mkdirSync(web, { recursive: true });
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Oraknid</title>");
    const { daemon: d, client } = await start(web);
    expect(await (await fetch(`${d.url}/`)).text()).toContain("<title>Oraknid</title>");
    expect((await client.system.status()).webUi).toBe(true);
  });
});
