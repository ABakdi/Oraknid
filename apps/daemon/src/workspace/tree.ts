import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectRepo } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { type JobRepo, jobs } from "../db/schema.ts";
import {
  addTaskWorktree,
  changedSince,
  checkpoint,
  commitAll,
  commitStaged,
  createWorktree,
  diffSince,
  diffStatSince,
  type Git,
  git,
  hasRef,
  removeTaskWorktree,
  restorePaths,
  rollback,
  stageAll,
  worktreeGit,
} from "./git.ts";
import { inRepo, repoOfPath, reposOfScope } from "./repos.ts";

// Where a job works (Sandboxing → Worktrees, ADR-042): one git work tree
// (the job's worktree of a project of one repo, or a folder kept by a
// shadow repo), or, for a project of several repos, the job's folder with
// each repo it touches as a worktree at that repo's folder.

/** A task's work committed in one repo: null names the only one. */
export interface TreeCommit {
  repo: string | null;
  folder: string;
  sha: string;
}

export interface WorkTree {
  /** Where Legs work and checks run. */
  cwd: string;
  /** Several repos (ADR-042). */
  several: boolean;
  /** Before a task's attempt: the repos its scope names, made ready. */
  prepare(scope: string[]): void;
  /** Records the work on a private ref; `onlyMissing` leaves a ref already there as it is. */
  checkpoint(ref: string, message: string, onlyMissing?: boolean): Promise<void>;
  hasRef(ref: string): boolean;
  changedSince(ref: string): Promise<string[]>;
  diffStatSince(ref: string): Promise<string>;
  diffSince(ref: string): Promise<string>;
  rollback(ref: string, trash: string): Promise<{ restored: string[]; trashed: string[] }>;
  restorePaths(ref: string, paths: string[], trash: string): void;
  /** The work as commits, one per repo that changed, each with its own message. */
  commit(message: (repo: string | null, several: boolean) => string): Promise<TreeCommit[]>;
  /** A local branch's commit, in the named repo (the only one when left out). */
  localCommit(branch: string, repo?: string | null): string | null;
  /** The plain git handle of a single work tree; null for several repos. */
  single: Git | null;
}

/** One work tree: what every job had before ADR-042. */
export function singleTree(g: Git, tmpDir: string): WorkTree {
  return {
    cwd: g.cwd,
    several: false,
    single: g,
    prepare: () => {},
    checkpoint: async (ref, message, onlyMissing) => {
      if (onlyMissing && hasRef(g, ref)) return;
      await checkpoint(g, ref, message, tmpDir);
    },
    hasRef: (ref) => hasRef(g, ref),
    changedSince: (ref) => changedSince(g, ref, tmpDir),
    diffStatSince: (ref) => diffStatSince(g, ref, tmpDir),
    diffSince: (ref) => diffSince(g, ref, tmpDir),
    rollback: (ref, trash) => rollback(g, ref, tmpDir, trash),
    restorePaths: (ref, paths, trash) => restorePaths(g, ref, paths, trash),
    commit: async (message) => {
      const sha = await commitAll(g, message(null, false));
      return sha ? [{ repo: null, folder: "", sha }] : [];
    },
    localCommit: (branch) => {
      try {
        return git(g, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * The job's tree in a project of several repos, as recorded on it: the
 * repos it opened come back as they were (ADR-042).
 */
export function multiTreeOf(
  db: Db,
  job: { id: string; branch: string | null; worktree: string | null; repos: JobRepo[] },
  project: { workspacePath: string; repos: ProjectRepo[] },
  tmpDir: string,
  from?: string | null,
): MultiTree {
  // The branch is `oraknid/<slug>-<the job id's end>` (createWorktree): its slug, back.
  const end = `-${job.id.slice(-6).toLowerCase()}`;
  const branch = job.branch ?? `oraknid/job${end}`;
  const slug = branch.replace(/^oraknid\//, "").slice(0, -end.length);
  return new MultiTree({
    projectPath: project.workspacePath,
    jobId: job.id,
    slug,
    root: job.worktree ?? join(project.workspacePath, ".oraknid", "worktrees", job.id),
    repos: project.repos,
    tmpDir,
    from: from ?? null,
    opened: job.repos,
    save: (opened) => db.update(jobs).set({ repos: opened }).where(eq(jobs.id, job.id)).run(),
  });
}

/** Where a repo's worktree starts: what "before" means for a repo opened after a checkpoint. */
export const startRef = (jobId: string) => `refs/oraknid/${jobId}/start`;

interface Open {
  repo: ProjectRepo;
  path: string;
  g: Git;
}

/**
 * A job in a project of several repos (ADR-042). Its folder mirrors the
 * project's: each repo it touches is a worktree on the job branch at that
 * repo's folder, made when a task's scope names it or when a Leg writes in
 * its folder, so paths, scopes and checks read as in the project. When the
 * project's folder is itself one of the repos, the job's folder is that
 * repo's worktree and the others sit inside it, left out of its commits.
 */
export class MultiTree implements WorkTree {
  readonly several = true;
  readonly single = null;
  readonly #open = new Map<string, Open>();

  constructor(
    private readonly o: {
      projectPath: string;
      jobId: string;
      /** The job branch's name, the same in every repo. */
      slug: string;
      /** The job's folder. */
      root: string;
      repos: ProjectRepo[];
      tmpDir: string;
      /** A branch to start from where it exists (a follow-up job). */
      from?: string | null;
      /** The repos opened so far, as recorded on the job. */
      opened: JobRepo[];
      save: (opened: JobRepo[]) => void;
      /** What "where its worktree started" is named by; the job's id by default. */
      startId?: string;
      /**
       * A task's own tree beside others (ADR-016 across several repos): each
       * repo a worktree on the task's branch, made from the job branch's tip
       * in that repo (`base` opens the repo in the job's tree first). `fresh`
       * names refs measured on an earlier tree, dropped when one is made.
       */
      task?: { branch: string; base: (r: ProjectRepo) => string; fresh: string[] };
    },
  ) {
    const top = o.repos.find((r) => r.folder === "");
    if (top) this.#ensure(top);
    else mkdirSync(o.root, { recursive: true });
    for (const j of o.opened) {
      const r = o.repos.find((x) => x.name === j.name);
      if (r) this.#ensure(r);
    }
  }

  get cwd() {
    return this.o.root;
  }

  /** The repos open now, in the project's order. */
  opened(): { repo: ProjectRepo; path: string }[] {
    return this.o.repos
      .map((r) => this.#open.get(r.name))
      .filter((x): x is Open => !!x)
      .map(({ repo, path }) => ({ repo, path }));
  }

  #repoPath(r: ProjectRepo) {
    return r.folder ? join(this.o.projectPath, r.folder) : this.o.projectPath;
  }

  #ensure(r: ProjectRepo): Open {
    const known = this.#open.get(r.name);
    if (known) return known;
    const path = r.folder ? join(this.o.root, r.folder) : this.o.root;
    const repoPath = this.#repoPath(r);
    let g: Git | null = null;
    try {
      g = worktreeGit(repoPath, path);
    } catch {}
    if (!g) {
      // What a Leg wrote in the repo's folder before it was a worktree is set aside, then put back in it.
      let aside: string | null = null;
      if (r.folder && existsSync(path)) {
        aside = join(this.o.root, ".oraknid", "aside", `${r.name}-${Date.now()}`);
        mkdirSync(dirname(aside), { recursive: true });
        renameSync(path, aside);
      }
      mkdirSync(dirname(path), { recursive: true });
      if (this.o.task) {
        addTaskWorktree(repoPath, path, this.o.task.branch, this.o.task.base(r));
        g = worktreeGit(repoPath, path);
        // A fresh tree from the job's tip: what was measured on an earlier one is gone.
        for (const ref of [startRef(this.#startId), ...this.o.task.fresh])
          if (hasRef(g, ref)) git(g, ["update-ref", "-d", ref]);
      } else {
        createWorktree(
          repoPath,
          this.o.jobId,
          this.o.slug,
          { release: r.releaseBranch, work: r.workBranch },
          this.o.from ?? null,
          path,
        );
        g = worktreeGit(repoPath, path);
      }
      if (aside) {
        cpSync(aside, path, { recursive: true, force: true });
        rmSync(aside, { recursive: true, force: true });
      }
    }
    const start = startRef(this.#startId);
    if (!hasRef(g, start)) git(g, ["update-ref", start, "HEAD"]);
    const open = { repo: r, path, g };
    this.#open.set(r.name, open);
    const opened = this.opened().map((x) => ({
      name: x.repo.name,
      folder: x.repo.folder,
      worktree: x.path,
    }));
    if (
      opened.length !== this.o.opened.length ||
      opened.some((x, i) => x.name !== this.o.opened[i]?.name)
    ) {
      this.o.opened = opened;
      this.o.save(opened);
    }
    return open;
  }

  /** The repo's git handle; the project's own folder's leaves the other repos' folders out. */
  #g(o: Open): Git {
    if (o.repo.folder !== "") return o.g;
    return { ...o.g, exclude: this.o.repos.filter((r) => r.folder).map((r) => r.folder) };
  }

  /** A repo's folder a Leg wrote in before it was opened becomes its worktree (ADR-042). */
  #adopt() {
    for (const r of this.o.repos)
      if (r.folder && !this.#open.has(r.name) && existsSync(join(this.o.root, r.folder)))
        this.#ensure(r);
  }

  get #startId() {
    return this.o.startId ?? this.o.jobId;
  }

  #ref(o: Open, ref: string) {
    return hasRef(o.g, ref) ? ref : startRef(this.#startId);
  }

  /** A repo of the project opened in this tree (made a worktree if it isn't), and where it lives. */
  open(name: string): { repo: ProjectRepo; repoPath: string; g: Git } {
    const r = this.o.repos.find((x) => x.name === name);
    if (!r) throw new Error(`This project has no repo named ${name}.`);
    const o = this.#ensure(r);
    return { repo: r, repoPath: this.#repoPath(r), g: this.#g(o) };
  }

  /** Every repo open now, the ones a Leg wrote in included. */
  all(): { repo: ProjectRepo; repoPath: string; g: Git }[] {
    return this.#each().map((o) => ({
      repo: o.repo,
      repoPath: this.#repoPath(o.repo),
      g: this.#g(o),
    }));
  }

  /** A task's tree, once merged or to be made again: each worktree and its branch go, then its folder. */
  remove() {
    const open = this.#each().sort((a, b) => b.repo.folder.length - a.repo.folder.length);
    for (const o of open)
      removeTaskWorktree(this.#repoPath(o.repo), o.path, this.o.task?.branch ?? "");
    this.#open.clear();
    rmSync(this.o.root, { recursive: true, force: true });
  }

  #each() {
    this.#adopt();
    return [...this.#open.values()];
  }

  /** Files in the job's folder outside every repo (no repo is the folder itself). */
  #strays(): string[] {
    if (this.o.repos.some((r) => r.folder === "")) return [];
    const out: string[] = [];
    const folders = this.o.repos.map((r) => r.folder);
    const walk = (rel: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(join(this.o.root, rel));
      } catch {
        return;
      }
      for (const name of entries.sort()) {
        if (out.length >= 2000) return;
        const p = rel ? `${rel}/${name}` : name;
        if (p === ".oraknid" || folders.includes(p)) continue;
        let dir = false;
        try {
          dir = statSync(join(this.o.root, p)).isDirectory();
        } catch {}
        if (dir) walk(p);
        else out.push(p);
      }
    };
    walk("");
    return out;
  }

  /** A repo's files go to the trash under its folder: `trash/web/<time>/…`. */
  #trashOf(o: Open, trash: string) {
    return o.repo.folder ? join(trash, ...o.repo.folder.split("/")) : trash;
  }

  #trash(paths: string[], trash: string) {
    const to = join(trash, new Date().toISOString().replace(/[:.]/g, "-"));
    for (const p of paths) {
      const from = join(this.o.root, p);
      if (!existsSync(from)) continue;
      mkdirSync(dirname(join(to, p)), { recursive: true });
      renameSync(from, join(to, p));
    }
  }

  prepare(scope: string[]) {
    for (const r of reposOfScope(this.o.repos, scope)) this.#ensure(r);
  }

  async checkpoint(ref: string, message: string, onlyMissing = false) {
    for (const o of this.#each()) {
      if (onlyMissing && hasRef(o.g, ref)) continue;
      await checkpoint(this.#g(o), ref, message, this.o.tmpDir);
    }
  }

  hasRef(ref: string) {
    const all = this.#each();
    return all.length > 0 && all.every((o) => hasRef(o.g, ref));
  }

  async changedSince(ref: string) {
    const out: string[] = [];
    for (const o of this.#each())
      for (const p of await changedSince(this.#g(o), this.#ref(o, ref), this.o.tmpDir))
        out.push(o.repo.folder ? `${o.repo.folder}/${p}` : p);
    return [...out, ...this.#strays()];
  }

  async diffStatSince(ref: string) {
    const parts: string[] = [];
    for (const o of this.#each()) {
      const stat = (await diffStatSince(this.#g(o), this.#ref(o, ref), this.o.tmpDir)).trim();
      if (stat) parts.push(`${o.repo.name} (${o.repo.folder || "."}/):\n${stat}`);
    }
    const strays = this.#strays();
    if (strays.length) parts.push(`Outside every repo:\n${strays.join("\n")}`);
    return parts.join("\n\n");
  }

  async diffSince(ref: string) {
    const parts: string[] = [];
    for (const o of this.#each())
      parts.push(await diffSince(this.#g(o), this.#ref(o, ref), this.o.tmpDir, o.repo.folder));
    return parts.filter((x) => x.trim()).join("\n");
  }

  async rollback(ref: string, trash: string) {
    const restored: string[] = [];
    const trashed: string[] = [];
    const at = (o: Open, p: string) => (o.repo.folder ? `${o.repo.folder}/${p}` : p);
    for (const o of this.#each()) {
      const r = await rollback(
        this.#g(o),
        this.#ref(o, ref),
        this.o.tmpDir,
        this.#trashOf(o, trash),
      );
      restored.push(...r.restored.map((p) => at(o, p)));
      trashed.push(...r.trashed.map((p) => at(o, p)));
    }
    const strays = this.#strays();
    this.#trash(strays, trash);
    return { restored, trashed: [...trashed, ...strays] };
  }

  restorePaths(ref: string, paths: string[], trash: string) {
    const open = this.#each();
    const outside: string[] = [];
    const byRepo = new Map<Open, string[]>();
    for (const p of paths) {
      const o = repoOfPath(
        open.map((x) => ({ ...x, folder: x.repo.folder })),
        p,
      );
      const hit = o ? open.find((x) => x.repo.name === o.repo.name) : undefined;
      if (!hit) outside.push(p);
      else byRepo.set(hit, [...(byRepo.get(hit) ?? []), inRepo(hit.repo.folder, p)]);
    }
    for (const [o, ps] of byRepo)
      restorePaths(this.#g(o), this.#ref(o, ref), ps, this.#trashOf(o, trash));
    this.#trash(outside, trash);
  }

  async commit(message: (repo: string | null, several: boolean) => string) {
    const changed: Open[] = [];
    for (const o of this.#each()) if (await stageAll(this.#g(o))) changed.push(o);
    const out: TreeCommit[] = [];
    for (const o of changed)
      out.push({
        repo: o.repo.name,
        folder: o.repo.folder,
        sha: await commitStaged(this.#g(o), message(o.repo.name, changed.length > 1)),
      });
    return out;
  }

  localCommit(branch: string, repo?: string | null) {
    const r = repo
      ? this.o.repos.find((x) => x.name === repo)
      : this.o.repos.length === 1
        ? this.o.repos[0]
        : undefined;
    if (!r) return null;
    try {
      const g = this.#open.get(r.name)?.g ?? { cwd: this.#repoPath(r), base: [] };
      return git(g, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`]).trim() || null;
    } catch {
      return null;
    }
  }
}
