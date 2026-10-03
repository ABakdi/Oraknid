import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubLink } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.ts";
import { jobs, tasks } from "../db/schema.ts";
import { linkProject, seedJob } from "../testing/fixtures.ts";
import type { GitHub } from "../workspace/github.ts";
import { runBuiltinCheck } from "./builtin-checks.ts";
import { adaptToGitHub } from "./links.ts";

const link: GitHubLink = {
  account: "ABakdi",
  owner: "ABakdi",
  name: "oraknid-piano",
  visibility: "public",
  origin: "new",
  ready: true,
  linkedAt: 1,
} as GitHubLink;

/** GitHub with one public repo whose dev branch is at "abc1234…". */
const fakeGitHub = {
  repo: async () => ({ fullName: "ABakdi/oraknid-piano", private: false }),
  read: async (path: string) => {
    if (path.endsWith("/branches/dev"))
      return { data: { commit: { sha: "abc1234def" } }, next: false };
    throw new Error("GitHub has no such branch.");
  },
} as unknown as GitHub;

describe("checks Oraknid answers itself about the project's repo (ADR-038)", () => {
  const run = (command: string, here: string | null = "abc1234def", l: GitHubLink | null = link) =>
    runBuiltinCheck(command, { github: fakeGitHub, link: l, localCommit: () => here });

  it("passes when the repo and the branch are there at this commit, and says why when not", async () => {
    expect(await run("ls")).toBeNull();
    expect(await run("oraknid github-repo")).toMatchObject({ ok: true });
    expect(await run("oraknid github-branch dev")).toMatchObject({ ok: true });
    expect((await run("oraknid github-branch dev", "fff0000"))?.output).toMatch(/push it/);
    expect((await run("oraknid github-branch main"))?.ok).toBe(false);
    expect(
      (await run("oraknid github-repo", null, { ...link, visibility: "private" }))?.output,
    ).toMatch(/is public, not private/);
    expect((await run("oraknid github-repo", null, null))?.output).toMatch(/no GitHub repo linked/);
  });

  it("brings a task planned around the gh CLI to the project's linked repo, once", async () => {
    const db = await openDatabase({
      file: ":memory:",
      backupsDir: join(mkdtempSync(join(tmpdir(), "oraknid-adapt-")), "b"),
    });
    const jobId = seedJob(db, "running");
    const projectId = db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.projectId as string;
    linkProject(db, projectId, link);
    // The piano task as it was planned before the link (2026-10-03).
    db.insert(tasks)
      .values({
        id: "t1",
        jobId,
        title: "Create a GitHub repo for the piano project and push the dev branch",
        instructions:
          "Create a GitHub repository with the gh CLI (`gh repo create web-piano --private`). Make it private unless the owner said otherwise. Push the dev branch to it (`git push -u <remote> dev`).",
        kind: "implement",
        scope: [".git"],
        verify: [
          "gh repo view --json url",
          "git ls-remote --heads $(git remote | grep -E '^(github|origin)$' | head -1) dev | grep -q dev",
        ],
        requiredCapabilities: ["implementation"],
        difficulty: "low",
        state: "ready",
      })
      .run();
    adaptToGitHub(db, projectId, "t1");
    const t = db.select().from(tasks).where(eq(tasks.id, "t1")).get();
    expect(t?.verify).toEqual(["oraknid github-repo", "oraknid github-branch dev"]);
    expect(t?.instructions).toMatch(/ABakdi\/oraknid-piano \(public\).*wins over anything above/);
    adaptToGitHub(db, projectId, "t1");
    expect(
      db
        .select()
        .from(tasks)
        .where(eq(tasks.id, "t1"))
        .get()
        ?.instructions.match(/Note from Oraknid/g),
    ).toHaveLength(1);
  });
});
