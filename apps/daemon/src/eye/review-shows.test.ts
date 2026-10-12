import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JobView, WebPlan } from "@oraknid/contracts";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { type StandInReviews, standInReviews } from "../harness/reviews.ts";
import { findChromium } from "../harness/visual.ts";
import { resolvePaths } from "../paths.ts";
import { writeSetting } from "../settings.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { fakeJudge } from "../testing/judge.ts";
import { type Action, scriptedLeg, type TurnContext } from "../testing/scripted-leg.ts";
import type { EyeBrain } from "./brain.ts";
import { agentRunCommand, EvaluationState, evaluationKey, readEvaluation } from "./evaluations.ts";
import { browserRenderChecker, httpRenderChecker, type RenderChecker } from "./render-check.ts";
import { announcedPorts, freePort, stopAllApps, waysToRun, withPort } from "./run-app.ts";

// A review is never shown before Oraknid has seen it render (ADR-069), from
// the Keys job's final review (2026-10-12): `pnpm dev` from the plan, Vite
// on its own port 5173 while Oraknid waited on another, then the job's
// folder of TSX shown as the review: a blank page. End to end with a
// scripted brain and Legs and the stand-in ReviewPort; no real agent.

let daemon: Daemon | undefined;
const servers: Server[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  stopAllApps();
  for (const s of servers.splice(0)) s.close();
});

const sh = (cwd: string, ...a: string[]) =>
  spawnSync("git", a, { cwd, encoding: "utf8" }).stdout.trim();

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-shows-"));
  sh(dir, "init", "-q", "-b", "master");
  sh(dir, "config", "user.email", "me@example.com");
  sh(dir, "config", "user.name", "Me");
  writeFileSync(join(dir, "README.md"), "# keys\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "-qm", "start");
  return dir;
}

const task = (t: TurnContext) => t.system.match(/# Your task: (.*)/)?.[1] ?? "";

/** The Keys job's last two nodes: the app built, then my review of it, with the plan's command. */
const plan = (run?: string): WebPlan => ({
  summary: "The app, then my review of it.",
  tasks: [
    {
      key: "app",
      title: "Build the app",
      instructions: "Write the app.",
      kind: "implement",
      dependsOn: [],
      scope: ["**"],
      verify: ["test -f package.json"],
      requiredCapabilities: ["implementation"],
      difficulty: "low",
    },
    {
      key: "try",
      title: "Owner testing of the interactive final app",
      instructions: "I try it.",
      kind: "evaluation",
      dependsOn: ["app"],
      scope: [],
      verify: [],
      requiredCapabilities: ["review"],
      difficulty: "low",
      evaluation: { kind: "app", why: "I try it before it's done.", ...(run ? { run } : {}) },
    },
  ],
  jobVerify: [],
});

/** Files as the agent's writes. */
const files = (f: Record<string, string>): Action[] =>
  Object.entries(f).map(([write, content]) => ({ write, content }));

const PAGE = (words: string) =>
  `<!doctype html><html><head><title>Keys</title></head><body><main><h1>${words}</h1></main></body></html>`;

/** A dev server like Vite: it reads its port from --port only, never PORT, and says where it listens. */
const viteLike = (fallback: number) => `const http = require("node:http");
const i = process.argv.indexOf("--port");
const port = i > 0 ? Number(process.argv[i + 1]) : ${fallback};
http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(${JSON.stringify(PAGE("Keys, live"))}); })
  .listen(port, "127.0.0.1", () => console.log("  VITE ready\\n  ➜  Local:   http://localhost:" + port + "/"));
`;

const WORKS = `require("node:http").createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end(${JSON.stringify(PAGE("Fixed keys"))}); }).listen(Number(process.env.PORT), "127.0.0.1");\n`;

const FAILS = `node -e "console.error('Error: Cannot find module vite'); process.exit(1)"`;

async function world(o: {
  plan: WebPlan;
  app: Record<string, string>;
  /** The recovery agent's turn (ADR-067 §3); by default it says it couldn't. */
  recover?: (t: TurnContext) => Action[];
  dir?: string;
  dbFile?: string;
  renderCheck?: RenderChecker;
  start?: boolean;
  /** The real review page (reviews/port.ts), not the stand-in. */
  page?: boolean;
}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "oraknid-showsd-"));
  const leg = scriptedLeg((t) =>
    task(t).startsWith("Recover:")
      ? (o.recover?.(t) ?? [{ say: "I looked and couldn't make it start.\nDONE" }])
      : [...files(o.app), { say: "DONE" }],
  );
  const reviews = standInReviews();
  const brain = {
    plan: async () => o.plan,
    replan: async () => o.plan,
    summarize: async () => ({ title: "s", body: "s" }),
    evaluate: async () => ({ accepted: true, reason: "ok", missing: [] }),
    repairCheck: async ({ command }: { command: string }) => ({
      broken: false,
      command,
      reason: "",
    }),
    triage: async () => ({ intent: "instruction", reply: "Noted.", silk: null, tasks: [] }),
    judgeAction: fakeJudge(() => ({ decision: "allow", reason: "fine" })),
    interviewRound: async () => ({ done: true, playback: "Clear.", questions: [], open: [] }),
  } as unknown as EyeBrain;
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: o.dbFile ?? ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
    brain,
    metricsIntervalMs: 50,
    guardIntervalMs: 3_600_000,
    stallCheckMs: 100,
    ...(o.page ? {} : { reviews: reviews.port }),
    appWaitMs: 8_000,
    renderCheck: o.renderCheck ?? httpRenderChecker(),
    reviewPassCheckMs: 100,
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  if (o.start === false) return { d: daemon, api, id: "", leg, reviews, dir };
  await api.legs.create({ kind: "claude-code", name: "Claude A", config: {} });
  const project = await api.projects.create({ name: "keys", workspacePath: repo() });
  await api.projects.setWorkSettings({
    id: project.id,
    settings: {
      ...(await api.projects.workSettings({ id: project.id })),
      evaluations: { mode: "some", kinds: ["app"] },
    },
  });
  const { id } = await api.jobs.create({
    projectId: project.id,
    goal: "Keys, a little instrument",
    verify: [],
    autonomy: "auto",
    inputs: [],
    allowedLegIds: [],
    unsandboxed: false,
  });
  await api.jobs.start({ id });
  return { d: daemon, api, id, leg, reviews, dir };
}

type Api = Awaited<ReturnType<typeof world>>["api"];

async function until(api: Api, id: string, states: string[], ms = 30_000): Promise<JobView> {
  const end = Date.now() + ms;
  for (;;) {
    const j = await api.jobs.get({ id });
    if (states.includes(j.state)) return j;
    if (Date.now() > end)
      throw new Error(
        `job stayed ${j.state} (${j.blockedReason ?? ""}): ${j.tasks.map((t) => `${t.title} ${t.state}`).join("; ")}`,
      );
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function waitFor<T>(
  what: string,
  fn: () => T | null | undefined | Promise<T | null | undefined>,
  ms = 30_000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`no ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const shown = (reviews: StandInReviews, after = 0) =>
  waitFor("a review opened", () => reviews.opened.slice(after).at(-1));

const onPort = (r: StandInReviews["opened"][number]) => {
  if (r.target.kind !== "port")
    throw new Error(`not on a port: ${JSON.stringify(r.problem ?? r.target)}`);
  return r.target.port;
};

const page = async (port: number) => (await fetch(`http://127.0.0.1:${port}/`)).text();

describe("the port is always given (ADR-069 §1)", () => {
  it("adds the dev server's port flags to the plan's command, through the script it calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-port-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", start: "node s.js" } }),
    );
    expect(withPort("pnpm dev", dir)).toBe("pnpm dev --port $PORT --strictPort --host 127.0.0.1");
    expect(withPort("npm run dev", dir)).toBe(
      "npm run dev -- --port $PORT --strictPort --host 127.0.0.1",
    );
    expect(withPort("npx vite", dir)).toBe("npx vite --port $PORT --strictPort --host 127.0.0.1");
    expect(withPort("next dev", dir)).toBe("next dev -p $PORT -H 127.0.0.1");
    expect(withPort("vite --port 3000", dir)).toBe("vite --port $PORT");
    expect(withPort("make serve PORT=$PORT", dir)).toBe("make serve PORT=$PORT");
    // A script that reads PORT itself is left as it is.
    expect(withPort("npm start", dir)).toBe("npm start");
    mkdirSync(join(dir, "web"));
    writeFileSync(
      join(dir, "web", "package.json"),
      JSON.stringify({ scripts: { dev: "astro dev" } }),
    );
    expect(withPort("cd web && pnpm dev", dir)).toBe(
      "cd web && pnpm dev --port $PORT --host 127.0.0.1",
    );
  });

  it("reads the port an app announces", () => {
    expect(
      announcedPorts(
        "\u001b[32m  VITE v6.0.0  ready\u001b[0m\n  ➜  Local:   http://localhost:5173/\n",
      ),
    ).toEqual([5173]);
    expect(announcedPorts("Server listening on port 3000")).toEqual([3000]);
    expect(
      announcedPorts("ready - started server on 0.0.0.0:3001, url: http://localhost:3001"),
    ).toEqual([3001]);
    expect(announcedPorts("nothing here")).toEqual([]);
    // Another server it talks to is not where it listens.
    expect(
      announcedPorts("[vite] proxying /api to http://localhost:8080\nready in 300 ms"),
    ).toEqual([]);
  });

  it("lists the ladder of ways: the plan's, the dev script, the build, a static site", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-ways-"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build" } }),
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    writeFileSync(join(dir, "index.html"), '<script type="module" src="/src/main.tsx"></script>');
    expect(waysToRun(dir, "pnpm dev", "node fixed.js")).toEqual([
      { kind: "command", command: "node fixed.js", from: "the recovery agent" },
      {
        kind: "command",
        command: "pnpm dev --port $PORT --strictPort --host 127.0.0.1",
        from: "the plan",
      },
      {
        kind: "command",
        command: "pnpm run dev --port $PORT --strictPort --host 127.0.0.1",
        from: "package.json's dev script",
      },
      { kind: "build", command: "pnpm run build", from: "package.json's build script" },
      { kind: "static", dir: "", from: "its index.html, as a static site" },
    ]);
  });

  it("reads the command the recovery agent says starts the app", () => {
    expect(agentRunCommand("It needed vite.\nRUN: `pnpm dev --port $PORT`\nDONE")).toBe(
      "pnpm dev --port $PORT",
    );
    expect(agentRunCommand("I couldn't.")).toBeNull();
  });
});

describe("the Keys review: a review is never shown before it renders (ADR-069)", () => {
  it("`pnpm dev` from the plan on a Vite-like app that ignores PORT: the port flags reach it, and the review opens on its port", async () => {
    const fallback = await freePort();
    const { reviews, api, id } = await world({
      plan: plan("pnpm dev"),
      app: {
        "package.json": JSON.stringify({ scripts: { dev: "node vite.js" } }),
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
        "vite.js": viteLike(fallback),
      },
    });
    const review = await shown(reviews);
    expect(review.kind).toBe("app");
    const port = onPort(review);
    // The port Oraknid gave it, not the one it would have taken.
    expect(port).not.toBe(fallback);
    expect(await page(port)).toContain("Keys, live");
    expect(review.checked).toEqual(["phone", "desktop"]);
    const waiting = await until(api, id, ["waiting"]);
    expect(waiting.blockedReason).toMatch(/^Waiting for your review of the running app/);
    const silk = await api.silk.list({ jobId: id });
    expect(silk.some((e) => /renders on phone, desktop/.test(e.title))).toBe(true);
  }, 60_000);

  it("an app that ignores the port it is given and every flag: the port it announces is used", async () => {
    const own = await freePort();
    const { reviews } = await world({
      plan: plan("npm run dev"),
      app: {
        "package.json": JSON.stringify({ scripts: { dev: "node server.js" } }),
        "server.js": viteLike(own).replace('process.argv.indexOf("--port")', "-1"),
      },
    });
    const review = await shown(reviews);
    expect(onPort(review)).toBe(own);
    expect(await page(own)).toContain("Keys, live");
  }, 60_000);

  it("a dev server that fails: its build is served from dist/, and renders", async () => {
    const { reviews, api, id } = await world({
      plan: plan(),
      app: {
        "package.json": JSON.stringify({ scripts: { dev: FAILS, build: "node build.js" } }),
        "build.js": `const fs = require("node:fs"); fs.mkdirSync("dist/assets", { recursive: true }); fs.writeFileSync("dist/assets/app.js", "document.querySelector('main').dataset.ok = '1';"); fs.writeFileSync("dist/index.html", ${JSON.stringify(PAGE("Built keys").replace("</body>", '<script type="module" src="/assets/app.js"></script></body>'))});\n`,
      },
    });
    const review = await shown(reviews);
    const port = onPort(review);
    expect(await page(port)).toContain("Built keys");
    const js = await fetch(`http://127.0.0.1:${port}/assets/app.js`);
    expect(js.headers.get("content-type")).toMatch(/javascript/);
    const silk = await api.silk.list({ jobId: id });
    const ready = silk.find((e) => /renders on/.test(e.title));
    expect(ready?.body).toContain("Cannot find module vite");
    expect(ready?.body).toContain("npm run build");
  }, 60_000);

  it("nothing runs: a recovery agent makes it start and says how; the ladder runs again with its command", async () => {
    const { reviews, leg } = await world({
      plan: plan("npm run dev"),
      app: { "package.json": JSON.stringify({ scripts: { dev: FAILS } }) },
      recover: () => [
        { write: "ok.js", content: WORKS },
        {
          say: "The dev script needs vite, which isn't installed; I added a small server.\nRUN: node ok.js\nDONE",
        },
      ],
    });
    const review = await shown(reviews);
    expect(await page(onPort(review))).toContain("Fixed keys");
    const asked = leg.log.find((t) => task(t).startsWith("Recover:"));
    expect(asked?.system).toContain("Cannot find module vite");
    expect(asked?.system).toContain("RUN: <command>");
  }, 90_000);

  it("the agent can't fix it, twice: the review says why and what was tried, never a folder of source; Try again works", async () => {
    const { reviews, api, id, leg } = await world({
      plan: plan("pnpm dev"),
      app: {
        "package.json": JSON.stringify({ scripts: { dev: FAILS } }),
        "index.html":
          '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>',
        "src/main.tsx":
          'import { createRoot } from "react-dom/client";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
      },
    });
    const first = await shown(reviews);
    expect(first.target).toEqual({ kind: "none" });
    expect(first.problem?.reason).toContain("pnpm dev");
    const tried = first.problem?.tried.join("\n") ?? "";
    expect(tried).toContain("Cannot find module vite");
    // The static site was tried too, and seen to be source code, not a page.
    expect(tried).toMatch(/src\/main\.tsx came as .*not JavaScript/);
    expect(leg.log.filter((t) => task(t).startsWith("Recover:"))).toHaveLength(2);
    expect(reviews.opened.every((r) => r.target.kind !== "folder")).toBe(true);
    const waiting = await until(api, id, ["waiting"]);
    expect(waiting.blockedReason).toMatch(/^The app didn't start for your review: /);

    // Fixed meanwhile (by me, say): Try again runs the ladder again, and the review shows the app.
    const job = await api.jobs.get({ id });
    writeFileSync(join(job.worktree as string, "ok.js"), WORKS);
    writeFileSync(
      join(job.worktree as string, "package.json"),
      JSON.stringify({ scripts: { dev: "node ok.js" } }),
    );
    const before = reviews.opened.length;
    reviews.retry(first.reviewId);
    const again = await shown(reviews, before);
    expect(await page(onPort(again))).toContain("Fixed keys");
    expect(again.checked).toEqual(["phone", "desktop"]);
  }, 120_000);

  it("an open review that shows an app's folder (opened before ADR-069) is prepared again when Oraknid starts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-heal-"));
    const dbFile = join(dir, "oraknid.db");
    const app = {
      "package.json": JSON.stringify({ scripts: { dev: "node ok.js" } }),
      "ok.js": WORKS,
    };
    const one = await world({ plan: plan(), app, dir, dbFile });
    const review = await shown(one.reviews);
    onPort(review);
    await until(one.api, one.id, ["waiting"]);
    // As v0.8.1 left the Keys review: the step's review on the job's folder, no app running.
    const st = readEvaluation(one.d.db, review.stepTaskId) as EvaluationState;
    writeSetting(one.d.db, evaluationKey(review.stepTaskId), EvaluationState, {
      ...st,
      port: null,
      shows: null,
      way: null,
      checked: [],
    });
    await one.d.close();
    daemon = undefined;

    const two = await world({ plan: plan(), app, dir, dbFile, start: false });
    const healed = await shown(two.reviews);
    expect(healed.stepTaskId).toBe(review.stepTaskId);
    expect(await page(onPort(healed))).toContain("Fixed keys");
    expect(readEvaluation(two.d.db, review.stepTaskId)?.shows).toBe("app");
  }, 90_000);
});

describe("on the review page (ADR-069 §4–§5)", () => {
  /** The HTTP look, remembering what it loaded. */
  const recording = () => {
    const urls: string[] = [];
    const inner = httpRenderChecker();
    const checker: RenderChecker = {
      check: (i) => {
        urls.push(i.url);
        return inner.check(i);
      },
    };
    return { urls, checker };
  };

  it("checks the app through the review's own frame, and the page says where it rendered", async () => {
    const seen = recording();
    const { api, id } = await world({
      plan: plan(),
      page: true,
      renderCheck: seen.checker,
      app: { "package.json": JSON.stringify({ scripts: { dev: "node ok.js" } }), "ok.js": WORKS },
    });
    const [review] = await waitFor("the review", async () => {
      const l = await api.reviews.list({ jobId: id });
      return l.length ? l : null;
    });
    expect(review).toMatchObject({ kind: "app", problem: null, checked: ["phone", "desktop"] });
    expect(review?.frameUrl).toMatch(/^http:\/\/rv-[0-9a-f]{32}\.localhost:\d+\/$/);
    // Loaded through a frame like the review's, before the review was opened.
    expect(seen.urls[0]).toMatch(/^http:\/\/rv-[0-9a-f]{32}\.localhost:\d+\/$/);
    expect(seen.urls[0]).not.toBe(review?.frameUrl);
  }, 60_000);

  it("nothing renders: the review has no frame, says why with what was tried, the inbox tells me once; Try again shows the app", async () => {
    const { api, id } = await world({
      plan: plan("npm run dev"),
      page: true,
      app: { "package.json": JSON.stringify({ scripts: { dev: FAILS } }) },
    });
    const review = await waitFor(
      "the review",
      async () => (await api.reviews.list({ jobId: id }))[0],
    );
    expect(review.frameUrl).toBeNull();
    expect(review.problem?.reason).toContain("npm run dev");
    expect(review.problem?.tried.length).toBeGreaterThan(0);
    expect(review.problem?.retrying).toBe(false);
    await expect(api.reviews.frame({ id: review.id })).rejects.toThrow(/Nothing to show/);
    const inbox = await api.inbox.list({});
    const told = inbox.filter((i) => i.jobId === id && /review/i.test(i.title));
    expect(told.map((i) => i.title)).toEqual(["The app didn't start for your review"]);

    const job = await until(api, id, ["waiting"]);
    writeFileSync(join(job.worktree as string, "ok.js"), WORKS);
    writeFileSync(
      join(job.worktree as string, "package.json"),
      JSON.stringify({ scripts: { dev: "node ok.js" } }),
    );
    await api.reviews.retry({ id: review.id });
    const healed = await waitFor("the app shown", async () => {
      const r = await api.reviews.get({ id: review.id });
      return r.frameUrl ? r : null;
    });
    expect(healed).toMatchObject({ problem: null, checked: ["phone", "desktop"], round: 1 });
    const after = (await api.inbox.list({})).filter(
      (i) => i.jobId === id && /review/i.test(i.title) && i.state === "open",
    );
    expect(after.map((i) => i.title)).toEqual(["The app is ready for your review"]);
  }, 120_000);
});

// ── The render check itself (ADR-069 §4) ─────────────────────────────

/** A little site: each path its type and body. */
async function site(pages: Record<string, { type: string; body: string; status?: number }>) {
  const port = await freePort();
  const s = createServer((q, r) => {
    const p = pages[new URL(q.url ?? "/", "http://x").pathname];
    if (!p) {
      r.statusCode = 404;
      r.end("Not found");
      return;
    }
    r.statusCode = p.status ?? 200;
    r.setHeader("content-type", p.type);
    r.end(p.body);
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(port, "127.0.0.1", resolve));
  return `http://127.0.0.1:${port}/`;
}

const HTML = "text/html; charset=utf-8";
const CASES = {
  good: { "/": { type: HTML, body: PAGE("Keys") } },
  spa: {
    "/": {
      type: HTML,
      body: '<!doctype html><body><div id="root"></div><script type="module" src="/app.js"></script></body>',
    },
    "/app.js": {
      type: "text/javascript",
      body: "document.getElementById('root').textContent = 'Keys from a script';",
    },
  },
  blank: {
    "/": {
      type: HTML,
      body: "<!doctype html><html><head><title>x</title></head><body></body></html>",
    },
  },
  tsx: {
    "/": {
      type: HTML,
      body: '<!doctype html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body>',
    },
    "/src/main.tsx": {
      type: "application/octet-stream",
      body: 'import { createRoot } from "react-dom/client";\ncreateRoot(root).render(<App />);',
    },
  },
  rawSource: {
    "/": {
      type: "text/plain",
      body: 'import React from "react";\nexport default function App() {}\n',
    },
  },
  listing: {
    "/": {
      type: HTML,
      body: '<!DOCTYPE HTML><html><head><title>Directory listing for /</title></head><body><h1>Directory listing for /</h1><ul><li><a href="src/">src/</a></li></ul></body></html>',
    },
  },
  missing: {
    "/": {
      type: HTML,
      body: "<!doctype html><title>Not found</title><p>Not in the design.</p>",
      status: 404,
    },
  },
  throws: {
    "/": {
      type: HTML,
      body: '<!doctype html><body><div id="root"></div><script>throw new Error("boom in the app")</script></body>',
    },
  },
};

describe("the render check catches what can't be shown (ADR-069 §4)", () => {
  it("over HTTP: a blank body, raw TSX, raw source, a directory listing, a missing page; a page and a single-page app pass", async () => {
    const check = httpRenderChecker();
    const at = async (k: keyof typeof CASES) => check.check({ url: await site(CASES[k]) });
    expect(await at("good")).toMatchObject({ ok: true, devices: ["phone", "desktop"] });
    expect(await at("spa")).toMatchObject({ ok: true });
    expect((await at("blank")).reason).toMatch(/blank/);
    expect((await at("tsx")).reason).toMatch(
      /\/src\/main\.tsx came as application\/octet-stream, not JavaScript/,
    );
    expect((await at("rawSource")).reason).toMatch(/source code/);
    expect((await at("listing")).reason).toMatch(/listing of files/);
    expect((await at("missing")).reason).toMatch(/no page at \//);
  });

  const browser = !!findChromium();
  it.skipIf(!browser)(
    "in a real browser (skipped without Chromium): blank, raw TSX, a page that throws, a listing fail; a page and an app drawn by its script pass",
    async () => {
      let loaded = true;
      const check = browserRenderChecker({
        settleMs: 1500,
        load: async () => {
          const pw = await import("playwright-core").catch(() => null);
          if (!pw) loaded = false;
          if (!pw) throw new Error("no playwright-core");
          return pw;
        },
      });
      const at = async (k: keyof typeof CASES) => check.check({ url: await site(CASES[k]) });
      const good = await at("good");
      if (!loaded) return;
      expect(good).toMatchObject({ ok: true, how: "browser", devices: ["phone", "desktop"] });
      expect(await at("spa")).toMatchObject({ ok: true, how: "browser" });
      expect((await at("blank")).reason).toMatch(/blank/);
      expect((await at("tsx")).reason).toMatch(
        /blank: its script \/src\/main\.tsx came as application\/octet-stream/,
      );
      expect((await at("throws")).reason).toMatch(/threw: .*boom in the app/);
      expect((await at("listing")).reason).toMatch(/listing of files/);
    },
    60_000,
  );
});
