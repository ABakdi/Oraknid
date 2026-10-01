import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import type { DoctorCheck } from "@oraknid/contracts";
import type { Paths } from "./paths.ts";

/**
 * Checks the machine Oraknid runs on and says, in plain words, what is
 * wrong and how to fix it (BR-17). Later milestones add their own checks.
 */
export function runDoctor(paths: Paths): DoctorCheck[] {
  return [
    checkNode(),
    checkDataDir(paths),
    checkCommand("git", ["--version"], "git", "Install git: sudo pacman -S git"),
    checkSandbox(),
    checkCommand(
      "systemd-inhibit",
      ["--version"],
      "Sleep inhibition (systemd-inhibit)",
      "Oraknid needs systemd-logind to keep the machine awake while jobs run.",
    ),
    checkCommand(
      "notify-send",
      ["--version"],
      "Desktop notifications (notify-send)",
      "Install libnotify: sudo pacman -S libnotify",
    ),
    checkOptional("nvidia-smi", ["--version"], "NVIDIA GPU metrics (nvidia-smi)"),
  ];
}

function checkNode(): DoctorCheck {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const ok = major > 22 || (major === 22 && minor >= 12);
  return {
    name: "Node.js",
    ok,
    detail: `Node ${process.versions.node}`,
    fix: ok ? null : "Oraknid needs Node 22.12 or newer.",
  };
}

function checkDataDir(paths: Paths): DoctorCheck {
  try {
    mkdirSync(paths.dataDir, { recursive: true });
    accessSync(paths.dataDir, constants.W_OK);
    return { name: "Data directory", ok: true, detail: paths.dataDir, fix: null };
  } catch (error) {
    return {
      name: "Data directory",
      ok: false,
      detail: `${paths.dataDir} is not writable (${(error as Error).message})`,
      fix: "Make the directory writable, or set ORAKNID_DATA_DIR to one that is.",
    };
  }
}

/** bwrap must exist and be allowed to create user namespaces (ADR-006). */
function checkSandbox(): DoctorCheck {
  const name = "Sandbox (bubblewrap)";
  const found = spawnSync("bwrap", ["--version"], { encoding: "utf8" });
  if (found.error || found.status !== 0) {
    return {
      name,
      ok: false,
      detail: "bwrap was not found.",
      fix: "Install bubblewrap: sudo pacman -S bubblewrap. Jobs refuse to run without it.",
    };
  }
  const run = spawnSync(
    "bwrap",
    ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--dev", "/dev", "true"],
    { encoding: "utf8", timeout: 5000 },
  );
  if (run.status !== 0) {
    return {
      name,
      ok: false,
      detail: `bwrap is installed but could not create a sandbox: ${(run.stderr || "no output").trim()}`,
      fix: "Allow unprivileged user namespaces (kernel.unprivileged_userns_clone=1).",
    };
  }
  return { name, ok: true, detail: found.stdout.trim(), fix: null };
}

function checkCommand(cmd: string, args: string[], name: string, fix: string): DoctorCheck {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) return { name, ok: false, detail: `${cmd} was not found.`, fix };
  return { name, ok: true, detail: firstLine(r.stdout || r.stderr), fix: null };
}

/** Missing optional tools are reported but never fail the check. */
function checkOptional(cmd: string, args: string[], name: string): DoctorCheck {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000 });
  if (r.error || r.status !== 0) {
    return {
      name,
      ok: true,
      detail: `${cmd} not found — this metric will not be shown.`,
      fix: null,
    };
  }
  return { name, ok: true, detail: firstLine(r.stdout), fix: null };
}

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
