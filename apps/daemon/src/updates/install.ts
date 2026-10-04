import { existsSync, readFileSync } from "node:fs";
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
