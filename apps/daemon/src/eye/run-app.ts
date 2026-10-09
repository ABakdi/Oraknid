import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxPlan } from "@oraknid/leg-sdk";

// The running app for an app review (ADR-064 §3): its dev server, started
// by Oraknid in the job's sandbox on a free local port, until the review
// is over. Nothing is written into the project.

/** How the app runs: a command, and where the command came from. */
export interface AppRun {
  command: string;
  from: string;
}

/** The package manager the project uses, by its lock file. */
function packageManager(cwd: string): "npm" | "pnpm" | "yarn" | "bun" {
  if (existsSync(join(cwd, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(cwd, "yarn.lock"))) return "yarn";
  if (existsSync(join(cwd, "bun.lockb")) || existsSync(join(cwd, "bun.lock"))) return "bun";
  return "npm";
}

const README_RUN =
  /^\s*(?:\$\s*)?((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b[^\n]*|python3? -m http\.server\b[^\n]*)$/m;

/**
 * The command that runs the app, with `$PORT` for its port: the plan's
 * own, else the project's dev (or start) script, else what its README
 * says, else a static server for a folder with an index.html. Null when
 * nothing says how.
 */
export function detectRun(cwd: string, planned?: string | null): AppRun | null {
  if (planned?.trim()) return { command: planned.trim(), from: "the plan" };
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    let scripts: Record<string, string> = {};
    try {
      scripts =
        (JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> })
          .scripts ?? {};
    } catch {}
    const pm = packageManager(cwd);
    const name = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
    if (name) {
      const script = scripts[name] as string;
      const run = pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
      // Vite and the like take the port as a flag; most others read PORT.
      const flags = /\b(vite|astro|svelte-kit|nuxt)\b/.test(script)
        ? ` -- --port $PORT --strictPort --host 127.0.0.1`
        : /\bnext\b/.test(script)
          ? " -- -p $PORT -H 127.0.0.1"
          : "";
      return { command: `${run}${flags}`, from: `package.json's ${name} script` };
    }
  }
  for (const readme of ["README.md", "readme.md", "README"]) {
    const path = join(cwd, readme);
    if (!existsSync(path)) continue;
    const m = readFileSync(path, "utf8").match(README_RUN);
    if (m?.[1]) return { command: m[1].trim(), from: readme };
  }
  if (existsSync(join(cwd, "index.html")))
    return { command: "python3 -m http.server $PORT --bind 127.0.0.1", from: "its index.html" };
  return null;
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

export interface RunningApp {
  port: number;
  command: string;
  stop: () => void;
  alive: () => boolean;
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

/**
 * Starts the app for a review: its command in the job's sandbox (the port
 * reachable from this computer) or, for a job I run without it, as it is;
 * resolves once the port answers, or rejects with what it said.
 */
export async function startApp(o: {
  stepTaskId: string;
  cwd: string;
  run: AppRun;
  port: number;
  plan: SandboxPlan | null;
  waitMs?: number;
  signal?: AbortSignal;
}): Promise<RunningApp> {
  stopApp(o.stepTaskId);
  const env = {
    PORT: String(o.port),
    HOST: "127.0.0.1",
    BROWSER: "none",
    CI: "1",
  };
  const command = o.run.command.replaceAll("$PORT", String(o.port));
  let child: ChildProcess;
  if (o.plan) {
    const home = mkdtempSync(join(tmpdir(), "oraknid-app-"));
    const wrapped = o.plan.sandbox.wrap({
      command: "/bin/sh",
      args: ["-c", command],
      cwd: o.cwd,
      writable: [o.cwd, home],
      readonly: o.plan.readonly,
      home,
      env: { ...o.plan.env, ...env },
      inboundPorts: [o.port],
    });
    // The sandbox sets its own environment; a stand-in that runs the command as it is gets the port too.
    child = spawn(wrapped.command, wrapped.args, {
      cwd: o.cwd,
      detached: true,
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
  } else {
    child = spawn("/bin/sh", ["-c", command], {
      cwd: o.cwd,
      detached: true,
      stdio: "pipe",
      env: { ...process.env, ...env },
    });
  }
  let output = "";
  const keep = (b: Buffer) => {
    output = (output + b.toString()).slice(-4000);
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  let exited = false;
  child.on("exit", () => {
    exited = true;
  });
  child.on("error", (e) => {
    exited = true;
    output += `\n${e.message}`;
  });
  const stop = () => {
    if (exited || !child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  const app: RunningApp = { port: o.port, command, stop, alive: () => !exited };
  const end = Date.now() + (o.waitMs ?? 90_000);
  for (;;) {
    if (o.signal?.aborted) {
      stop();
      throw o.signal.reason ?? new Error("Stopped.");
    }
    if (await answers(o.port)) break;
    if (exited) throw new Error(`\`${command}\` stopped before it answered:\n${output.trim()}`);
    if (Date.now() > end) {
      stop();
      throw new Error(`\`${command}\` didn't answer on port ${o.port} in time:\n${output.trim()}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  apps.set(o.stepTaskId, app);
  return app;
}
