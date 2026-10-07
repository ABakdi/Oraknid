import type { GitHubLink } from "@oraknid/contracts";
import type { GitHub } from "../workspace/github.ts";
import { type Ci, ciOf } from "../workspace/github-ci.ts";
import type { VerifyResult } from "./verify.ts";

/**
 * Checks Oraknid runs itself, not in the sandbox (ADR-038): what is on the
 * project's linked GitHub repo, read with the account's token, which no
 * check in the sandbox has (and `gh` isn't there). In a project of several
 * repos (ADR-042), `--repo <name>` says which.
 *
 *   oraknid github-repo [--repo <name>]              the linked repo exists, with the visibility chosen
 *   oraknid github-branch <branch> [--repo <name>]   the branch is on it, at the same commit as here
 *   oraknid github-ci [<branch>|--branch <b>] [--repo <name>] [--timeout <minutes>]
 *                                                    the branch's CI passed (ADR-058): its runs for the
 *                                                    commit here (else its latest) waited for
 */
export const BUILTIN_CHECK = /^oraknid\s+github-(repo|branch|ci)((?:\s+\S+)*)\s*$/;

/** How long `github-ci` waits by default, and at most (minutes). */
export const CI_WAIT_MIN = 20;
export const CI_WAIT_MAX = 60;

export interface BuiltinCheck {
  kind: "repo" | "branch" | "ci";
  branch: string | null;
  repo: string | null;
  /** github-ci: how long to wait, minutes (null: the default). */
  timeoutMin?: number | null;
}

/** The parts of a built-in check: which, the branch, the repo named. */
export function parseBuiltinCheck(command: string): BuiltinCheck | null {
  const m = BUILTIN_CHECK.exec(command.trim());
  if (!m) return null;
  const kind = m[1] as BuiltinCheck["kind"];
  const words = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
  let repo: string | null = null;
  let branch: string | null = null;
  let timeout: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--repo") repo = words[++i] ?? "";
    else if (w.startsWith("--repo=")) repo = w.slice("--repo=".length);
    else if (kind === "ci" && w === "--branch") branch = words[++i] ?? null;
    else if (kind === "ci" && w.startsWith("--branch=")) branch = w.slice("--branch=".length);
    else if (kind === "ci" && w === "--timeout") timeout = words[++i] ?? null;
    else if (kind === "ci" && w.startsWith("--timeout=")) timeout = w.slice("--timeout=".length);
    else rest.push(w);
  }
  const parsed: BuiltinCheck = { kind, branch: branch ?? rest[0] ?? null, repo };
  if (kind === "ci") {
    const n = timeout ? Number.parseFloat(timeout) : Number.NaN;
    parsed.timeoutMin = Number.isFinite(n) && n > 0 ? Math.min(n, CI_WAIT_MAX) : null;
  }
  return parsed;
}

export async function runBuiltinCheck(
  command: string,
  o: {
    github?: GitHub;
    /** The link of a project of one repo. */
    link: GitHubLink | null;
    /** The link of the repo named (or of the only one), or why there is none (ADR-042). */
    linkFor?: (repo: string | null) => GitHubLink | string | null;
    localCommit: (branch: string, repo: string | null) => string | null;
    /** github-ci: GitHub Actions (tests give their own), how often to look, and a stop. */
    ci?: Ci;
    ciPollMs?: number;
    signal?: AbortSignal;
  },
): Promise<VerifyResult | null> {
  const parsed = parseBuiltinCheck(command);
  if (!parsed) return null;
  const started = Date.now();
  const done = (ok: boolean, output: string, signature?: string): VerifyResult => ({
    command,
    ok,
    exitCode: ok ? 0 : 1,
    output,
    signature: ok ? null : (signature ?? `builtin:${output.slice(0, 80)}`),
    ms: Date.now() - started,
  });
  if (parsed.repo === "") return done(false, "Name the repo: --repo <its name in the project>.");
  const found = o.linkFor ? o.linkFor(parsed.repo) : o.link;
  if (typeof found === "string") return done(false, found);
  const link = found;
  const { github } = o;
  if (!link)
    return done(
      false,
      parsed.repo
        ? `The repo ${parsed.repo} has no GitHub repo linked.`
        : "This project has no GitHub repo linked.",
    );
  if (!github) return done(false, "GitHub isn't set up in Oraknid.");
  const full = `${link.owner}/${link.name}`;
  try {
    if (parsed.kind === "repo") {
      const r = await github.repo(full, link.account);
      const want = link.visibility === "private";
      if (r.private !== want)
        return done(
          false,
          `${full} exists but is ${r.private ? "private" : "public"}, not ${link.visibility}.`,
        );
      return done(true, `${full} exists, ${link.visibility}.`);
    }
    if (parsed.kind === "ci") return await ciCheck(parsed, link, github, o, done);
    const branch = parsed.branch;
    if (!branch) return done(false, "Name the branch: oraknid github-branch <branch>.");
    const { data } = await github.read<{ commit?: { sha?: string } }>(
      `/repos/${full}/branches/${encodeURIComponent(branch)}`,
      link.account,
    );
    const remote = data.commit?.sha ?? null;
    if (!remote) return done(false, `${full} has no branch ${branch}.`);
    const here = o.localCommit(branch, parsed.repo);
    if (here && here !== remote)
      return done(
        false,
        `${branch} on ${full} is at ${remote.slice(0, 7)}, here it is at ${here.slice(0, 7)}: push it.`,
      );
    return done(true, `${branch} is on ${full} at ${remote.slice(0, 7)}.`);
  } catch (error) {
    return done(false, `${full}: ${(error as Error).message}`);
  }
}

/**
 * `oraknid github-ci` (ADR-058): waits for the branch's runs of the commit
 * here (pushed by the job's end steps), else of its latest commit on GitHub;
 * passes when every one passed, fails with the failing step's last lines.
 */
async function ciCheck(
  parsed: BuiltinCheck,
  link: GitHubLink,
  github: GitHub,
  o: {
    localCommit: (branch: string, repo: string | null) => string | null;
    ci?: Ci;
    ciPollMs?: number;
    signal?: AbortSignal;
  },
  done: (ok: boolean, output: string, signature?: string) => VerifyResult,
): Promise<VerifyResult> {
  const full = `${link.owner}/${link.name}`;
  const branch = parsed.branch ?? (await github.repo(full, link.account)).defaultBranch;
  const sha = o.localCommit(branch, parsed.repo);
  const minutes = parsed.timeoutMin ?? CI_WAIT_MIN;
  const ci = o.ci ?? ciOf(github);
  const w = await ci.waitFor(
    { owner: link.owner, name: link.name, account: link.account },
    branch,
    {
      sha,
      timeoutMs: minutes * 60_000,
      ...(o.ciPollMs ? { pollMs: o.ciPollMs } : {}),
      ...(o.signal ? { signal: o.signal } : {}),
    },
  );
  const at = (s: string | null) => (s ? ` at ${s.slice(0, 7)}` : "");
  if (w.state === "none") return done(false, w.why, `builtin:ci:none:${full}`);
  if (w.state === "passing")
    return done(
      true,
      `CI passed on ${branch} of ${full}${at(w.sha)}: ${w.runs.map((r) => r.name).join(", ")}.`,
    );
  if (w.state === "failing") {
    const where = w.job ? `: ${w.job.name}${w.step ? ` → ${w.step}` : ""}` : "";
    const how = w.run.conclusion === "cancelled" ? "was cancelled" : "failed";
    const tail = w.tail.length
      ? `\nThe last lines of ${w.step ?? w.job?.name ?? "its log"}:\n${w.tail.join("\n")}`
      : "";
    return done(
      false,
      `${w.run.name} ${how} on ${branch} of ${full}${at(w.sha)}${where}. ${w.run.url}${tail}`,
      `builtin:ci:failing:${full}:${w.run.name}:${w.job?.name ?? ""}:${w.step ?? ""}`,
    );
  }
  const words = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return done(
    false,
    w.runs.length
      ? `CI is still running on ${branch} of ${full}${at(w.sha)} after ${words}: ${w.runs
          .filter((r) => r.status !== "completed")
          .map((r) => r.name)
          .join(", ")}.`
      : `No CI run for ${sha ? sha.slice(0, 7) : "the latest commit"} on ${branch} of ${full} after ${words}: is it pushed, and does a workflow run on pushes to ${branch}?`,
    `builtin:ci:timeout:${full}:${branch}`,
  );
}
