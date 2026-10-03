import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { InstallStep, ServiceCommand, ServiceManager, ServiceStatus } from "../service.ts";
import { defaultRun, type Run, rootPrefix, rootStepper, shQuote } from "./exec.ts";

/**
 * The runit service's `run` (ADR-036): runsv starts it as root, chpst drops
 * to my user and all my groups, and runsv restarts it when it ends.
 */
export function runitRun(command: ServiceCommand, user: { name: string; home: string }) {
  const env = { HOME: user.home, USER: user.name, ...command.env };
  const exports = Object.entries(env)
    .map(([k, v]) => `export ${k}=${shQuote(v)}`)
    .join("\n");
  const name = shQuote(user.name);
  const exec = [command.execPath, ...command.args].map(shQuote).join(" ");
  return `#!/bin/sh
# Written by oraknid install. Remove it with: oraknid uninstall
exec 2>&1
${exports}
cd "$HOME" || exit 1
exec chpst -u "${user.name}:$(id -Gn ${name} | tr ' ' ':')" ${exec}
`;
}

/** Where the distribution keeps service directories, and the folder that enables them. */
export function runitDirs(exists: (path: string) => boolean = existsSync) {
  return {
    svDir: exists("/etc/runit/sv") ? "/etc/runit/sv" : "/etc/sv",
    linkDir: exists("/var/service") ? "/var/service" : "/etc/runit/runsvdir/default",
  };
}

export interface RunitOptions {
  svDir?: string;
  linkDir?: string;
  run?: Run;
  user?: { name: string; home: string };
  sudo?: string[];
}

export function createRunitService(options: RunitOptions = {}): ServiceManager {
  const dirs = runitDirs();
  const service = join(options.svDir ?? dirs.svDir, "oraknid");
  const link = join(options.linkDir ?? dirs.linkDir, "oraknid");
  const user = options.user ?? { name: userInfo().username, home: homedir() };
  const run = options.run ?? defaultRun;
  const root = rootStepper(run, options.sudo ?? rootPrefix());

  return {
    install(command) {
      const tmp = mkdtempSync(join(tmpdir(), "oraknid-runit-"));
      try {
        const source = join(tmp, "run");
        writeFileSync(source, runitRun(command, user));
        const linked = existsSync(link);
        const steps: InstallStep[] = [
          root(`Write ${service}/run`, "install", ["-D", "-m", "0755", source, `${service}/run`]),
        ];
        if (!steps[0]?.ok) return steps;
        // runsvdir starts a newly linked service within five seconds; one already linked restarts.
        steps.push(
          linked
            ? root("Restart oraknid", "sv", ["restart", link])
            : root(`Start at boot (link into ${options.linkDir ?? dirs.linkDir})`, "ln", [
                "-sfn",
                service,
                link,
              ]),
        );
        return steps;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    uninstall() {
      return [
        root("Stop oraknid", "sv", ["down", link]),
        root(`Remove ${link}`, "rm", ["-f", link]),
        root(`Remove ${service}`, "rm", ["-rf", service]),
      ];
    },
    status(): ServiceStatus {
      const installed = existsSync(join(service, "run"));
      const enabled = existsSync(link);
      // `sv status` needs to read runsv's supervise folder, which is root's: unknown counts as not running.
      const active = enabled && run("sv", ["status", link]).stdout.startsWith("run:");
      const detail = !installed
        ? "Not installed as a service."
        : !enabled
          ? "Installed but not enabled."
          : active
            ? "Running as a runit service; starts at boot."
            : "Enabled as a runit service; starts at boot.";
      // Not running can't be told from "can't read runsv's folder": enabled is enough.
      const fix = !installed
        ? "Run: oraknid install"
        : !enabled
          ? `Run: sudo ln -s ${service} ${link}`
          : null;
      return { installed, enabled, active, startsAtBoot: enabled, detail, fix };
    },
  };
}
