import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ProjectRepo } from "@oraknid/contracts";
import type { GitHub } from "../workspace/github.ts";

// A project moved from another computer whose folder isn't here (ADR-061):
// each of its repos linked to GitHub cloned again where it was, through
// its account's token. Nothing that is there is touched.

export async function cloneAgain(
  project: { workspacePath: string; repos: ProjectRepo[] },
  github: Pick<GitHub, "clone" | "cloneUrl">,
): Promise<{ cloned: string[] }> {
  const linked = project.repos.filter((r) => r.github);
  if (!linked.length)
    throw new Error(
      "None of this project's repos is linked to GitHub: copy its folder from the old computer instead.",
    );
  const cloned: string[] = [];
  // The project's own folder first: a repo in a subfolder goes inside it.
  for (const r of [...linked].sort((a, b) => a.folder.length - b.folder.length)) {
    const dest = r.folder
      ? join(project.workspacePath, ...r.folder.split("/"))
      : project.workspacePath;
    if (existsSync(dest)) continue;
    const link = r.github as NonNullable<ProjectRepo["github"]>;
    mkdirSync(dirname(dest), { recursive: true });
    await github.clone(github.cloneUrl(`${link.owner}/${link.name}`), dest, link.account);
    cloned.push(r.name);
  }
  if (!cloned.length) throw new Error("Its folders are all here already: nothing to clone.");
  return { cloned };
}
