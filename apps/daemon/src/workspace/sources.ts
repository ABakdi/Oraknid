import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { NewProjectFrom } from "@oraknid/contracts";
import type { EventBus } from "../events/bus.ts";
import { expandPath } from "./folders.ts";
import type { GitHub } from "./github.ts";
import { hostFor } from "./hosts/registry.ts";
import type { Projects } from "./projects.ts";

// A new project from where I say (Jobs-and-Projects → Starting work):
// a folder I have, a new empty one, a new GitHub repo or a cloned one; or
// the same on GitLab, Gitea or Forgejo (ADR-062), named by `host`.

function parentFolder(path: string): string {
  const parent = expandPath(path);
  if (!existsSync(parent) || !statSync(parent).isDirectory())
    throw new Error(`${parent} is not a folder: choose where the project goes.`);
  try {
    accessSync(parent, constants.W_OK);
  } catch {
    throw new Error(`${parent} is not writable.`);
  }
  return parent;
}

/** The project made from one of my GitHub repos is linked to it (ADR-038); on another host too. */
function linked<P extends { id: string }>(
  d: { projects: Projects },
  p: P,
  login: string | null,
  fullName: string,
  visibility: "public" | "private",
  host?: string,
): P {
  const cut = fullName.lastIndexOf("/");
  const owner = fullName.slice(0, cut);
  const name = fullName.slice(cut + 1);
  if (!login) return p;
  const github = d.projects.setGitHub(p.id, {
    ...(host ? { host } : {}),
    account: login,
    owner,
    name,
    visibility,
    origin: "existing",
  });
  return { ...p, github };
}

export async function projectFrom(
  d: { projects: Projects; github: GitHub; bus: EventBus },
  input: NewProjectFrom,
) {
  const s = input.source;
  if (s.kind === "folder")
    return d.projects.create({
      name: input.name ?? basename(expandPath(s.path)),
      workspacePath: expandPath(s.path),
      ...(s.initGit !== undefined ? { initGit: s.initGit } : {}),
    });
  const parent = parentFolder(s.parent);
  const named = (folder: string) => {
    const dest = join(parent, folder);
    if (existsSync(dest)) throw new Error(`${dest} exists already: choose another name or folder.`);
    return dest;
  };
  if (s.kind === "new-folder") {
    const dest = named(s.name);
    mkdirSync(dest);
    return d.projects.create({ name: input.name ?? s.name, workspacePath: dest, initGit: true });
  }
  if (s.kind === "github-new") {
    const dest = named(s.name);
    const h = hostOf(d.github, s.host);
    const login = s.account ?? (await h.accounts())[0]?.login ?? null;
    const repo = await h.createRepo(
      { name: s.name, private: s.private, description: s.description },
      login,
    );
    // Mine, from the page or the helper (which asked first): audited (ADR-023).
    d.bus.publish({
      type: "github.repo-created",
      topic: "overview",
      jobId: null,
      payload: { fullName: repo.fullName, private: s.private, ...(s.host ? { host: s.host } : {}) },
      actor: "owner",
    });
    await h.clone(h.cloneUrl(repo.fullName), dest, login);
    const p = d.projects.create({ name: input.name ?? s.name, workspacePath: dest });
    // Made from this repo: it is the project's GitHub link, nothing to ask later (ADR-038).
    return linked(d, p, login, repo.fullName, s.private ? "private" : "public", s.host);
  }
  if (s.kind === "github-clone") {
    const folder = s.fullName.split("/").pop() as string;
    const dest = named(folder);
    const h = hostOf(d.github, s.host);
    if (!s.host && s.fullName.split("/").length !== 2)
      throw new Error("A GitHub repository is owner/name.");
    const login = s.account ?? (await h.accounts())[0]?.login ?? null;
    await h.clone(h.cloneUrl(s.fullName), dest, login);
    const p = d.projects.create({ name: input.name ?? folder, workspacePath: dest });
    const repo = await h.repo(s.fullName, login).catch(() => null);
    return linked(d, p, login, s.fullName, repo && !repo.private ? "public" : "private", s.host);
  }
  const folder = basename(s.url.replace(/\/+$/, "")).replace(/\.git$/, "") || "project";
  const dest = named(folder);
  await d.github.clone(s.url, dest);
  return d.projects.create({ name: input.name ?? folder, workspacePath: dest });
}

/** GitHub, or the host named (ADR-062). */
function hostOf(github: GitHub, host: string | undefined) {
  const h = hostFor(github, host ? { host } : null);
  if (!h) throw new Error("GitHub isn't set up in Oraknid.");
  return h;
}
