import { existsSync } from "node:fs";
import type { InstallInfo, NewEvent, UpdateRun, UpdatesView } from "@oraknid/contracts";
import Database from "better-sqlite3";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { Paths } from "../paths.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { VERSION } from "../version.ts";
import {
  CheckError,
  EMPTY_CACHE,
  type FeedCache,
  type Fetch,
  newerReleases,
  ReleaseFeed,
} from "./github.ts";
import { findAppDir, readInstall } from "./install.ts";
import {
  backupBeforeUpdate,
  type Launcher,
  markAnnounced,
  readRun,
  runsUnderSystemd,
  startUpdate,
} from "./runner.ts";

// Updates from inside Oraknid (docs/04-Decisions/ADR-048-Updates.md).

export const UPDATES_STATE = "updates.state";
const State = z.object({
  checkedAt: z.number().nullable(),
  error: z.string().nullable(),
  cache: z.custom<FeedCache>((v) => typeof v === "object" && v !== null),
  /** The versions already told about (a notification each), the newest last. */
  notified: z.array(z.string()),
});
type State = z.infer<typeof State>;
const DAY = 24 * 3600_000;
const FRESH: State = { checkedAt: null, error: null, cache: EMPTY_CACHE, notified: [] };

export interface UpdatesOptions {
  /** Where the last check is kept (the settings table); null: in memory, the CLI without the daemon. */
  db: Db | null;
  bus: { publish(event: NewEvent): unknown };
  paths: Paths;
  now: () => number;
  /** How many jobs are active (they pause for the restart). */
  runningJobs: () => number;
  /** The version running (tests). */
  version?: string;
  /** The repository's folder this program runs from; found from this module otherwise. */
  appDir?: string | null;
  fetch?: Fetch;
  /** GitHub's API (tests: a stand-in). */
  api?: string;
  launcher?: Launcher;
  underSystemd?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Between automatic checks: 6 hours. */
  checkEveryMs?: number;
  /** The first automatic check after start: a minute. */
  firstCheckMs?: number;
}

/** Who asks: the CLI and a device at home may update; away from home, a device with full rights (ADR-030). */
export interface Asker {
  remote: boolean;
  full: boolean;
}

export class Updates {
  readonly version: string;
  readonly #appDir: string | null;
  readonly #feed: ReleaseFeed;
  #checking: Promise<void> | undefined;
  #memory: State = FRESH;
  #timers: NodeJS.Timeout[] = [];

  constructor(private readonly o: UpdatesOptions) {
    this.version = o.version ?? VERSION;
    this.#appDir = o.appDir === undefined ? findAppDir() : o.appDir;
    this.#feed = new ReleaseFeed({
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.api ? { api: o.api } : {}),
      userAgent: `oraknid/${this.version}`,
    });
  }

  /** How this Oraknid was installed: read each time (install.sh may have just written it). */
  install(): InstallInfo {
    if (!this.#appDir) return { mode: "clone", appDir: process.cwd() };
    return readInstall(this.#appDir);
  }

  #state(): State {
    return this.o.db ? readSetting(this.o.db, UPDATES_STATE, State, FRESH) : this.#memory;
  }

  #save(s: State) {
    if (this.o.db) writeSetting(this.o.db, UPDATES_STATE, State, s, this.o.now());
    else this.#memory = s;
  }

  /**
   * Checks on their own: a minute after start, then every six hours; only
   * for an install made by the script (a clone, the tests and a developer's
   * `pnpm dev` stay off the network until asked). Says once how the last
   * update ended.
   */
  start() {
    this.#announceRun();
    if (this.install().mode !== "script") return;
    const check = () => void this.check().catch((e) => console.error("update check failed", e));
    const first = setTimeout(check, this.o.firstCheckMs ?? 60_000);
    const every = setInterval(check, this.o.checkEveryMs ?? 6 * 3600_000);
    first.unref();
    every.unref();
    this.#timers.push(first, every);
  }

  stop() {
    for (const t of this.#timers) clearTimeout(t);
    this.#timers = [];
  }

  /**
   * Asks GitHub for the releases (and, on the dev channel, how far dev is
   * past the installed commit); an unchanged answer costs nothing. Never
   * throws for GitHub: why it failed is kept, with the last answer.
   */
  check(): Promise<void> {
    this.#checking ??= this.#check().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  async #check() {
    const s = this.#state();
    const install = this.install();
    try {
      const releases = await this.#feed.releases(s.cache.releases);
      let compare = s.cache.compare;
      if (install.mode === "script" && install.channel === "dev" && install.commit)
        compare = await this.#feed.ahead(install.commit, "dev", compare);
      const next: State = {
        ...s,
        checkedAt: this.o.now(),
        error: null,
        cache: { releases, compare },
      };
      this.#save(this.#announce(next));
    } catch (error) {
      const message =
        error instanceof CheckError
          ? error.message
          : "The check went wrong; the details are in Oraknid's log.";
      if (!(error instanceof CheckError)) console.error("update check failed", error);
      this.#save({ ...s, error: message });
    }
  }

  /** A notification once per new version, on the install the script made. */
  #announce(s: State): State {
    if (this.install().mode !== "script") return s;
    const newest = this.#newer(s)[0];
    if (!newest || s.notified.includes(newest.tag)) return s;
    this.o.bus.publish({
      type: "update.available",
      topic: "overview",
      jobId: null,
      payload: {
        tag: newest.tag,
        version: newest.version,
        name: newest.name,
        url: newest.url,
        message: `Oraknid ${newest.tag} is out. Update from Settings → About & updates.`,
      },
      actor: "oraknid",
    });
    return { ...s, notified: [...s.notified, newest.tag].slice(-20) };
  }

  #channel() {
    const i = this.install();
    // A clone is on the newest work: every release counts.
    return i.mode === "script" ? i.channel : "dev";
  }

  #newer(s: State) {
    return newerReleases(s.cache.releases?.list ?? [], this.version, this.#channel());
  }

  lastRun(): UpdateRun | null {
    return readRun(this.o.paths.dataDir, this.o.paths.logs, { now: this.o.now });
  }

  view(who: Asker): UpdatesView {
    const s = this.#state();
    const install = this.install();
    const newer = this.#newer(s).map(({ draft: _, ...r }) => r);
    const compare = s.cache.compare;
    const devAhead =
      install.mode === "script" &&
      install.channel === "dev" &&
      compare &&
      compare.base === install.commit
        ? compare.ahead
        : null;
    const available = newer.length > 0 || (devAhead?.count ?? 0) > 0;
    const target =
      install.mode !== "script" || !available
        ? null
        : install.channel === "dev"
          ? "dev"
          : (newer[0]?.tag ?? null);
    const last = this.lastRun();
    // An update that ended more than a day ago is old news.
    const run =
      last && last.state !== "running" && (last.finishedAt ?? last.startedAt) < this.o.now() - DAY
        ? null
        : last;
    const whyNot =
      install.mode !== "script"
        ? install.unrecorded
          ? `The install.sh that installed Oraknid in ${install.appDir} didn't record what it installed: run it once more (with --dev for dev) and Oraknid updates itself from then on.`
          : `Oraknid runs from a clone at ${install.appDir}: update it with git (git pull, pnpm install, pnpm build).`
        : who.remote && !who.full
          ? "Updating away from home needs a device with full rights."
          : run?.state === "running"
            ? "An update is running."
            : !target
              ? "Oraknid is up to date."
              : null;
    return {
      version: this.version,
      install,
      checkedAt: s.checkedAt,
      error: s.error,
      newer,
      devAhead,
      available,
      target,
      runningJobs: this.o.runningJobs(),
      canUpdate: whyNot === null,
      whyNot,
      run,
    };
  }

  /**
   * Update now: refused from a clone, away from home without full rights,
   * with nothing to update to, while one runs, and while jobs run unless I
   * confirm. The database is copied first; then install.sh runs apart from
   * the daemon. Data is never touched: the script replaces the program only.
   */
  async run(who: Asker, input: { confirm: boolean }): Promise<UpdateRun> {
    const v = this.view(who);
    const install = v.install;
    if (install.mode !== "script" || !v.canUpdate || !v.target)
      throw new Error(v.whyNot ?? "There is nothing to update to.");
    if (v.runningJobs > 0 && !input.confirm)
      throw new Error(
        `${v.runningJobs} job${v.runningJobs === 1 ? " is" : "s are"} running. They pause at a safe point while Oraknid restarts and go on after it; confirm to update now.`,
      );
    const backup = await this.#backup();
    startUpdate(
      {
        appDir: install.appDir,
        from: install.from,
        ref: v.target,
        service: install.service,
        gui: install.gui,
        fromVersion: this.version,
        fromCommit: install.commit,
      },
      backup,
      {
        dataDir: this.o.paths.dataDir,
        logsDir: this.o.paths.logs,
        now: this.o.now,
        ...(this.o.launcher ? { launcher: this.o.launcher } : {}),
        underSystemd: this.o.underSystemd ?? runsUnderSystemd(this.o.env),
        env: this.o.env ?? process.env,
      },
    );
    this.o.bus.publish({
      type: "update.started",
      topic: "overview",
      jobId: null,
      payload: {
        from: this.version,
        target: v.target,
        backup,
        message: `Updating Oraknid ${this.version} to ${v.target}; it restarts on its own.`,
      },
      actor: "owner",
    });
    const run = this.lastRun();
    if (!run) throw new Error("The update didn't start.");
    return run;
  }

  /** The database copied first: the daemon's, open; without the daemon, its file. */
  async #backup(): Promise<string | null> {
    const { db, paths, now } = this.o;
    if (db) return backupBeforeUpdate(db.$client, paths.backups, this.version, now());
    if (!existsSync(paths.db)) return null;
    const client = new Database(paths.db, { readonly: true, fileMustExist: true });
    try {
      return await backupBeforeUpdate(client, paths.backups, this.version, now());
    } finally {
      client.close();
    }
  }

  /** How the last update ended, told once, after the restart it caused. */
  #announceEnd(run: UpdateRun) {
    const message =
      run.state === "succeeded"
        ? `Updated to ${run.toVersion ? `v${run.toVersion}` : run.target}.`
        : run.state === "rolled-back"
          ? `The update to ${run.target} failed; Oraknid went back to v${run.fromVersion}. Its log: Settings → About & updates.`
          : `The update to ${run.target} failed. Its log: Settings → About & updates.`;
    this.o.bus.publish({
      type: "update.finished",
      topic: "overview",
      jobId: null,
      payload: { state: run.state, from: run.fromVersion, to: run.toVersion, message },
      actor: "oraknid",
    });
  }

  #announceRun() {
    const run = this.lastRun();
    if (!run || run.state === "running") return;
    if (markAnnounced(this.o.paths.dataDir)) this.#announceEnd(run);
  }
}
