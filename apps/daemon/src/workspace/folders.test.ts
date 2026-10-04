import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterClient } from "@orpc/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Router } from "../api/router.ts";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { expandPath, listFolders, makeFolder } from "./folders.ts";

// The folder picker (Web-UI → The folder picker): folders by name, never a
// file, a repo marked, refusals in words.

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oraknid-folders-"));
  home = join(root, "home");
  mkdirSync(join(home, "code", "piano", ".git"), { recursive: true });
  mkdirSync(join(home, "code", "Notes"));
  mkdirSync(join(home, "code", "app"));
  // A worktree's or submodule's .git is a file: still a repo.
  writeFileSync(join(home, "code", "app", ".git"), "gitdir: /elsewhere\n");
  mkdirSync(join(home, "code", ".cache"));
  writeFileSync(join(home, "code", "secret.txt"), "never listed");
});

afterEach(() => {
  chmodSync(root, 0o755);
  rmSync(root, { recursive: true, force: true });
});

const names = (l: { entries: { name: string }[] }) => l.entries.map((e) => e.name);

describe("listing a folder's folders", () => {
  it("starts at my home, and lists folders only, sorted, repos marked", () => {
    const l = listFolders({}, home);
    expect(l.path).toBe(home);
    expect(l.home).toBe(home);
    expect(names(l)).toEqual(["code"]);
    const code = listFolders({ path: join(home, "code") }, home);
    expect(names(code)).toEqual(["app", "Notes", "piano"]);
    expect(code.entries.find((e) => e.name === "piano")?.isGitRepo).toBe(true);
    expect(code.entries.find((e) => e.name === "app")?.isGitRepo).toBe(true);
    expect(code.entries.find((e) => e.name === "Notes")?.isGitRepo).toBe(false);
    expect(code.parent).toBe(home);
    expect(code.writable).toBe(true);
    expect(code.isGitRepo).toBe(false);
    expect(JSON.stringify(code)).not.toContain("secret.txt");
  });

  it("leaves hidden folders out unless asked, and counts them", () => {
    const code = join(home, "code");
    expect(listFolders({ path: code }, home).hidden).toBe(1);
    const all = listFolders({ path: code, showHidden: true }, home);
    expect(names(all)).toContain(".cache");
    expect(all.hidden).toBe(0);
  });

  it("takes ~ for my home, and has no parent above /", () => {
    expect(listFolders({ path: "~/code" }, home).path).toBe(join(home, "code"));
    expect(expandPath("~", home)).toBe(home);
    expect(listFolders({ path: "/" }, home).parent).toBeNull();
  });

  it("lists a link to a folder as a link, and leaves a broken one out", () => {
    symlinkSync(join(home, "code", "piano"), join(home, "piano-link"));
    symlinkSync(join(root, "gone"), join(home, "broken"));
    symlinkSync(join(home, "code", "secret.txt"), join(home, "file-link"));
    const l = listFolders({}, home);
    expect(names(l)).toEqual(["code", "piano-link"]);
    const link = l.entries.find((e) => e.name === "piano-link");
    expect(link).toMatchObject({ symlink: true, isGitRepo: true, path: join(home, "piano-link") });
  });

  it("refuses, in words, a path that isn't there, a file, or one that isn't full", () => {
    expect(() => listFolders({ path: join(home, "nope") }, home)).toThrow(/doesn't exist/);
    expect(() => listFolders({ path: join(home, "code", "secret.txt") }, home)).toThrow(
      /is a file, not a folder/,
    );
    expect(() => listFolders({ path: "code" }, home)).toThrow(/Give a full path/);
  });

  it.skipIf(process.getuid?.() === 0)(
    "says a folder it may not read, without crashing, and lists it unopened",
    () => {
      const locked = join(home, "code", "Notes");
      chmodSync(locked, 0o000);
      try {
        const code = listFolders({ path: join(home, "code") }, home);
        expect(code.entries.find((e) => e.name === "Notes")?.readable).toBe(false);
        expect(() => listFolders({ path: locked }, home)).toThrow(/isn't allowed to look in/);
      } finally {
        chmodSync(locked, 0o755);
      }
    },
  );
});

describe("a new folder from the picker", () => {
  it("makes an empty folder, and refuses one that is there", () => {
    const made = makeFolder({ parent: join(home, "code"), name: "site" }, home);
    expect(made.path).toBe(join(home, "code", "site"));
    expect(names(listFolders({ path: join(home, "code") }, home))).toContain("site");
    expect(() => makeFolder({ parent: join(home, "code"), name: "site" }, home)).toThrow(
      /exists already/,
    );
    expect(() => makeFolder({ parent: join(home, "nope"), name: "x" }, home)).toThrow(
      /doesn't exist/,
    );
  });
});

describe("files.folders through the API", () => {
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
  });

  it("asks for the same token as every call, and refuses a missing path in words", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-folders-daemon-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs().os,
      adapters: {},
    });
    const res = await fetch(`${daemon.url}/api/files/folders`, { method: "POST" });
    expect(res.status).toBe(401);
    const api = createORPCClient<RouterClient<Router>>(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    const code = await api.files.folders({ path: join(home, "code") });
    expect(code.entries.map((e) => e.name)).toEqual(["app", "Notes", "piano"]);
    await expect(api.files.folders({ path: join(home, "nope") })).rejects.toThrow(/doesn't exist/);
    const made = await api.files.makeFolder({ parent: join(home, "code"), name: "site" });
    expect(made.path).toBe(join(home, "code", "site"));
    await expect(
      api.files.makeFolder({ parent: join(home, "code"), name: "../out" }),
    ).rejects.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
