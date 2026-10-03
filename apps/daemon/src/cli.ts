#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { format } from "node:util";
import {
  createBwrapSandbox,
  createKeychainStore,
  createServiceManager,
  type InstallStep,
} from "@oraknid/os";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { Command, Option } from "commander";
import type { Router } from "./api/router.ts";
import { type RuntimeInfo, startDaemon } from "./daemon.ts";
import { runDoctor } from "./doctor.ts";
import { DEFAULT_HOST, DEFAULT_PORT, resolvePaths } from "./paths.ts";
import { VERSION } from "./version.ts";

const paths = resolvePaths();
const program = new Command()
  .name("oraknid")
  .description("Always watching, many legs.")
  .version(VERSION);

program
  .command("run")
  .description("run the daemon in the foreground (what the service runs)")
  .addOption(
    new Option("--port <port>", "port to listen on").default(DEFAULT_PORT).argParser(Number),
  )
  .action(async ({ port }: { port: number }) => {
    const running = await findRunning();
    if (running) fail(`Oraknid is already running (pid ${running.pid}) at ${running.url}.`);
    // A promise nobody awaited must never take every running job down with it (Audit 1 → Q1-04).
    process.on("unhandledRejection", (error) =>
      log(
        `unhandled rejection: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      ),
    );
    // The daemon writes its own log, however it was started (Phase 2 → M2.0: readable in the UI).
    teeToLog(paths.daemonLog);
    const daemon = await startDaemon({ paths, port, host: DEFAULT_HOST, writeRuntimeFile: true });
    log(`Oraknid ${VERSION} listening on ${daemon.url} (data: ${paths.dataDir})`);
    const stop = async (signal: string) => {
      log(`${signal} received, stopping`);
      await daemon.close();
      process.exit(0);
    };
    process.once("SIGTERM", () => void stop("SIGTERM"));
    process.once("SIGINT", () => void stop("SIGINT"));
  });

program
  .command("start")
  .description("start the daemon in the background")
  .action(async () => {
    const running = await findRunning();
    if (running) {
      console.log(`Already running at ${running.url} (pid ${running.pid}).`);
      return;
    }
    // Re-run this same entry point (with any loader flags, e.g. tsx in development); it writes its own log.
    const child = spawn(process.execPath, [...process.execArgv, process.argv[1] ?? "", "run"], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const info = await waitFor(async () => findRunning(), 10_000);
    if (!info) fail(`The daemon did not come up within 10 s. See ${paths.daemonLog}.`);
    console.log(`Oraknid is running at ${info.url} (pid ${info.pid}).`);
  });

program
  .command("stop")
  .description("stop the background daemon")
  .action(async () => {
    const info = readRuntime();
    if (!info || !isAlive(info.pid)) {
      rmSync(paths.runtimeFile, { force: true });
      console.log("Oraknid is not running.");
      return;
    }
    process.kill(info.pid, "SIGTERM");
    const gone = await waitFor(async () => !isAlive(info.pid) || undefined, 10_000);
    if (!gone) fail(`pid ${info.pid} did not stop within 10 s.`);
    console.log("Oraknid stopped.");
  });

program
  .command("status")
  .description("show whether the daemon runs, and how it is doing")
  .action(async () => {
    const info = await findRunning();
    if (!info) {
      // Its process is there but doesn't answer yet: it is starting, not stopped.
      const runtime = readRuntime();
      if (runtime && isAlive(runtime.pid))
        console.log(`Oraknid is starting (pid ${runtime.pid}): ask again in a moment.`);
      else console.log("Oraknid is not running. Start it with: oraknid start");
      process.exitCode = 1;
      return;
    }
    const s = await api(info).system.status();
    console.log(`Oraknid ${s.version} — running`);
    console.log(`  url      ${info.url}`);
    console.log(`  pid      ${s.pid}`);
    console.log(`  uptime   ${formatDuration(s.uptimeMs)}`);
    console.log(`  data     ${s.dataDir}`);
    console.log(`  events   ${s.lastSeq}`);
  });

program
  .command("logs")
  .description("show the daemon's log")
  .option("-f, --follow", "keep printing new lines")
  .addOption(new Option("-n, --lines <n>", "how many lines").default(100).argParser(Number))
  .action(({ follow, lines }: { follow?: boolean; lines: number }) => {
    if (!existsSync(paths.daemonLog)) fail(`No log yet at ${paths.daemonLog}.`);
    const args = ["-n", String(lines), ...(follow ? ["-F"] : []), paths.daemonLog];
    spawnSync("tail", args, { stdio: "inherit" });
  });

program
  .command("open")
  .description("open the web UI in the browser")
  .action(async () => {
    const info = await findRunning();
    if (!info) fail("Oraknid is not running. Start it with: oraknid start");
    // The code stays in this terminal: a command line is readable by every
    // user of this machine (/proc), so it never goes in the address (Audit 2).
    const { code } = await api(info).devices.pairStart();
    spawn("xdg-open", [info.url], { detached: true, stdio: "ignore" }).unref();
    console.log(`Opening ${info.url}`);
    console.log(`If the page asks to pair this browser, its code is: ${code} (valid 5 minutes)`);
  });

program
  .command("pair")
  .description("show a code to pair a browser or phone with this Oraknid")
  .action(async () => {
    const info = await findRunning();
    if (!info) fail("Oraknid is not running. Start it with: oraknid start");
    const { code, expiresAt } = await api(info).devices.pairStart();
    console.log(`Pairing code: ${code}`);
    console.log(
      `Enter it in Oraknid on the new device within ${Math.round((expiresAt - Date.now()) / 60_000)} minutes.`,
    );
  });

program
  .command("pin")
  .description("the PIN that unlocks Oraknid on every device")
  .argument("<action>", "reset: forget the PIN; every device then asks for a new one")
  .action(async (action: string) => {
    if (action !== "reset") fail('Only "oraknid pin reset" is known.');
    const info = await findRunning();
    if (!info) fail("Oraknid is not running. Start it with: oraknid start");
    await api(info).lock.reset();
    console.log("The PIN is reset. Open Oraknid on this computer to set a new one.");
  });

program
  .command("doctor")
  .description("check this machine and say what is wrong")
  .action(async () => {
    const running = await findRunning();
    const checks = running
      ? await api(running).system.doctor()
      : runDoctor(paths, {
          sandbox: createBwrapSandbox().status(),
          secrets: await createKeychainStore().probe(),
          service: createServiceManager().manager.status(),
        });
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
      if (c.fix) console.log(`    → ${c.fix}`);
    }
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
  });

program
  .command("install")
  .description(
    "run Oraknid as a background service with what this system uses (systemd, OpenRC, runit)",
  )
  .action(async () => {
    const entry = process.argv[1] ?? "";
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) {
      fail(
        "Install from a build: pnpm --filter @oraknid/daemon build, then run dist/cli.mjs install.",
      );
    }
    // A daemon started by hand would hold the port the service needs.
    const running = await findRunning();
    if (running) {
      process.kill(running.pid, "SIGTERM");
      await waitFor(async () => !isAlive(running.pid) || undefined, 10_000);
    }
    const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin" };
    for (const k of ["ORAKNID_DATA_DIR", "ORAKNID_CONFIG_DIR"]) {
      const v = process.env[k];
      if (v) env[k] = v;
    }
    const service = createServiceManager();
    console.log(`Installing Oraknid as ${service.label}.`);
    const steps = service.install({
      execPath: process.execPath,
      args: [resolve(entry), "run"],
      env,
    });
    report(steps);
    const c = service.commands;
    console.log(`
Start:    ${c.start}
Stop:     ${c.stop}
Disable:  ${c.disable}
Logs:     ${c.logs}
Remove:   oraknid uninstall (your data is kept)`);
  });

program
  .command("uninstall")
  .description("stop and remove the background service (data is kept)")
  .action(() => {
    const service = createServiceManager();
    console.log(
      `Removing ${service.kind === "autostart" ? "the autostart entry" : `the ${service.kind} service`}.`,
    );
    report(service.uninstall());
  });

await program.parseAsync();

// ── helpers ─────────────────────────────────────────────────────────

function api(info: { url: string; token?: string }) {
  return createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${info.url}/api`,
      headers: { authorization: `Bearer ${info.token ?? ""}` },
    }),
  );
}

function readRuntime(): (RuntimeInfo & { token?: string }) | undefined {
  try {
    return JSON.parse(readFileSync(paths.runtimeFile, "utf8")) as RuntimeInfo & { token?: string };
  } catch {
    return undefined;
  }
}

/** The daemon counts as running only if its pid is alive and it answers. */
async function findRunning(): Promise<(RuntimeInfo & { token?: string }) | undefined> {
  const info = readRuntime();
  if (!info || !isAlive(info.pid)) return undefined;
  try {
    const res = await fetch(`${info.url}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok ? info : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await probe();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}

function report(steps: InstallStep[]) {
  for (const s of steps) console.log(`${s.ok ? "✓" : "✗"} ${s.step}${s.ok ? "" : `: ${s.detail}`}`);
  if (steps.some((s) => !s.ok)) process.exitCode = 1;
}

/** Everything the daemon prints also goes to its log file, rotated at 10 MB (one old file kept). */
function teeToLog(file: string) {
  mkdirSync(dirname(file), { recursive: true });
  try {
    if (statSync(file).size > 10 * 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {}
  const fd = openSync(file, "a", 0o600);
  for (const name of ["log", "error", "warn"] as const) {
    const original = console[name].bind(console);
    console[name] = (...args: unknown[]) => {
      original(...args);
      try {
        writeSync(fd, `${format(...args)}\n`);
      } catch {}
    };
  }
}

function log(message: string) {
  console.log(`${new Date().toISOString()} ${message}`);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
