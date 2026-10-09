/**
 * A daemon with reviews open, for checking the review page in headless
 * Chromium (scripts/review-check.mjs): its own data folder and port, a
 * project with a small design in design/, a stand-in "app" on a local port
 * whose page logs an error and fails a request, and a review open on each.
 * No agent runs.
 *
 *   pnpm --filter @oraknid/daemon exec tsx scripts/review-daemon.ts [--port 7518] [--dir <folder>]
 *
 * Prints one JSON line on stdout once it listens: { url, token, session,
 * design, app }. Never point it at ~/.local/share/oraknid or 7417.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import type { Router } from "../src/api/router.ts";
import { startDaemon } from "../src/daemon.ts";
import { resolvePaths } from "../src/paths.ts";
import { fakeOs } from "../src/testing/fake-os.ts";
import { seedJob } from "../src/testing/fixtures.ts";

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const port = Number(arg("port", "7518"));
if (port === 7417) throw new Error("7417 is the owner's own Oraknid: pick another port.");
const dir = arg("dir", "") || mkdtempSync(join(tmpdir(), "oraknid-review-check-"));
if (dir.includes(".local/share/oraknid")) throw new Error("Not the owner's data folder.");
const paths = resolvePaths({
  ORAKNID_DATA_DIR: join(dir, "data"),
  ORAKNID_CONFIG_DIR: join(dir, "data"),
});

// The project and its design: a header, a row of knobs, a play button.
const project = join(dir, "keys");
mkdirSync(join(project, "design"), { recursive: true });
writeFileSync(
  join(project, "design", "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Keys</title><link rel="stylesheet" href="style.css"></head>
<body><header><h1>Keys</h1><a href="about.html">About</a></header>
<main><section class="knobs">${["Cutoff", "Resonance", "Attack", "Release"].map((k) => `<div class="knob" data-testid="knob-${k.toLowerCase()}"><span>${k}</span></div>`).join("")}</section>
<button id="play">Play</button></main></body></html>`,
);
writeFileSync(
  join(project, "design", "style.css"),
  `body{margin:0;font:16px system-ui,sans-serif;background:#111;color:#eee}header{display:flex;justify-content:space-between;align-items:center;padding:12px 20px;background:#222}header a{color:#9cf}
.knobs{display:flex;flex-wrap:wrap;gap:20px;padding:20px}.knob{width:90px;height:90px;border-radius:50%;background:radial-gradient(#666,#333);display:flex;align-items:center;justify-content:center;font-size:12px}
#play{margin:20px;padding:12px 28px;font-size:18px;border-radius:8px;border:0;background:#7c3aed;color:#fff}`,
);
writeFileSync(
  join(project, "design", "about.html"),
  `<!doctype html><title>About</title><link rel="stylesheet" href="style.css"><p style="padding:20px">A synth.</p><a href="index.html">Back</a>`,
);

// The "app": a page that says an error and asks for something missing.
const app = createServer((req, res) => {
  if (req.url === "/") {
    res.setHeader("content-type", "text/html");
    res.end(
      `<!doctype html><html><head><title>App</title></head><body><h1 id="title">The app</h1><button id="go">Go</button><script>console.error("knob engine failed to start"); fetch("/api/missing");</script></body></html>`,
    );
    return;
  }
  res.statusCode = 404;
  res.end("missing");
});
await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
const appPort = (app.address() as { port: number }).port;

const daemon = await startDaemon({
  paths,
  port,
  host: "127.0.0.1",
  os: fakeOs().os,
  adapters: {},
  program: (ctx) =>
    new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve())),
  naming: { backfillDelayMs: -1 },
  ciWatch: false,
  ...(arg("web", "") ? { webDir: arg("web", "") } : {}),
});
const api = createORPCClient<RouterClient<Router>>(
  new RPCLink({
    url: `${daemon.url}/api`,
    headers: { authorization: `Bearer ${daemon.cliToken}` },
  }),
);
const { session } = await api.lock.setPin({ current: null, pin: "246810" });
const jobId = seedJob(daemon.db, "running", project);
const design = await api.reviews.open({ jobId, kind: "design", target: "design" });
const appReview = await api.reviews.open({
  jobId,
  kind: "app",
  target: appPort,
  title: "The running app",
});

console.log(
  JSON.stringify({
    url: daemon.url,
    token: daemon.cliToken,
    session,
    dir,
    jobId,
    design: design.id,
    app: appReview.id,
  }),
);

const stop = async () => {
  app.close();
  await daemon.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
