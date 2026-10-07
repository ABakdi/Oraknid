import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../../api/router.ts";
import { remoteAllowed } from "../../auth/lock.ts";
import { type Daemon, startDaemon } from "../../daemon.ts";
import { jobs, skills } from "../../db/schema.ts";
import { runBuiltinCheck } from "../../eye/builtin-checks.ts";
import { resolvePaths } from "../../paths.ts";
import { type FakeGitHost, startFakeGitHost } from "../../testing/fake-git-host.ts";
import { fakeOs } from "../../testing/fake-os.ts";
import { githubCall, judgeGitHub } from "../github-tool.ts";
import { splitDiff } from "./host.ts";
import { normaliseHostUrl } from "./rest.ts";

// Git hosts besides GitHub (ADR-062): GitLab and Gitea/Forgejo accounts by
// token, read, created, cloned and pushed to through Oraknid's own
// credential path, against stand-ins answering from real bare repos.

const GL_TOKEN = "glpat-secret-token-1234";
const GT_TOKEN = "gitea-secret-token-5678";

let daemon: Daemon | undefined;
let host: FakeGitHost | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  await host?.close();
  host = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  dirs.push(d);
  return d;
};

async function harness(kind: "gitlab" | "gitea", o: { forgejo?: boolean } = {}) {
  host = await startFakeGitHost({
    kind,
    ...(o.forgejo ? { forgejo: true } : {}),
    tokens: { [kind === "gitlab" ? GL_TOKEN : GT_TOKEN]: "me" },
    groups: { [kind === "gitlab" ? "team/web" : "acme"]: 7 },
  });
  const dir = tmp("oraknid-hosts-");
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  return { api, host, daemon };
}

/** A job in a project, as the github tool needs one. */
function jobIn(d: Daemon, projectId: string, branch: string | null = null) {
  d.db
    .insert(skills)
    .values({
      id: "01KSKILL000000000000000000",
      version: 1,
      name: "s",
      description: "",
      source: "built-in",
      body: "",
      interview: false,
      requiredTools: [],
      verify: [],
      createdAt: 0,
    })
    .onConflictDoNothing()
    .run();
  const id = "01KJOB00000000000000000000";
  d.db
    .insert(jobs)
    .values({
      id,
      projectId,
      title: "Ship it",
      goal: "",
      inputs: [],
      skillId: "01KSKILL000000000000000000",
      skillVersion: 1,
      autonomy: "auto",
      allowedLegIds: [],
      budget: {
        tokens: null,
        quotaShare: null,
        wallClockMs: null,
        money: { limit: 0, hard: true },
      },
      state: "running",
      branch,
      createdAt: 0,
    })
    .run();
  return id;
}

const commit = (cwd: string, file: string, text: string, message: string) => {
  writeFileSync(join(cwd, file), text);
  execFileSync("git", ["add", "."], { cwd });
  execFileSync(
    "git",
    ["-c", "user.name=Me", "-c", "user.email=me@example.com", "commit", "-q", "-m", message],
    { cwd },
  );
};

describe("Git hosts (ADR-062)", () => {
  it("normalises a host's address, refusing plain http elsewhere and GitHub", () => {
    expect(normaliseHostUrl("https://GitLab.com/")).toEqual({
      url: "https://gitlab.com",
      host: "gitlab.com",
    });
    expect(normaliseHostUrl("https://example.org/gitea/")).toEqual({
      url: "https://example.org/gitea",
      host: "example.org/gitea",
    });
    expect(() => normaliseHostUrl("http://git.example.org")).toThrow(/in clear/);
    expect(() => normaliseHostUrl("https://github.com")).toThrow(/own card/);
    expect(() => normaliseHostUrl("https://me:pw@gitlab.com")).toThrow(/without a name/);
  });

  it("cuts a diff of several files into GitHub's per-file changes", () => {
    const files = splitDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "index 1..2 100644",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/b.md b/b.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.md",
        "@@ -0,0 +1,2 @@",
        "+one",
        "+two",
        "",
      ].join("\n"),
    );
    expect(files).toEqual([
      expect.objectContaining({ path: "a.ts", status: "modified", additions: 1, deletions: 1 }),
      expect.objectContaining({ path: "b.md", status: "added", additions: 2, deletions: 0 }),
    ]);
    expect(files[0]?.patch).toBe("@@ -1 +1 @@\n-old\n+new");
  });

  it("GitLab: an account by token, its projects read, created, cloned, pushed to and a merge request opened, the token never shown", async () => {
    const { api, host, daemon } = await harness("gitlab");
    // A wrong token is refused in words.
    await expect(
      api.hosts.addAccount({ kind: "gitlab", url: host.url, token: "wrong-token-000" }),
    ).rejects.toThrow(/refused the token/);
    const added = await api.hosts.addAccount({ kind: "gitlab", url: host.url, token: GL_TOKEN });
    const id = host.url.replace(/^http:\/\//, "");
    expect(added).toEqual({ host: id, login: "me" });
    expect(await api.hosts.accounts({ check: true })).toEqual([
      { host: id, kind: "gitlab", url: host.url, login: "me", error: null },
    ]);
    expect((await api.hosts.list()).map((h) => h.label)).toEqual(["GitHub", `GitLab (${id})`]);

    // The list, every host's, the group's subgroup project among them.
    const list = await api.hosts.repoList({});
    expect(list.errors).toEqual([]);
    expect(list.repos.map((r) => r.fullName).sort()).toEqual(["me/site", "team/web/tools"]);
    expect(list.repos.find((r) => r.fullName === "team/web/tools")).toMatchObject({
      host: id,
      owner: "team/web",
      name: "tools",
      visibility: "public",
    });

    // Browsing: info, branches, tree, a file, the README, commits with diffs.
    const ref = { host: id, owner: "me", name: "site" };
    expect(await api.hosts.repoInfo(ref)).toMatchObject({
      fullName: "me/site",
      visibility: "private",
      defaultBranch: "main",
      empty: false,
    });
    expect((await api.hosts.branches(ref)).items.map((b) => b.name)).toEqual(["main"]);
    const tree = await api.hosts.tree({ ...ref, ref: "main" });
    expect(tree.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:src", "file:README.md"]);
    const file = await api.hosts.file({ ...ref, ref: "main", path: "src/a.ts" });
    expect(file.text).toBe("export const a = 2;\n");
    expect((await api.hosts.readme({ ...ref, ref: "main" }))?.text).toContain("# site");
    const commits = await api.hosts.commits({ ...ref, branch: "main" });
    expect(commits.items.map((c) => c.title)).toEqual(["Two", "First"]);
    const two = await api.hosts.commit({ ...ref, sha: commits.items[0]?.sha as string });
    expect(two.message).toBe("Two\n\nThe second commit.");
    expect(two.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", status: "modified", additions: 1, deletions: 1 }),
    ]);

    // A new project from a new GitLab repo: created, cloned through Oraknid's credentials, linked.
    const parent = tmp("oraknid-hosts-parent-");
    const p = await api.projects.createFrom({
      source: {
        kind: "github-new",
        host: id,
        parent,
        name: "piano",
        private: true,
        description: "",
      },
    });
    expect(p.github).toMatchObject({
      host: id,
      account: "me",
      owner: "me",
      name: "piano",
      visibility: "private",
      ready: true,
    });
    expect(host.gitAuth.length).toBeGreaterThan(0);
    expect(host.gitAuth.every((a) => a.user === "oauth2" && a.ok)).toBe(true);
    // The token is in no remote nor config of the clone.
    const config = execFileSync("git", ["config", "--list"], {
      cwd: p.workspacePath,
      encoding: "utf8",
    });
    expect(config).not.toContain(GL_TOKEN);

    // The github tool on a GitLab link: a branch pushed, a merge request opened.
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: p.workspacePath });
    commit(p.workspacePath, "keys.ts", "export const keys = 88;\n", "Keys");
    const jobId = jobIn(daemon, p.id, "feature");
    const deps = {
      db: daemon.db,
      bus: daemon.bus,
      github: daemon.github,
      projects: daemon.projects,
    };
    expect(judgeGitHub(daemon.db, jobId, "push", {})).toEqual({ linked: "push" });
    const info = await githubCall(deps, jobId, "repo_info", {});
    expect(info).toContain(`through the account me on ${id}`);
    const pushed = await githubCall(deps, jobId, "push", { branch: "feature" });
    expect(pushed).toContain("Pushed feature to me/piano");
    expect(pushed).not.toContain(GL_TOKEN);
    const head = execFileSync("git", ["rev-parse", "feature"], {
      cwd: p.workspacePath,
      encoding: "utf8",
    }).trim();
    expect(
      execFileSync("git", ["rev-parse", "feature"], {
        cwd: host.bare("me/piano"),
        encoding: "utf8",
      }).trim(),
    ).toBe(head);
    const mr = await githubCall(deps, jobId, "open_pull_request", {
      head: "feature",
      title: "Keys",
    });
    expect(mr).toMatch(/Opened pull request #1: .*merge_requests\/1/);
    expect(host.mergeRequests[0]).toMatchObject({ source: "feature", target: "main" });
    // CI stays GitHub's: a GitLab link's pipelines aren't read, said so (ADR-058).
    await expect(githubCall(deps, jobId, "ci_runs", {})).rejects.toThrow(/GitHub Actions only/);
    expect(
      (
        await runBuiltinCheck("oraknid github-ci main", {
          github: daemon.github,
          link: p.github,
          localCommit: () => null,
        })
      )?.output,
    ).toContain("GitHub Actions only");

    // The merge request read on the Repos page, with its commit and diff.
    const prRef = { host: id, owner: "me", name: "piano" };
    expect((await api.hosts.pulls({ ...prRef, state: "open" })).items[0]).toMatchObject({
      number: 1,
      head: "feature",
      base: "main",
      state: "open",
    });
    const pull = await api.hosts.pull({ ...prRef, number: 1 });
    expect(pull.commits.map((c) => c.title)).toEqual(["Keys"]);
    expect(pull.files.map((f) => f.path)).toEqual(["keys.ts"]);

    // The built-in checks read the GitLab link the same way.
    const link = p.github;
    const check = (command: string) =>
      runBuiltinCheck(command, {
        github: daemon?.github,
        link,
        localCommit: () => head,
      });
    expect((await check("oraknid github-repo"))?.ok).toBe(true);
    expect((await check("oraknid github-branch feature"))?.ok).toBe(true);
    expect((await check("oraknid github-branch nope"))?.output).toContain("has no branch nope");

    // A new repo in a subgroup, from the Repos page.
    const made = await api.hosts.createRepo({
      host: id,
      owner: "team/web",
      name: "docs",
      private: false,
    });
    expect(made).toEqual({ host: id, account: "me", owner: "team/web", name: "docs" });

    // Nothing ever carried the token: no request line, no event.
    expect(host.hits.join("\n")).not.toContain(GL_TOKEN);
    const events = daemon.db.$client.prepare("select payload from events").all() as {
      payload: string;
    }[];
    expect(events.map((e) => e.payload).join("\n")).not.toContain(GL_TOKEN);

    // Removed: its token leaves the keychain, and the list says nothing of it.
    await api.hosts.removeAccount({ host: id, login: "me" });
    expect(await api.hosts.accounts({})).toEqual([]);
    expect(await daemon.secrets.get(`githost.token.${id}.me`)).toBeUndefined();
  });

  it("Gitea and Forgejo: the flavour named, repos read with their diffs, a clone by its login and token", async () => {
    const { api, host } = await harness("gitea", { forgejo: true });
    const added = await api.hosts.addAccount({ kind: "gitea", url: host.url, token: GT_TOKEN });
    const id = added.host;
    expect((await api.hosts.list())[1]?.label).toBe(`Forgejo (${id})`);
    const list = await api.hosts.repoList({ host: id });
    expect(list.repos.map((r) => r.fullName).sort()).toEqual(["acme/tools", "me/site"]);
    const ref = { host: id, owner: "me", name: "site" };
    const tree = await api.hosts.tree({ ...ref, ref: "main" });
    expect(tree.entries.map((e) => `${e.type}:${e.name}`)).toEqual(["dir:src", "file:README.md"]);
    expect(
      (await api.hosts.tree({ ...ref, ref: "main", recursive: true })).entries.map((e) => e.path),
    ).toContain("src/a.ts");
    expect((await api.hosts.file({ ...ref, ref: "main", path: "README.md" })).text).toContain(
      "Hello.",
    );
    const commits = await api.hosts.commits({ ...ref, branch: "main" });
    const c = await api.hosts.commit({ ...ref, sha: commits.items[0]?.sha as string });
    expect(c.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", additions: 1, deletions: 1 }),
    ]);
    expect(c.files[0]?.patch).toContain("+export const a = 2;");

    // Cloned with the account's login and token through GIT_ASKPASS.
    const parent = tmp("oraknid-hosts-parent-");
    const p = await api.projects.createFrom({
      source: { kind: "github-clone", host: id, parent, fullName: "me/site" },
    });
    expect(p.github).toMatchObject({ host: id, owner: "me", name: "site", visibility: "private" });
    expect(host.gitAuth.some((a) => a.user === "me" && a.ok)).toBe(true);
    expect(host.hits.join("\n")).not.toContain(GT_TOKEN);
  });

  it("keeps adding and removing an account and creating a repo at home for a standard device", () => {
    for (const p of ["/hosts/addAccount", "/hosts/removeAccount", "/hosts/createRepo"])
      expect(remoteAllowed(p)).toBe(false);
    expect(remoteAllowed("/hosts/repoList")).toBe(true);
  });
});
