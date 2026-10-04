import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync } from "node:fs";
import type { DoctorCheck } from "@oraknid/contracts";
import type { SandboxStatus, SecretStoreStatus, ServiceStatus } from "@oraknid/os";
import { findRclone, RCLONE_FIX, rcloneVersion } from "./cloud/rclone.ts";
import type { Paths } from "./paths.ts";

export interface DoctorInputs {
  sandbox: SandboxStatus;
  secrets: SecretStoreStatus;
  service: ServiceStatus;
}

/**
 * Checks the machine Oraknid runs on and says, in plain words, what is
 * wrong and how to fix it (BR-17).
 */
export function runDoctor(paths: Paths, inputs: DoctorInputs): DoctorCheck[] {
  const pm = packageManager();
  return [
    checkNode(),
    checkDataDir(paths),
    checkCommand("git", ["--version"], "git", `Install git: ${installCommand(pm, "git")}`),
    {
      name: "Sandbox (bubblewrap)",
      ok: inputs.sandbox.available,
      detail: inputs.sandbox.detail,
      fix: inputs.sandbox.available
        ? null
        : `Install bubblewrap (${installCommand(pm, "bubblewrap")}) and allow unprivileged user namespaces. Jobs refuse to run without it.`,
    },
    checkCommand(
      "systemd-inhibit",
      ["--version"],
      "Sleep inhibition (systemd-inhibit)",
      "Oraknid needs systemd-logind to keep the machine awake while jobs run.",
    ),
    {
      name: "Secret store",
      ok: inputs.secrets.available || inputs.secrets.kind === "none",
      detail: inputs.secrets.detail,
      fix: null,
    },
    {
      name: "Background service",
      ok: true,
      detail: inputs.service.detail,
      fix: inputs.service.fix,
    },
    checkCommand(
      "notify-send",
      ["--version"],
      "Desktop notifications (notify-send)",
      `Install libnotify: ${installCommand(pm, "libnotify")}`,
    ),
    checkOptional("nvidia-smi", ["--version"], "NVIDIA GPU metrics (nvidia-smi)"),
    checkRclone(),
  ];
}

type PackageManager = "apt" | "dnf" | "pacman" | "zypper" | "apk" | null;

/** This system's package manager, as install.sh finds it. */
export function packageManager(
  has: (cmd: string) => boolean = (cmd) =>
    spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0,
): PackageManager {
  if (has("apt-get")) return "apt";
  if (has("dnf")) return "dnf";
  if (has("pacman")) return "pacman";
  if (has("zypper")) return "zypper";
  if (has("apk")) return "apk";
  return null;
}

/** Packages are named per distribution: libnotify's command is libnotify-bin on Debian. */
const PACKAGE_NAMES: Record<string, Partial<Record<Exclude<PackageManager, null>, string>>> = {
  libnotify: { apt: "libnotify-bin", zypper: "libnotify-tools" },
};

/** The command that installs a package here, or a plain word when the package manager is unknown. */
export function installCommand(pm: PackageManager, pkg: string): string {
  const name = PACKAGE_NAMES[pkg]?.[pm ?? "apt"] ?? pkg;
  switch (pm) {
    case "apt":
      return `sudo apt install ${name}`;
    case "dnf":
      return `sudo dnf install ${name}`;
    case "pacman":
      return `sudo pacman -S ${name}`;
    case "zypper":
      return `sudo zypper install ${name}`;
    case "apk":
      return `sudo apk add ${name}`;
    default:
      return `install ${pkg} with your package manager`;
  }
}

/** Cloud storage's rclone (ADR-046): optional, said with how to get it. */
function checkRclone(): DoctorCheck {
  const name = "Cloud storage (rclone)";
  const bin = findRclone();
  const version = bin ? rcloneVersion(bin) : null;
  if (!bin || !version)
    return {
      name,
      ok: true,
      detail: "rclone not found — Cloud storage needs it; nothing else does.",
      fix: RCLONE_FIX,
    };
  return { name, ok: true, detail: `${version} (${bin})`, fix: null };
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
