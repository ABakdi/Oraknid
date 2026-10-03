import type { GitHubLink } from "@oraknid/contracts";
import type { GitHub } from "../workspace/github.ts";
import type { VerifyResult } from "./verify.ts";

/**
 * Checks Oraknid runs itself, not in the sandbox (ADR-038): what is on the
 * project's linked GitHub repo, read with the account's token, which no
 * check in the sandbox has (and `gh` isn't there). In a project of several
 * repos (ADR-042), `--repo <name>` says which.
 *
 *   oraknid github-repo [--repo <name>]              the linked repo exists, with the visibility chosen
 *   oraknid github-branch <branch> [--repo <name>]   the branch is on it, at the same commit as here
 */
export const BUILTIN_CHECK = /^oraknid\s+github-(repo|branch)((?:\s+\S+)*)\s*$/;

/** The parts of a built-in check: which, the branch, the repo named. */
export function parseBuiltinCheck(
  command: string,
): { kind: "repo" | "branch"; branch: string | null; repo: string | null } | null {
  const m = BUILTIN_CHECK.exec(command.trim());
  if (!m) return null;
  const words = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
  let repo: string | null = null;
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === "--repo") repo = words[++i] ?? "";
    else if (w.startsWith("--repo=")) repo = w.slice("--repo=".length);
    else rest.push(w);
  }
  return { kind: m[1] as "repo" | "branch", branch: rest[0] ?? null, repo };
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
  },
): Promise<VerifyResult | null> {
  const parsed = parseBuiltinCheck(command);
  if (!parsed) return null;
  const started = Date.now();
  const done = (ok: boolean, output: string): VerifyResult => ({
    command,
    ok,
    exitCode: ok ? 0 : 1,
    output,
    signature: ok ? null : `builtin:${output.slice(0, 80)}`,
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
