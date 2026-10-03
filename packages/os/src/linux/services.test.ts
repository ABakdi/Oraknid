import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { autostartEntry, createAutostartService } from "./autostart.ts";
import type { Run } from "./exec.ts";
import { createOpenrcService, openrcScript } from "./openrc.ts";
import { createRunitService, runitDirs, runitRun } from "./runit.ts";
import { detectServiceKind, type ServiceProbe, serviceCommands } from "./services.ts";

const me = { name: "me", home: "/home/me" };
const command = {
  execPath: "/home/me/.local/share/oraknid/app/.tools/node/bin/node",
  args: ["/home/me/.local/share/oraknid/app/apps/daemon/dist/cli.mjs", "run"],
  env: { PATH: "/usr/local/bin:/usr/bin", ORAKNID_DATA_DIR: "/home/me/my data" },
};

function probe(pid1: string, paths: string[] = [], tools: string[] = []): ServiceProbe {
  return { pid1: `${pid1}\n`, exists: (p) => paths.includes(p), has: (t) => tools.includes(t) };
}

/** A fake runner that records each command and, for `install`, what it would write. */
function recorder(fail: string[] = []) {
  const calls: string[] = [];
  const written: Record<string, string> = {};
  const run: Run = (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const real = cmd === "sudo" ? args.slice(1) : args;
    if ((cmd === "sudo" ? args[0] : cmd) === "install") {
      const [source, dest] = real.slice(-2) as [string, string];
      written[dest] = readFileSync(source, "utf8");
    }
    const failed = fail.find((f) => line.includes(f));
    return failed
      ? { status: 1, stdout: "", stderr: `${failed} failed` }
      : { status: 0, stdout: "", stderr: "" };
  };
  return { calls, written, run };
}

describe("which service manager", () => {
  it("goes by PID 1", () => {
    expect(detectServiceKind(probe("systemd"))).toBe("systemd");
    expect(detectServiceKind(probe("runit"))).toBe("runit");
    expect(detectServiceKind(probe("runit-init"))).toBe("runit");
    expect(detectServiceKind(probe("openrc-init"))).toBe("openrc");
    expect(detectServiceKind(probe("s6-svscan", [], ["sv", "runsvdir"]))).toBe("autostart");
  });

  it("goes by the tools present when PID 1 is a plain init", () => {
    expect(detectServiceKind(probe("init", ["/run/openrc"], ["openrc-run", "rc-service"]))).toBe(
      "openrc",
    );
    // OpenRC installed but not running: not OpenRC.
    expect(detectServiceKind(probe("init", [], ["openrc-run", "rc-service"]))).toBe("autostart");
    expect(detectServiceKind(probe("init", ["/var/service"], ["sv", "runsvdir"]))).toBe("runit");
    expect(detectServiceKind(probe("init", ["/run/systemd/system"]))).toBe("systemd");
    expect(detectServiceKind(probe("bash"))).toBe("autostart");
  });

  it("can be chosen by hand with ORAKNID_SERVICE", () => {
    expect(detectServiceKind({ ...probe("systemd"), override: "runit" })).toBe("runit");
    expect(detectServiceKind({ ...probe("systemd"), override: "nonsense" })).toBe("systemd");
  });

  it("says how to stop, disable and read the logs with the system's own tools", () => {
    expect(serviceCommands("systemd").stop).toBe("systemctl --user stop oraknid");
    expect(serviceCommands("openrc").disable).toBe("sudo rc-update del oraknid default");
    expect(serviceCommands("runit", "/var/service").stop).toBe("sudo sv down /var/service/oraknid");
    expect(serviceCommands("autostart").disable).toMatch(/autostart\/oraknid\.desktop$/);
  });
});

describe("OpenRC", () => {
  it("writes a supervised script that runs as me, with my environment", () => {
    const text = openrcScript(command, me);
    expect(text.startsWith("#!/sbin/openrc-run\n")).toBe(true);
    expect(text).toContain("supervisor=supervise-daemon");
    expect(text).toContain("command=/usr/bin/env");
    expect(text).toContain("command_user=me");
    expect(text).toContain('retry="TERM/150/KILL/5"');
    // No PATH exported in the script itself: OpenRC needs its own.
    expect(text).not.toMatch(/^export /m);
  });

  it("hands the daemon its environment and command through env, as OpenRC's eval reads them", () => {
    const text = openrcScript(command, me);
    // What supervise-daemon gets: source the assignment, then eval the words, as OpenRC does.
    const r = spawnSync(
      "sh",
      ["-c", `${text.match(/^command_args=.*$/m)?.[0]}\neval 'printf "%s\\n"' "$command_args"`],
      { encoding: "utf8" },
    );
    expect(r.stdout.trim().split("\n")).toEqual([
      "HOME=/home/me",
      "USER=me",
      "PATH=/usr/local/bin:/usr/bin",
      "ORAKNID_DATA_DIR=/home/me/my data",
      command.execPath,
      command.args[0],
      "run",
    ]);
  });

  it("the script is valid sh", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-openrc-"));
    writeFileSync(join(dir, "oraknid"), openrcScript(command, me));
    expect(spawnSync("sh", ["-n", join(dir, "oraknid")]).status).toBe(0);
  });

  it("installs through sudo: writes the script, adds it to the default runlevel, starts it", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-openrc-"));
    const r = recorder();
    const svc = createOpenrcService({ initDir: dir, user: me, run: r.run, sudo: ["sudo"] });
    const steps = svc.install(command);
    expect(r.calls.slice(1)).toEqual([
      "sudo rc-update add oraknid default",
      "sudo rc-service oraknid start",
    ]);
    expect(r.calls[0]).toMatch(new RegExp(`^sudo install -m 0755 \\S+ ${dir}/oraknid$`));
    expect(r.written[join(dir, "oraknid")]).toContain("command_user=me");
    expect(steps.every((s) => s.ok)).toBe(true);
  });

  it("stops at the first refusal, and as root needs no sudo", () => {
    const r = recorder(["install"]);
    const svc = createOpenrcService({ initDir: "/nowhere", user: me, run: r.run, sudo: [] });
    const steps = svc.install(command);
    expect(steps).toEqual([
      { step: "Write /nowhere/oraknid", ok: false, detail: "install failed" },
    ]);
    expect(r.calls[0]).toMatch(/^install /);
  });

  it("uninstalls: stop, out of the runlevel, script removed", () => {
    const r = recorder();
    createOpenrcService({
      initDir: "/etc/init.d",
      user: me,
      run: r.run,
      sudo: ["sudo"],
    }).uninstall();
    expect(r.calls).toEqual([
      "sudo rc-service oraknid stop",
      "sudo rc-update del oraknid default",
      "sudo rm -f /etc/init.d/oraknid",
    ]);
  });

  it("status reads the runlevel folder", () => {
    const init = mkdtempSync(join(tmpdir(), "oraknid-openrc-"));
    const runlevel = mkdtempSync(join(tmpdir(), "oraknid-runlevel-"));
    writeFileSync(join(init, "oraknid"), "");
    writeFileSync(join(runlevel, "oraknid"), "");
    const svc = createOpenrcService({
      initDir: init,
      runlevelDir: runlevel,
      user: me,
      run: () => ({ status: 3, stdout: "", stderr: "" }),
    });
    expect(svc.status()).toMatchObject({ installed: true, startsAtBoot: true, active: false });
  });
});

describe("runit", () => {
  it("writes a run script that drops to me and all my groups", () => {
    const text = runitRun(command, me);
    expect(text).toContain("exec 2>&1");
    expect(text).toContain("export ORAKNID_DATA_DIR='/home/me/my data'");
    expect(text).toContain(
      `exec chpst -u "me:$(id -Gn me | tr ' ' ':')" ${command.execPath} ${command.args[0]} run`,
    );
    const dir = mkdtempSync(join(tmpdir(), "oraknid-runit-"));
    writeFileSync(join(dir, "run"), text);
    expect(spawnSync("sh", ["-n", join(dir, "run")]).status).toBe(0);
  });

  it("knows where Void, Artix and Debian keep services", () => {
    expect(runitDirs((p) => p === "/var/service")).toEqual({
      svDir: "/etc/sv",
      linkDir: "/var/service",
    });
    expect(runitDirs((p) => p === "/etc/runit/sv")).toEqual({
      svDir: "/etc/runit/sv",
      linkDir: "/etc/runit/runsvdir/default",
    });
  });

  it("installs: writes the service and links it, or restarts one already linked", () => {
    const sv = mkdtempSync(join(tmpdir(), "oraknid-sv-"));
    const links = mkdtempSync(join(tmpdir(), "oraknid-links-"));
    const r = recorder();
    const svc = createRunitService({
      svDir: sv,
      linkDir: links,
      user: me,
      run: r.run,
      sudo: ["sudo"],
    });
    svc.install(command);
    expect(r.written[`${sv}/oraknid/run`]).toContain("chpst");
    expect(r.calls[1]).toBe(`sudo ln -sfn ${sv}/oraknid ${links}/oraknid`);

    mkdirSync(join(links, "oraknid"));
    r.calls.length = 0;
    svc.install(command);
    expect(r.calls[1]).toBe(`sudo sv restart ${links}/oraknid`);
  });

  it("uninstalls: down, unlinked, removed", () => {
    const r = recorder();
    createRunitService({
      svDir: "/etc/sv",
      linkDir: "/var/service",
      user: me,
      run: r.run,
      sudo: ["sudo"],
    }).uninstall();
    expect(r.calls).toEqual([
      "sudo sv down /var/service/oraknid",
      "sudo rm -f /var/service/oraknid",
      "sudo rm -rf /etc/sv/oraknid",
    ]);
  });
});

describe("autostart", () => {
  it("writes a desktop entry that starts Oraknid in the background", () => {
    const text = autostartEntry(command);
    expect(text).toContain("[Desktop Entry]");
    expect(text).toContain(
      `Exec=env "ORAKNID_DATA_DIR=/home/me/my data" ${command.execPath} ${command.args[0]} start`,
    );
    expect(text).not.toContain("PATH=");
  });

  it("installs the entry and starts Oraknid now; uninstall removes it", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-autostart-"));
    const r = recorder();
    const svc = createAutostartService({ dir, run: r.run });
    const steps = svc.install(command);
    expect(existsSync(join(dir, "oraknid.desktop"))).toBe(true);
    expect(r.calls).toEqual([`${command.execPath} ${command.args[0]} start`]);
    expect(steps.every((s) => s.ok)).toBe(true);
    expect(svc.status()).toMatchObject({ installed: true, startsAtBoot: false });
    svc.uninstall();
    expect(existsSync(join(dir, "oraknid.desktop"))).toBe(false);
  });
});
