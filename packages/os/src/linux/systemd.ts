import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { ServiceManager, ServiceNotifier, ServiceStatus } from "../service.ts";
import { defaultRun, type Run, stepper } from "./exec.ts";

export const UNIT_NAME = "oraknid.service";

/**
 * The systemd user unit (docs/02-Architecture/OS-Integration.md).
 * Type=notify with a watchdog: systemd restarts a daemon that dies or hangs.
 * TimeoutStopSec leaves room for pause to reach safe points (BR-7: up to 120 s).
 */
export function unitText(command: {
  execPath: string;
  args: string[];
  env: Record<string, string>;
}) {
  const exec = [command.execPath, ...command.args].map(quote).join(" ");
  const env = Object.entries(command.env)
    .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Oraknid — always watching, many legs
Documentation=https://oraknid.com

[Service]
Type=notify
NotifyAccess=all
ExecStart=${exec}
${env ? `${env}\n` : ""}Restart=always
RestartSec=2
WatchdogSec=30
TimeoutStopSec=150
KillMode=mixed

[Install]
WantedBy=default.target
`;
}

/** systemd's quoting: double quotes with backslash escapes when needed. */
function quote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `"${s.replace(/(["\\])/g, "\\$1")}"`;
}

export interface SystemdOptions {
  unitDir?: string;
  run?: Run;
  user?: string;
}

export function createSystemdService(options: SystemdOptions = {}): ServiceManager {
  const unitDir = options.unitDir ?? join(homedir(), ".config/systemd/user");
  const unitPath = join(unitDir, UNIT_NAME);
  const user = options.user ?? userInfo().username;
  const run = options.run ?? defaultRun;
  const step = stepper(run);

  return {
    install(command) {
      mkdirSync(unitDir, { recursive: true });
      writeFileSync(unitPath, unitText(command));
      return [
        { step: `Write ${unitPath}`, ok: true, detail: "done" },
        step("Reload systemd", "systemctl", ["--user", "daemon-reload"]),
        step("Enable and start oraknid.service", "systemctl", [
          "--user",
          "enable",
          "--now",
          UNIT_NAME,
        ]),
        step("Start at boot, before login (linger)", "loginctl", ["enable-linger", user]),
      ];
    },
    uninstall() {
      const steps = [
        step("Stop and disable oraknid.service", "systemctl", [
          "--user",
          "disable",
          "--now",
          UNIT_NAME,
        ]),
      ];
      rmSync(unitPath, { force: true });
      steps.push({ step: `Remove ${unitPath}`, ok: true, detail: "done" });
      steps.push(step("Reload systemd", "systemctl", ["--user", "daemon-reload"]));
      return steps;
    },
    status(): ServiceStatus {
      const installed = existsSync(unitPath);
      const enabled =
        run("systemctl", ["--user", "is-enabled", UNIT_NAME]).stdout.trim() === "enabled";
      const active =
        run("systemctl", ["--user", "is-active", UNIT_NAME]).stdout.trim() === "active";
      const linger =
        run("loginctl", ["show-user", user, "-p", "Linger", "--value"]).stdout.trim() === "yes";
      const detail = !installed
        ? "Not installed as a service. Run: oraknid install"
        : !enabled
          ? "Installed but not enabled."
          : !linger
            ? "Starts when I log in, not at boot (linger is off)."
            : active
              ? "Running as a service; starts at boot."
              : "Enabled, but not running right now.";
      return { installed, enabled, active, startsAtBoot: enabled && linger, detail };
    },
  };
}

/**
 * sd_notify through `systemd-notify`. With NotifyAccess=all and a recent
 * systemd (pidfd-based attribution), messages from the short-lived helper
 * are credited to the service. A no-op outside systemd.
 */
export function createSystemdNotifier(env: NodeJS.ProcessEnv = process.env): ServiceNotifier {
  const active = Boolean(env.NOTIFY_SOCKET);
  const send = (...args: string[]) => {
    if (!active) return;
    spawn("systemd-notify", args, { stdio: "ignore" }).on("error", () => {});
  };
  return {
    ready: () => send("--ready", `--pid=${process.pid}`),
    stopping: () => send("STOPPING=1"),
    startWatchdog() {
      const usec = Number(env.WATCHDOG_USEC);
      if (!active || !usec) return () => {};
      // Ping at half the interval, as systemd recommends.
      const timer = setInterval(() => send("WATCHDOG=1"), Math.max(500, usec / 2000));
      timer.unref();
      return () => clearInterval(timer);
    },
  };
}
