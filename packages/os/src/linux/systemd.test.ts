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
  const installWith = (
    loginctl: (args: string[]) => { status: number; stdout: string; stderr: string },
  ) => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-unit-"));
    const calls: string[] = [];
    const svc = createSystemdService({
      unitDir: dir,
      user: "me",
      run: (cmd, args) => {
        calls.push([cmd, ...args].join(" "));
        if (cmd === "loginctl") return loginctl(args);
        if (cmd === "sudo") return { status: 1, stdout: "", stderr: "a password is required" };
        return { status: 0, stdout: "", stderr: "" };
      },
    });
    const steps = svc.install({ execPath: "/usr/bin/node", args: ["cli.mjs", "run"], env: {} });
    return { dir, calls, steps };
  };

  it("installs: writes the unit, reloads, enables, turns on linger — and reports each step", () => {
    let on = false;
    const { dir, calls, steps } = installWith((args) => {
      if (args[0] === "enable-linger") on = true;
      return { status: 0, stdout: on ? "yes\n" : "no\n", stderr: "" };
    });
    expect(readFileSync(join(dir, "oraknid.service"), "utf8")).toContain("ExecStart=");
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now oraknid.service",
      "loginctl show-user me -p Linger --value",
      "loginctl enable-linger me",
      "loginctl show-user me -p Linger --value",
    ]);
    expect(steps.at(-1)).toEqual({
      step: "Start at boot, before login (linger)",
      ok: true,
      detail: "done",
    });
  });

  it("leaves linger alone when it is on already (it was asked again and refused, 2026-10-03)", () => {
    const { calls, steps } = installWith(() => ({ status: 0, stdout: "yes\n", stderr: "" }));
    expect(calls).not.toContain("loginctl enable-linger me");
    expect(steps.at(-1)).toMatchObject({ ok: true, detail: "already on" });
  });

  it("makes a refused linger a warning with the command, not a failure", () => {
    const { calls, steps } = installWith((args) =>
      args[0] === "enable-linger"
        ? { status: 1, stdout: "", stderr: "Could not enable linger: Access denied" }
        : { status: 0, stdout: "no\n", stderr: "" },
    );
    expect(calls).toContain("sudo -n loginctl enable-linger me");
    expect(steps.at(-1)).toMatchObject({ ok: false, warning: true });
    expect(steps.at(-1)?.detail).toMatch(
      /Access denied\. Oraknid starts when you log in; to start it at boot, run: sudo loginctl enable-linger me/,
    );
  });

  it("explains what is missing for starting at boot", () => {
    const svc = createSystemdService({
      unitDir: mkdtempSync(join(tmpdir(), "oraknid-unit-")),
      user: "me",
      run: () => ({ status: 0, stdout: "no\n", stderr: "" }),
    });
    expect(svc.status()).toMatchObject({ installed: false, startsAtBoot: false });
    expect(svc.status().fix).toBe("Run: oraknid install");
  });
});

describe("systemd: what doctor says to run", () => {
  function svc(answers: Record<string, string>) {
    const unitDir = mkdtempSync(join(tmpdir(), "oraknid-unit-"));
    writeFileSync(join(unitDir, "oraknid.service"), "");
    return createSystemdService({
      unitDir,
      user: "me",
      run: (cmd, args) => ({
        status: 0,
        stdout: `${answers[`${cmd} ${args.join(" ")}`] ?? ""}\n`,
        stderr: "",
      }),
    });
  }
  const enabled = { "systemctl --user is-enabled oraknid.service": "enabled" };
  const active = { "systemctl --user is-active oraknid.service": "active" };
  const linger = { "loginctl show-user me -p Linger --value": "yes" };

  it("nothing when enabled, lingering and running", () => {
    expect(svc({ ...enabled, ...active, ...linger }).status().fix).toBeNull();
  });
  it("linger when it would start only at login", () => {
    expect(svc({ ...enabled, ...active }).status().fix).toBe("Run: loginctl enable-linger me");
  });
  it("enable when installed but not enabled; start when stopped", () => {
    expect(svc({}).status().fix).toBe("Run: systemctl --user enable --now oraknid.service");
    expect(svc({ ...enabled, ...linger }).status().fix).toBe(
      "Run: systemctl --user start oraknid.service",
    );
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
