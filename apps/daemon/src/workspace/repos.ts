import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { GitHubLink, ProjectRepo } from "@oraknid/contracts";
import { detectBranches, isGitRepo } from "./git.ts";

// A project's repositories (ADR-042): its folder itself (one repo, folder
// ""), or several git repositories in its folders, each with its name in
// the project, its branches and its GitHub link.

type ProjectLike = {
  workspacePath: string;
  isGitRepo: boolean;
  shadow: boolean;
  releaseBranch: string;
  workBranch: string;
  repos: ProjectRepo[];
};

/** A name a repo can have in its project, made from a folder's. */
export function repoNameOf(folder: string): string {
  const n = (folder.split("/").filter(Boolean).at(-1) ?? "repo")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
  return n && n !== "." && n !== ".." ? n : "repo";
}

/**
 * Its repos as stored, or, for a row written before repos were kept (a
 * test's, an old one), its folder as its one repo.
 */
export function projectRepos(p: ProjectLike): ProjectRepo[] {
  if (p.repos.length) return p.repos;
  if (!p.isGitRepo || p.shadow) return [];
  return [
    {
      name: repoNameOf(basename(p.workspacePath)),
      folder: "",
      releaseBranch: p.releaseBranch,
      workBranch: p.workBranch,
      github: null,
    },
  ];
}

/** Several repos (ADR-042): more than one, or one in a folder of the project's. */
export const isSeveral = (repos: ProjectRepo[]) =>
  repos.length > 1 || (repos.length === 1 && repos[0]?.folder !== "");

/** The GitHub link of a project of one repo: what ADR-038 called the project's link. */
export function oneRepoLink(p: ProjectLike): GitHubLink | null {
  const repos = projectRepos(p);
  return repos.length === 1 && repos[0]?.folder === "" ? (repos[0].github ?? null) : null;
}

const SKIP = new Set(["node_modules", ".oraknid", ".git", "dist", "build", "target", "vendor"]);

/**
 * The git repositories in a project's folder, at most two folders down
 * (`web/`, `apps/api/`), not inside each other. A submodule (a `.git`
 * file pointing into the parent's modules) is part of its parent, not a
 * repo of the project.
 */
export function findRepos(root: string): { folder: string; release: string; work: string }[] {
  const out: { folder: string; release: string; work: string }[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(".") || SKIP.has(name)) continue;
      const folder = rel ? `${rel}/${name}` : name;
      const path = join(root, folder);
      let dir = false;
      try {
        dir = statSync(path).isDirectory();
      } catch {}
      if (!dir) continue;
      const dotGit = join(path, ".git");
      if (existsSync(dotGit) && statSync(dotGit).isDirectory() && isGitRepo(path)) {
        const b = detectBranches(path);
        out.push({ folder, release: b.release, work: b.work });
        continue;
      }
      if (depth < 2) walk(folder, depth + 1);
    }
  };
  walk("", 1);
  return out;
}

/** The repo a path of the project's belongs to: the deepest whose folder holds it. */
export function repoOfPath<R extends { folder: string }>(repos: R[], path: string): R | null {
  const p = path.replace(/^\.\//, "");
  let best: R | null = null;
  for (const r of repos) {
    const inside = r.folder === "" || p === r.folder || p.startsWith(`${r.folder}/`);
    if (inside && (!best || r.folder.length > best.folder.length)) best = r;
  }
  return best;
}

/** A path relative to its repo's folder. */
export const inRepo = (folder: string, path: string) =>
  folder === "" ? path : path === folder ? "" : path.slice(folder.length + 1);

/** The fixed start of a glob, before its first wildcard. */
const fixedRoot = (glob: string) => {
  const parts: string[] = [];
  for (const seg of glob.replace(/^\.\//, "").split("/").filter(Boolean)) {
    if (/[*?[{]/.test(seg)) break;
    parts.push(seg);
  }
  return parts.join("/");
};

/**
 * The repos a task's scope names (ADR-042): a glob whose fixed start is in
 * a repo's folder names that repo; `**` names every repo; one outside every
 * repo's folder names the project's folder's own repo, if it is one.
 */
export function reposOfScope<R extends { folder: string }>(repos: R[], scope: string[]): R[] {
  const named = new Set<R>();
  for (const glob of scope) {
    const root = fixedRoot(glob);
    const inside = repos.filter(
      (r) => r.folder !== "" && (root === r.folder || root.startsWith(`${r.folder}/`)),
    );
    const prefixOf = repos.filter((r) => r.folder !== "" && r.folder.startsWith(`${root}/`));
    const top = repos.find((r) => r.folder === "");
    // `**` names them all; `apps/**` over apps/web and apps/api, each under it.
    const these = inside.length
      ? inside
      : root === ""
        ? repos
        : prefixOf.length
          ? prefixOf
          : top
            ? [top]
            : [];
    for (const r of these) named.add(r);
  }
  return repos.filter((r) => named.has(r));
}
