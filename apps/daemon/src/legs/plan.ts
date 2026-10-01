import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { SandboxPlan } from "@oraknid/leg-sdk";
import type { Sandbox } from "@oraknid/os";
import type { LegRow } from "./registry.ts";

/**
 * Toolchain directories a Leg may read but not write (Sandboxing): every
 * PATH entry under my home (system ones are under /usr, already bound).
 */
export function toolchainDirs(path = process.env.PATH ?? "", home = homedir()): string[] {
  return [
    ...new Set(
      path
        .split(":")
        .filter((d) => d.startsWith(home + sep) && existsSync(d))
        .map((d) => realpathSync(d)),
    ),
  ];
}

/** Where a binary really lives, so a symlinked install (e.g. ~/.local/bin/claude) still runs. */
function binaryDir(binary: string): string | null {
  const candidates = binary.includes("/")
    ? [binary]
    : (process.env.PATH ?? "").split(":").map((d) => join(d, binary));
  for (const c of candidates) if (existsSync(c)) return dirname(realpathSync(c));
  return null;
}

export function sandboxPlan(leg: LegRow, sandbox: Sandbox, legsDir: string): SandboxPlan {
  const home = join(legsDir, leg.id, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = leg.config as Record<string, unknown>;
  const readonly = toolchainDirs();
  const writable: string[] = [];
  if (leg.kind === "claude-code") {
    const dir = binaryDir(String(config.binary ?? "claude"));
    if (dir) readonly.push(dir);
    if (typeof config.configDir === "string") writable.push(config.configDir);
  }
  return {
    sandbox,
    home,
    writable,
    readonly: [...new Set(readonly)],
    env: {
      PATH: process.env.PATH ?? "/usr/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      TERM: "dumb",
    },
  };
}
