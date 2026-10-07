import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstallRecord } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import { addWebUi, findAppDir, RECORD_FILE, readInstall } from "./install.ts";
import { type Launcher, readRun, startUpdate, type UpdatePlan } from "./runner.ts";

// install.sh's record of what it installed, and the update script that runs
// it (ADR-048): real git repositories in temp folders, no network, nothing
// of mine touched.

const ROOT = findAppDir() as string;
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
};

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A stand-in install.sh: records how it was called, checks out what it was asked for. */
const fakeScript = (exit: number) => `#!/bin/sh
REF="$2"; DIR="$4"; FROM="$6"
echo "$*" >>"$DIR/../calls.log"
case "$REF" in
????????????????????????????????????????) git -C "$DIR" checkout -q --detach "$REF"; exit 0 ;;
esac
git -C "$DIR" fetch -q "$FROM" "$REF" || exit 4
git -C "$DIR" checkout -q --detach FETCH_HEAD
v="$(sed -n 's/^  "version": "\\(.*\\)",$/\\1/p' "$DIR/package.json")"
f="$(printf '%s' "$FROM" | sed 's/"/\\\\"/g')"
printf '{"ref":"%s","channel":"stable","commit":"%s","version":"%s","installedAt":"x","from":"%s","service":true}\\n' "$REF" "$(git -C "$DIR" rev-parse HEAD)" "$v" "$f" >"$DIR/${RECORD_FILE}"
exit ${exit}
`;

/**
 * Oraknid's repository in miniature: v0.1.0, v0.2.0, and v0.3.0 whose
 * install.sh fails; dev one commit past it.
 */
function origin(root: string, o: { knowsGui?: boolean } = {}) {
  const dir = join(root, 'ori"gin');
  mkdirSync(dir);
  git(dir, "init", "-q", "-b", "dev");
  const commit = (version: string, exit: number) => {
    writeFileSync(
      join(dir, "package.json"),
      `{\n  "name": "oraknid",\n  "version": "${version}",\n  "private": true\n}\n`,
    );
    // An install.sh that knows --gui / --no-gui (ADR-055) says so in its help.
    writeFileSync(
      join(dir, "install.sh"),
      fakeScript(exit) + (o.knowsGui ? "# --gui | --no-gui\n" : ""),
    );
    writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", `v${version}`);
    git(dir, "tag", `v${version}`);
    return git(dir, "rev-parse", "HEAD");
  };
  const c1 = commit("0.1.0", 0);
  const c2 = commit("0.2.0", 0);
  const c3 = commit("0.3.0", 3);
  writeFileSync(join(dir, "NEW"), "new work\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "New work on dev");
  return { dir, c1, c2, c3, dev: git(dir, "rev-parse", "HEAD") };
}

/** install.sh's own functions, run in a shell: fetch_source, then write_record. */
function installSh(o: {
  dir: string;
  from: string;
  ref: string;
  service?: boolean;
  gui?: boolean;
}) {
  const r = spawnSync(
    "sh",
    [
      "-c",
      'ORAKNID_INSTALL_LIB=1 . "$0"; DIR="$1"; FROM="$2"; REF="$3"; SERVICE="$4"; GUI="$5"; fetch_source && write_record',
      join(ROOT, "install.sh"),
      o.dir,
      o.from,
      o.ref,
      o.service === false ? "0" : "1",
      o.gui === undefined ? "" : o.gui ? "1" : "0",
    ],
    { env: GIT_ENV, encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`install.sh: ${r.stdout}${r.stderr}`);
  return r.stdout;
}

const record = (dir: string) =>
  InstallRecord.parse(JSON.parse(readFileSync(join(dir, RECORD_FILE), "utf8")));

describe("install.sh's record of what it installed (ADR-048)", () => {
  it("writes the ref, its channel, the commit, the version, when and from where", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-install-"));
    const o = origin(root);
    const app = join(root, "app");
    const out = installSh({ dir: app, from: o.dir, ref: "dev" });
    expect(out).toContain(`Recorded dev (dev channel, version 0.3.0) in ${app}/${RECORD_FILE}`);
    const dev = record(app);
    expect(dev).toMatchObject({
      ref: "dev",
      channel: "dev",
      commit: o.dev,
      version: "0.3.0",
      from: o.dir,
      service: true,
    });
    expect(Date.parse(dev.installedAt)).toBeGreaterThan(Date.now() - 60_000);
    // Read back as the daemon reads it; the record doesn't count as a change in the checkout.
    expect(readInstall(app)).toMatchObject({ mode: "script", channel: "dev", appDir: app });
    expect(git(app, "status", "--porcelain")).toBe("");

    // Running it again with a release's tag: the stable channel, that version.
    installSh({ dir: app, from: o.dir, ref: "v0.2.0", service: false });
    expect(record(app)).toMatchObject({
      ref: "v0.2.0",
      channel: "stable",
      commit: o.c2,
      version: "0.2.0",
      service: false,
    });
    installSh({ dir: app, from: o.dir, ref: "v0.1.0" });
    expect(record(app)).toMatchObject({ channel: "stable", commit: o.c1, version: "0.1.0" });
  });

  it("goes back to a commit the checkout has without fetching it", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-install-"));
    const o = origin(root);
    const app = join(root, "app");
    installSh({ dir: app, from: o.dir, ref: "dev" });
    // The repository it came from is gone: the commit is still here.
    installSh({ dir: app, from: join(root, "gone"), ref: o.c2 });
    expect(git(app, "rev-parse", "HEAD")).toBe(o.c2);
  });

  it("is a clone, not an install, without the record", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-install-"));
    expect(readInstall(root)).toEqual({ mode: "clone", appDir: root });
    writeFileSync(join(root, RECORD_FILE), "{ not json");
    expect(readInstall(root).mode).toBe("clone");
  });

  it("knows an install by an install.sh from before the record (v0.1.0) by its .tools/ kept out of git", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-install-"));
    mkdirSync(join(root, ".git", "info"), { recursive: true });
    writeFileSync(join(root, ".git", "info", "exclude"), "# git ls-files\n/.tools/\n");
    expect(readInstall(root)).toEqual({ mode: "clone", appDir: root, unrecorded: true });
  });
});

describe("the update script (ADR-048)", () => {
  /** An install at v0.1.0 from the miniature repository, its data folder, and a launcher that runs the script to its end. */
  function installed(g: { knowsGui?: boolean; gui?: boolean } = {}) {
    const root = mkdtempSync(join(tmpdir(), "oraknid-update-"));
    const o = origin(root, g);
    const app = join(root, "app");
    git(root, "clone", "-q", o.dir, app);
    git(app, "checkout", "-q", "--detach", o.c1);
    writeFileSync(
      join(app, RECORD_FILE),
      JSON.stringify({
        ref: "v0.1.0",
        channel: "stable",
        commit: o.c1,
        version: "0.1.0",
        installedAt: "2026-10-04T09:00:00Z",
        from: o.dir,
        service: true,
      }),
    );
    const data = join(root, "data");
    const launcher: Launcher = {
      run: () => ({ status: 1, stderr: "" }),
      detach: (cmd, args) => {
        const r = spawnSync(cmd, args, { env: GIT_ENV });
        if (r.status !== 0) throw new Error(`the update script ended with ${r.status}`);
      },
    };
    const update = (ref: string) => {
      const plan: UpdatePlan = {
        appDir: app,
        from: o.dir,
        ref,
        service: true,
        ...(g.gui === undefined ? {} : { gui: g.gui }),
        fromVersion: "0.1.0",
        fromCommit: o.c1,
      };
      startUpdate(plan, null, {
        dataDir: data,
        logsDir: join(data, "logs"),
        now: Date.now,
        launcher,
        underSystemd: false,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, ...GIT_ENV },
      });
      return readRun(data, join(data, "logs"), { now: Date.now });
    };
    const calls = () => readFileSync(join(root, "calls.log"), "utf8").trim().split("\n");
    return { o, app, update, calls };
  }

  it("runs the new version's install.sh with what was installed, and says it succeeded", () => {
    const { o, app, update, calls } = installed();
    const run = update("v0.2.0");
    expect(run).toMatchObject({
      state: "succeeded",
      exitCode: 0,
      toVersion: "0.2.0",
      target: "v0.2.0",
    });
    expect(calls()).toEqual([`--ref v0.2.0 --dir ${app} --from ${o.dir}`]);
    expect(git(app, "rev-parse", "HEAD")).toBe(o.c2);
    expect(run?.log.join("\n")).toMatch(
      /Updating Oraknid 0\.1\.0 \(\w+\) to v0\.2\.0[\s\S]*Update: succeeded\./,
    );
  });

  it("goes back to the version before when the new one fails, its record too", () => {
    const { o, app, update, calls } = installed();
    const run = update("v0.3.0");
    expect(run).toMatchObject({ state: "rolled-back", exitCode: 3, toVersion: null });
    expect(calls()).toEqual([
      `--ref v0.3.0 --dir ${app} --from ${o.dir}`,
      `--ref ${o.c1} --dir ${app} --from ${o.dir}`,
    ]);
    expect(git(app, "rev-parse", "HEAD")).toBe(o.c1);
    expect(record(app)).toMatchObject({ ref: "v0.1.0", version: "0.1.0", commit: o.c1 });
  });

  it("changes nothing, and builds nothing again, when it can't get the new version", () => {
    const { app, o, update, calls } = installed();
    const run = update("v9.9.9");
    expect(run).toMatchObject({ state: "failed", exitCode: 4 });
    // This version's own install.sh ran, once.
    expect(calls()).toEqual([`--ref v9.9.9 --dir ${app} --from ${o.dir}`]);
    expect(git(app, "rev-parse", "HEAD")).toBe(o.c1);
    expect(run?.log.join("\n")).toContain("Using this version's install.sh.");
  });

  it("keeps a terminal-only install terminal only, and a GUI one with its GUI (ADR-055)", () => {
    const tonly = installed({ knowsGui: true, gui: false });
    expect(tonly.update("v0.2.0")).toMatchObject({ state: "succeeded" });
    expect(tonly.calls()).toEqual([
      `--ref v0.2.0 --dir ${tonly.app} --from ${tonly.o.dir} --no-gui`,
    ]);
    const gui = installed({ knowsGui: true });
    gui.update("v0.3.0");
    // Going back to the version before keeps the choice too.
    expect(gui.calls()).toEqual([
      `--ref v0.3.0 --dir ${gui.app} --from ${gui.o.dir} --gui`,
      `--ref ${gui.o.c1} --dir ${gui.app} --from ${gui.o.dir} --gui`,
    ]);
  });
});

/** install.sh's functions in a shell, with an environment of the test's own. */
function shLib(script: string, env: Record<string, string>, ...args: string[]) {
  const r = spawnSync(
    "sh",
    ["-c", `ORAKNID_INSTALL_LIB=1 . "$0"; ${script}`, join(ROOT, "install.sh"), ...args],
    // No display, no browser, no terminal: what the test says, nothing of this machine's.
    {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: tmpdir(), ...env },
      encoding: "utf8",
    },
  );
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("install.sh with or without the web UI (ADR-055)", () => {
  const choose = (env: Record<string, string>, dir: string, gui = "") =>
    shLib('DIR="$1"; GUI="$2"; choose_gui; echo "GUI=$GUI"', env, dir, gui).out;

  it("--gui and --no-gui win; then what an earlier install chose; then a display or not", () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-gui-"));
    expect(choose({ DISPLAY: ":0" }, dir, "0")).toContain("GUI=0");
    expect(choose({}, dir, "1")).toContain("GUI=1");
    // Nothing said, no terminal to ask on: a desktop gets the web UI, a server doesn't.
    expect(choose({ DISPLAY: ":0" }, dir)).toMatch(/With the web UI\.\nGUI=1/);
    expect(choose({ WAYLAND_DISPLAY: "wayland-1" }, dir)).toContain("GUI=1");
    expect(choose({ BROWSER: "lynx" }, dir)).toContain("GUI=1");
    expect(choose({}, dir)).toMatch(
      /Terminal only: no web UI \(add it later with: oraknid install --gui\)\.\nGUI=0/,
    );
    // Run again (an update by hand), the choice of the install before stays.
    writeFileSync(join(dir, RECORD_FILE), '{\n  "service": true,\n  "gui": false\n}\n');
    expect(choose({ DISPLAY: ":0" }, dir)).toBe("GUI=0\n");
    writeFileSync(join(dir, RECORD_FILE), '{\n  "service": true,\n  "gui": true\n}\n');
    expect(choose({}, dir)).toBe("GUI=1\n");
  });

  it("records the choice; a record from before it reads as with the web UI", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-install-"));
    const o = origin(root);
    const app = join(root, "app");
    const out = installSh({ dir: app, from: o.dir, ref: "dev", gui: false });
    expect(out).toContain("version 0.3.0, terminal only)");
    expect(record(app).gui).toBe(false);
    expect(readInstall(app)).toMatchObject({ mode: "script", gui: false });
    installSh({ dir: app, from: o.dir, ref: "dev", gui: true });
    expect(record(app).gui).toBe(true);
    installSh({ dir: app, from: o.dir, ref: "dev" });
    expect(record(app).gui).toBe(true);
    expect(InstallRecord.parse({ ...record(app), gui: undefined }).gui).toBe(true);
  });

  it("terminal only, installs and builds everything but apps/web, and removes a web build left from before", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-build-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    // A pnpm that only says how it was called.
    writeFileSync(join(bin, "pnpm"), `#!/bin/sh\necho "$*" >>"${root}/pnpm.log"\n`, {
      mode: 0o755,
    });
    const app = join(root, "app");
    mkdirSync(join(app, "apps", "web", "dist"), { recursive: true });
    mkdirSync(join(app, "apps", "web", "dist-remote"), { recursive: true });
    const env = { PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` };
    const build = (gui: string) => shLib('DIR="$1"; GUI="$2"; build', env, app, gui);
    expect(build("0").status).toBe(0);
    expect(readFileSync(join(root, "pnpm.log"), "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile --filter !@oraknid/web",
      "exec turbo run build --filter !@oraknid/web",
    ]);
    expect(existsSync(join(app, "apps", "web", "dist"))).toBe(false);
    expect(existsSync(join(app, "apps", "web", "dist-remote"))).toBe(false);
    writeFileSync(join(root, "pnpm.log"), "");
    expect(build("1").status).toBe(0);
    expect(readFileSync(join(root, "pnpm.log"), "utf8").trim().split("\n")).toEqual([
      "install --frozen-lockfile",
      "build",
    ]);
  });

  it("lists --gui and --no-gui in its help", () => {
    const r = spawnSync("sh", [join(ROOT, "install.sh"), "--help"], { encoding: "utf8" });
    expect(r.stdout).toContain("--gui | --no-gui");
    expect(r.stdout).toContain("--uninstall");
  });

  it("oraknid install --gui builds the web UI and records it", () => {
    const root = mkdtempSync(join(tmpdir(), "oraknid-addgui-"));
    writeFileSync(
      join(root, RECORD_FILE),
      JSON.stringify({ ref: "main", gui: false, service: true }),
    );
    const ran: string[] = [];
    addWebUi(
      root,
      (cmd, args, o) => {
        ran.push(`${cmd} ${args.join(" ")}`);
        expect(o.cwd).toBe(root);
        expect(o.env.PATH?.startsWith(join(root, ".tools", "bin"))).toBe(true);
        return 0;
      },
      { PATH: "/usr/bin" },
    );
    expect(ran).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm exec turbo run build --filter @oraknid/web",
    ]);
    expect(JSON.parse(readFileSync(join(root, RECORD_FILE), "utf8"))).toMatchObject({
      ref: "main",
      gui: true,
    });
    // A step that fails says which, and the record stays as it was.
    writeFileSync(join(root, RECORD_FILE), JSON.stringify({ gui: false }));
    expect(() => addWebUi(root, () => 1, { PATH: "/usr/bin" })).toThrow(
      "pnpm install --frozen-lockfile failed (exit 1).",
    );
    expect(JSON.parse(readFileSync(join(root, RECORD_FILE), "utf8")).gui).toBe(false);
  });
});

describe("install.sh --local-models (ADR-054)", () => {
  /** install.sh's own function, run in a shell on a release's asset names. */
  const pick = (kind: string, arch: string, names: string[]) =>
    spawnSync(
      "sh",
      [
        "-c",
        'ORAKNID_INSTALL_LIB=1 . "$0"; pick_llama_asset "$1" "$2"',
        join(ROOT, "install.sh"),
        kind,
        arch,
      ],
      { input: `${names.join("\n")}\n`, encoding: "utf8" },
    ).stdout.trim();
  const builds = (gpu: string) =>
    spawnSync(
      "sh",
      ["-c", 'ORAKNID_INSTALL_LIB=1 . "$0"; builds_for "$1"', join(ROOT, "install.sh"), gpu],
      {
        encoding: "utf8",
      },
    ).stdout.trim();
  const release = [
    "llama-b7000-bin-macos-arm64.zip",
    "llama-b7000-bin-ubuntu-x64.zip",
    "llama-b7000-bin-ubuntu-vulkan-x64.zip",
    "llama-b7000-bin-ubuntu-arm64.zip",
    "llama-b7000-bin-win-cuda-12.4-x64.zip",
    "llama-b7000-bin-ubuntu-rocm-6.4-x64.tar.gz",
  ];

  it("picks the Linux build for this computer's GPU and architecture", () => {
    expect(pick("vulkan", "x64", release)).toBe("llama-b7000-bin-ubuntu-vulkan-x64.zip");
    expect(pick("rocm", "x64", release)).toBe("llama-b7000-bin-ubuntu-rocm-6.4-x64.tar.gz");
    expect(pick("cpu", "x64", release)).toBe("llama-b7000-bin-ubuntu-x64.zip");
    expect(pick("cpu", "arm64", release)).toBe("llama-b7000-bin-ubuntu-arm64.zip");
    // No Linux CUDA build in this release: Vulkan is tried next.
    expect(pick("cuda", "x64", release)).toBe("");
    expect(builds("cuda")).toBe("cuda vulkan cpu");
    expect(builds("cpu")).toBe("cpu");
  });
});
