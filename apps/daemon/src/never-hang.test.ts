import { execFileSync } from "node:child_process";
import { close, closeSync, mkdirSync, mkdtempSync, open, openSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Inhibitor } from "@oraknid/os";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "./daemon.ts";
import { startSelfCheck } from "./os/self-check.ts";
import { resolvePaths } from "./paths.ts";
import { fakeOs } from "./testing/fake-os.ts";

// ADR-070, never hang on the desktop. Seen 2026-10-16 after a reboot: the
// thread pool full of keychain calls that never returned, and every page
// of the web UI waiting behind them.

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

function webDir() {
  const web = mkdtempSync(join(tmpdir(), "oraknid-web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>Oraknid</title>");
  writeFileSync(join(web, "assets", "app-1234.js"), "console.log('app')");
  return web;
}

async function start(o: Partial<Parameters<typeof startDaemon>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-nohang-"));
  const daemon: Daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs().os,
    ...o,
  });
  cleanup.push(() => daemon.close());
  return daemon;
}

/**
 * Takes every thread of the pool: each opens a FIFO no one writes to, and
 * waits there, as the keychain's calls did. Returns how to let them go.
 */
function blockThePool() {
  const fifo = join(mkdtempSync(join(tmpdir(), "oraknid-fifo-")), "f");
  execFileSync("mkfifo", [fifo]);
  const size = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  for (let i = 0; i < size; i++)
    open(fifo, "r", (err, fd) => {
      if (!err) close(fd, () => {});
    });
  return () => closeSync(openSync(fifo, "w"));
}

const settles = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

describe("the web UI while the thread pool is stuck", () => {
  it("serves its index and assets from memory", async () => {
    const daemon = await start({ webDir: webDir() });
    const release = blockThePool();
    cleanup.push(release);
    // The pool is held: a file's stat waits.
    expect(await settles(stat(join(tmpdir())), 300)).toBe(false);
    const index = await fetch(`${daemon.url}/`, { signal: AbortSignal.timeout(3000) });
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>Oraknid</title>");
    const deep = await fetch(`${daemon.url}/jobs/123`, { signal: AbortSignal.timeout(3000) });
    expect(await deep.text()).toContain("<title>Oraknid</title>");
    const asset = await fetch(`${daemon.url}/assets/app-1234.js`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(asset.headers.get("content-type")).toMatch(/javascript/);
    expect(await asset.text()).toBe("console.log('app')");
    release();
    cleanup.pop();
  });

  it("the self-check sees it: the daemon exits, under a service manager", async () => {
    const exits: number[] = [];
    await start({
      webDir: webDir(),
      selfCheck: { everyMs: 50, timeoutMs: 100, giveUpMs: 400, exit: (c) => exits.push(c) },
    });
    const release = blockThePool();
    cleanup.push(release);
    const until = Date.now() + 5000;
    while (!exits.length && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(exits).toEqual([70]);
  });
});

describe("the keychain not there yet", () => {
  it("the daemon serves at once, says it waits for the keychain, and takes it when it comes", async () => {
    const fake = fakeOs({ keychainWaiting: true });
    const daemon = await start({ os: fake.os, webDir: webDir(), keychainRetryMs: 50 });
    expect((await fetch(`${daemon.url}/`)).status).toBe(200);
    expect(daemon.secrets.status()).toMatchObject({ available: false });
    expect(daemon.secrets.status().detail).toMatch(/Waiting for the keychain to unlock/);
    await expect(daemon.secrets.set("k", "v")).rejects.toThrow(/Waiting for the keychain/);
    fake.setKeychain(true);
    const until = Date.now() + 3000;
    while (!daemon.secrets.status().available && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
    expect(daemon.secrets.status()).toMatchObject({ kind: "keychain", available: true });
    await daemon.secrets.set("k", "v");
    expect(await daemon.secrets.get("k")).toBe("v");
  });
});

describe("stopping", () => {
  it("has a deadline: a step that never ends doesn't hold it", async () => {
    const fake = fakeOs();
    const stuck: Inhibitor = { ...fake.inhibitor, release: () => new Promise(() => {}) };
    const daemon = await start({ os: { ...fake.os, inhibitor: stuck }, stopDeadlineMs: 300 });
    const said: string[] = [];
    const error = console.error;
    console.error = (...a: unknown[]) => said.push(a.join(" "));
    try {
      const started = Date.now();
      await daemon.close();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      console.error = error;
    }
    expect(said.join("\n")).toMatch(
      /Stopping took over 0.3 s \(still waiting on: the sleep inhibitor\)/,
    );
  });
});

describe("the self-check", () => {
  it("exits after two minutes failing on end, not before, and forgets a failure that passed", async () => {
    let now = 0;
    let well = false;
    const exits: number[] = [];
    const said: string[] = [];
    const sc = startSelfCheck({
      probes: [
        {
          name: "a file read",
          // Stuck: never settles, as a read behind a full pool.
          run: () => (well ? Promise.resolve() : new Promise(() => {})),
        },
      ],
      everyMs: 3600_000,
      timeoutMs: 20,
      now: () => now,
      log: (m) => said.push(m),
      exit: (c) => exits.push(c),
    });
    cleanup.push(() => sc.stop());
    await sc.check();
    expect(said[0]).toMatch(/Self-check failed: a file read took over 0.02 s/);
    now += 60_000;
    await sc.check();
    // Well again: the count starts over.
    well = true;
    now += 30_000;
    expect((await sc.check()).ok).toBe(true);
    well = false;
    now += 30_000;
    await sc.check();
    now += 90_000;
    await sc.check();
    expect(exits).toEqual([]);
    now += 30_000;
    await sc.check();
    expect(exits).toEqual([70]);
    expect(said.at(-1)).toMatch(
      /failing for 120 s .*exiting so the service manager starts Oraknid again/,
    );
  });

  it("without a service manager it keeps running and says how to restart it", async () => {
    let now = 0;
    const said: string[] = [];
    const sc = startSelfCheck({
      probes: [{ name: "its own page", run: () => Promise.reject(new Error("refused")) }],
      everyMs: 3600_000,
      now: () => now,
      log: (m) => said.push(m),
      exit: null,
    });
    cleanup.push(() => sc.stop());
    await sc.check();
    now += 120_000;
    await sc.check();
    expect(said.at(-1)).toMatch(/keeps running\. Restart it: oraknid stop, then oraknid start/);
  });
});
