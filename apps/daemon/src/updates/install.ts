import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type InstallInfo, InstallRecord } from "@oraknid/contracts";

// How this Oraknid was installed (ADR-048): by install.sh, or a developer's clone.

export const RECORD_FILE = ".oraknid-install.json";

/** The repository's root this program runs from (src/ or dist/): where install.sh is. */
export function findAppDir(from = dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "install.sh")) && existsSync(join(dir, "pnpm-workspace.yaml")))
      return dir;
    dir = dirname(dir);
  }
  return null;
}

/** A command run in the app's folder; its exit status. */
export type RunIn = (
  cmd: string,
  args: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv },
) => number;

/**
 * `oraknid install --gui` (ADR-055): the web UI added to an install made for
 * the terminal only. Its dependencies installed and it built, with the Node
 * and pnpm install.sh put in the app's folder; the record then says so, and
 * updates build it from then on.
 */
export function addWebUi(appDir: string, run: RunIn, env: NodeJS.ProcessEnv = process.env): void {
  const tools = `${join(appDir, ".tools", "bin")}:${join(appDir, ".tools", "node", "bin")}`;
  const e = {
    ...env,
    PATH: `${tools}:${env.PATH ?? "/usr/bin:/bin"}`,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    TURBO_TELEMETRY_DISABLED: "1",
    DO_NOT_TRACK: "1",
  };
  const steps: [string, string[]][] = [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["exec", "turbo", "run", "build", "--filter", "@oraknid/web"]],
  ];
  for (const [cmd, args] of steps) {
    const status = run(cmd, args, { cwd: appDir, env: e });
    if (status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (exit ${status}).`);
  }
  const file = join(appDir, RECORD_FILE);
  if (!existsSync(file)) return;
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  writeFileSync(file, `${JSON.stringify({ ...raw, gui: true }, null, 2)}\n`);
}

/**
 * The record install.sh wrote in the app's folder: there, this is its
 * install, and Oraknid can update itself; missing (or unreadable), it runs
 * from a clone and git updates it.
 */
export function readInstall(appDir: string): InstallInfo {
  try {
    const raw = JSON.parse(readFileSync(join(appDir, RECORD_FILE), "utf8")) as unknown;
    const record = InstallRecord.parse(raw);
    return { mode: "script", appDir, ...record };
  } catch {
    // install.sh has always kept its .tools/ out of git: one from before the record (v0.1.0).
    let unrecorded = false;
    try {
      unrecorded = readFileSync(join(appDir, ".git", "info", "exclude"), "utf8")
        .split("\n")
        .includes("/.tools/");
    } catch {}
    return unrecorded ? { mode: "clone", appDir, unrecorded } : { mode: "clone", appDir };
  }
}
