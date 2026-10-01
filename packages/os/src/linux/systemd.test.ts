import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSystemdService, unitText } from "./systemd.ts";

describe("unit file", () => {
  it("runs the daemon as a notify service with a watchdog and restarts", () => {
    const text = unitText({
      execPath: "/usr/bin/node",
      args: ["/opt/oraknid/cli.mjs", "run"],
      env: { ORAKNID_DATA_DIR: "/home/me/my data" },
    });
    expect(text).toContain("ExecStart=/usr/bin/node /opt/oraknid/cli.mjs run");
    expect(text).toContain("Type=notify");
    expect(text).toContain("WatchdogSec=30");
    expect(text).toContain("Restart=always");
    expect(text).toContain('Environment="ORAKNID_DATA_DIR=/home/me/my data"');
    expect(text).toContain("WantedBy=default.target");
  });
});

describe("service manager", () => {
  it("installs: writes the unit, reloads, enables, turns on linger — and reports each step", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-unit-"));
    const calls: string[] = [];
    const svc = createSystemdService({
      unitDir: dir,
      user: "me",
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        return cmd === "loginctl"
          ? { status: 1, stdout: "", stderr: "Access denied" }
          : { status: 0, stdout: "", stderr: "" };
      },
    });
    const steps = svc.install({ execPath: "/usr/bin/node", args: ["cli.mjs", "run"], env: {} });
    expect(readFileSync(join(dir, "oraknid.service"), "utf8")).toContain("ExecStart=");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now oraknid.service",
      "loginctl enable-linger me",
    ]);
    expect(steps.at(-1)).toEqual({
      step: "Start at boot, before login (linger)",
      ok: false,
      detail: "Access denied",
    });
  });

  it("explains what is missing for starting at boot", () => {
    const svc = createSystemdService({
      unitDir: mkdtempSync(join(tmpdir(), "oraknid-unit-")),
      user: "me",
      run: () => ({ status: 0, stdout: "no\n", stderr: "" }),
    });
    expect(svc.status()).toMatchObject({ installed: false, startsAtBoot: false });
    expect(svc.status().detail).toMatch(/oraknid install/);
  });
});

const userSystemd =
  spawnSync("systemctl", ["--user", "is-system-running"]).status !== null &&
  spawnSync("systemd-run", ["--version"]).status === 0;

describe.runIf(userSystemd)("systemd notify, for real", () => {
  it("a transient notify unit becomes active only after ready, and stays up on watchdog pings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-notify-"));
    const script = join(dir, "svc.mjs");
    const notifier = resolve(import.meta.dirname, "systemd.ts");
    writeFileSync(
      script,
      `const { createSystemdNotifier } = await import(${JSON.stringify(notifier)});
const n = createSystemdNotifier();
setTimeout(() => { n.ready(); n.startWatchdog(); }, 500);
setInterval(() => {}, 1000);
`,
    );
    const unit = `oraknid-test-${process.pid}`;
    const start = spawnSync(
      "systemd-run",
      [
        "--user",
        `--unit=${unit}`,
        "-p",
        "Type=notify",
        "-p",
        "NotifyAccess=all",
        "-p",
        "WatchdogSec=2",
        process.execPath,
        script,
      ],
      { encoding: "utf8", timeout: 20_000 },
    );
    try {
      expect(start.status, start.stderr).toBe(0);
      // systemd-run waits for READY=1 on a notify unit, so it is active now.
      expect(isActive(unit)).toBe("active");
      // Survive several watchdog intervals.
      await new Promise((r) => setTimeout(r, 5000));
      expect(isActive(unit)).toBe("active");
    } finally {
      spawnSync("systemctl", ["--user", "stop", unit]);
    }
  }, 30_000);
});

function isActive(unit: string) {
  return spawnSync("systemctl", ["--user", "is-active", unit], { encoding: "utf8" }).stdout.trim();
}
