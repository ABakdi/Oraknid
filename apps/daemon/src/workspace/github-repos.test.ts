import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Router } from "../api/router.ts";
import { remoteAllowed } from "../auth/lock.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { type FakeGitHub, startFakeGitHub } from "../testing/fake-github.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { asText } from "./github-repos.ts";

// Repos (ADR-040): my repositories read through GitHub's API, against a stand-in.

let daemon: Daemon | undefined;
let gh: FakeGitHub | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await daemon?.close();
  daemon = undefined;
  await gh?.close();
  gh = undefined;
});

async function harness(o: { fillerRepos?: number } = {}) {
  gh = await startFakeGitHub(o);
  const dir = mkdtempSync(join(tmpdir(), "oraknid-repos-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: {},
    github: { api: gh.api },
  });
  const api = createORPCClient<RouterClient<Router>>(
    new RPCLink({
      url: `${daemon.url}/api`,
      headers: { authorization: `Bearer ${daemon.cliToken}` },
    }),
  );
  await api.github.addAccount({ token: "good-token" });
  await api.github.addAccount({ token: "work-token" });
  const folder = mkdtempSync(join(tmpdir(), "oraknid-repos-piano-"));
  const project = await api.projects.create({
    name: "Piano",
    workspacePath: folder,
    initGit: true,
  });
  await api.projects.setGitHub({
    id: project.id,
    link: { account: "me", owner: "me", name: "piano", visibility: "public", origin: "existing" },
  });
  return { api, gh, projectId: project.id };
}

const piano = { owner: "me", name: "piano" };
const reads = (g: FakeGitHub, part: string) => g.hits.filter((h) => h.includes(part)).length;

describe("Repos (ADR-040)", () => {
  it("lists every account's repositories once, paged from GitHub, with what the list shows", async () => {
    const { api, gh, projectId } = await harness({ fillerRepos: 150 });
    const all = await api.github.repoList({});
    expect(all.errors).toEqual([]);
    expect(all.truncated).toBe(false);
    // 153 of mine (two pages of 100) and acme/site; me/piano seen by both accounts, listed once.
    expect(all.repos).toHaveLength(154);
    expect(gh.hits).toContain(
      "GET /user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=2",
    );
    const p = all.repos.find((r) => r.fullName === "me/piano");
    expect(p).toMatchObject({
      account: "me",
      visibility: "public",
      defaultBranch: "main",
      pushedAt: "2026-10-02T00:00:00.000Z",
      description: "A small piano in the browser",
      url: "https://github.com/me/piano",
      project: { id: projectId, name: "Piano" },
    });
    expect(all.repos[0]?.fullName).toBe("me/piano");
    expect(all.repos.find((r) => r.fullName === "acme/site")).toMatchObject({
      account: "work",
      visibility: "private",
      defaultBranch: "trunk",
      project: null,
    });
    expect(all.repos.find((r) => r.fullName === "me/empty")?.pushedAt).toBeNull();
    // One account's.
    const work = await api.github.repoList({ account: "work" });
    expect(work.repos.map((r) => `${r.account}:${r.fullName}`)).toEqual([
      "work:me/piano",
      "work:acme/site",
    ]);
    // New work's picker takes an empty repository too (nothing pushed: no time).
    expect((await api.github.repos()).find((r) => r.fullName === "me/empty")?.updatedAt).toBeNull();
    await expect(api.github.repoList({ account: "nobody" })).rejects.toThrow(
      /No GitHub account nobody/,
    );
  });

  it("reads a repository: info, branches, tree, files, README, commits and pull requests", async () => {
    const { api } = await harness();
    const info = await api.github.repoInfo(piano);
    expect(info).toMatchObject({ fullName: "me/piano", stars: 7, empty: false, account: "me" });
    expect((await api.github.repoInfo({ owner: "me", name: "empty" })).empty).toBe(true);
    // Read through the account that can see it: acme/site only through "work".
    expect((await api.github.repoInfo({ owner: "acme", name: "site" })).account).toBe("work");

    const branches = await api.github.branches(piano);
    expect(branches.items.map((b) => b.name)).toEqual(["main", "dev", "feature/keys"]);
    expect(branches.items[0]?.protected).toBe(true);

    const root = await api.github.tree({ ...piano, ref: "main" });
    // Folders first, then files, by name.
    expect(root.entries.map((e) => `${e.type}:${e.name}`)).toEqual([
      "dir:assets",
      "dir:src",
      "file:package.json",
      "file:README.md",
    ]);
    const src = await api.github.tree({ ...piano, ref: "feature/keys", path: "src" });
    expect(src.entries.map((e) => e.path)).toEqual(["src/app.ts", "src/tune.ts"]);
    const deep = await api.github.tree({ ...piano, ref: "main", recursive: true });
    expect(deep.entries.find((e) => e.path === "src")?.type).toBe("dir");
    expect(deep.entries.find((e) => e.path === "src/app.ts")?.type).toBe("file");

    const app = await api.github.file({ ...piano, ref: "main", path: "src/app.ts" });
    expect(app.text).toContain("export function play");
    expect(app).toMatchObject({ binary: false, tooLarge: false });
    const logo = await api.github.file({ ...piano, ref: "main", path: "assets/logo.png" });
    expect(logo).toMatchObject({ text: null, binary: true, tooLarge: false });
    const big = await api.github.file({ ...piano, ref: "main", path: "assets/samples.bin" });
    expect(big).toMatchObject({ text: null, binary: false, tooLarge: true });
    expect(big.size).toBe(600 * 1024);
    await expect(api.github.file({ ...piano, ref: "main", path: "src" })).rejects.toThrow(
      /a folder/,
    );

    expect((await api.github.readme({ ...piano, ref: "main" }))?.text).toContain("# Piano");
    expect(await api.github.readme({ owner: "me", name: "empty", ref: "main" })).toBeNull();

    // A branch's history, 30 a page.
    const first = await api.github.commits({ ...piano, branch: "main" });
    expect(first.items).toHaveLength(30);
    expect(first.next).toBe(true);
    expect(first.items[0]).toMatchObject({
      title: "Play a scale one note a beat",
      author: { name: "Me Myself", login: "me" },
    });
    const second = await api.github.commits({ ...piano, branch: "main", page: 2 });
    expect(second.items).toHaveLength(15);
    expect(second.next).toBe(false);
    expect(
      (await api.github.commits({ owner: "me", name: "empty", branch: "main" })).items,
    ).toEqual([]);

    const commit = await api.github.commit({ ...piano, sha: first.items[0]?.sha ?? "" });
    expect(commit.message).toContain("The metronome sets the tempo.");
    expect(commit.files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/tune.ts",
      "assets/logo.png",
    ]);
    expect(commit.files[0]?.patch).toContain("+export function play(notes: string[]): void {");
    // A binary file has no patch.
    expect(commit.files[2]?.patch).toBeNull();
    expect(commit).toMatchObject({ additions: 7, deletions: 2 });

    const open = await api.github.pulls({ ...piano, state: "open" });
    expect(open.items.map((x) => `${x.number}:${x.state}:${x.head}`)).toEqual(["2:open:metronome"]);
    const closed = await api.github.pulls({ ...piano, state: "closed" });
    expect(closed.items.map((x) => `${x.number}:${x.state}`)).toEqual(["1:merged"]);
    const pr = await api.github.pull({ ...piano, number: 2 });
    expect(pr.body).toContain("**metronome**");
    expect(pr.commits).toHaveLength(2);
    expect(pr.files.map((f) => f.path)).toEqual(["src/app.ts", "src/tune.ts"]);
    expect(pr.truncated).toBe(false);

    await expect(api.github.repoInfo({ owner: "someone", name: "else" })).rejects.toThrow(
      /GitHub has no such thing in someone\/else, or me's token can't read it/,
    );
  });

  it("keeps a read a minute, then asks again with the ETag and an unchanged answer costs nothing", async () => {
    const { api, gh } = await harness();
    vi.useFakeTimers({ toFake: ["Date"] });
    await api.github.tree({ ...piano, ref: "main" });
    await api.github.tree({ ...piano, ref: "main" });
    expect(reads(gh, "/contents/?ref=main")).toBe(1);
    const left = (await api.github.limits()).find((l) => l.account === "me")?.remaining ?? 0;
    vi.setSystemTime(Date.now() + 61_000);
    const again = await api.github.tree({ ...piano, ref: "main" });
    expect(again.entries).toHaveLength(4);
    expect(reads(gh, "/contents/?ref=main")).toBe(2);
    // The 304 left the allowance as it was.
    expect((await api.github.limits()).find((l) => l.account === "me")?.remaining).toBe(left);
    // A repository I create is listed at once: what was kept is forgotten.
    await api.github.repoList({ account: "me" });
    const made = await api.github.createRepo({ name: "violin", private: true });
    expect(made).toEqual({ account: "me", owner: "me", name: "violin" });
    expect(
      (await api.github.repoList({ account: "me" })).repos.some((r) => r.fullName === "me/violin"),
    ).toBe(true);
  });

  it("says GitHub's limits in plain words", async () => {
    const { api, gh } = await harness();
    await api.github.repoInfo(piano);
    const limits = await api.github.limits();
    expect(limits.find((l) => l.account === "me")).toMatchObject({ limit: 5000 });
    expect(limits.find((l) => l.account === "me")?.words).toMatch(
      /^4,99\d of 5,000 requests left this hour; full again at \d\d:\d\d, in (29|30) minutes\.$/,
    );
    gh.setRemaining("me", 0);
    await expect(api.github.branches(piano)).rejects.toThrow(
      /GitHub's hourly allowance for me is used up \(5000 requests\); it fills again at \d\d:\d\d, in (29|30) minutes\./,
    );
    expect((await api.github.limits()).find((l) => l.account === "me")?.words).toMatch(
      /^None of 5,000 requests left this hour/,
    );
    // The list says which account it couldn't read, and still shows the others.
    const all = await api.github.repoList({});
    expect(all.errors).toEqual([
      { account: "me", error: expect.stringMatching(/allowance for me is used up/) },
    ]);
    expect(all.repos.map((r) => r.fullName)).toContain("acme/site");
    // Backing off (ADR-058): until it fills again, nothing more is asked of GitHub with that
    // account; what was read is served as it was, the rest refused in the same words.
    gh.setRemaining("me", 100);
    const asked = gh.hits.length;
    expect((await api.github.repoInfo(piano)).fullName).toBe("me/piano");
    await expect(api.github.commits({ ...piano, branch: "dev" })).rejects.toThrow(
      /allowance for me is used up/,
    );
    expect(gh.hits.length).toBe(asked);
    gh.slowDown(30);
    await expect(
      api.github.commits({ owner: "acme", name: "site", account: "work", branch: "trunk" }),
    ).rejects.toThrow("GitHub asks Oraknid to slow down for work: try again in 30 seconds.");
  });

  it("never sends a token to the browser", async () => {
    const { api } = await harness();
    const said = JSON.stringify([
      await api.github.accounts({ check: true }),
      await api.github.repoList({}),
      await api.github.repoInfo(piano),
      await api.github.branches(piano),
      await api.github.tree({ ...piano, ref: "main" }),
      await api.github.file({ ...piano, ref: "main", path: "src/app.ts" }),
      await api.github.readme({ ...piano, ref: "main" }),
      await api.github.commits({ ...piano, branch: "main" }),
      await api.github.pulls({ ...piano, state: "open" }),
      await api.github.pull({ ...piano, number: 2 }),
      await api.github.limits(),
      await api.github.repoInfo({ owner: "nope", name: "nope" }).catch((e: Error) => e.message),
    ]);
    expect(said).not.toMatch(/good-token|work-token/);
  });

  it("reads away from home; creating and linking stay at home", () => {
    for (const read of [
      "/github/repoList",
      "/github/repoInfo",
      "/github/tree",
      "/github/file",
      "/github/commits",
      "/github/pull",
      "/github/limits",
    ])
      expect(remoteAllowed(read)).toBe(true);
    for (const change of [
      "/github/createRepo",
      "/github/addAccount",
      "/github/removeAccount",
      "/projects/setGitHub",
    ]) {
      expect(remoteAllowed(change)).toBe(false);
      // A device with full rights may (ADR-030).
      expect(remoteAllowed(change, true)).toBe(true);
    }
  });

  it("tells text from binary", () => {
    expect(asText(new TextEncoder().encode("héllo"))).toBe("héllo");
    expect(asText(new Uint8Array([0x68, 0, 0x69]))).toBeNull();
    expect(asText(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull();
  });
});
