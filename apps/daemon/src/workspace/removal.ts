import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import type {
  ProjectArchive,
  ProjectArchivedWith,
  ProjectDelete,
  ProjectRepo,
  RemovalPreview,
  RemovalRepo,
  RemovalResult,
  RemovalStep,
  RepoLoss,
} from "@oraknid/contracts";
import type { EventBus } from "../events/bus.ts";
import { git, isGitRepo, worktreeGit } from "./git.ts";
import type { GitHub } from "./github.ts";
import type { Projects } from "./projects.ts";

// Archiving and deleting a project with my choices (Jobs-and-Projects →
// Archiving and deleting a project): its records, its folder on this
// computer, its repos on GitHub. Each step is said, done or not, and why.

/** How many files a folder's size is measured over before it says "at least". */
const SIZE_FILES = 500_000;
/** How long measuring may take. */
const SIZE_MS = 10_000;
/** How many paths a list of what would be lost names. */
const SHOW = 8;

export interface RemovalDeps {
  projects: Projects;
  github: GitHub;
  bus: EventBus;
  logsDir: string;
  /** Oraknid's own folders (data, config): never deleted, nor a folder holding one. */
  keep: string[];
  /** The home folder (the real one by default). */
  home?: string;
  /** Cancels a job; its state reaches cancelled when it has stopped. */
  cancelJob: (jobId: string) => Promise<void>;
}

/** "1.2 GB". */
export function bytesInWords(n: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return u === 0 ? `${n} bytes` : `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[u]}`;
}

/** A folder's size on disk; symbolic links are counted as links, never followed. */
export function folderSize(path: string): { bytes: number; files: number; partial: boolean } {
  const start = Date.now();
  let bytes = 0;
  let files = 0;
  const stack = [path];
  while (stack.length) {
    if (files >= SIZE_FILES || Date.now() - start > SIZE_MS) return { bytes, files, partial: true };
    const p = stack.pop() as string;
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      try {
        for (const name of readdirSync(p)) stack.push(join(p, name));
      } catch {}
    } else {
      files++;
      bytes += st.size;
    }
  }
  return { bytes, files, partial: false };
}

const inside = (child: string, parent: string) =>
  child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/**
 * Why a project's folder may not be deleted, or null: it must be a real
 * folder (not a symbolic link), not the root, a top-level folder, the
 * home folder or one holding it, nor one holding Oraknid's own data, and
 * neither hold nor sit in another project's folder.
 */
export function folderRefusal(
  path: string,
  o: { home: string; keep: string[]; others: { name: string; workspacePath: string }[] },
): string | null {
  if (!isAbsolute(path)) return `${path} isn't a full path.`;
  const p = resolve(path);
  let real = p;
  try {
    const st = lstatSync(p);
    if (st.isSymbolicLink())
      return `${p} is a symbolic link: Oraknid doesn't follow it to delete what it points to.`;
    if (!st.isDirectory()) return `${p} isn't a folder.`;
    real = realpathSync(p);
  } catch {
    // Not there: nothing to refuse, nothing to delete.
  }
  const homes = [resolve(o.home)];
  try {
    homes.push(realpathSync(o.home));
  } catch {}
  for (const c of new Set([p, real])) {
    if (c === sep || c.split(sep).filter(Boolean).length < 2)
      return `${c} is a top-level folder of this computer: Oraknid won't delete it.`;
    if (homes.some((h) => inside(h, c)))
      return `${c} is your home folder or holds it: Oraknid won't delete it.`;
    for (const k of o.keep)
      if (inside(resolve(k), c)) return `${c} holds Oraknid's own data: Oraknid won't delete it.`;
    for (const other of o.others) {
      const op = resolve(other.workspacePath);
      if (op === c) continue;
      if (inside(op, c))
        return `${c} holds the folder of the project "${other.name}" (${op}): Oraknid won't delete it.`;
      if (inside(c, op))
        return `${c} is inside the folder of the project "${other.name}" (${op}): Oraknid won't delete it.`;
    }
  }
  return null;
}

/** Changes not committed, in a repo and its worktrees, other repos' folders left out. */
function uncommitted(path: string, others: string[]): string[] {
  const g = { cwd: path, base: [] };
  const out: string[] = [];
  const lines = (text: string) =>
    text
      .split("\n")
      .filter(Boolean)
      .map((l) => l.slice(3).trim());
  for (const f of lines(git(g, ["status", "--porcelain=v1", "--untracked-files=normal"])))
    if (
      !f.startsWith(".oraknid/") &&
      f !== ".oraknid" &&
      !others.some((o) => f === `${o}/` || f.startsWith(`${o}/`))
    )
      out.push(f);
  const list = git(g, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))
    .slice(1);
  for (const wt of list) {
    if (!existsSync(wt)) continue;
    try {
      const wg = worktreeGit(path, wt);
      for (const f of lines(git(wg, ["status", "--porcelain=v1", "--untracked-files=normal"])))
        if (!f.startsWith(".oraknid/")) out.push(`${wt}/${f}`);
    } catch {
      out.push(`${wt} (a worktree git can't read)`);
    }
  }
  return out;
}

/**
 * What would be lost if a repo's folder went: files not committed, and
 * commits on no branch of its GitHub repo (`heads`, its branches' tips;
 * null when it has none: its remote-tracking branches are used).
 */
export function repoLoss(path: string, heads: string[] | null, others: string[] = []): RepoLoss {
  const none: RepoLoss = {
    uncommitted: [],
    uncommittedCount: 0,
    unpushed: [],
    stashes: 0,
    error: null,
  };
  if (!existsSync(path)) return none;
  if (!isGitRepo(path)) return { ...none, error: `${path} isn't a git repo.` };
  const g = { cwd: path, base: [] };
  try {
    const files = uncommitted(path, others);
    const known = heads?.filter((sha) => {
      try {
        git(g, ["cat-file", "-e", `${sha}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    });
    const unpushed: RepoLoss["unpushed"] = [];
    for (const line of git(g, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .split("\n")
      .filter(Boolean)) {
      const not = known ? (known.length ? ["--not", ...known] : []) : ["--not", "--remotes"];
      const n = Number(git(g, ["rev-list", "--count", line, ...not]).trim());
      if (n > 0) unpushed.push({ branch: line, commits: n });
    }
    let stashes = 0;
    try {
      stashes = git(g, ["stash", "list"]).split("\n").filter(Boolean).length;
    } catch {}
    return {
      uncommitted: files.slice(0, SHOW),
      uncommittedCount: files.length,
      unpushed,
      stashes,
      error: null,
    };
  } catch (e) {
    return { ...none, error: `Its state couldn't be read: ${(e as Error).message}` };
  }
}

/** Files in a project's folder that are in none of its repos (a project of several). */
function outsideRepos(root: string, repos: ProjectRepo[]): string[] {
  if (!repos.length || repos.some((r) => r.folder === "") || !existsSync(root)) return [];
  const folders = repos.map((r) => r.folder);
  const out: string[] = [];
  const walk = (rel: string) => {
    if (out.length >= SHOW) return;
    let names: string[] = [];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const f = rel ? `${rel}/${name}` : name;
      if (f === ".oraknid" || folders.includes(f)) continue;
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(join(root, f));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // A folder holding a repo is gone through; any other is lost as a whole.
        if (folders.some((r) => r.startsWith(`${f}/`))) walk(f);
        else if (readdirSync(join(root, f)).length) out.push(`${f}/`);
      } else out.push(f);
      if (out.length >= SHOW) return;
    }
  };
  walk("");
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export class ProjectRemoval {
  constructor(private readonly d: RemovalDeps) {}

  #refusal(id: string, path: string) {
    return folderRefusal(path, {
      home: this.d.home ?? homedir(),
      keep: this.d.keep,
      others: this.d.projects.list().filter((p) => p.id !== id),
    });
  }

  /** What deleting or archiving would touch, and what deleting the folder would lose. */
  async preview(id: string): Promise<RemovalPreview> {
    const p = this.d.projects.require(id);
    const path = p.workspacePath;
    const exists = existsSync(path);
    const refused = exists ? this.#refusal(id, path) : null;
    const size = exists && !refused ? folderSize(path) : null;
    const scopes = new Map<string, Promise<string[] | null>>();
    const repos: RemovalRepo[] = [];
    for (const r of p.repos) {
      const rpath = r.folder ? join(path, ...r.folder.split("/")) : path;
      const others = p.repos
        .filter((x) => x !== r && x.folder && r.folder === "")
        .map((x) => x.folder);
      const link = r.github;
      let github: RemovalRepo["github"] = null;
      let heads: string[] | null = null;
      let headsError: string | null = null;
      if (link) {
        const fullName = `${link.owner}/${link.name}`;
        github = {
          fullName,
          account: link.account,
          url: `https://github.com/${fullName}`,
          ready: link.ready,
          owned: null,
          archived: null,
          scopes: null,
          canDelete: null,
          error: null,
        };
        if (link.ready) {
          try {
            if (!scopes.has(link.account))
              scopes.set(link.account, this.d.github.scopes(link.account));
            const s = await (scopes.get(link.account) as Promise<string[] | null>);
            const o = await this.d.github.ownership(fullName, link.account);
            Object.assign(github, {
              owned: o.owned,
              archived: o.archived,
              url: o.url,
              scopes: s,
              canDelete: s ? s.includes("delete_repo") : null,
            });
          } catch (e) {
            github.error = (e as Error).message;
          }
          if (existsSync(rpath))
            try {
              heads = await this.d.github.remoteHeads(fullName, link.account);
            } catch (e) {
              headsError = `GitHub couldn't be reached to compare ${r.name} with ${fullName}: ${(e as Error).message}`;
            }
        }
      }
      const loss = repoLoss(rpath, link?.ready ? heads : null, others);
      repos.push({
        name: r.name,
        folder: r.folder,
        path: rpath,
        github,
        loss: headsError && !loss.error ? { ...loss, error: headsError } : loss,
      });
    }
    const outside = outsideRepos(path, p.repos);
    const reasons: string[] = [];
    if (!exists) reasons.push(`The folder isn't there: ${path}.`);
    if (refused) reasons.push(refused);
    if (!p.repos.length)
      reasons.push(
        "It isn't a git repo on GitHub: nothing could bring the folder back. Delete the project instead, or keep its folder.",
      );
    for (const r of repos) {
      if (!r.github) {
        reasons.push(`${r.name} isn't linked to a GitHub repo: it couldn't be cloned back.`);
        continue;
      }
      if (!r.github.ready) {
        reasons.push(`${r.name}'s GitHub repo ${r.github.fullName} isn't created yet.`);
        continue;
      }
      if (r.loss.error) reasons.push(`${r.name}: ${r.loss.error}`);
      if (r.loss.uncommittedCount)
        reasons.push(
          `${r.name}: ${plural(r.loss.uncommittedCount, "file")} changed and not committed (${r.loss.uncommitted.join(", ")}${r.loss.uncommittedCount > r.loss.uncommitted.length ? ", …" : ""}).`,
        );
      if (r.loss.unpushed.length)
        reasons.push(
          `${r.name}: commits not on GitHub, on ${r.loss.unpushed.map((b) => `${b.branch} (${b.commits})`).join(", ")}.`,
        );
      if (r.loss.stashes) reasons.push(`${r.name}: ${plural(r.loss.stashes, "stash", "stashes")}.`);
    }
    if (outside.length)
      reasons.push(`Files in the folder that are in none of its repos: ${outside.join(", ")}.`);
    return {
      id,
      name: p.name,
      folder: {
        path,
        exists,
        bytes: size?.bytes ?? null,
        files: size?.files ?? 0,
        partial: size?.partial ?? false,
        refused,
      },
      runningJobs: this.d.projects.activeJobs(id).map((j) => ({ id: j.id, title: j.title })),
      repos,
      outside,
      archiveFolder: { allowed: reasons.length === 0, reasons },
      archivedWith: p.archivedWith
        ? {
            githubArchived: p.archivedWith.githubArchived ?? [],
            folderDeleted: !!p.archivedWith.folderDeleted,
          }
        : null,
    };
  }

  /** Its running jobs cancelled when I said so, refused otherwise. */
  async #stopJobs(id: string, stop: boolean, steps: RemovalStep[]) {
    const active = this.d.projects.activeJobs(id);
    if (!active.length) return;
    if (!stop) throw new Error(`"${active[0]?.title}" is still going; cancel it first.`);
    for (const j of active) await this.d.cancelJob(j.id);
    const end = Date.now() + 30_000;
    while (this.d.projects.activeJobs(id).length && Date.now() < end)
      await new Promise((r) => setTimeout(r, 50));
    const left = this.d.projects.activeJobs(id);
    if (left.length)
      throw new Error(`"${left[0]?.title}" hasn't stopped yet; try again in a moment.`);
    steps.push({
      kind: "jobs",
      target: this.d.projects.require(id).name,
      status: "done",
      message: `Cancelled ${plural(active.length, "running job")}: ${active.map((j) => j.title).join(", ")}.`,
    });
  }

  /** The linked repos named, each with its repo in the project; an unknown one is refused. */
  #linked(id: string, names: string[]) {
    const repos = this.d.projects.require(id).repos;
    return [...new Set(names.map((n) => n.toLowerCase()))].map((n) => {
      const repo = repos.find(
        (r) => r.github && `${r.github.owner}/${r.github.name}`.toLowerCase() === n,
      );
      if (!repo?.github)
        throw new Error(`${n} isn't a GitHub repo linked to this project. Nothing was done.`);
      return { repo, link: repo.github, fullName: `${repo.github.owner}/${repo.github.name}` };
    });
  }

  /** A repo on GitHub archived, unarchived or deleted: only one its account owns. */
  async #onGitHub(
    kind: "github-delete" | "github-archive" | "github-unarchive",
    fullName: string,
    account: string,
  ): Promise<RemovalStep> {
    try {
      const o = await this.d.github.ownership(fullName, account);
      if (!o.owned)
        return {
          kind,
          target: fullName,
          status: "failed",
          message: `${fullName} isn't owned by ${account}: Oraknid only changes a repo the account owns.`,
        };
      if (kind === "github-delete") await this.d.github.deleteRepo(fullName, account);
      else await this.d.github.setArchived(fullName, kind === "github-archive", account);
      return {
        kind,
        target: fullName,
        status: "done",
        message:
          kind === "github-delete"
            ? `Deleted ${fullName} on GitHub.`
            : kind === "github-archive"
              ? `Archived ${fullName} on GitHub: it is read-only there.`
              : `Unarchived ${fullName} on GitHub: it can be pushed to again.`,
      };
    } catch (e) {
      return { kind, target: fullName, status: "failed", message: (e as Error).message };
    }
  }

  /** The folder deleted, its symbolic links removed as links, never followed. */
  #deleteFolder(id: string, path: string): RemovalStep {
    if (!existsSync(path))
      return {
        kind: "folder",
        target: path,
        status: "skipped",
        message: `${path} was already gone.`,
      };
    const refused = this.#refusal(id, path);
    if (refused) return { kind: "folder", target: path, status: "failed", message: refused };
    const size = folderSize(path);
    try {
      rmSync(path, { recursive: true, force: false, maxRetries: 2 });
    } catch (e) {
      return {
        kind: "folder",
        target: path,
        status: "failed",
        message: `${path} couldn't be deleted completely: ${(e as Error).message}`,
      };
    }
    return {
      kind: "folder",
      target: path,
      status: "done",
      message: `Deleted ${path} from this computer (${size.partial ? "at least " : ""}${bytesInWords(size.bytes)}, ${plural(size.files, "file")}).`,
    };
  }

  /**
   * Deleted: on GitHub first (each repo I ticked), then its folder, then
   * its records. A step on GitHub that fails keeps the project and its
   * folder, so I can grant the permission and try again.
   */
  async delete(input: ProjectDelete): Promise<RemovalResult> {
    const p = this.d.projects.require(input.id);
    const steps: RemovalStep[] = [];
    const repos = this.#linked(input.id, input.deleteRepos ?? []);
    if (input.deleteFolder && existsSync(p.workspacePath)) {
      const refused = this.#refusal(input.id, p.workspacePath);
      if (refused) throw new Error(`${refused} Nothing was done.`);
    }
    await this.#stopJobs(input.id, !!input.stopJobs, steps);
    const deleted: string[] = [];
    for (const r of repos) {
      const step = await this.#onGitHub("github-delete", r.fullName, r.link.account);
      steps.push(step);
      if (step.status === "done") {
        deleted.push(r.fullName);
        // Gone on GitHub: the link goes too, so trying again doesn't ask for it.
        this.d.projects.setGitHub(input.id, null, "owner", r.repo.name);
      }
    }
    const kept = (why: string): RemovalResult => {
      if (input.deleteFolder)
        steps.push({ kind: "folder", target: p.workspacePath, status: "skipped", message: why });
      steps.push({ kind: "records", target: p.name, status: "skipped", message: why });
      this.#audit("project.delete-stopped", input.id, p.name, steps);
      return { steps, kept: true, jobs: 0, folder: p.workspacePath };
    };
    if (steps.some((s) => s.kind === "github-delete" && s.status === "failed"))
      return kept(
        "Not done: a step on GitHub failed, so the project and its folder are kept. Fix it (or untick that repo) and delete again.",
      );
    let folderDeleted = false;
    if (input.deleteFolder) {
      const step = this.#deleteFolder(input.id, p.workspacePath);
      steps.push(step);
      if (step.status === "failed")
        return kept(
          "Not done: the folder couldn't be deleted, so the project is kept. Fix it and delete again.",
        );
      folderDeleted = step.status === "done";
    }
    const r = this.d.projects.remove(input.id, this.d.logsDir, {
      folderDeleted: folderDeleted ? p.workspacePath : null,
      githubDeleted: deleted,
      steps: steps.map(({ kind, target, status }) => ({ kind, target, status })),
    });
    steps.push({
      kind: "records",
      target: p.name,
      status: "done",
      message: `"${p.name}" and ${plural(r.jobs, "job")} left Oraknid with their history.${
        input.deleteFolder ? "" : ` The folder stays as it is: ${p.workspacePath}.`
      }`,
    });
    return { steps, kept: false, jobs: r.jobs, folder: r.folder };
  }

  /**
   * Archived: its repos on GitHub I ticked made read-only, its folder
   * deleted when I asked and nothing would be lost, then hidden from the
   * lists with a note of what was done, for unarchiving.
   */
  async archive(input: ProjectArchive): Promise<RemovalResult> {
    if (!input.archived) return this.unarchive(input);
    const p = this.d.projects.require(input.id);
    if (p.archivedAt) throw new Error(`"${p.name}" is archived already.`);
    const steps: RemovalStep[] = [];
    const repos = this.#linked(input.id, input.archiveRepos ?? []);
    if (input.deleteFolder) {
      const pv = await this.preview(input.id);
      // Jobs about to be cancelled don't count; their worktrees' changes do.
      if (!pv.archiveFolder.allowed)
        throw new Error(
          `The folder can't be deleted: ${pv.archiveFolder.reasons.join(" ")} Nothing was done.`,
        );
    }
    await this.#stopJobs(input.id, !!input.stopJobs, steps);
    const archived: string[] = [];
    for (const r of repos) {
      const step = await this.#onGitHub("github-archive", r.fullName, r.link.account);
      steps.push(step);
      if (step.status === "done") archived.push(r.fullName);
    }
    let folderDeleted = false;
    if (input.deleteFolder) {
      const step = this.#deleteFolder(input.id, p.workspacePath);
      steps.push(step);
      folderDeleted = step.status === "done";
    }
    const record: ProjectArchivedWith = { githubArchived: archived, folderDeleted };
    this.d.projects.setArchived(input.id, true, record);
    steps.push({
      kind: "archive",
      target: p.name,
      status: "done",
      message: `"${p.name}" is in Archived projects, everything of it kept${
        folderDeleted ? "; its folder comes back from GitHub when I unarchive it" : ""
      }.`,
    });
    return { steps, kept: true, jobs: 0, folder: p.workspacePath };
  }

  /**
   * Back in the list: the GitHub repos I ticked unarchived, and its folder,
   * if archiving deleted it, cloned back from GitHub to the same place in
   * the same layout. A clone that fails leaves it archived, to try again.
   */
  async unarchive(input: ProjectArchive): Promise<RemovalResult> {
    const p = this.d.projects.require(input.id);
    if (!p.archivedAt) throw new Error(`"${p.name}" isn't archived.`);
    const steps: RemovalStep[] = [];
    const record = p.archivedWith ?? { githubArchived: [], folderDeleted: false };
    const stillArchived = new Set(record.githubArchived ?? []);
    for (const r of this.#linked(input.id, input.unarchiveRepos ?? [])) {
      const step = await this.#onGitHub("github-unarchive", r.fullName, r.link.account);
      steps.push(step);
      if (step.status === "done")
        for (const x of stillArchived)
          if (x.toLowerCase() === r.fullName.toLowerCase()) stillArchived.delete(x);
    }
    if (record.folderDeleted) {
      const restored = await this.#restore(input.id, steps);
      if (!restored) {
        this.d.projects.setArchived(input.id, true, {
          githubArchived: [...stillArchived],
          folderDeleted: true,
        });
        steps.push({
          kind: "archive",
          target: p.name,
          status: "skipped",
          message: `"${p.name}" stays archived: its folder couldn't be brought back. Unarchive it again to try the rest.`,
        });
        return { steps, kept: true, jobs: 0, folder: p.workspacePath };
      }
    }
    this.d.projects.setArchived(input.id, false, null);
    steps.push({
      kind: "archive",
      target: p.name,
      status: "done",
      message: `"${p.name}" is back in the list.${
        stillArchived.size ? ` Still archived on GitHub: ${[...stillArchived].join(", ")}.` : ""
      }`,
    });
    return { steps, kept: true, jobs: 0, folder: p.workspacePath };
  }

  /** Each repo cloned back from GitHub to its folder; its branches made as they were. */
  async #restore(id: string, steps: RemovalStep[]): Promise<boolean> {
    const p = this.d.projects.require(id);
    const root = p.workspacePath;
    let ok = true;
    const n = p.repos.length;
    if (p.repos.some((r) => r.folder !== "")) mkdirSync(root, { recursive: true });
    for (const [i, r] of p.repos.entries()) {
      const dest = r.folder ? join(root, ...r.folder.split("/")) : root;
      const target = r.github ? `${r.github.owner}/${r.github.name}` : r.name;
      this.#progress(id, r.name, i, n, "cloning");
      if (existsSync(dest) && isGitRepo(dest)) {
        steps.push({
          kind: "restore",
          target: dest,
          status: "skipped",
          message: `${dest} is there already.`,
        });
        this.#progress(id, r.name, i + 1, n, "done");
        continue;
      }
      if (!r.github) {
        ok = false;
        steps.push({
          kind: "restore",
          target: dest,
          status: "failed",
          message: `${r.name} isn't linked to a GitHub repo: nothing to clone it from.`,
        });
        continue;
      }
      try {
        // The folder of a project of one repo: an empty one left there is cloned into.
        if (existsSync(dest) && !readdirSync(dest).length) rmdirSync(dest);
        await this.d.github.clone(this.d.github.cloneUrl(target), dest, r.github.account);
        const g = { cwd: dest, base: [] };
        for (const b of [r.releaseBranch, r.workBranch]) {
          try {
            git(g, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
          } catch {
            try {
              git(g, ["branch", "--track", b, `origin/${b}`]);
            } catch {
              // Not on GitHub: made from the release branch when a job needs it.
            }
          }
        }
        steps.push({
          kind: "restore",
          target: dest,
          status: "done",
          message: `Cloned ${target} back into ${dest}.`,
        });
        this.#progress(id, r.name, i + 1, n, "done");
      } catch (e) {
        ok = false;
        steps.push({
          kind: "restore",
          target: dest,
          status: "failed",
          message: `${target} couldn't be cloned into ${dest}: ${(e as Error).message}`,
        });
        this.#progress(id, r.name, i + 1, n, "failed");
      }
    }
    return ok;
  }

  #progress(id: string, repo: string, done: number, of: number, state: string) {
    this.d.bus.publish({
      type: "project.restoring",
      topic: "overview",
      jobId: null,
      payload: { id, repo, done, of, state },
      actor: "owner",
    });
  }

  #audit(type: string, id: string, name: string, steps: RemovalStep[]) {
    this.d.bus.publish({
      type,
      topic: "overview",
      jobId: null,
      payload: {
        id,
        name,
        steps: steps.map(({ kind, target, status }) => ({ kind, target, status })),
      },
      actor: "owner",
    });
  }
}
