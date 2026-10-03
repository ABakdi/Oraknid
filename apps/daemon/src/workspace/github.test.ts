import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

let daemon: Daemon | undefined;
let close: (() => void) | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
  close?.();
});

const git = (cwd: string, ...a: string[]) =>
  spawnSync("git", ["-c", "user.email=me@example.com", "-c", "user.name=Me", ...a], {
    cwd,
    encoding: "utf8",
  });

/** A stand-in for GitHub: its API, and bare repos under `web` for the clone URLs. */
async function fakeGitHub() {
  const web = mkdtempSync(join(tmpdir(), "oraknid-fake-gh-"));
  const repos = new Map<string, boolean>();
  const make = (fullName: string) => {
    const bare = join(web, `${fullName}.git`);
    mkdirSync(bare, { recursive: true });
    git(bare, "init", "-q", "--bare", "-b", "main");
    const work = mkdtempSync(join(tmpdir(), "oraknid-fake-gh-work-"));
    git(work, "init", "-q", "-b", "main");
    writeFileSync(join(work, "README.md"), `# ${fullName}\n`);
    git(work, "add", ".");
    git(work, "commit", "-qm", "Initial commit");
    git(work, "push", "-q", bare, "main");
  };
  make("me/old-site");
  repos.set("me/old-site", false);
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.headers.authorization !== "Bearer good-token") {
      res.statusCode = 401;
      return res.end('{"message":"Bad credentials"}');
    }
    if (req.url === "/user") return res.end('{"login":"me"}');
    if (req.url?.startsWith("/user/repos") && req.method === "GET")
      return res.end(
        JSON.stringify(
          [...repos].map(([fullName, priv]) => ({
            full_name: fullName,
            name: fullName.split("/")[1],
            private: priv,
            description: null,
            pushed_at: "2026-10-02T00:00:00Z",
          })),
        ),
      );
    if (req.url === "/user/repos" && req.method === "POST") {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const b = JSON.parse(body) as { name: string; private: boolean };
        const fullName = `me/${b.name}`;
        if (repos.has(fullName)) {
          res.statusCode = 422;
          return res.end(
            '{"message":"Repository creation failed.","errors":[{"message":"name already exists on this account"}]}',
          );
        }
        repos.set(fullName, b.private);
        make(fullName);
        res.statusCode = 201;
        res.end(
          JSON.stringify({ full_name: fullName, clone_url: `https://github.com/${fullName}.git` }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  close = () => server.close();
  return {
    api: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    web: `file://${web}`,
    repos,
  };
}

describe("GitHub and new projects (ADR-023)", () => {
  it("checks the token, lists repos, creates and clones one, and never writes the token down", async () => {
    const gh = await fakeGitHub();
    const dir = mkdtempSync(join(tmpdir(), "oraknid-gh-"));
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
    expect(await api.github.status()).toEqual({ connected: false, login: null, error: null });
    await expect(api.github.addAccount({ token: "wrong-token-x" })).rejects.toThrow(
      /refused the token/,
    );
    expect(await api.github.addAccount({ token: "good-token" })).toEqual({ login: "me" });
    expect((await api.github.repos()).map((r) => r.fullName)).toEqual(["me/old-site"]);

    const parent = mkdtempSync(join(tmpdir(), "oraknid-gh-parent-"));
    const created = await api.projects.createFrom({
      source: { kind: "github-new", parent, name: "new-site", private: true, description: "" },
    });
    expect(created.name).toBe("new-site");
    expect(readFileSync(join(parent, "new-site", "README.md"), "utf8")).toBe("# me/new-site\n");
    expect(gh.repos.get("me/new-site")).toBe(true);
    // The token is in no file of the clone.
    expect(readFileSync(join(parent, "new-site", ".git", "config"), "utf8")).not.toContain(
      "good-token",
    );
    await expect(
      api.projects.createFrom({
        source: { kind: "github-new", parent, name: "new-site", private: true, description: "" },
      }),
    ).rejects.toThrow(/exists already/);

    const cloned = await api.projects.createFrom({
      source: { kind: "github-clone", parent, fullName: "me/old-site" },
    });
    expect(cloned.name).toBe("old-site");
    const fresh = await api.projects.createFrom({
      source: { kind: "new-folder", parent, name: "blank" },
    });
    expect(fresh.name).toBe("blank");
    expect(existsSync(join(parent, "blank", ".git"))).toBe(true);
    await api.github.removeAccount({ login: "me" });
    expect((await api.github.status()).connected).toBe(false);
  });
});
