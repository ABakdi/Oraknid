import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Event, NewEvent } from "@oraknid/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { resolvePaths } from "../paths.ts";
import { fakeApp, fakeGitHub, fakeLauncher, release } from "../testing/fake-updates.ts";
import { compareVersions, isNewer, parseVersion } from "./semver.ts";
import { type Asker, Updates, type UpdatesOptions } from "./service.ts";

// Updates from inside Oraknid (ADR-048): which releases count, how a check
// behaves without GitHub, and how Update now starts.

const HOME: Asker = { remote: false, full: true };
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) closeDatabase(db);
});

async function setup(
  record: Parameters<typeof fakeApp>[0],
  o: Partial<UpdatesOptions> & { dbFile?: string } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), "oraknid-updates-"));
  const paths = resolvePaths({ ORAKNID_DATA_DIR: dataDir, ORAKNID_CONFIG_DIR: dataDir });
  const db = await openDatabase({ file: o.dbFile ?? ":memory:", backupsDir: paths.backups });
  dbs.push(db);
  const gh = fakeGitHub();
  const launcher = fakeLauncher();
  const events: NewEvent[] = [];
  let t = Date.parse("2026-10-04T12:00:00Z");
  const updates = new Updates({
    db,
    bus: { publish: (e) => events.push(e) },
    paths,
    now: () => t,
    runningJobs: () => 0,
    version: "0.1.0",
    appDir: fakeApp(record),
    fetch: gh.fetch,
    launcher,
    underSystemd: false,
    env: { PATH: "/usr/bin:/bin", HOME: "/home/me" },
    ...o,
  });
  return {
    updates,
    gh,
    launcher,
    events,
    paths,
    db,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const LIST = [
  release("v0.3.0-rc.1", { prerelease: true }),
  release("v0.2.5", { draft: true }),
  release("v0.2.0"),
  release("v0.1.0", { prerelease: true }),
  release("nightly"),
];

describe("versions (ADR-047)", () => {
  it("orders releases and pre-releases as semver does", () => {
    const order = [
      "0.1.0",
      "0.2.0-alpha",
      "0.2.0-alpha.1",
      "0.2.0-alpha.beta",
      "0.2.0-beta.2",
      "0.2.0-beta.11",
      "0.2.0-rc.1",
      "0.2.0",
      "0.10.0",
      "1.0.0",
    ];
    for (let i = 1; i < order.length; i++) {
      const a = parseVersion(order[i - 1] as string);
      const b = parseVersion(order[i] as string);
      expect(a && b && compareVersions(a, b), `${order[i - 1]} < ${order[i]}`).toBeLessThan(0);
    }
    expect(isNewer("v0.2.0", "0.1.0")).toBe(true);
    expect(isNewer("v0.1.0", "0.1.0")).toBe(false);
    expect(isNewer("v0.1.0+build.5", "0.1.0")).toBe(false);
    expect(isNewer("nightly", "0.1.0")).toBe(false);
  });
});

describe("the updates service (ADR-048)", () => {
  it("on the stable channel, counts only releases: no draft, no pre-release", async () => {
    const { updates, gh } = await setup({ ref: "main", channel: "stable" });
    gh.releases = LIST;
    await updates.check();
    const v = updates.view(HOME);
    expect(v.install).toMatchObject({ mode: "script", channel: "stable", ref: "main" });
    expect(v.newer.map((r) => r.tag)).toEqual(["v0.2.0"]);
    expect(v.newer[0]).toMatchObject({ notes: "What is new in v0.2.0.", prerelease: false });
    expect(v).toMatchObject({ available: true, target: "v0.2.0", canUpdate: true, error: null });
    expect(v.devAhead).toBeNull();
    // A stable install doesn't ask about dev.
    expect(gh.calls.some((c) => c.url.includes("/compare/"))).toBe(false);
  });

  it("on the dev channel, counts pre-releases too, and new work on dev past the installed commit", async () => {
    const commit = "c".repeat(40);
    const { updates, gh } = await setup({ ref: "dev", channel: "dev", commit });
    gh.releases = LIST;
    gh.ahead = 3;
    await updates.check();
    const v = updates.view(HOME);
    expect(v.newer.map((r) => r.tag)).toEqual(["v0.3.0-rc.1", "v0.2.0"]);
    expect(v.devAhead).toMatchObject({ count: 3 });
    expect(v.devAhead?.commits[0]?.message).toBe("Work 3");
    expect(v.target).toBe("dev");
    expect(gh.calls.find((c) => c.url.includes("/compare/"))?.url).toContain(
      `/repos/ABakdi/Oraknid/compare/${commit}...dev`,
    );
  });

  it("is up to date on dev with no new release and no new commit", async () => {
    const { updates, gh } = await setup({ ref: "dev", channel: "dev" });
    gh.releases = [release("v0.1.0", { prerelease: true })];
    await updates.check();
    const v = updates.view(HOME);
    expect(v).toMatchObject({ available: false, target: null, canUpdate: false });
    expect(v.devAhead?.count).toBe(0);
    expect(v.whyNot).toBe("Oraknid is up to date.");
  });

  it("from a clone: says to update with git, no Update now, no checks on its own", async () => {
    const { updates, gh } = await setup(null, { firstCheckMs: 1 });
    updates.start();
    await new Promise((r) => setTimeout(r, 30));
    updates.stop();
    expect(gh.calls).toEqual([]);
    const v = updates.view(HOME);
    expect(v.install.mode).toBe("clone");
    expect(v.canUpdate).toBe(false);
    expect(v.whyNot).toMatch(/runs from a clone at .*oraknid-app-.*: update it with git/);
    // Check now still says what is out.
    gh.releases = LIST;
    await updates.check();
    expect(updates.view(HOME).newer.map((r) => r.tag)).toEqual(["v0.3.0-rc.1", "v0.2.0"]);
    await expect(updates.run(HOME, { confirm: true })).rejects.toThrow(/clone/);
  });

  it("installed by an install.sh from before the record: says to run it once more", async () => {
    const appDir = fakeApp(null);
    mkdirSync(join(appDir, ".git", "info"), { recursive: true });
    writeFileSync(join(appDir, ".git", "info", "exclude"), "/.tools/\n");
    const { updates } = await setup(null, { appDir });
    const v = updates.view(HOME);
    expect(v.install).toMatchObject({ mode: "clone", unrecorded: true });
    expect(v.canUpdate).toBe(false);
    expect(v.whyNot).toMatch(/didn't record what it installed: run it once more/);
  });

  it("checks on its own when installed by the script", async () => {
    const { updates, gh } = await setup({}, { firstCheckMs: 1 });
    gh.releases = LIST;
    updates.start();
    await new Promise((r) => setTimeout(r, 50));
    updates.stop();
    expect(gh.calls.length).toBe(1);
    expect(updates.view(HOME).checkedAt).not.toBeNull();
  });

  it("asks again with the ETag: an unchanged list is a 304 and keeps what it had", async () => {
    const { updates, gh, advance } = await setup({});
    gh.releases = LIST;
    await updates.check();
    advance(60_000);
    await updates.check();
    expect(gh.calls.map((c) => c.ifNoneMatch)).toEqual([undefined, '"r1"']);
    const v = updates.view(HOME);
    expect(v.newer.map((r) => r.tag)).toEqual(["v0.2.0"]);
    expect(v.checkedAt).toBe(Date.parse("2026-10-04T12:01:00Z"));
    // A new release changes the ETag.
    gh.releases = [release("v0.4.0"), ...LIST];
    gh.etag = '"r2"';
    await updates.check();
    expect(updates.view(HOME).target).toBe("v0.4.0");
  });

  it("offline or rate-limited, says why in words and keeps the last answer; never throws", async () => {
    const { updates, gh } = await setup({});
    gh.releases = LIST;
    await updates.check();
    gh.offline = true;
    await expect(updates.check()).resolves.toBeUndefined();
    let v = updates.view(HOME);
    expect(v.error).toMatch(/couldn't be reached \(offline\?\)/);
    expect(v.target).toBe("v0.2.0");
    gh.offline = false;
    gh.limited = true;
    await updates.check();
    v = updates.view(HOME);
    expect(v.error).toMatch(/limit for checks without an account/);
    gh.limited = false;
    await updates.check();
    expect(updates.view(HOME).error).toBeNull();
  });

  it("tells about a new version once, not at every check", async () => {
    const { updates, gh, events } = await setup({});
    gh.releases = LIST;
    await updates.check();
    gh.etag = '"r2"';
    await updates.check();
    const told = () => events.filter((e) => e.type === "update.available");
    expect(told().map((e) => (e.payload as { tag: string }).tag)).toEqual(["v0.2.0"]);
    gh.releases = [release("v0.3.0"), ...LIST];
    gh.etag = '"r3"';
    await updates.check();
    expect(told().map((e) => (e.payload as { tag: string }).tag)).toEqual(["v0.2.0", "v0.3.0"]);
    expect((told()[1] as Event | NewEvent).topic).toBe("overview");
  });

  it("away from home, only a device with full rights may update (ADR-030)", async () => {
    const { updates, gh } = await setup({});
    gh.releases = LIST;
    await updates.check();
    const away = { remote: true, full: false };
    expect(updates.view(away)).toMatchObject({ canUpdate: false });
    expect(updates.view(away).whyNot).toMatch(/full rights/);
    await expect(updates.run(away, { confirm: true })).rejects.toThrow(/full rights/);
    expect(updates.view({ remote: true, full: true }).canUpdate).toBe(true);
  });
});

describe("Update now (ADR-048)", () => {
  it("refuses while jobs run unless I confirm, saying how many", async () => {
    const { updates, gh, launcher } = await setup({}, { runningJobs: () => 2 });
    gh.releases = LIST;
    await updates.check();
    expect(updates.view(HOME).runningJobs).toBe(2);
    await expect(updates.run(HOME, { confirm: false })).rejects.toThrow(
      /2 jobs are running\. They pause at a safe point/,
    );
    expect(launcher.detached).toEqual([]);
    await updates.run(HOME, { confirm: true });
    expect(launcher.detached.length).toBe(1);
  });

  it("stable: installs the release's tag, detached, with what was installed", async () => {
    const { updates, gh, launcher, paths, events } = await setup({
      ref: "main",
      from: "/home/me/src/oraknid",
    });
    gh.releases = LIST;
    await updates.check();
    const run = await updates.run(HOME, { confirm: false });
    expect(run).toMatchObject({ state: "running", target: "v0.2.0", fromVersion: "0.1.0" });
    expect(launcher.runs).toEqual([]);
    const script = join(paths.dataDir, "updates", "run-update.sh");
    expect(launcher.detached).toEqual([["/bin/sh", script]]);
    const text = readFileSync(script, "utf8");
    expect(text).toContain("REF='v0.2.0'");
    expect(text).toContain("FROM='/home/me/src/oraknid'");
    expect(text).toContain("NO_SERVICE=''");
    expect(text).toContain(`PREV='${"1".repeat(40)}'`);
    expect(text).toContain("export ORAKNID_UPDATE=1");
    expect(text).toContain("export PATH='/usr/bin:/bin'");
    expect(events.map((e) => e.type)).toContain("update.started");
    // One at a time.
    expect(updates.view(HOME)).toMatchObject({ canUpdate: false, whyNot: "An update is running." });
    await expect(updates.run(HOME, { confirm: true })).rejects.toThrow(/An update is running/);
  });

  it("dev: installs dev; without the service, Oraknid is started again by hand", async () => {
    const { updates, gh, launcher, paths } = await setup({
      ref: "dev",
      channel: "dev",
      service: false,
    });
    gh.ahead = 1;
    await updates.check();
    await updates.run(HOME, { confirm: false });
    const text = readFileSync(join(paths.dataDir, "updates", "run-update.sh"), "utf8");
    expect(text).toContain("REF='dev'");
    expect(text).toContain("NO_SERVICE=--no-service");
    expect(launcher.detached.length).toBe(1);
  });

  it("under systemd, runs as its own transient unit, so the service's restart doesn't end it", async () => {
    const { updates, gh, launcher, paths } = await setup({}, { underSystemd: true });
    gh.releases = LIST;
    await updates.check();
    await updates.run(HOME, { confirm: false });
    expect(launcher.detached).toEqual([]);
    expect(launcher.runs[0]?.slice(0, 2)).toEqual(["systemd-run", "--user"]);
    expect(launcher.runs[0]).toContain("--collect");
    expect(launcher.runs[0]?.slice(-2)).toEqual([
      "/bin/sh",
      join(paths.dataDir, "updates", "run-update.sh"),
    ]);
  });

  it("says so when systemd-run can't start it, and leaves no update running", async () => {
    const { updates, gh } = await setup({}, { underSystemd: true, launcher: fakeLauncher(1) });
    gh.releases = LIST;
    await updates.check();
    await expect(updates.run(HOME, { confirm: false })).rejects.toThrow(
      /couldn't be started outside the service \(systemd-run: Failed to connect to bus\)/,
    );
    expect(updates.view(HOME).run).toBeNull();
  });

  it("copies the database first, keeping the last three copies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-updates-db-"));
    const { updates, gh, paths, advance, db } = await setup({}, { dbFile: join(dir, "o.db") });
    db.$client.exec("create table mine (x text); insert into mine values ('kept')");
    gh.releases = LIST;
    await updates.check();
    for (let i = 0; i < 4; i++) {
      const run = await updates.run(HOME, { confirm: false });
      expect(run.backup).toMatch(/pre-update-.*-v0\.1\.0\.db$/);
      expect(existsSync(run.backup ?? "")).toBe(true);
      // The run ends (the script writes its result), and the next may start.
      writeFileSync(join(paths.dataDir, "updates", "result"), "failed 1 1791115230\n");
      advance(60_000);
    }
    const kept = readdirSync(paths.backups).filter((f) => f.startsWith("pre-update-"));
    expect(kept.length).toBe(3);
    expect(kept.every((f) => f.endsWith(".db"))).toBe(true);
    // The copy is the database.
    const Database = (await import("better-sqlite3")).default;
    const copy = new Database(join(paths.backups, kept.sort().at(-1) as string), {
      readonly: true,
    });
    expect(copy.prepare("select x from mine").get()).toEqual({ x: "kept" });
    copy.close();
  });

  it("follows the run from its result and its pid; says once how it ended", async () => {
    const { updates, gh, paths, events, advance } = await setup({});
    gh.releases = LIST;
    await updates.check();
    await updates.run(HOME, { confirm: false });
    const u = join(paths.dataDir, "updates");
    writeFileSync(join(paths.logs, "update.log"), "", { flag: "a" });
    writeFileSync(
      join(paths.logs, "update.log"),
      "12:00 Updating Oraknid\n12:03 Update: succeeded.\n",
      {
        flag: "a",
      },
    );
    // Its process is there: running.
    writeFileSync(join(u, "pid"), String(process.pid));
    expect(updates.view(HOME).run?.state).toBe("running");
    // Gone without a result: interrupted.
    writeFileSync(join(u, "pid"), "999999999");
    expect(updates.view(HOME).run?.state).toBe("interrupted");
    writeFileSync(join(u, "result"), "succeeded 0 1791115230\n");
    const run = updates.view(HOME).run;
    expect(run).toMatchObject({ state: "succeeded", exitCode: 0, finishedAt: 1_791_115_230_000 });
    expect(run?.log).toEqual(["12:00 Updating Oraknid", "12:03 Update: succeeded."]);
    // After the restart, the new daemon says it once.
    advance(1000);
    updates.start();
    updates.start();
    updates.stop();
    const ended = events.filter((e) => e.type === "update.finished");
    expect(ended.length).toBe(1);
    expect((ended[0]?.payload as { message?: string } | undefined)?.message).toMatch(
      /^Updated to /,
    );
    // A day later it is old news.
    advance(25 * 3600_000);
    expect(updates.view(HOME).run).toBeNull();
  });
});
