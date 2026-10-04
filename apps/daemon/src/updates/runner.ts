import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { UpdateRun, UpdateRunState } from "@oraknid/contracts";
import Database from "better-sqlite3";
import { readInstall } from "./install.ts";

// Update now (ADR-048): install.sh, run apart from the daemon it restarts.

/** What one update installs, and from where. */
export interface UpdatePlan {
  appDir: string;
  /** The repository install.sh fetches from (the record's `from`). */
  from: string;
  /** What it installs: a release's tag, or `dev`. */
  ref: string;
  /** Whether the background service runs Oraknid (else it is restarted by hand). */
  service: boolean;
  fromVersion: string;
  fromCommit: string;
}

/** Starting a program apart from this one. */
export interface Launcher {
  /** Runs a command to its end (systemd-run returns once the unit started). */
  run(cmd: string, args: string[]): { status: number | null; stderr: string };
  /** Starts a command in its own session, not waited for. */
  detach(cmd: string, args: string[]): void;
}

export const systemLauncher: Launcher = {
  run(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { status: r.status, stderr: r.error ? r.error.message : (r.stderr ?? "") };
  },
  detach(cmd, args) {
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
  },
};

export interface RunnerDeps {
  dataDir: string;
  /** Where update.log goes. */
  logsDir: string;
  now: () => number;
  launcher?: Launcher;
  /**
   * Whether this daemon is a systemd unit: the update then runs as its own
   * transient unit, or the service's restart would end it with the daemon.
   */
  underSystemd?: boolean;
  env?: NodeJS.ProcessEnv;
}

export const updatesDir = (dataDir: string) => join(dataDir, "updates");
export const updateLog = (logsDir: string) => join(logsDir, "update.log");

/** Runs under systemd: a unit's process has INVOCATION_ID, and systemd-run is there. */
export function runsUnderSystemd(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.INVOCATION_ID && spawnSync("sh", ["-c", "command -v systemd-run"]).status === 0;
}

/**
 * A copy of the database before the update, which may bring migrations
 * that run at the next start: `.backup()` is consistent while it is open.
 * The last `keep` are kept. Null for a database in memory (tests).
 */
export async function backupBeforeUpdate(
  client: Database.Database,
  backupsDir: string,
  version: string,
  now: number,
  keep = 3,
): Promise<string | null> {
  if (client.memory) return null;
  mkdirSync(backupsDir, { recursive: true });
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  // The time first, so the names sort in the order they were made.
  const name = `pre-update-${stamp}-v${version}.db`;
  const tmp = join(backupsDir, `${name}.tmp`);
  await client.backup(tmp);
  const check = new Database(tmp);
  try {
    const r = check.pragma("quick_check", { simple: true });
    if (r !== "ok")
      throw new Error(
        `The copy of the database made before updating failed its check: ${String(r)}`,
      );
    check.pragma("journal_mode = DELETE");
  } finally {
    check.close();
  }
  renameSync(tmp, join(backupsDir, name));
  for (const f of readdirSync(backupsDir)
    .filter((f) => f.startsWith("pre-update-") && f.endsWith(".db"))
    .sort()
    .slice(0, -keep))
    rmSync(join(backupsDir, f));
  return join(backupsDir, name);
}

/** A value inside single quotes for sh. */
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The variables the update passes on (the service's own, so install.sh finds the same Node and data). */
const PASSED = [
  "PATH",
  "HOME",
  "USER",
  "LANG",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "ORAKNID_DATA_DIR",
  "ORAKNID_CONFIG_DIR",
  "ORAKNID_SERVICE",
];

/**
 * The script that runs one update: the new version's install.sh (taken from
 * where its code comes from; this one's if that fails) with what was
 * installed; when it fails after changing the program, the version before is
 * built again. It writes how it ended in `result` for the daemon to read.
 */
export function wrapperScript(plan: UpdatePlan, dir: string, log: string, env: NodeJS.ProcessEnv) {
  const exports = PASSED.filter((k) => env[k] !== undefined)
    .map((k) => `export ${k}=${q(env[k] ?? "")}`)
    .join("\n");
  return `#!/bin/sh
# Written by Oraknid for one update (docs/04-Decisions/ADR-048-Updates.md).
# It runs apart from the daemon, which the update restarts.
set -u
${exports}
export ORAKNID_UPDATE=1
APP=${q(plan.appDir)}
FROM=${q(plan.from)}
REF=${q(plan.ref)}
PREV=${q(plan.fromCommit)}
FROMV=${q(plan.fromVersion)}
U=${q(dir)}
NO_SERVICE=${plan.service ? "''" : "--no-service"}
echo $$ >"$U/pid"
exec >>${q(log)} 2>&1 </dev/null
say() { printf '%s %s\\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
finish() {
	say "Update: $1."
	printf '%s %s %s\\n' "$1" "$2" "$(date +%s)" >"$U/result.new" && mv -f "$U/result.new" "$U/result"
	exit 0
}
# Without the service, Oraknid was started by hand: started again on the new build.
restart_by_hand() {
	[ -z "$NO_SERVICE" ] && return 0
	"$HOME/.local/bin/oraknid" stop || true
	"$HOME/.local/bin/oraknid" start || true
}

say "Updating Oraknid $FROMV ($PREV) to $REF"
cp "$APP/.oraknid-install.json" "$U/install-before.json" 2>/dev/null || true
if git -C "$APP" fetch --quiet "$FROM" "$REF" && git -C "$APP" show FETCH_HEAD:install.sh >"$U/install.sh.new"; then
	mv -f "$U/install.sh.new" "$U/install.sh"
else
	say "Using this version's install.sh."
	cp "$APP/install.sh" "$U/install.sh"
fi
# shellcheck disable=SC2086 # NO_SERVICE is one option or none
sh "$U/install.sh" --ref "$REF" --dir "$APP" --from "$FROM" $NO_SERVICE
code=$?
if [ "$code" = 0 ]; then
	restart_by_hand
	finish succeeded 0
fi
say "The update stopped (exit $code)."
if [ "$(git -C "$APP" rev-parse HEAD 2>/dev/null)" = "$PREV" ]; then
	say "The program wasn't changed: still $FROMV."
	finish failed "$code"
fi
say "Going back to $FROMV ($PREV)."
# shellcheck disable=SC2086
if sh "$U/install.sh" --ref "$PREV" --dir "$APP" --from "$FROM" $NO_SERVICE; then
	cp "$U/install-before.json" "$APP/.oraknid-install.json" 2>/dev/null || true
	restart_by_hand
	finish rolled-back "$code"
fi
finish failed "$code"
`;
}

interface StatusFile {
  startedAt: number;
  fromVersion: string;
  fromCommit: string;
  target: string;
  appDir: string;
  backup: string | null;
  /** Where this update's lines start in update.log. */
  logOffset: number;
  /** Its end was told (an event) once. */
  announced?: boolean;
}

/**
 * Starts an update apart from the daemon: as a transient systemd unit when
 * the daemon is one, else in its own session. Its status file, written
 * first, is what the UI follows across the restart.
 */
export function startUpdate(plan: UpdatePlan, backup: string | null, deps: RunnerDeps) {
  const dir = updatesDir(deps.dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(deps.logsDir, { recursive: true });
  const log = updateLog(deps.logsDir);
  for (const f of ["result", "pid"]) rmSync(join(dir, f), { force: true });
  const status: StatusFile = {
    startedAt: deps.now(),
    fromVersion: plan.fromVersion,
    fromCommit: plan.fromCommit,
    target: plan.ref,
    appDir: plan.appDir,
    backup,
    logOffset: existsSync(log) ? statSync(log).size : 0,
  };
  writeFileSync(join(dir, "status.json"), `${JSON.stringify(status, null, 2)}\n`, { mode: 0o600 });
  const script = join(dir, "run-update.sh");
  writeFileSync(script, wrapperScript(plan, dir, log, deps.env ?? process.env), { mode: 0o700 });
  const launcher = deps.launcher ?? systemLauncher;
  if (deps.underSystemd) {
    const unit = `oraknid-update-${status.startedAt}`;
    const r = launcher.run("systemd-run", [
      "--user",
      `--unit=${unit}`,
      "--collect",
      "--quiet",
      "--description=Oraknid update",
      "/bin/sh",
      script,
    ]);
    if (r.status !== 0) {
      rmSync(join(dir, "status.json"), { force: true });
      throw new Error(
        `The update couldn't be started outside the service (systemd-run: ${r.stderr.trim() || `exit ${r.status}`}).`,
      );
    }
  } else {
    launcher.detach("/bin/sh", [script]);
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Lines of a file from `offset`, the last `n`, reading at most 256 KB. */
function linesFrom(file: string, offset: number, n: number): string[] {
  if (!existsSync(file)) return [];
  const size = statSync(file).size;
  const start = Math.max(offset, size - 256 * 1024);
  if (start >= size) return [];
  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, buf.length, start);
  } finally {
    closeSync(fd);
  }
  const lines = buf.toString("utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-n);
}

/** The last update started, as its status file, its result and its log say; null if none. */
export function readRun(
  dataDir: string,
  logsDir: string,
  o: { now: () => number; isAlive?: (pid: number) => boolean; lines?: number },
): UpdateRun | null {
  const dir = updatesDir(dataDir);
  let s: StatusFile;
  try {
    s = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as StatusFile;
  } catch {
    return null;
  }
  let state: UpdateRunState = "running";
  let exitCode: number | null = null;
  let finishedAt: number | null = null;
  const result = existsSync(join(dir, "result"))
    ? readFileSync(join(dir, "result"), "utf8").trim().split(/\s+/)
    : null;
  if (result) {
    const [word, code, at] = result;
    state = (["succeeded", "rolled-back", "failed"] as const).find((x) => x === word) ?? "failed";
    exitCode = Number.isFinite(Number(code)) ? Number(code) : null;
    finishedAt = Number(at) ? Number(at) * 1000 : null;
  } else {
    const pid = existsSync(join(dir, "pid")) ? Number(readFileSync(join(dir, "pid"), "utf8")) : 0;
    // Gone without a result (the computer stopped); a moment's grace for its start.
    const gone = pid ? !(o.isAlive ?? alive)(pid) : o.now() - s.startedAt > 60_000;
    if (gone) state = "interrupted";
  }
  const toVersion = state === "succeeded" ? installedVersion(s.appDir) : null;
  return {
    state,
    startedAt: s.startedAt,
    finishedAt,
    fromVersion: s.fromVersion,
    fromCommit: s.fromCommit,
    target: s.target,
    toVersion,
    exitCode,
    backup: s.backup,
    log: linesFrom(updateLog(logsDir), s.logOffset, o.lines ?? 200),
  };
}

function installedVersion(appDir: string): string | null {
  const i = readInstall(appDir);
  return i.mode === "script" ? i.version : null;
}

/** Marks the last update's end as told; true the first time only. */
export function markAnnounced(dataDir: string): boolean {
  const file = join(updatesDir(dataDir), "status.json");
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as StatusFile;
    if (s.announced) return false;
    writeFileSync(file, `${JSON.stringify({ ...s, announced: true }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}
