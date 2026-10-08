#!/usr/bin/env node
/**
 * The web UI under a busy daemon, measured in headless Chromium (Web-UI →
 * Performance). It starts apps/daemon/scripts/ui-perf-daemon.ts (its own
 * data folder and port, a seeded database, a job that looks like it runs),
 * opens each main page for a while and reports, per page:
 *
 *   long tasks a minute and their total, the JS heap after the window (after
 *   a GC), the DOM's nodes, requests a minute and bytes a minute, and the
 *   worst main-thread stall seen by a 100 ms timer.
 *
 *   pnpm --filter @oraknid/web exec vite build   # the UI the daemon serves
 *   node scripts/ui-perf.mjs [--seconds 60] [--port 7517] [--only overview,eye] [--json out.json] [--shots dir] [--cpu] [--web dir] [--keep-oversized] [--hidden]
 *
 * Needs playwright-core (a dev dependency) and a Chromium: --chromium /path,
 * else /usr/bin/chromium or Playwright's own. Never uses 7417 or the
 * owner's data folder.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const seconds = Number(arg("seconds", "60"));
const port = Number(arg("port", "7517"));
const only = arg("only", "")?.split(",").filter(Boolean) ?? [];
const out = arg("json", "");
const shots = arg("shots", "");
/** Also a CPU profile of each window: its heaviest functions by self time. */
const cpu = process.argv.includes("--cpu");
/** The built UI to serve, when not apps/web/dist (a copy, to compare two builds). */
const web = arg("web", "");
/** The seeded oversized rows left as they are: the screens against data from before migration 0043. */
const keepOversized = process.argv.includes("--keep-oversized");
/** The page out of sight for the window (another tab in front). */
const hidden = process.argv.includes("--hidden");
if (port === 7417) throw new Error("7417 is the owner's own Oraknid.");

// The daemon, seeded.
const daemon = spawn(
  "pnpm",
  [
    "--filter",
    "@oraknid/daemon",
    "exec",
    "tsx",
    "scripts/ui-perf-daemon.ts",
    "--port",
    String(port),
    "--quiet",
    ...(web ? ["--web", web] : []),
    ...(keepOversized ? ["--keep-oversized"] : []),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
);
const info = await new Promise((resolve, reject) => {
  let buf = "";
  daemon.stdout.on("data", (d) => {
    buf += d;
    const line = buf.split("\n").find((l) => l.startsWith("{"));
    if (line) resolve(JSON.parse(line));
  });
  daemon.on("exit", (code) => reject(new Error(`the daemon stopped (${code})`)));
});
const stopDaemon = () => daemon.kill("SIGTERM");
process.on("exit", stopDaemon);

const pages = [
  ["overview", "/"],
  ["eye", `/projects/${info.projectId}/eye`],
  ["work", `/projects/${info.projectId}/work/${info.jobId}`],
  ["workflow", `/projects/${info.projectId}/workflow/${info.jobId}`],
  ["activity", `/projects/${info.projectId}/activity`],
  ["silk", `/projects/${info.projectId}/silk`],
  ["new-work", "/new"],
  ["legs", "/legs"],
  ["servers", "/servers"],
  ["server", `/servers/${info.serverId}`],
  ["inbox", "/inbox"],
  ["models", "/models"],
  ["logs", "/logs"],
  ["settings", "/settings"],
].filter(([name]) => !only.length || only.includes(name));

const executablePath =
  arg("chromium", "") || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ executablePath, args: ["--enable-precise-memory-info"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(
  ({ token, session }) => {
    localStorage.setItem("oraknid.token", token);
    sessionStorage.setItem("oraknid.unlock", session);
    const perf = { longTasks: 0, longMs: 0, worstLagMs: 0 };
    window.__perf = perf;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        perf.longTasks++;
        perf.longMs += e.duration;
      }
    }).observe({ type: "longtask", buffered: true });
    // A 100 ms timer late by more than that: the page did not answer.
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      perf.worstLagMs = Math.max(perf.worstLagMs, now - last - 100);
      last = now;
    }, 100);
  },
  { token: info.token, session: info.session },
);

/** A call into a page that may be frozen: given up on after 30 s. */
const within = (p, what) =>
  Promise.race([
    p,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`frozen: ${what} took more than 30 s`)), 30_000),
    ),
  ]);

const results = [];
for (const [name, path] of pages) {
  const page = await context.newPage();
  try {
    await measure(name, path, page);
  } catch (error) {
    // A page that stopped answering is a result too.
    results.push({ page: name, frozen: String(error.message ?? error).slice(0, 120) });
    console.log(JSON.stringify(results.at(-1)));
  }
  await page.close().catch(() => {});
}

async function measure(name, path, page) {
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Network.enable");
  let requests = 0;
  let bytes = 0;
  // What opening the page took: its requests' bytes and its long tasks until it settled.
  let loadBytes = 0;
  const byPath = new Map();
  let measuring = false;
  // The API's answers only: the app's own files are not data.
  const apiRequests = new Set();
  cdp.on("Network.requestWillBeSent", (e) => {
    if (!e.request.url.includes("/api/")) return;
    apiRequests.add(e.requestId);
    if (!measuring) return;
    requests++;
    const p = new URL(e.request.url).pathname.replace("/api/", "");
    byPath.set(p, (byPath.get(p) ?? 0) + 1);
  });
  cdp.on("Network.loadingFinished", (e) => {
    if (!apiRequests.has(e.requestId)) return;
    if (measuring) bytes += e.encodedDataLength;
    else loadBytes += e.encodedDataLength;
  });
  await page.goto(`${info.url}${path}`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const opened = await within(
    page.evaluate(() => ({ ...window.__perf })),
    "opened",
  );
  // The window starts once the page has settled: what it does while I look at it.
  await within(
    page.evaluate(() => {
      window.__perf.longTasks = 0;
      window.__perf.longMs = 0;
      window.__perf.worstLagMs = 0;
    }),
    "reset",
  );
  if (hidden)
    // Another tab in front: what the page still does out of sight.
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await cdp.send("HeapProfiler.collectGarbage");
  const heapAt = async () =>
    (await cdp.send("Performance.getMetrics")).metrics.find((m) => m.name === "JSHeapUsedSize")
      .value;
  const heapStart = await heapAt();
  if (cpu) {
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
  }
  measuring = true;
  const started = Date.now();
  await page.waitForTimeout(seconds * 1000);
  measuring = false;
  let heaviest = "";
  if (cpu) {
    const { profile } = await cdp.send("Profiler.stop");
    const self = new Map();
    const dt = (profile.endTime - profile.startTime) / profile.samples.length / 1000;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (const id of profile.samples) {
      const f = byId.get(id).callFrame;
      const key = `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber}`;
      self.set(key, (self.get(key) ?? 0) + dt);
    }
    heaviest = [...self.entries()]
      .filter(([k]) => !k.startsWith("(idle)") && !k.startsWith("(program)"))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, ms]) => `${Math.round(ms)}ms ${k}`)
      .join("\n  ");
  }
  const minutes = (Date.now() - started) / 60_000;
  const perf = await within(
    page.evaluate(() => window.__perf),
    "read",
  );
  await within(cdp.send("HeapProfiler.collectGarbage"), "gc");
  const metrics = Object.fromEntries(
    (await within(cdp.send("Performance.getMetrics"), "metrics")).metrics.map((m) => [
      m.name,
      m.value,
    ]),
  );
  const top = [...byPath.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const r = {
    page: name,
    loadLongMs: Math.round(opened.longMs),
    loadKB: Math.round(loadBytes / 1024),
    longTasksPerMin: +(perf.longTasks / minutes).toFixed(1),
    longMsPerMin: Math.round(perf.longMs / minutes),
    worstLagMs: Math.round(perf.worstLagMs),
    heapStartMB: +(heapStart / 1e6).toFixed(1),
    heapEndMB: +(metrics.JSHeapUsedSize / 1e6).toFixed(1),
    domNodes: metrics.Nodes,
    requestsPerMin: +(requests / minutes).toFixed(1),
    kbPerMin: Math.round(bytes / 1024 / minutes),
    top: top.map(([p, n]) => `${p}×${n}`).join(" "),
  };
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  results.push(r);
  if (heaviest) console.log(`  ${heaviest}`);
  console.log(JSON.stringify(r));
  await page.close();
}

await browser.close();
stopDaemon();
console.table(results.map(({ top, ...r }) => r));
if (out) writeFileSync(out, JSON.stringify(results, null, 2));
process.exit(0);
