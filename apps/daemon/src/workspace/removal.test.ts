import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { folderRefusal, folderSize } from "./removal.ts";

// Archiving and deleting a project with my choices (Jobs-and-Projects →
// Archiving and deleting a project): temp folders, a stand-in for GitHub's
// API, and local bare repos as its clone URLs. Nothing real is touched.

let daemon: Daemon | undefined;
let close: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  close?.();
  close = undefined;
});

const tmp = (name: string) => realpathSync(mkdtempSync(join(tmpdir(), `oraknid-rm-${name}-`)));

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.email=me@example.com", "-c", "user.name=Me", ...a], {
    cwd,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

interface FakeRepo {
  owner: string;
  ownerType: "User" | "Organization";
  archived: boolean;
  /** Logins that can see it, and whether each administers it. */
  access: Record<string, boolean>;
}

/**
 * GitHub's API for these calls: /user with the token's scopes, a repo's
 * owner and archived state, DELETE (403 without delete_repo, as GitHub
 * says it) and PATCH archived. Each repo is a bare repo under `web`.
 */
async function fakeGitHub() {
  const web = tmp("web");
  const tokens: Record<string, { login: string; scopes: string | null }> = {
    "me-good-token": { login: "me", scopes: "repo, delete_repo" },
    "work-good-token": { login: "work", scopes: "repo" },
  };
  const repos = new Map<string, FakeRepo>();
  const hits: string[] = [];
  const make = (fullName: string, r: Omit<FakeRepo, "archived">) => {
    const bare = join(web, `${fullName}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    const work = tmp("seed");
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "README.md"), `# ${fullName}\n`);
    git(work, "add", ".");
    git(work, "commit", "-qm", "Initial commit");
    git(work, "branch", "dev");
    git(work, "push", "-q", bare, "main", "dev");
    repos.set(fullName, { ...r, archived: false });
    return `file://${bare}`;
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
      const who = tokens[token];
      hits.push(`${req.method} ${req.url}`);
      if (!who) {
        res.statusCode = 401;
        return res.end('{"message":"Bad credentials"}');
      }
      if (who.scopes !== null) res.setHeader("x-oauth-scopes", who.scopes);
      if (req.url === "/user") return res.end(JSON.stringify({ login: who.login }));
      const m = /^\/repos\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
      const fullName = m ? `${m[1]}/${m[2]}` : "";
      const r = repos.get(fullName);
      if (!m || !r || !(who.login in r.access)) {
        res.statusCode = 404;
        return res.end('{"message":"Not Found"}');
      }
      if (req.method === "GET")
        return res.end(
          JSON.stringify({
            full_name: fullName,
            owner: { login: r.owner, type: r.ownerType },
            archived: r.archived,
            html_url: `https://github.com/${fullName}`,
            permissions: { admin: r.access[who.login] },
          }),
        );
      if (req.method === "DELETE") {
        if (!who.scopes?.includes("delete_repo") || !r.access[who.login]) {
          res.statusCode = 403;
          return res.end('{"message":"Must have admin rights to Repository."}');
        }
        repos.delete(fullName);
        res.statusCode = 204;
        return res.end();
      }
      if (req.method === "PATCH") {
        if (!r.access[who.login]) {
          res.statusCode = 403;
          return res.end('{"message":"Must have admin rights to Repository."}');
        }
        r.archived = !!(JSON.parse(body || "{}") as { archived?: boolean }).archived;
        return res.end(JSON.stringify({ full_name: fullName, archived: r.archived }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return {
    api: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    web: `file://${web}`,
    repos,
    hits,
    make,
  };
}

async function start() {
  const gh = await fakeGitHub();
  const dir = tmp("data");
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
    github: { api: gh.api, web: gh.web },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.github.addAccount({ token: "me-good-token" });
  await api.github.addAccount({ token: "work-good-token" });
  return { api, gh, d: daemon };
}

type Api = Awaited<ReturnType<typeof start>>["api"];

/** A project of one repo, cloned from a "GitHub" repo and linked to it. */
async function oneRepoProject(
  api: Api,
  gh: Awaited<ReturnType<typeof fakeGitHub>>,
  owner = "me",
  name = "site",
) {
  const url = gh.make(`${owner}/${name}`, { owner, ownerType: "User", access: { [owner]: true } });
  const parent = tmp("parent");
  const path = join(parent, name);
  git(parent, "clone", "-q", url, path);
  const p = await api.projects.create({ name, workspacePath: path });
  await api.projects.setGitHub({
    id: p.id,
    link: { account: owner, owner, name, visibility: "private", origin: "existing" },
  });
  return { id: p.id, path, parent };
}

describe("a folder Oraknid may delete", () => {
  const home = tmp("home");
  const data = join(home, ".local", "share", "oraknid");
  const o = (others: { name: string; workspacePath: string }[] = []) => ({
    home,
    keep: [data],
    others,
  });

  it("refuses the root, a top-level folder, home and what holds it, and Oraknid's data", () => {
    expect(folderRefusal("/", o())).toMatch(/top-level/);
    expect(folderRefusal("/usr", o())).toMatch(/top-level/);
    expect(folderRefusal(home, o())).toMatch(/home folder/);
    expect(folderRefusal(join(home, ".."), o())).toMatch(/home folder/);
    expect(folderRefusal(join(home, ".local"), o())).toMatch(/Oraknid's own data/);
    expect(folderRefusal("relative/path", o())).toMatch(/full path/);
    const mine = join(home, "code", "site");
    mkdirSync(mine, { recursive: true });
    expect(folderRefusal(mine, o())).toBeNull();
  });

  it("refuses a folder holding another project's, or inside one, and a symbolic link", () => {
    const root = tmp("nest");
    mkdirSync(join(root, "a", "b"), { recursive: true });
    const others = [{ name: "Inner", workspacePath: join(root, "a", "b") }];
    expect(folderRefusal(join(root, "a"), o(others))).toMatch(
      /holds the folder of the project "Inner"/,
    );
    expect(
      folderRefusal(
        join(root, "a", "b", "c"),
        o([{ name: "Outer", workspacePath: join(root, "a") }]),
      ),
    ).toMatch(/inside the folder of the project "Outer"/);
    symlinkSync(join(root, "a"), join(root, "link"));
    expect(folderRefusal(join(root, "link"), o())).toMatch(/symbolic link/);
  });

  it("measures a folder without following its symbolic links", () => {
    const root = tmp("size");
    writeFileSync(join(root, "a.txt"), "x".repeat(1000));
    const outside = tmp("outside");
    writeFileSync(join(outside, "big.bin"), "y".repeat(100_000));
    symlinkSync(outside, join(root, "out"));
    const s = folderSize(root);
    expect(s.files).toBe(2);
    expect(s.bytes).toBeLessThan(5000);
  });
});

describe("deleting a project with my choices", () => {
  it("removes only Oraknid's records when nothing is ticked, the folder stays", async () => {
    const { api, gh } = await start();
    const { id, path } = await oneRepoProject(api, gh);
    const r = await api.projects.delete({ id });
    expect(r.kept).toBe(false);
    expect(r.steps.map((s) => [s.kind, s.status])).toEqual([["records", "done"]]);
    expect(r.steps[0]?.message).toContain("The folder stays");
    expect(existsSync(join(path, "README.md"))).toBe(true);
    expect((await api.projects.list()).map((p) => p.id)).not.toContain(id);
    expect(gh.repos.has("me/site")).toBe(true);
  });

  it("deletes the folder, worktrees included, and never follows a symbolic link out", async () => {
    const { api, gh, d } = await start();
    const { id, path } = await oneRepoProject(api, gh);
    mkdirSync(join(path, ".oraknid", "worktrees", "J1"), { recursive: true });
    writeFileSync(join(path, ".oraknid", "worktrees", "J1", "work.txt"), "wip\n");
    const outside = tmp("precious");
    writeFileSync(join(outside, "keep.txt"), "mine\n");
    symlinkSync(outside, join(path, "shortcut"));
    const pv = await api.projects.removalPreview({ id });
    expect(pv.folder.exists).toBe(true);
    expect(pv.folder.refused).toBeNull();
    expect(pv.folder.bytes).toBeGreaterThan(0);
    const r = await api.projects.delete({ id, deleteFolder: true });
    expect(r.steps.map((s) => [s.kind, s.status])).toEqual([
      ["folder", "done"],
      ["records", "done"],
    ]);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("mine\n");
    const audit = d.bus.since(0, ["overview"], 500).find((e) => e.type === "project.deleted");
    expect(audit?.payload).toMatchObject({ records: true, folderDeleted: path, githubDeleted: [] });
    expect(JSON.stringify(audit?.payload)).not.toContain("me-good-token");
  });

  it("refuses a folder holding another project's folder, and does nothing", async () => {
    const { api } = await start();
    const outer = tmp("outer");
    git(outer, "init", "-q", "-b", "main");
    const inner = join(outer, "inner");
    mkdirSync(inner);
    git(inner, "init", "-q", "-b", "main");
    const a = await api.projects.create({ name: "Outer", workspacePath: outer });
    await api.projects.create({ name: "Inner", workspacePath: inner });
    expect((await api.projects.removalPreview({ id: a.id })).folder.refused).toMatch(/Inner/);
    await expect(api.projects.delete({ id: a.id, deleteFolder: true })).rejects.toThrow(
      /holds the folder of the project "Inner".*Nothing was done/,
    );
    expect(existsSync(inner)).toBe(true);
    expect((await api.projects.list()).map((p) => p.id)).toContain(a.id);
  });

  it("deletes a GitHub repo with its account's token, said plainly when the token lacks delete_repo", async () => {
    const { api, gh } = await start();
    gh.make("me/web", { owner: "me", ownerType: "User", access: { me: true } });
    gh.make("work/api", { owner: "work", ownerType: "User", access: { work: true } });
    const root = tmp("several");
    git(root, "clone", "-q", `${gh.web}/me/web.git`, join(root, "web"));
    git(root, "clone", "-q", `${gh.web}/work/api.git`, join(root, "api"));
    const p = await api.projects.create({ name: "Shop", workspacePath: root });
    expect(p.repos.map((r) => r.name).sort()).toEqual(["api", "web"]);
    const link = (account: string, name: string) => ({
      account,
      owner: account,
      name,
      visibility: "private" as const,
      origin: "existing" as const,
    });
    await api.projects.setGitHub({ id: p.id, link: link("me", "web"), repo: "web" });
    await api.projects.setGitHub({ id: p.id, link: link("work", "api"), repo: "api" });

    const pv = await api.projects.removalPreview({ id: p.id });
    const byName = Object.fromEntries(pv.repos.map((r) => [r.name, r.github]));
    expect(byName.web).toMatchObject({
      owned: true,
      canDelete: true,
      scopes: ["repo", "delete_repo"],
    });
    expect(byName.api).toMatchObject({ owned: true, canDelete: false, scopes: ["repo"] });

    const r = await api.projects.delete({
      id: p.id,
      deleteFolder: true,
      deleteRepos: ["me/web", "work/api"],
    });
    expect(r.kept).toBe(true);
    expect(r.steps.map((s) => [s.kind, s.target, s.status])).toEqual([
      ["github-delete", "me/web", "done"],
      ["github-delete", "work/api", "failed"],
      ["folder", root, "skipped"],
      ["records", "Shop", "skipped"],
    ]);
    expect(r.steps[1]?.message).toMatch(/hasn't the permission to delete repositories/);
    expect(r.steps[1]?.message).toMatch(/delete_repo/);
    expect(gh.repos.has("me/web")).toBe(false);
    expect(gh.repos.has("work/api")).toBe(true);
    expect(existsSync(root)).toBe(true);
    // The deleted repo's link went with it: trying again only asks for the rest.
    const after = (await api.projects.get({ id: p.id })).repos.find((x) => x.name === "web");
    expect(after?.github).toBeNull();
    await expect(api.projects.delete({ id: p.id, deleteRepos: ["me/web"] })).rejects.toThrow(
      /isn't a GitHub repo linked to this project/,
    );
  });

  it("never touches a repo the account doesn't own", async () => {
    const { api, gh } = await start();
    const url = gh.make("someone/lib", {
      owner: "someone",
      ownerType: "User",
      access: { me: false },
    });
    const parent = tmp("parent");
    git(parent, "clone", "-q", url, join(parent, "lib"));
    const p = await api.projects.create({ name: "lib", workspacePath: join(parent, "lib") });
    await api.projects.setGitHub({
      id: p.id,
      link: {
        account: "me",
        owner: "someone",
        name: "lib",
        visibility: "public",
        origin: "existing",
      },
    });
    const r = await api.projects.delete({ id: p.id, deleteRepos: ["someone/lib"] });
    expect(r.steps[0]).toMatchObject({ kind: "github-delete", status: "failed" });
    expect(r.steps[0]?.message).toMatch(/isn't owned by me/);
    expect(gh.hits.some((h) => h.startsWith("DELETE"))).toBe(false);
    expect(gh.repos.has("someone/lib")).toBe(true);
  });
});

describe("archiving a project with my choices", () => {
  it("archives its GitHub repo, keeps everything, and unarchives it on GitHub when I tick it", async () => {
    const { api, gh } = await start();
    const { id, path } = await oneRepoProject(api, gh);
    const r = await api.projects.archive({ id, archived: true, archiveRepos: ["me/site"] });
    expect(r.steps.map((s) => [s.kind, s.status])).toEqual([
      ["github-archive", "done"],
      ["archive", "done"],
    ]);
    expect(gh.repos.get("me/site")?.archived).toBe(true);
    const p = await api.projects.get({ id });
    expect(p.archivedAt).toBeTruthy();
    expect(p.archivedWith).toEqual({ githubArchived: ["me/site"], folderDeleted: false });
    expect(existsSync(path)).toBe(true);
    const back = await api.projects.archive({ id, archived: false, unarchiveRepos: ["me/site"] });
    expect(back.steps.map((s) => [s.kind, s.status])).toEqual([
      ["github-unarchive", "done"],
      ["archive", "done"],
    ]);
    expect(gh.repos.get("me/site")?.archived).toBe(false);
    const again = await api.projects.get({ id });
    expect(again.archivedAt).toBeNull();
    expect(again.archivedWith).toBeNull();
  });

  it("refuses to delete the folder while something isn't committed or pushed, and says what", async () => {
    const { api, gh } = await start();
    const { id, path } = await oneRepoProject(api, gh);
    writeFileSync(join(path, "draft.md"), "not committed\n");
    let pv = await api.projects.removalPreview({ id });
    expect(pv.archiveFolder.allowed).toBe(false);
    expect(pv.archiveFolder.reasons.join(" ")).toMatch(
      /1 file changed and not committed \(draft\.md\)/,
    );
    await expect(api.projects.archive({ id, archived: true, deleteFolder: true })).rejects.toThrow(
      /draft\.md.*Nothing was done/,
    );
    git(path, "add", ".");
    git(path, "commit", "-qm", "Draft");
    git(path, "checkout", "-q", "-b", "idea");
    writeFileSync(join(path, "idea.md"), "x\n");
    git(path, "add", ".");
    git(path, "commit", "-qm", "Idea");
    pv = await api.projects.removalPreview({ id });
    expect(pv.archiveFolder.reasons.join(" ")).toMatch(
      /commits not on GitHub, on (main \(1\), idea \(2\)|idea \(2\), main \(1\))/,
    );
    expect((await api.projects.get({ id })).archivedAt).toBeNull();
    expect(existsSync(path)).toBe(true);
  });

  it("refuses when a repo isn't linked to GitHub: nothing could bring it back", async () => {
    const { api } = await start();
    const path = tmp("local");
    git(path, "init", "-q", "-b", "main");
    const p = await api.projects.create({ name: "local", workspacePath: path });
    const pv = await api.projects.removalPreview({ id: p.id });
    expect(pv.archiveFolder.allowed).toBe(false);
    expect(pv.archiveFolder.reasons.join(" ")).toMatch(/isn't linked to a GitHub repo/);
  });

  it("deletes a clean, pushed folder, then clones it back in the same layout when unarchived", async () => {
    const { api, gh, d } = await start();
    gh.make("me/web", { owner: "me", ownerType: "User", access: { me: true } });
    gh.make("me/api", { owner: "me", ownerType: "User", access: { me: true } });
    const root = join(tmp("layout"), "shop");
    mkdirSync(join(root, "apps"), { recursive: true });
    git(root, "clone", "-q", `${gh.web}/me/web.git`, join(root, "apps", "web"));
    git(root, "clone", "-q", `${gh.web}/me/api.git`, join(root, "api"));
    const p = await api.projects.create({ name: "Shop", workspacePath: root });
    for (const [repo, name] of [
      ["web", "web"],
      ["api", "api"],
    ] as const)
      await api.projects.setGitHub({
        id: p.id,
        repo,
        link: { account: "me", owner: "me", name, visibility: "private", origin: "existing" },
      });
    const pv = await api.projects.removalPreview({ id: p.id });
    expect(pv.archiveFolder).toEqual({ allowed: true, reasons: [] });

    const r = await api.projects.archive({ id: p.id, archived: true, deleteFolder: true });
    expect(r.steps.map((s) => [s.kind, s.status])).toEqual([
      ["folder", "done"],
      ["archive", "done"],
    ]);
    expect(existsSync(root)).toBe(false);
    expect((await api.projects.get({ id: p.id })).archivedWith).toEqual({
      githubArchived: [],
      folderDeleted: true,
    });

    const back = await api.projects.archive({ id: p.id, archived: false });
    expect(back.steps.map((s) => [s.kind, s.status])).toEqual([
      ["restore", "done"],
      ["restore", "done"],
      ["archive", "done"],
    ]);
    expect(readFileSync(join(root, "apps", "web", "README.md"), "utf8")).toBe("# me/web\n");
    expect(readFileSync(join(root, "api", "README.md"), "utf8")).toBe("# me/api\n");
    // Its branches are there again, as they were.
    expect(git(join(root, "api"), "branch", "--list", "dev").trim()).toContain("dev");
    expect((await api.projects.get({ id: p.id })).archivedAt).toBeNull();
    const progress = d.bus
      .since(0, ["overview"], 500)
      .filter(
        (e) => e.type === "project.restoring" && (e.payload as { state: string }).state === "done",
      );
    expect(progress.length).toBe(2);
  });

  it("stays archived when the folder can't be brought back", async () => {
    const { api, gh } = await start();
    const { id, path } = await oneRepoProject(api, gh);
    await api.projects.archive({ id, archived: true, deleteFolder: true });
    expect(existsSync(path)).toBe(false);
    gh.repos.delete("me/site");
    spawnSync("rm", ["-rf", join(gh.web.slice("file://".length), "me", "site.git")]);
    const back = await api.projects.archive({ id, archived: false });
    expect(back.steps.map((s) => [s.kind, s.status])).toEqual([
      ["restore", "failed"],
      ["archive", "skipped"],
    ]);
    expect((await api.projects.get({ id })).archivedAt).toBeTruthy();
  });
});
