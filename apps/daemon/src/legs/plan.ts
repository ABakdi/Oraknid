import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { SandboxPlan } from "@oraknid/leg-sdk";
import { type Sandbox, withLocalPorts } from "@oraknid/os";
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

/**
 * This computer's ports a Leg's own settings name (a local model at
 * http://localhost:11434): its sandbox may reach them (Sandboxing → network).
 */
export function legLocalPorts(config: unknown): number[] {
  const ports = new Set<number>();
  for (const m of JSON.stringify(config ?? {}).matchAll(
    /\b(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?/gi,
  ))
    ports.add(m[1] ? Number(m[1]) : m[0].toLowerCase().startsWith("https") ? 443 : 80);
  return [...ports].filter((p) => p > 0 && p < 65536);
}

export function sandboxPlan(
  leg: LegRow,
  sandbox: Sandbox,
  legsDir: string,
  /** The project's ports on this computer its jobs may reach. */
  localPorts: number[] = [],
): SandboxPlan {
  const home = join(legsDir, leg.id, "home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const config = leg.config as Record<string, unknown>;
  const readonly = toolchainDirs();
  const writable: string[] = [];
  if (leg.kind === "opencode" || leg.kind === "antigravity") {
    const dir = binaryDir(String(config.binary ?? (leg.kind === "opencode" ? "opencode" : "agy")));
    if (dir) readonly.push(dir);
  }
  if (leg.kind === "claude-code") {
    const dir = binaryDir(String(config.binary ?? "claude"));
    if (dir) readonly.push(dir);
    if (typeof config.configDir === "string") writable.push(config.configDir);
  }
  return {
    sandbox: withLocalPorts(sandbox, [...legLocalPorts(config), ...localPorts]),
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
