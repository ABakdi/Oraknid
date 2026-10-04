import { accessSync, constants, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { NewProjectFrom } from "@oraknid/contracts";
import type { EventBus } from "../events/bus.ts";
import { expandPath } from "./folders.ts";
import type { GitHub } from "./github.ts";
import type { Projects } from "./projects.ts";

// A new project from where I say (Jobs-and-Projects → Starting work):
// a folder I have, a new empty one, a new GitHub repo or a cloned one.

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

/** The project made from one of my GitHub repos is linked to it (ADR-038). */
function linked<P extends { id: string }>(
  d: { projects: Projects },
  p: P,
  login: string | null,
  fullName: string,
  visibility: "public" | "private",
): P {
  const [owner, name] = fullName.split("/") as [string, string];
  if (!login) return p;
  const github = d.projects.setGitHub(p.id, {
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
    const login = s.account ?? (await d.github.accounts())[0]?.login ?? null;
    const repo = await d.github.createRepo(
      { name: s.name, private: s.private, description: s.description },
      login,
    );
    // Mine, from the page or the helper (which asked first): audited (ADR-023).
    d.bus.publish({
      type: "github.repo-created",
      topic: "overview",
      jobId: null,
      payload: { fullName: repo.fullName, private: s.private },
      actor: "owner",
    });
    await d.github.clone(d.github.cloneUrl(repo.fullName), dest, login);
    const p = d.projects.create({ name: input.name ?? s.name, workspacePath: dest });
    // Made from this repo: it is the project's GitHub link, nothing to ask later (ADR-038).
    return linked(d, p, login, repo.fullName, s.private ? "private" : "public");
  }
  if (s.kind === "github-clone") {
    const folder = s.fullName.split("/")[1] as string;
    const dest = named(folder);
    const login = s.account ?? (await d.github.accounts())[0]?.login ?? null;
    await d.github.clone(d.github.cloneUrl(s.fullName), dest, login);
    const p = d.projects.create({ name: input.name ?? folder, workspacePath: dest });
    const repo = await d.github.repo(s.fullName, login).catch(() => null);
    return linked(d, p, login, s.fullName, repo && !repo.private ? "public" : "private");
  }
  const folder = basename(s.url.replace(/\/+$/, "")).replace(/\.git$/, "") || "project";
  const dest = named(folder);
  await d.github.clone(s.url, dest);
  return d.projects.create({ name: input.name ?? folder, workspacePath: dest });
}
