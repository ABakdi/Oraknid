#!/usr/bin/env node
// Releases Oraknid (ADR-047, ADR-058).
//
//   node scripts/release.mjs <X.Y.Z> [--title "<words>"] [--dry-run]
//   node scripts/release.mjs <X.Y.Z> --publish [--repo <owner/name>]
//   node scripts/release.mjs <X.Y.Z> --assets-only        (release.yml, on a pushed tag)
//
// Without --publish: checks the tree is clean and on dev and the CHANGELOG
// has the version's section; sets every package.json to the version (and
// the OpenAPI document's, when the canon has one); commits
// "release: vX.Y.Z[, <title>]"; tags vX.Y.Z (annotated); writes
// dist/release/vX.Y.Z/{install.sh (REF="vX.Y.Z"), SHA256SUMS, notes.md}.
// --dry-run says all that and changes nothing.
// --publish then pushes dev and the tag, creates the GitHub release (a
// pre-release before 1.0) with the CHANGELOG section as its notes, uploads
// install.sh and SHA256SUMS, and fast-forwards main to the tag. The token
// comes from git's credential helper (`git credential fill`), is sent only
// to GitHub's API in a header, and is never printed nor put in an argument.
// --assets-only writes the dist folder for a tag already made (nothing else).

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : undefined;
};
const version = args.find((a) => /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(a));
const dry = flag("--dry-run");
const publish = flag("--publish");
const assetsOnly = flag("--assets-only");
const title = option("--title");
const root = process.cwd();
const tag = `v${version}`;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: a script run by hand (its test points it at a stand-in), not a turbo task
const api = process.env.ORAKNID_GITHUB_API ?? "https://api.github.com";

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}
const say = (line) => console.log(line);
const git = (...a) => execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
const gitOk = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" }).status === 0;

if (!version) fail("give the version: node scripts/release.mjs X.Y.Z [--dry-run|--publish]");
if (publish && dry) fail("--dry-run and --publish together: choose one.");

// ── The CHANGELOG's section ───────────────────────────────────────────
/** The lines under "## X.Y.Z", up to the next "## ". */
function changelogSection(text, v) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) =>
    new RegExp(`^## ${v.replaceAll(".", "\\.")}(\\s|$)`).test(l),
  );
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
}
const changelog = existsSync(join(root, "CHANGELOG.md"))
  ? readFileSync(join(root, "CHANGELOG.md"), "utf8")
  : "";
const notes = changelogSection(changelog, version);
if (!notes) fail(`CHANGELOG.md has no section "## ${version}": write it first.`);

// ── The pinned install script and its checksum ────────────────────────
function buildAssets() {
  const script = readFileSync(join(root, "install.sh"), "utf8");
  const pinned = script.replace(/^REF="[^"]*"$/m, `REF="${tag}"`);
  if (pinned === script && !script.includes(`REF="${tag}"`))
    fail('install.sh has no line REF="…" to pin.');
  const dir = join(root, "dist", "release", tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "install.sh"), pinned);
  chmodSync(join(dir, "install.sh"), 0o755);
  const sum = createHash("sha256").update(pinned).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${sum}  install.sh\n`);
  writeFileSync(join(dir, "notes.md"), `${notes}\n`);
  return { dir, sum };
}

if (assetsOnly) {
  const { dir, sum } = buildAssets();
  say(
    `Wrote ${dir}: install.sh (REF="${tag}", sha256 ${sum.slice(0, 12)}…), SHA256SUMS, notes.md.`,
  );
  process.exit(0);
}

// ── Checks before anything changes ────────────────────────────────────
if (git("status", "--porcelain", "--untracked-files=no"))
  fail("the tree has changes: commit or discard them first.");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
if (branch !== "dev") fail(`releases are made on dev, not ${branch}.`);
if (gitOk("rev-parse", "--verify", "--quiet", `refs/tags/${tag}`)) fail(`${tag} exists already.`);

const manifests = git("ls-files", "--", "*package.json")
  .split("\n")
  .filter((f) => f && /(^|\/)package\.json$/.test(f) && !f.includes("node_modules"));
const VERSION_LINE = /^(\s*"version":\s*")[^"]*(")/m;
const openapi = join(root, "docs", "02-Architecture", "openapi.json");
const daemonPkg = join(root, "apps", "daemon", "package.json");
const regenerate =
  existsSync(openapi) &&
  existsSync(daemonPkg) &&
  !!JSON.parse(readFileSync(daemonPkg, "utf8")).scripts?.openapi;
const message = `release: ${tag}${title ? `, ${title}` : ""}`;

say(`Release ${tag}${dry ? " (dry run: nothing is changed)" : ""}`);
say(`- every package.json to ${version}: ${manifests.join(", ")}`);
if (regenerate) say("- the OpenAPI document regenerated (its version)");
say(`- commit "${message}" on dev, annotated tag ${tag}`);
say(`- dist/release/${tag}: install.sh (REF="${tag}"), SHA256SUMS, notes.md`);
if (publish)
  say(`- push dev and ${tag}; the GitHub release with its notes and assets; main to ${tag}`);
say(`- notes: ${notes.split("\n")[0]}`);
if (dry) process.exit(0);

// ── The release commit and tag ────────────────────────────────────────
for (const f of manifests) {
  const path = join(root, f);
  const text = readFileSync(path, "utf8");
  if (!VERSION_LINE.test(text)) continue;
  writeFileSync(path, text.replace(VERSION_LINE, `$1${version}$2`));
}
if (regenerate) {
  const r = spawnSync("pnpm", ["--filter", "@oraknid/daemon", "openapi"], {
    cwd: root,
    stdio: "inherit",
  });
  if (r.status !== 0) fail("the OpenAPI document couldn't be regenerated.");
}
git("add", "--update");
git("commit", "--quiet", "-m", message);
git("tag", "-a", tag, "-m", `Oraknid ${tag}\n\n${notes}`);
const { dir, sum } = buildAssets();
say(
  `Tagged ${tag} at ${git("rev-parse", "--short", "HEAD")}; ${dir} (sha256 ${sum.slice(0, 12)}…).`,
);
if (!publish) {
  say(
    `Next: node scripts/release.mjs ${version} --publish (or push the tag: release.yml adds the assets).`,
  );
  process.exit(0);
}

// ── Publishing ────────────────────────────────────────────────────────
/** The GitHub token from git's credential helper; never printed. */
function token() {
  const r = spawnSync("git", ["credential", "fill"], {
    cwd: root,
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const found = /^password=(.+)$/m.exec(r.stdout ?? "")?.[1];
  if (r.status !== 0 || !found)
    fail("git has no credential for github.com: set one up (a token with Contents: write).");
  return found;
}

function repoName() {
  const given = option("--repo");
  if (given) return given;
  const url = git("remote", "get-url", "origin");
  const m = /github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  if (!m) fail("origin isn't a GitHub repository: name it with --repo <owner/name>.");
  return m[1];
}

async function gh(secret, method, url, body, type = "application/json") {
  const res = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${secret}`,
      "x-github-api-version": "2022-11-28",
      "content-type": type,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    const why = (() => {
      try {
        return JSON.parse(text).message;
      } catch {
        return text.slice(0, 200);
      }
    })();
    // GitHub's words only: the token is in no message.
    fail(`GitHub refused ${method} ${new URL(url).pathname}: ${res.status} ${why}`);
  }
  return text ? JSON.parse(text) : null;
}

const repo = repoName();
const secret = token();
git("push", "--quiet", "origin", "dev");
git("push", "--quiet", "origin", tag);
say(`Pushed dev and ${tag} to ${repo}.`);
const major = Number(version.split(".")[0]);
const release = await gh(
  secret,
  "POST",
  `${api}/repos/${repo}/releases`,
  JSON.stringify({
    tag_name: tag,
    name: `Oraknid ${tag}`,
    body: notes,
    prerelease: major < 1 || version.includes("-"),
    draft: false,
  }),
);
const upload = String(release.upload_url).replace(/\{.*\}$/, "");
for (const [name, type] of [
  ["install.sh", "text/x-shellscript"],
  ["SHA256SUMS", "text/plain"],
]) {
  await gh(
    secret,
    "POST",
    `${upload}?name=${encodeURIComponent(name)}`,
    readFileSync(join(dir, name)),
    type,
  );
}
say(`Released ${release.html_url ?? tag} with install.sh and SHA256SUMS.`);
// main follows the releases: only ever fast-forwarded.
const fetched =
  spawnSync("git", ["fetch", "--quiet", "origin", "main"], { cwd: root }).status === 0;
if (fetched && !gitOk("merge-base", "--is-ancestor", "FETCH_HEAD", tag))
  fail(`main on ${repo} isn't behind ${tag}: it wasn't moved (nothing is forced).`);
git("push", "--quiet", "origin", `${tag}^{commit}:refs/heads/main`);
if (gitOk("rev-parse", "--verify", "--quiet", "refs/heads/main")) git("branch", "-f", "main", tag);
say(`main is at ${tag}.`);
