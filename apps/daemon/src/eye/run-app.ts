import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, request, type Server } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { SandboxPlan } from "@oraknid/leg-sdk";
import { designFile, typeOf } from "../reviews/frame.ts";
import type { RenderCheck } from "./render-check.ts";

// The running app for an app review (ADR-064 §3, ADR-069): its dev server,
// started by Oraknid in the job's sandbox on a free local port, until the
// review is over. Nothing is written into the project.
//
// ADR-069: the port is always given (a plan's `pnpm dev` gets Vite's port
// flags as a detected script does), the port the app announces is read
// from what it prints, and there is a ladder of ways to run it before
// giving up: the plan's command, the dev script, a build served as it is,
// a static site. Each way's result is kept, in words.

/** How the app runs: a command, and where the command came from. */
export interface AppRun {
  command: string;
  from: string;
}

/**
 * One way to run the app (ADR-069 §2): a command that serves it on
 * `$PORT`; its build command, then the build's output served; or a folder
 * served as it is (relative to the job's folder, "" for itself).
 */
export type Way =
  | { kind: "command"; command: string; from: string }
  | { kind: "build"; command: string; from: string }
  | { kind: "static"; dir: string; from: string };

/** The package manager the project uses, by its lock file. */
function packageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

function readScripts(cwd: string): Record<string, string> {
  try {
    return (
      (
        JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
          scripts?: Record<string, string>;
        }
      ).scripts ?? {}
    );
  } catch {
    return {};
  }
}

type Tool = "vite" | "next" | "astro" | "nuxt" | "angular" | "webpack";

/** The dev server a command (or a script's text) runs, when it is one that takes its port as a flag. */
export function toolOf(text: string): Tool | null {
  if (/\bnuxi?\b/.test(text)) return "nuxt";
  if (/\bastro\b/.test(text)) return "astro";
  if (/\b(?:vite|svelte-kit)\b/.test(text)) return "vite";
  if (/\bnext\b/.test(text)) return "next";
  if (/\bng\s+serve\b/.test(text)) return "angular";
  if (/\bwebpack(?:-dev-server|\s+serve)\b/.test(text)) return "webpack";
  return null;
}

/** A dev server's port flags: Vite ignores PORT (2026-10-12, the Keys review); most others read it. */
const FLAGS: Record<Tool, string> = {
  vite: "--port $PORT --strictPort --host 127.0.0.1",
  next: "-p $PORT -H 127.0.0.1",
  astro: "--port $PORT --host 127.0.0.1",
  nuxt: "--port $PORT --host 127.0.0.1",
  angular: "--port $PORT --host 127.0.0.1",
  webpack: "--port $PORT --host 127.0.0.1",
};

/** What separates a script's own arguments: npm needs `--`; pnpm, yarn and bun pass it on to the script, which then ignores what follows. */
const separator = (pm: string) => (pm === "npm" ? " --" : "");

const NOT_A_SCRIPT = new Set(["install", "i", "add", "exec", "dlx", "x", "ci", "test", "build"]);

/**
 * The command with the port given (ADR-069 §1): `$PORT` already in it,
 * as it is; a port written in it, Oraknid's instead; a known dev server,
 * directly or through `pnpm dev`/`npm run dev` (its script read), with its
 * port flags. Anything else reads PORT from its environment.
 */
export function withPort(command: string, cwd: string): string {
  const c = command.trim();
  if (/\$\{?PORT\b/.test(c)) return c;
  const fixed = c.replace(/(--port[=\s]+|\s-p\s+)\d{2,5}\b/, "$1$PORT");
  if (fixed !== c) return fixed;
  const segments = c.split(/&&|;/).map((s) => s.trim());
  const last = segments.at(-1) ?? c;
  let dir = cwd;
  for (const s of segments.slice(0, -1)) {
    const cd = /^cd\s+(\S+)$/.exec(s);
    if (cd?.[1]) dir = resolve(dir, cd[1]);
  }
  const run = /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/.exec(last);
  if (run) {
    const [, pm, name] = run as unknown as [string, string, string];
    if (NOT_A_SCRIPT.has(name)) return c;
    const script = readScripts(dir)[name];
    const tool = script ? toolOf(script) : null;
    return tool ? `${c}${separator(pm)} ${FLAGS[tool]}` : c;
  }
  const direct =
    /^(?:npx\s+|pnpm\s+(?:exec|dlx)\s+|yarn\s+|bunx\s+)?(vite|next|astro|nuxi|nuxt|ng\s+serve|svelte-kit|webpack(?:-dev-server|\s+serve))\b/.exec(
      last,
    );
  const tool = direct?.[1] ? toolOf(direct[1]) : null;
  return tool ? `${c} ${FLAGS[tool]}` : c;
}

const README_RUN =
  /^\s*(?:\$\s*)?((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b[^\n]*|python3? -m http\.server\b[^\n]*)$/m;

/** Where a build puts what it made (ADR-069 §2). */
export const BUILD_OUTPUTS = ["dist", "build", "out", ".output/public"];

/** The build's output folder with an index.html, if there is one. */
export function builtOutput(cwd: string): string | null {
  return BUILD_OUTPUTS.find((d) => existsSync(join(cwd, d, "index.html"))) ?? null;
}

/**
 * The ladder of ways to run the app (ADR-069 §2), first to try first: the
 * recovery agent's command, the plan's, the project's dev (or start)
 * script, its README's, its build served, a build already there, a static
 * site. Each command with the port given.
 */
export function waysToRun(cwd: string, planned?: string | null, agent?: string | null): Way[] {
  const ways: Way[] = [];
  const add = (w: Way) => {
    const same = (x: Way) =>
      x.kind === w.kind &&
      (x.kind === "static" ? x.dir === (w as typeof x).dir : x.command === (w as typeof x).command);
    if (!ways.some(same)) ways.push(w);
  };
  if (agent?.trim())
    add({ kind: "command", command: withPort(agent, cwd), from: "the recovery agent" });
  if (planned?.trim()) add({ kind: "command", command: withPort(planned, cwd), from: "the plan" });
  const scripts = readScripts(cwd);
  const pm = packageManager(cwd);
  const name = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
  if (name) {
    const script = scripts[name] as string;
    const tool = toolOf(script);
    add({
      kind: "command",
      command: `${pm} run ${name}${tool ? `${separator(pm)} ${FLAGS[tool]}` : ""}`,
      from: `package.json's ${name} script`,
    });
  }
  for (const readme of ["README.md", "readme.md", "README"]) {
    const path = join(cwd, readme);
    if (!existsSync(path)) continue;
    const m = readFileSync(path, "utf8").match(README_RUN);
    if (m?.[1]) add({ kind: "command", command: withPort(m[1], cwd), from: readme });
    break;
  }
  if (scripts.build)
    add({ kind: "build", command: `${pm} run build`, from: "package.json's build script" });
  const built = builtOutput(cwd);
  if (built) add({ kind: "static", dir: built, from: `the build already in ${built}/` });
  if (existsSync(join(cwd, "index.html")))
    add({ kind: "static", dir: "", from: "its index.html, as a static site" });
  return ways;
}

/**
 * The command that runs the app, with `$PORT` for its port: the first
 * command of the ladder. Null when nothing says how.
 */
export function detectRun(cwd: string, planned?: string | null): AppRun | null {
  const way = waysToRun(cwd, planned).find((w) => w.kind === "command");
  if (way?.kind === "command") return { command: way.command, from: way.from };
  if (existsSync(join(cwd, "index.html")))
    return { command: "python3 -m http.server $PORT --bind 127.0.0.1", from: "its index.html" };
  return null;
}

/** A way in words: "`pnpm dev` (the plan)". */
export function wayWords(w: Way): string {
  return w.kind === "static"
    ? `serving ${w.dir ? `${w.dir}/` : "the folder"} as it is (${w.from})`
    : w.kind === "build"
      ? `\`${w.command}\`, then serving what it built (${w.from})`
      : `\`${w.command}\` (${w.from})`;
}

/** A port nothing on this computer listens on now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      const port = typeof a === "object" && a ? a.port : 0;
      s.close(() => resolve(port));
    });
  });
}

/** Is this port free on this computer? */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.unref();
    s.on("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

/** Does something answer HTTP on this port? */
function answers(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port, path: "/", method: "GET", timeout: 1000 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

/** Terminal colours and cursor moves out of what an app printed. */
const plain = (s: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences are what is taken out
  s.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");

/**
 * The ports an app says it listens on, latest last: "Local:
 * http://localhost:5173/", "listening on :3000", "ready on
 * http://0.0.0.0:3000", "started server on port 8080".
 */
export function announcedPorts(output: string): number[] {
  const text = plain(output);
  const found: number[] = [];
  const add = (p: string | undefined) => {
    const n = Number(p);
    if (Number.isInteger(n) && n >= 1024 && n <= 65535) found.push(n);
  };
  // Only a line that announces where it listens: "proxying /api to http://localhost:8080" is another server's.
  const announces = /\b(?:local|listen(?:ing)?|running|started|ready|serving|available|server)\b/i;
  for (const line of text.split("\n")) {
    if (!announces.test(line) || /\bprox(?:y|ying)\b|\bapi\b|\bbackend\b/i.test(line)) continue;
    const url = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})\b/.exec(
      line,
    );
    if (url) {
      add(url[1]);
      continue;
    }
    const said =
      /\b(?:listen(?:ing)?|running|started|ready|serving|available)\b[^\n]{0,40}?(?:\bport\s*:?\s*|:)(\d{4,5})\b/i.exec(
        line,
      );
    if (said) add(said[1]);
  }
  return [...new Set(found)];
}

export interface RunningApp {
  port: number;
  command: string;
  stop: () => void;
  alive: () => boolean;
  /** What it printed so far (its last few thousand characters). */
  output: () => string;
}

/** The app didn't start: why, what it printed, and the port it said it listens on, if any. */
export class AppDidntStart extends Error {
  constructor(
    message: string,
    readonly output: string,
    readonly announced: number | null,
  ) {
    super(message);
  }
}

/** The apps running for reviews now, by evaluation step. */
const apps = new Map<string, RunningApp>();

export const runningApp = (stepTaskId: string) => {
  const a = apps.get(stepTaskId);
  return a?.alive() ? a : null;
};

/** The review is over: its app stops. */
export function stopApp(stepTaskId: string) {
  apps.get(stepTaskId)?.stop();
  apps.delete(stepTaskId);
}

/** Oraknid is stopping: every review's app stops with it. */
export function stopAllApps() {
  for (const id of [...apps.keys()]) stopApp(id);
}

/** A process started for a review: what it printed (its log file, and what the sandbox said on its pipes), whether it ended. */
interface Spawned {
  child: ChildProcess;
  output: () => string;
  exited: () => boolean;
  code: () => number | null;
  stop: () => void;
}

/** A shell command in the job's sandbox (or as it is, for a job I run without it), its output kept. */
function spawnIn(o: {
  cwd: string;
  command: string;
  env: Record<string, string>;
  plan: SandboxPlan | null;
  inbound?: number[];
}): Spawned {
  const home = mkdtempSync(join(tmpdir(), "oraknid-app-"));
  const log = join(home, "output.log");
  // Written by the shell itself, inside the sandbox too: the reason a start failed is never empty.
  const shell = "/bin/sh";
  const script = `exec >>'${log.replaceAll("'", "'\\''")}' 2>&1; ${o.command}`;
  let child: ChildProcess;
  if (o.plan) {
    const wrapped = o.plan.sandbox.wrap({
      command: shell,
      args: ["-c", script],
      cwd: o.cwd,
      writable: [o.cwd, home],
      readonly: o.plan.readonly,
      home,
      env: { ...o.plan.env, ...o.env },
      inboundPorts: o.inbound ?? [],
    });
    // The sandbox sets its own environment; a stand-in that runs the command as it is gets the port too.
    child = spawn(wrapped.command, wrapped.args, {
      cwd: o.cwd,
      detached: true,
      stdio: "pipe",
      env: { ...process.env, ...o.env },
    });
  } else {
    child = spawn(shell, ["-c", script], {
      cwd: o.cwd,
      detached: true,
      stdio: "pipe",
      env: { ...process.env, ...o.env },
    });
  }
  let piped = "";
  const keep = (b: Buffer) => {
    piped = (piped + b.toString()).slice(-8000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = false;
  let code: number | null = null;
  child.on("exit", (c) => {
    exited = true;
    code = c;
  });
  child.on("error", (e) => {
    exited = true;
    piped += `\n${e.message}`;
  });
  const output = () => {
    let file = "";
    try {
      file = readFileSync(log, "utf8");
    } catch {}
    // The pipes carry what the sandbox itself said (it couldn't start, say); the log, the app.
    return plain([piped.trim(), file.trim()].filter(Boolean).join("\n")).slice(-8000);
  };
  const stop = () => {
    if (!exited && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => rmSync(home, { recursive: true, force: true }), 2000).unref();
  };
  return { child, output, exited: () => exited, code: () => code, stop };
}

const tail = (s: string, n = 1500) => {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/**
 * Starts the app for a review: its command in the job's sandbox (the port
 * reachable from this computer) or, for a job I run without it, as it is;
 * resolves once the port answers, or the port it announced does, or
 * rejects with what it said.
 */
export async function startApp(o: {
  stepTaskId: string;
  cwd: string;
  run: AppRun;
  port: number;
  plan: SandboxPlan | null;
  waitMs?: number;
  signal?: AbortSignal;
  /** More ports reachable from this computer: the one it announced, on a second start. */
  extraPorts?: number[];
}): Promise<RunningApp> {
  stopApp(o.stepTaskId);
  const env = {
    PORT: String(o.port),
    HOST: "127.0.0.1",
    BROWSER: "none",
    CI: "1",
  };
  const command = o.run.command.replaceAll("$PORT", String(o.port));
  const p = spawnIn({
    cwd: o.cwd,
    command,
    env,
    plan: o.plan,
    inbound: [o.port, ...(o.extraPorts ?? [])],
  });
  let port = o.port;
  const end = Date.now() + (o.waitMs ?? 90_000);
  const seconds = Math.round((o.waitMs ?? 90_000) / 1000);
  const said = () => tail(p.output()) || "it printed nothing";
  for (;;) {
    if (o.signal?.aborted) {
      p.stop();
      throw o.signal.reason ?? new Error("Stopped.");
    }
    if (await answers(o.port)) break;
    // The port it says it listens on, when it isn't the one it was given (ADR-069 §1).
    const other = announcedPorts(p.output()).filter((x) => x !== o.port);
    let found: number | null = null;
    for (const x of other.reverse()) if (await answers(x)) found = x;
    if (found) {
      port = found;
      break;
    }
    if (p.exited()) {
      throw new AppDidntStart(
        `\`${command}\` stopped before it answered (exit code ${p.code() ?? "unknown"}): ${said()}`,
        p.output(),
        other[0] ?? null,
      );
    }
    if (Date.now() > end) {
      p.stop();
      const announced = other[0] ?? null;
      throw new AppDidntStart(
        `\`${command}\` didn't answer on port ${o.port} in ${seconds} s${announced ? `; it said it listens on ${announced}, which this computer couldn't reach` : ""}: ${said()}`,
        p.output(),
        announced,
      );
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const app: RunningApp = {
    port,
    command,
    stop: p.stop,
    alive: () => !p.exited(),
    output: p.output,
  };
  apps.set(o.stepTaskId, app);
  return app;
}

/** Runs a build to its end (in the sandbox, as the app runs): whether it worked, and what it printed. */
export async function runBuild(o: {
  cwd: string;
  command: string;
  plan: SandboxPlan | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; output: string; reason: string | null }> {
  const p = spawnIn({ cwd: o.cwd, command: o.command, env: { CI: "1" }, plan: o.plan });
  const end = Date.now() + (o.timeoutMs ?? 5 * 60_000);
  while (!p.exited()) {
    if (o.signal?.aborted) {
      p.stop();
      throw o.signal.reason ?? new Error("Stopped.");
    }
    if (Date.now() > end) {
      p.stop();
      return {
        ok: false,
        output: p.output(),
        reason: `\`${o.command}\` didn't finish in time: ${tail(p.output()) || "it printed nothing"}`,
      };
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  // Let the last of its output reach the log.
  await new Promise((r) => setTimeout(r, 50));
  const ok = p.code() === 0;
  return {
    ok,
    output: p.output(),
    reason: ok
      ? null
      : `\`${o.command}\` failed (exit code ${p.code() ?? "unknown"}): ${tail(p.output()) || "it printed nothing"}`,
  };
}

/**
 * A folder served as it is, by Oraknid itself, on a local port (ADR-069
 * §2): read-only, nothing outside it, no dot files; a path that isn't a
 * file gives its index.html, as a single-page app's server does.
 */
export function serveStatic(o: {
  stepTaskId: string;
  root: string;
  port: number;
}): Promise<RunningApp> {
  stopApp(o.stepTaskId);
  let root: string;
  try {
    root = resolve(o.root);
  } catch {
    root = o.root;
  }
  const server: Server = createHttpServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.end();
      return;
    }
    const path = new URL(req.url ?? "/", "http://x").pathname;
    let file = designFile(root, path);
    if (!file && !/\.[a-z0-9]+$/i.test(path)) file = designFile(root, "/");
    if (!file) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not found");
      return;
    }
    res.setHeader("Content-Type", typeOf(file));
    res.setHeader("Cache-Control", "no-store");
    res.end(req.method === "HEAD" ? undefined : readFileSync(file));
  });
  return new Promise((resolveApp, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => {
      let open = true;
      server.on("close", () => {
        open = false;
      });
      const app: RunningApp = {
        port: o.port,
        command: `serve ${root}`,
        stop: () => {
          if (open) server.close();
          server.closeAllConnections?.();
        },
        alive: () => open,
        output: () => "",
      };
      apps.set(o.stepTaskId, app);
      resolveApp(app);
    });
  });
}

/** One way tried, in words: what was run, and why it wasn't enough. */
export interface Tried {
  way: string;
  ok: boolean;
  reason: string | null;
}

export interface WayDeps {
  stepTaskId: string;
  cwd: string;
  plan: SandboxPlan | null;
  waitMs?: number;
  buildMs?: number;
  signal?: AbortSignal;
}

/** Runs one way on a port (a build's output found, or built first): the app, or why not. */
export async function runWay(
  d: WayDeps,
  way: Way,
  port: number,
  rebuild = true,
): Promise<RunningApp> {
  if (way.kind === "static") {
    const root = join(d.cwd, way.dir);
    if (!existsSync(join(root, "index.html")))
      throw new AppDidntStart(`${way.dir || "the folder"} has no index.html`, "", null);
    return serveStatic({ stepTaskId: d.stepTaskId, root, port });
  }
  if (way.kind === "build") {
    if (rebuild || !builtOutput(d.cwd)) {
      const b = await runBuild({
        cwd: d.cwd,
        command: way.command,
        plan: d.plan,
        ...(d.buildMs ? { timeoutMs: d.buildMs } : {}),
        ...(d.signal ? { signal: d.signal } : {}),
      });
      if (!b.ok) throw new AppDidntStart(b.reason ?? "the build failed", b.output, null);
    }
    const out = builtOutput(d.cwd);
    if (!out)
      throw new AppDidntStart(
        `\`${way.command}\` worked, but made no ${BUILD_OUTPUTS.map((x) => `${x}/`).join(", ")} with an index.html`,
        "",
        null,
      );
    return serveStatic({ stepTaskId: d.stepTaskId, root: join(d.cwd, out), port });
  }
  const run = { command: way.command, from: way.from };
  const start = (extra: number[] = []) =>
    startApp({
      stepTaskId: d.stepTaskId,
      cwd: d.cwd,
      run,
      port,
      plan: d.plan,
      ...(d.waitMs ? { waitMs: d.waitMs } : {}),
      ...(d.signal ? { signal: d.signal } : {}),
      extraPorts: extra,
    });
  try {
    return await start();
  } catch (error) {
    // In the sandbox the port it announced isn't reachable: once more, with it reachable too.
    if (
      d.plan &&
      error instanceof AppDidntStart &&
      error.announced &&
      error.announced !== port &&
      (await portFree(error.announced))
    )
      return start([error.announced]);
    throw error;
  }
}

/**
 * The ladder (ADR-069 §2): each way in turn, on a free port, until one
 * runs and `check` says it renders; every try kept in words.
 */
export async function bringUp(
  d: WayDeps & {
    ways: Way[];
    check: (port: number) => Promise<RenderCheck>;
    onTry?: (t: Tried) => void;
  },
): Promise<
  | { ok: true; app: RunningApp; way: Way; check: RenderCheck; tried: Tried[] }
  | { ok: false; tried: Tried[] }
> {
  const tried: Tried[] = [];
  const note = (t: Tried) => {
    tried.push(t);
    d.onTry?.(t);
  };
  for (const way of d.ways) {
    if (d.signal?.aborted) throw d.signal.reason ?? new Error("Stopped.");
    let app: RunningApp;
    try {
      app = await runWay(d, way, await freePort());
    } catch (error) {
      if (d.signal?.aborted) throw error;
      note({ way: wayWords(way), ok: false, reason: (error as Error).message });
      continue;
    }
    let check: RenderCheck;
    try {
      check = await d.check(app.port);
    } catch (error) {
      if (d.signal?.aborted) {
        stopApp(d.stepTaskId);
        throw error;
      }
      check = { ok: false, reason: (error as Error).message, devices: [], how: "http" };
    }
    if (check.ok) {
      note({ way: wayWords(way), ok: true, reason: null });
      return { ok: true, app, way, check, tried };
    }
    stopApp(d.stepTaskId);
    note({
      way: wayWords(way),
      ok: false,
      reason: `it started on port ${app.port}, but ${check.reason ?? "it didn't render"}${app.output().trim() ? `; it printed: ${tail(app.output(), 600)}` : ""}`,
    });
  }
  return { ok: false, tried };
}
