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
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { format } from "node:util";
import type { UpdatesView } from "@oraknid/contracts";
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
import { addWebUi as addWebUiIn, findAppDir } from "./updates/install.ts";
import { readRun, updateLog } from "./updates/runner.ts";
import { Updates } from "./updates/service.ts";
import { VERSION } from "./version.ts";

const paths = resolvePaths();
const program = new Command()
  .name("oraknid")
  .description("Always watching, many legs.")
  .version(VERSION);

program
  .command("tui", { isDefault: true })
  .description("open Oraknid in this terminal (what `oraknid` alone does)")
  .action(async () => {
    const info = await findRunning();
    if (!info) fail("Oraknid is not running. Start it with: oraknid start");
    // Loaded only here: the service never loads Ink or React (ADR-055).
    const { runTui } = await import("./tui/index.tsx");
    try {
      await runTui({
        url: info.url,
        token: info.token ?? "",
        stateFile: join(paths.configDir, "tui.json"),
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    process.exit(0);
  });

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
    await needWebUi(info);
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
    await needWebUi(info);
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
  .command("export")
  .description(
    "everything, as one archive encrypted to a passphrase, to move Oraknid to another computer",
  )
  .option("--all", "the database, Silk, settings and the keychain's entries (required)")
  .option("-o, --out <file>", "where to write it (default: oraknid-move-<date>.age here)")
  .option("--passphrase-file <file>", "read the passphrase from a file instead of asking")
  .action(async (o: { all?: boolean; out?: string; passphraseFile?: string }) => {
    if (!o.all)
      fail(
        "Use oraknid export --all. A job or a project is exported as a zip from its page (Export).",
      );
    const passphrase = o.passphraseFile
      ? readFileSync(o.passphraseFile, "utf8").replace(/\r?\n$/, "")
      : await newPassphrase();
    const secrets = await localSecrets();
    const { exportAll } = await import("./moving/move.ts");
    try {
      const r = await exportAll({ paths, secrets, passphrase });
      const out = resolve(o.out ?? r.name);
      writeFileSync(out, r.data, { mode: 0o600 });
      const c = r.manifest.counts;
      console.log(
        `✓ ${out}: ${c.projects} project(s), ${c.jobs} job(s), ${c.servers} server(s), ${c.secrets} secret(s).`,
      );
      console.log(
        "Projects' folders aren't in it: on the new computer, copy them or clone their repos again.",
      );
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("import")
  .description(
    "restore an archive made by `oraknid export --all` (Oraknid stopped, a fresh install)",
  )
  .argument("<file>", "the archive (.age)")
  .option("--replace", "replace this Oraknid's projects and jobs (its database is backed up first)")
  .option("--passphrase-file <file>", "read the passphrase from a file instead of asking")
  .action(async (file: string, o: { replace?: boolean; passphraseFile?: string }) => {
    if (await findRunning()) fail("Stop Oraknid first (oraknid stop), then import.");
    const passphrase = o.passphraseFile
      ? readFileSync(o.passphraseFile, "utf8").replace(/\r?\n$/, "")
      : await askHidden("The archive's passphrase: ");
    const secrets = await localSecrets();
    const { importAll } = await import("./moving/move.ts");
    try {
      const r = await importAll({
        paths,
        secrets,
        data: readFileSync(file),
        passphrase,
        replace: o.replace === true,
      });
      const c = r.manifest.counts;
      console.log(
        `✓ Imported ${c.projects} project(s), ${c.jobs} job(s), ${c.servers} server(s) and ${r.secrets} secret(s), from Oraknid ${r.manifest.oraknid}.`,
      );
      if (r.missing.length) {
        console.log("These projects' folders aren't on this computer:");
        for (const p of r.missing) {
          const repos = p.repos.filter((x) => x.github).map((x) => x.github);
          console.log(
            `  ${p.name}: ${p.folder}${repos.length ? ` (Clone again on its page: ${repos.join(", ")})` : " (copy it from the old computer)"}`,
          );
        }
      }
      console.log("Legs log in again from their cards. Start Oraknid with: oraknid start");
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  });

program
  .command("start-job")
  .description("start a draft job (New work's Start)")
  .argument("<id>", "the draft's id")
  .option(
    "--unsandboxed",
    "run it without the sandbox (only when the sandbox doesn't work here; asks first)",
  )
  .option("-y, --yes", "with --unsandboxed: don't ask")
  .action(async (id: string, o: { unsandboxed?: boolean; yes?: boolean }) => {
    const info = await findRunning();
    if (!info) fail("Oraknid is not running. Start it with: oraknid start");
    if (o.unsandboxed) {
      // An explicit choice, confirmed and recorded (ADR-006).
      const ok =
        o.yes ||
        (await ask(
          "Without the sandbox its agents run with your own rights on this computer. Run it so? [y/N] ",
        ));
      if (!ok) fail("Not started.");
    }
    try {
      await api(info).jobs.start(o.unsandboxed ? { id, unsandboxed: true, confirm: true } : { id });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    console.log(o.unsandboxed ? "Started, without the sandbox." : "Started.");
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
  .option("--gui", "also build the web UI, on an install made for the terminal only")
  .action(async ({ gui }: { gui?: boolean }) => {
    const entry = process.argv[1] ?? "";
    if (!entry.endsWith(".mjs") && !entry.endsWith(".js")) {
      fail(
        "Install from a build: pnpm --filter @oraknid/daemon build, then run dist/cli.mjs install.",
      );
    }
    if (gui) addWebUi();
    // A daemon started by hand would hold the port the service needs.
    const running = await findRunning();
    if (running) {
      process.kill(running.pid, "SIGTERM");
      await waitFor(async () => !isAlive(running.pid) || undefined, 10_000);
    }
    // Each folder once: every update installs from a service whose PATH holds ours already.
    const path = [...new Set((process.env.PATH ?? "/usr/bin").split(":").filter(Boolean))].join(
      ":",
    );
    const env: Record<string, string> = { PATH: path };
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

program
  .command("update")
  .description("update Oraknid to the newest version on its channel (your data is kept)")
  .option("--check", "only say whether there is an update")
  .option("-y, --yes", "update even while jobs run (they pause, and go on after the restart)")
  .action(async ({ check, yes }: { check?: boolean; yes?: boolean }) => {
    const running = await findRunning();
    // Without the daemon, the same service here: its check in memory, the database's file copied.
    const local = running
      ? null
      : new Updates({
          db: null,
          bus: { publish: () => {} },
          paths,
          now: Date.now,
          runningJobs: () => 0,
        });
    const who = { remote: false, full: true };
    const v = running
      ? await api(running).updates.check()
      : await local?.check().then(() => local.view(who));
    if (!v) return;
    printUpdates(v);
    if (check) return;
    if (!v.canUpdate) {
      if (v.available || v.install.mode !== "script") process.exitCode = 1;
      return;
    }
    if (v.runningJobs > 0 && !yes) {
      const sure = await ask(
        `${v.runningJobs} job(s) running: they pause at a safe point while Oraknid restarts, and go on after it. Update now? [y/N] `,
      );
      if (!sure) fail("Not updated. (Run it with --yes to update without asking.)");
    }
    const run = running
      ? await api(running).updates.run({ confirm: true })
      : await local?.run(who, { confirm: true });
    if (!run) return;
    if (run.backup) console.log(`Database copied to ${run.backup}`);
    console.log(`Updating to ${run.target}; following ${updateLog(paths.logs)}\n`);
    let shown = 0;
    for (;;) {
      const now = readRun(paths.dataDir, paths.logs, { now: Date.now, lines: 100_000 });
      if (!now) fail("The update's status is gone.");
      for (const line of now.log.slice(shown)) console.log(line);
      shown = now.log.length;
      if (now.state !== "running") {
        const said: Record<string, string> = {
          succeeded: `Updated to ${now.toVersion ? `v${now.toVersion}` : now.target}.`,
          "rolled-back": `The update failed; Oraknid went back to v${now.fromVersion}.`,
          failed: "The update failed; see the lines above.",
          interrupted: "The update stopped without a word (was the computer stopped?).",
        };
        console.log(`\n${said[now.state]}`);
        if (now.state !== "succeeded") process.exitCode = 1;
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  });

await program.parseAsync();

function printUpdates(v: UpdatesView) {
  const i = v.install;
  console.log(
    i.mode === "script"
      ? `Oraknid ${v.version} · ${i.channel === "dev" ? "dev channel (pre-releases and new work on dev)" : "stable channel (releases)"} · installed from ${i.ref} into ${i.appDir}`
      : `Oraknid ${v.version} · running from a clone at ${i.appDir}`,
  );
  if (v.error) console.log(`! ${v.error}`);
  for (const r of v.newer) {
    console.log(`\n${r.tag}${r.prerelease ? " (pre-release)" : ""} — ${r.name}  ${r.url}`);
    const notes = r.notes.trim().split("\n").slice(0, 12);
    for (const line of notes) console.log(`  ${line}`);
  }
  if (v.devAhead?.count) {
    console.log(`\nNew work on dev (${v.devAhead.count} commits)  ${v.devAhead.url}`);
    for (const c of v.devAhead.commits.slice(0, 10))
      console.log(`  ${c.sha.slice(0, 7)} ${c.message}`);
  }
  if (v.available) console.log(`\nUpdate available${v.target ? `: ${v.target}` : ""}.`);
  else if (!v.error) console.log("\nUp to date.");
  if (v.whyNot && v.available) console.log(v.whyNot);
  else if (v.install.mode !== "script") console.log(v.whyNot);
}

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** A line typed without showing it (a passphrase). */
async function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY)
    fail("Give the passphrase with --passphrase-file, or run this in a terminal.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let asked = false;
  out._writeToOutput = (s: string) => {
    if (!asked) {
      out.output.write(s);
      asked = true;
    }
  };
  const answer = await new Promise<string>((r) => rl.question(question, r));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

/** A new passphrase, typed twice. */
async function newPassphrase(): Promise<string> {
  const p = await askHidden("A passphrase for the archive (12 characters or more): ");
  const again = await askHidden("The same passphrase again: ");
  if (p !== again) fail("The two passphrases differ.");
  return p;
}

/** This data folder's secrets, from here (the keychain, or the encrypted file opened). */
async function localSecrets() {
  const { Secrets } = await import("./os/secrets.ts");
  const { isDefaultDataDir } = await import("./paths.ts");
  const secrets = new Secrets(paths.dataDir, createKeychainStore(), {
    ownsLegacy: isDefaultDataDir(paths.dataDir),
  });
  const status = await secrets.init();
  if (!status.available) {
    try {
      secrets.unlock(await askHidden("The passphrase of Oraknid's secrets file: "));
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }
  return secrets;
}

// ── helpers ─────────────────────────────────────────────────────────

function api(info: { url: string; token?: string }) {
  return createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${info.url}/api`,
      headers: { authorization: `Bearer ${info.token ?? ""}` },
    }),
  );
}

/** A browser or a phone needs the web UI; a terminal-only install says so (ADR-055). */
async function needWebUi(info: { url: string; token?: string }) {
  const s = await api(info).system.status();
  if (s.webUi === false)
    fail(
      "This Oraknid has no web UI (it was installed for the terminal only), and a browser or a phone needs it.\n" +
        "Use it here with: oraknid\n" +
        "Add the web UI with: oraknid install --gui",
    );
}

/** `oraknid install --gui`: builds the web UI in the app's folder, then the service restarts on it. */
function addWebUi() {
  const appDir = findAppDir();
  if (!appDir) fail("The app's folder (with install.sh) wasn't found next to this program.");
  console.log(`Adding the web UI in ${appDir}`);
  try {
    addWebUiIn(appDir, (cmd, args, o) => {
      console.log(`+ ${cmd} ${args.join(" ")}`);
      return spawnSync(cmd, args, { ...o, stdio: "inherit" }).status ?? 1;
    });
  } catch (error) {
    fail(`The web UI wasn't added: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log("✓ The web UI is built; the service restarts on it.");
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
  for (const s of steps)
    console.log(`${s.ok ? "✓" : s.warning ? "!" : "✗"} ${s.step}${s.ok ? "" : `: ${s.detail}`}`);
  // A warning leaves the service running: only a real failure fails the command.
  if (steps.some((s) => !s.ok && !s.warning)) process.exitCode = 1;
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
