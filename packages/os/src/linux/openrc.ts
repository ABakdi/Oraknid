import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { InstallStep, ServiceCommand, ServiceManager, ServiceStatus } from "../service.ts";
import { defaultRun, type Run, rootPrefix, rootStepper, shQuote } from "./exec.ts";

/**
 * The OpenRC script (ADR-036): a system service that drops to my user,
 * kept alive by supervise-daemon, with as long to stop as systemd gives it.
 * The environment goes through env(1): exporting PATH in the script would
 * hide OpenRC's own helpers from it. OpenRC evals command_args, so each
 * word is quoted, and the whole is quoted again for the assignment.
 */
export function openrcScript(command: ServiceCommand, user: { name: string; home: string }) {
  const env = Object.entries({ HOME: user.home, USER: user.name, ...command.env }).map(
    ([k, v]) => `${k}=${v}`,
  );
  const args = [...env, command.execPath, ...command.args].map(shQuote).join(" ");
  return `#!/sbin/openrc-run
# Written by oraknid install. Remove it with: oraknid uninstall

name="oraknid"
description="Oraknid — always watching, many legs"
supervisor=supervise-daemon
command=/usr/bin/env
command_args=${shQuote(args)}
command_user=${shQuote(user.name)}
directory=${shQuote(user.home)}
respawn_delay=2
respawn_max=0
retry="TERM/150/KILL/5"

depend() {
\tneed localmount
\tafter net
}
`;
}

export interface OpenrcOptions {
  initDir?: string;
  runlevelDir?: string;
  run?: Run;
  user?: { name: string; home: string };
  sudo?: string[];
}

export function createOpenrcService(options: OpenrcOptions = {}): ServiceManager {
  const initDir = options.initDir ?? "/etc/init.d";
  const runlevelDir = options.runlevelDir ?? "/etc/runlevels/default";
  const script = join(initDir, "oraknid");
  const user = options.user ?? { name: userInfo().username, home: homedir() };
  const run = options.run ?? defaultRun;
  const sudo = options.sudo ?? rootPrefix();
  const root = rootStepper(run, sudo);

  return {
    install(command) {
      const tmp = mkdtempSync(join(tmpdir(), "oraknid-openrc-"));
      try {
        const source = join(tmp, "oraknid");
        writeFileSync(source, openrcScript(command, user));
        const wasThere = existsSync(script);
        const steps: InstallStep[] = [
          root(`Write ${script}`, "install", ["-m", "0755", source, script]),
        ];
        if (!steps[0]?.ok) return steps;
        steps.push(
          root("Start at boot (rc-update add oraknid default)", "rc-update", [
            "add",
            "oraknid",
            "default",
          ]),
          root(wasThere ? "Restart oraknid" : "Start oraknid", "rc-service", [
            "oraknid",
            wasThere ? "restart" : "start",
          ]),
        );
        return steps;
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    },
    uninstall() {
      return [
        root("Stop oraknid", "rc-service", ["oraknid", "stop"]),
        root("Remove from boot (rc-update del)", "rc-update", ["del", "oraknid", "default"]),
        root(`Remove ${script}`, "rm", ["-f", script]),
      ];
    },
    status(): ServiceStatus {
      const installed = existsSync(script);
      const enabled = existsSync(join(runlevelDir, "oraknid"));
      const active = installed && run("rc-service", ["oraknid", "status"]).status === 0;
      const detail = !installed
        ? "Not installed as a service. Run: oraknid install"
        : !enabled
          ? "Installed but not started at boot. Run: sudo rc-update add oraknid default"
          : active
            ? "Running as an OpenRC service; starts at boot."
            : "Starts at boot, but not running right now. Run: sudo rc-service oraknid start";
      return { installed, enabled, active, startsAtBoot: enabled, detail };
    },
  };
}
