import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  type InstallStep,
  SERVICE_ENV,
  type ServiceManager,
  type ServiceNotifier,
  type ServiceStatus,
} from "../service.ts";
import { defaultRun, type Run, stepper } from "./exec.ts";

export const UNIT_NAME = "oraknid.service";

/** A question to systemd or logind, asked from the daemon too: never waited on long (ADR-070). */
const QUICK = { timeoutMs: 10_000 };

/**
 * The systemd user unit (docs/02-Architecture/OS-Integration.md).
 * Type=notify with a watchdog: systemd restarts a daemon that dies or hangs.
 * TimeoutStopSec leaves room for pause to reach safe points (BR-7: up to
 * 120 s); past that systemd kills what is left, the daemon's own deadline
 * having failed. On a desktop it starts with the graphical session, after
 * it, so the session's keychain is up first (ADR-070); on a machine
 * without one, at the user manager's start (boot, with linger). Ordered
 * after dbus.socket either way. The environment carries a larger thread
 * pool and says a service manager restarts it (ADR-070).
 */
export function unitText(
  command: {
    execPath: string;
    args: string[];
    env: Record<string, string>;
  },
  o: { desktop?: boolean } = {},
) {
  const exec = [command.execPath, ...command.args].map(quote).join(" ");
  const env = Object.entries({ ...SERVICE_ENV, ...command.env })
    .map(([k, v]) => `Environment=${quote(`${k}=${v}`)}`)
    .join("\n");
  const target = o.desktop ? "graphical-session.target" : "default.target";
  return `[Unit]
Description=Oraknid — always watching, many legs
Documentation=https://oraknid.com
After=dbus.socket${o.desktop ? " graphical-session.target" : ""}

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
WantedBy=${target}
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
  /** Whether this is a desktop session (tests); asked of systemd otherwise. */
  desktop?: () => boolean;
}

/**
 * A desktop session: systemd's graphical-session.target is running. A
 * compositor that never starts it (Hyprland without uwsm) counts as none,
 * or the service would never start: the keychain gate (ADR-070) stands
 * alone there.
 */
export function graphicalSession(run: Run): boolean {
  return (
    run("systemctl", ["--user", "is-active", "graphical-session.target"], {
      timeoutMs: 10_000,
    }).stdout.trim() === "active"
  );
}

export function createSystemdService(options: SystemdOptions = {}): ServiceManager {
  const unitDir = options.unitDir ?? join(homedir(), ".config/systemd/user");
  const unitPath = join(unitDir, UNIT_NAME);
  const user = options.user ?? userInfo().username;
  const run = options.run ?? defaultRun;
  const step = stepper(run);

  /**
   * Linger, so Oraknid starts at boot: left alone when it's on already;
   * otherwise asked for, then once more with sudo if it needs no password.
   * Refused (polkit, no session), the service still runs from login on:
   * a warning with the command, not a failure (seen 2026-10-03).
   */
  const lingerStep = (): InstallStep => {
    const name = "Start at boot, before login (linger)";
    const isOn = () =>
      run("loginctl", ["show-user", user, "-p", "Linger", "--value"], QUICK).stdout.trim() ===
      "yes";
    if (isOn()) return { step: name, ok: true, detail: "already on" };
    const mine = run("loginctl", ["enable-linger", user]);
    if (mine.status === 0 && isOn()) return { step: name, ok: true, detail: "done" };
    const viaSudo = run("sudo", ["-n", "loginctl", "enable-linger", user]);
    if (viaSudo.status === 0 && isOn()) return { step: name, ok: true, detail: "done (sudo)" };
    const why = (mine.stderr || mine.stdout).trim().split("\n").pop() || `exit ${mine.status}`;
    return {
      step: name,
      ok: false,
      warning: true,
      detail: `${why}. Oraknid starts when you log in; to start it at boot, run: sudo loginctl enable-linger ${user}`,
    };
  };

  return {
    install(command) {
      mkdirSync(unitDir, { recursive: true });
      const desktop = (options.desktop ?? (() => graphicalSession(run)))();
      const text = unitText(command, { desktop });
      let before: string | null = null;
      try {
        before = readFileSync(unitPath, "utf8");
      } catch {}
      writeFileSync(unitPath, text);
      const written: InstallStep = {
        step: `Write ${unitPath}`,
        ok: true,
        detail: desktop ? "done (starts with the desktop session)" : "done",
      };
      const reload = step("Reload systemd", "systemctl", ["--user", "daemon-reload"]);
      // A unit changed by an update: its WantedBy link moved (reenable), and the
      // service started again on it, so the new settings apply now (ADR-070).
      const changed = before !== null && before !== text;
      const start = changed
        ? [
            step("Enable oraknid.service on its new settings", "systemctl", [
              "--user",
              "reenable",
              UNIT_NAME,
            ]),
            step("Restart oraknid.service on its new settings", "systemctl", [
              "--user",
              "restart",
              UNIT_NAME,
            ]),
          ]
        : [
            step("Enable and start oraknid.service", "systemctl", [
              "--user",
              "enable",
              "--now",
              UNIT_NAME,
            ]),
          ];
      return [written, reload, ...start, lingerStep()];
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
        run("systemctl", ["--user", "is-enabled", UNIT_NAME], QUICK).stdout.trim() === "enabled";
      const active =
        run("systemctl", ["--user", "is-active", UNIT_NAME], QUICK).stdout.trim() === "active";
      const linger =
        run("loginctl", ["show-user", user, "-p", "Linger", "--value"], QUICK).stdout.trim() ===
        "yes";
      let withDesktop = false;
      try {
        withDesktop = /^WantedBy=graphical-session\.target$/m.test(readFileSync(unitPath, "utf8"));
      } catch {}
      const detail = !installed
        ? "Not installed as a service."
        : !enabled
          ? "Installed but not enabled."
          : withDesktop
            ? active
              ? "Running as a service; starts with the desktop session, once its keychain is up."
              : "Enabled (starts with the desktop session), but not running right now."
            : !linger
              ? "Starts when I log in, not at boot (linger is off)."
              : active
                ? "Running as a service; starts at boot."
                : "Enabled, but not running right now.";
      const fix = !installed
        ? "Run: oraknid install"
        : !enabled
          ? `Run: systemctl --user enable --now ${UNIT_NAME}`
          : !withDesktop && !linger
            ? `Run: loginctl enable-linger ${user}`
            : active
              ? null
              : `Run: systemctl --user start ${UNIT_NAME}`;
      return {
        installed,
        enabled,
        active,
        startsAtBoot: enabled && linger && !withDesktop,
        detail,
        fix,
      };
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
