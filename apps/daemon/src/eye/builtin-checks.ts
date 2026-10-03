import type { GitHubLink } from "@oraknid/contracts";
import type { GitHub } from "../workspace/github.ts";
import type { VerifyResult } from "./verify.ts";

/**
 * Checks Oraknid runs itself, not in the sandbox (ADR-038): what is on the
 * project's linked GitHub repo, read with the account's token, which no
 * check in the sandbox has (and `gh` isn't there).
 *
 *   oraknid github-repo              the linked repo exists, with the visibility chosen
 *   oraknid github-branch <branch>   the branch is on it, at the same commit as here
 */
export const BUILTIN_CHECK = /^oraknid\s+github-(repo|branch)(?:\s+(\S+))?\s*$/;

export async function runBuiltinCheck(
  command: string,
  o: { github?: GitHub; link: GitHubLink | null; localCommit: (branch: string) => string | null },
): Promise<VerifyResult | null> {
  const m = BUILTIN_CHECK.exec(command.trim());
  if (!m) return null;
  const started = Date.now();
  const done = (ok: boolean, output: string): VerifyResult => ({
    command,
    ok,
    exitCode: ok ? 0 : 1,
    output,
    signature: ok ? null : `builtin:${output.slice(0, 80)}`,
    ms: Date.now() - started,
  });
  const { link, github } = o;
  if (!link) return done(false, "This project has no GitHub repo linked.");
  if (!github) return done(false, "GitHub isn't set up in Oraknid.");
  const full = `${link.owner}/${link.name}`;
  try {
    if (m[1] === "repo") {
      const r = await github.repo(full, link.account);
      const want = link.visibility === "private";
      if (r.private !== want)
        return done(
          false,
          `${full} exists but is ${r.private ? "private" : "public"}, not ${link.visibility}.`,
        );
      return done(true, `${full} exists, ${link.visibility}.`);
    }
    const branch = m[2];
    if (!branch) return done(false, "Name the branch: oraknid github-branch <branch>.");
    const { data } = await github.read<{ commit?: { sha?: string } }>(
      `/repos/${full}/branches/${encodeURIComponent(branch)}`,
      link.account,
    );
    const remote = data.commit?.sha ?? null;
    if (!remote) return done(false, `${full} has no branch ${branch}.`);
    const here = o.localCommit(branch);
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
