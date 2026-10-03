import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServiceCommand, ServiceManager, ServiceStatus } from "../service.ts";
import { defaultRun, type Run, stepper } from "./exec.ts";

/** A word for a desktop entry's Exec line (the XDG spec's quoting). */
function execQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["`$\\])/g, "\\$1")}"`;
}

/**
 * The XDG autostart entry (ADR-036): with no service manager I know, a
 * desktop session starts Oraknid when I log in. It runs `start`, which
 * detaches, rather than `run`.
 */
export function autostartEntry(command: ServiceCommand) {
  const args =
    command.args.at(-1) === "run" ? [...command.args.slice(0, -1), "start"] : command.args;
  // PATH comes from the session; Oraknid's own settings are carried over.
  const env = Object.entries(command.env)
    .filter(([k]) => k !== "PATH")
    .map(([k, v]) => `${k}=${v}`);
  const exec = [...(env.length ? ["env", ...env] : []), command.execPath, ...args]
    .map(execQuote)
    .join(" ");
  return `[Desktop Entry]
Type=Application
Name=Oraknid
Comment=Always watching, many legs.
Exec=${exec}
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
`;
}

export interface AutostartOptions {
  dir?: string;
  run?: Run;
}

export function createAutostartService(options: AutostartOptions = {}): ServiceManager {
  const dir =
    options.dir ?? join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "autostart");
  const file = join(dir, "oraknid.desktop");
  const step = stepper(options.run ?? defaultRun);
  return {
    install(command) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, autostartEntry(command));
      const start =
        command.args.at(-1) === "run" ? [...command.args.slice(0, -1), "start"] : command.args;
      return [
        {
          step: `Write ${file} (starts Oraknid when I log in to a desktop)`,
          ok: true,
          detail: "done",
        },
        step("Start oraknid now", command.execPath, start),
      ];
    },
    uninstall() {
      rmSync(file, { force: true });
      return [{ step: `Remove ${file}`, ok: true, detail: "done" }];
    },
    status(): ServiceStatus {
      const installed = existsSync(file);
      return {
        installed,
        enabled: installed,
        active: false,
        startsAtBoot: false,
        detail: installed
          ? "Starts when I log in to a desktop session (no service manager I know)."
          : "No service manager I know: nothing starts Oraknid at login yet.",
        fix: installed
          ? null
          : "Run: oraknid install (an autostart entry for a desktop session), or add `oraknid run` to your init system",
      };
    },
  };
}
