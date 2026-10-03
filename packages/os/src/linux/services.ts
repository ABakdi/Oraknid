import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceManager } from "../service.ts";
import { createAutostartService } from "./autostart.ts";
import { createOpenrcService } from "./openrc.ts";
import { createRunitService, runitDirs } from "./runit.ts";
import { createSystemdService } from "./systemd.ts";

export type ServiceKind = "systemd" | "openrc" | "runit" | "autostart";

export interface ServiceProbe {
  /** What PID 1 calls itself (/proc/1/comm). */
  pid1: string;
  exists(path: string): boolean;
  has(tool: string): boolean;
  /** ORAKNID_SERVICE, to choose by hand. */
  override?: string;
}

/**
 * Which service manager this system runs (ADR-036): PID 1 first, then the
 * tools present. Anything else (s6, a container, an init I don't know)
 * gets the XDG autostart entry.
 */
export function detectServiceKind(p: ServiceProbe): ServiceKind {
  const chosen = p.override?.trim();
  if (chosen === "systemd" || chosen === "openrc" || chosen === "runit" || chosen === "autostart")
    return chosen;
  const pid1 = p.pid1.trim();
  if (pid1 === "systemd" || p.exists("/run/systemd/system")) return "systemd";
  if (pid1 === "runit" || pid1 === "runit-init") return "runit";
  if (pid1 === "openrc-init") return "openrc";
  if (pid1 === "s6-svscan") return "autostart";
  // sysvinit or busybox init with OpenRC on top (Alpine, Gentoo, Devuan), or runsvdir under another init.
  if (p.has("openrc-run") && p.has("rc-service") && p.exists("/run/openrc")) return "openrc";
  if (
    p.has("sv") &&
    p.has("runsvdir") &&
    (p.exists("/var/service") || p.exists("/etc/runit/runsvdir/default"))
  )
    return "runit";
  return "autostart";
}

export interface ServiceCommands {
  start: string;
  stop: string;
  disable: string;
  logs: string;
}

/** How to start, stop, disable and read the logs of Oraknid with the system's own tools. */
export function serviceCommands(kind: ServiceKind, linkDir = runitDirs().linkDir): ServiceCommands {
  switch (kind) {
    case "systemd":
      return {
        start: "systemctl --user start oraknid",
        stop: "systemctl --user stop oraknid",
        disable: "systemctl --user disable --now oraknid",
        logs: "journalctl --user -u oraknid -f   (or: oraknid logs -f)",
      };
    case "openrc":
      return {
        start: "sudo rc-service oraknid start",
        stop: "sudo rc-service oraknid stop",
        disable: "sudo rc-update del oraknid default",
        logs: "oraknid logs -f",
      };
    case "runit":
      return {
        start: `sudo sv up ${linkDir}/oraknid`,
        stop: `sudo sv down ${linkDir}/oraknid`,
        disable: `sudo rm ${linkDir}/oraknid`,
        logs: "oraknid logs -f",
      };
    case "autostart":
      return {
        start: "oraknid start",
        stop: "oraknid stop",
        disable: `rm ${join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart/oraknid.desktop")}`,
        logs: "oraknid logs -f",
      };
  }
}

export const SERVICE_LABELS: Record<ServiceKind, string> = {
  systemd: "a systemd user service",
  openrc: "an OpenRC service running as me",
  runit: "a runit service running as me",
  autostart:
    "no service manager I know: an autostart entry starts Oraknid when I log in to a desktop. Without a desktop, run `oraknid start` at login, or add `oraknid run` to your init system",
};

/** This system's probe: /proc/1/comm, the filesystem, and `command -v`. */
export function systemProbe(): ServiceProbe {
  let pid1 = "";
  try {
    pid1 = readFileSync("/proc/1/comm", "utf8");
  } catch {}
  return {
    pid1,
    exists: existsSync,
    has: (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" }).status === 0,
    override: process.env.ORAKNID_SERVICE,
  };
}

export interface DetectedService {
  kind: ServiceKind;
  label: string;
  manager: ServiceManager;
  commands: ServiceCommands;
}

/** The service manager for this system, how to drive it, and what to call it. */
export function createServiceManager(probe: ServiceProbe = systemProbe()): DetectedService {
  const kind = detectServiceKind(probe);
  const manager =
    kind === "systemd"
      ? createSystemdService()
      : kind === "openrc"
        ? createOpenrcService()
        : kind === "runit"
          ? createRunitService()
          : createAutostartService();
  return { kind, label: SERVICE_LABELS[kind], manager, commands: serviceCommands(kind) };
}
