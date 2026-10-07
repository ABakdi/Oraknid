import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The release script (ADR-047, ADR-058), in a repository of its own: never
// this one, never the real GitHub (a stand-in answers), and the token from
// git's credential helper never printed.

const SCRIPT = fileURLToPath(new URL("../../../scripts/release.mjs", import.meta.url));
const TOKEN = "sekret-token-123";
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function sandbox() {
  const base = mkdtempSync(join(tmpdir(), "oraknid-release-"));
  dirs.push(base);
  const home = join(base, "home");
  mkdirSync(home);
  // Only this test's git config: a name, and a credential helper that answers with a token.
  writeFileSync(
    join(home, ".gitconfig"),
    `[user]\n\tname = Me\n\temail = me@example.com\n[init]\n\tdefaultBranch = dev\n[credential]\n\thelper = "!f() { echo username=x-access-token; echo password=${TOKEN}; }; f"\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  const repo = join(base, "repo");
  mkdirSync(join(repo, "packages", "a"), { recursive: true });
  const git = (...a: string[]) => {
    const r = spawnSync("git", a, { cwd: repo, env, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git("init", "--quiet", "-b", "dev");
  writeFileSync(join(repo, "package.json"), '{\n  "name": "x",\n  "version": "0.1.0"\n}\n');
  writeFileSync(
    join(repo, "packages", "a", "package.json"),
    '{\n  "name": "a",\n  "version": "0.1.0",\n  "dependencies": { "b": "1.0.0" }\n}\n',
  );
  writeFileSync(join(repo, "install.sh"), '#!/bin/sh\nREPO="x"\nREF="main"\necho "$REF"\n');
  writeFileSync(
    join(repo, "CHANGELOG.md"),
    "# Changelog\n\n## 0.2.0 — 2026-10-07 (pre-release)\n\nCI inside Oraknid.\n\n- runs and logs\n\n## 0.1.0 — 2026-10-01\n\nThe first.\n",
  );
  git("add", ".");
  git("commit", "--quiet", "-m", "start");
  const run = (...a: string[]) => {
    const r = spawnSync("node", [SCRIPT, ...a], {
      cwd: repo,
      // Nowhere: a run without --publish asks GitHub nothing.
      env: { ...env, ORAKNID_GITHUB_API: "http://127.0.0.1:9" },
      encoding: "utf8",
    });
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  };
  return { base, repo, env, git, run };
}

describe("the release script (ADR-047, ADR-058)", () => {
  it("says what it would do on a dry run, and changes nothing", () => {
    const s = sandbox();
    const r = s.run("0.2.0", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("Release v0.2.0 (dry run: nothing is changed)");
    expect(r.out).toContain("every package.json to 0.2.0: package.json, packages/a/package.json");
    expect(r.out).toContain('commit "release: v0.2.0" on dev, annotated tag v0.2.0');
    expect(r.out).toContain("notes: CI inside Oraknid.");
    expect(readFileSync(join(s.repo, "package.json"), "utf8")).toContain('"version": "0.1.0"');
    expect(s.git("tag")).toBe("");
    expect(s.git("status", "--porcelain")).toBe("");
    expect(existsSync(join(s.repo, "dist"))).toBe(false);
  });

  it("builds only the assets for a tag already made (release.yml)", () => {
    const s = sandbox();
    expect(s.run("0.1.0", "--assets-only").code).toBe(0);
    const dir = join(s.repo, "dist", "release", "v0.1.0");
    expect(readFileSync(join(dir, "install.sh"), "utf8")).toContain('REF="v0.1.0"');
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("The first.\n");
    expect(s.git("tag")).toBe("");
  });

  it("refuses without the CHANGELOG's section, with changes in the tree, or off dev", () => {
    const s = sandbox();
    expect(s.run("0.9.9", "--dry-run").out).toContain('CHANGELOG.md has no section "## 0.9.9"');
    writeFileSync(join(s.repo, "install.sh"), "changed\n");
    expect(s.run("0.2.0").out).toContain("the tree has changes");
    s.git("checkout", "--quiet", "--", "install.sh");
    s.git("checkout", "--quiet", "-b", "main");
    expect(s.run("0.2.0").out).toContain("releases are made on dev, not main");
    expect(s.run("nope").code).toBe(1);
  });

  it("bumps, commits, tags and builds the pinned install.sh and SHA256SUMS", () => {
    const s = sandbox();
    const r = s.run("0.2.0", "--title", "CI inside Oraknid");
    expect(r.code).toBe(0);
    for (const f of ["package.json", "packages/a/package.json"])
      expect(readFileSync(join(s.repo, f), "utf8")).toContain('"version": "0.2.0"');
    // A dependency's version is left alone.
    expect(readFileSync(join(s.repo, "packages/a/package.json"), "utf8")).toContain('"b": "1.0.0"');
    expect(s.git("log", "-1", "--format=%s")).toBe("release: v0.2.0, CI inside Oraknid");
    expect(s.git("cat-file", "-t", "v0.2.0")).toBe("tag");
    expect(s.git("tag", "-l", "--format=%(contents)", "v0.2.0")).toContain("CI inside Oraknid.");
    const dir = join(s.repo, "dist", "release", "v0.2.0");
    const script = readFileSync(join(dir, "install.sh"), "utf8");
    expect(script).toContain('REF="v0.2.0"');
    expect(script).not.toContain('REF="main"');
    const sum = createHash("sha256").update(script).digest("hex");
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe(`${sum}  install.sh\n`);
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe(
      "CI inside Oraknid.\n\n- runs and logs\n",
    );
    // The same release twice is refused.
    expect(s.run("0.2.0").out).toContain("v0.2.0 exists already");
  });

  it("publishes: pushes, makes the pre-release with its notes and assets, moves main, never prints the token", async () => {
    const s = sandbox();
    const origin = join(s.base, "origin.git");
    spawnSync("git", ["init", "--quiet", "--bare", origin], { env: s.env });
    s.git("remote", "add", "origin", origin);
    s.git("push", "--quiet", "origin", "dev", "dev:main");
    const seen: { method: string; path: string; auth: string; body: string }[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => {
        body += d;
      });
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        seen.push({
          method: req.method ?? "",
          path: `${url.pathname}${url.search}`,
          auth: req.headers.authorization ?? "",
          body,
        });
        res.setHeader("content-type", "application/json");
        if (url.pathname === "/repos/me/piano/releases") {
          res.statusCode = 201;
          return res.end(
            JSON.stringify({
              id: 7,
              html_url: "https://github.com/me/piano/releases/tag/v0.2.0",
              upload_url: `http://${req.headers.host}/uploads/repos/me/piano/releases/7/assets{?name,label}`,
            }),
          );
        }
        res.statusCode = 201;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const address = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const r = await runAsync(["0.2.0", "--publish", "--repo", "me/piano"], {
        cwd: s.repo,
        env: { ...s.env, ORAKNID_GITHUB_API: address },
      });
      expect(r.out).not.toContain(TOKEN);
      expect(r.code).toBe(0);
      expect(r.out).toContain("main is at v0.2.0.");
      const made = seen.find((x) => x.path === "/repos/me/piano/releases");
      expect(made?.auth).toBe(`Bearer ${TOKEN}`);
      expect(JSON.parse(made?.body ?? "{}")).toEqual({
        tag_name: "v0.2.0",
        name: "Oraknid v0.2.0",
        body: "CI inside Oraknid.\n\n- runs and logs",
        prerelease: true,
        draft: false,
      });
      expect(seen.filter((x) => x.path.startsWith("/uploads/")).map((x) => x.path)).toEqual([
        "/uploads/repos/me/piano/releases/7/assets?name=install.sh",
        "/uploads/repos/me/piano/releases/7/assets?name=SHA256SUMS",
      ]);
      const bare = (...a: string[]) =>
        spawnSync("git", ["--git-dir", origin, ...a], { encoding: "utf8" }).stdout.trim();
      const tagged = s.git("rev-parse", "v0.2.0^{commit}");
      expect(bare("rev-parse", "refs/heads/main")).toBe(tagged);
      expect(bare("rev-parse", "refs/heads/dev")).toBe(tagged);
      expect(bare("rev-parse", "v0.2.0^{commit}")).toBe(tagged);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

/** The script run without blocking this process (the stand-in GitHub answers in it). */
function runAsync(
  a: string[],
  o: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("node", [SCRIPT, ...a], { cwd: o.cwd, env: o.env });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      out += d;
    });
    child.on("close", (code) => resolve({ code, out }));
  });
}
