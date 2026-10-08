import { buildContextPack, guidanceFromOthers, skillExcerpt, taskScope } from "@oraknid/core";
import { summarizeShortened } from "../silk/summarize.ts";
import { BUILT_IN, type ToolRow } from "../tools/registry.ts";
import { githubLinkOf, githubLinksOf } from "../workspace/github-tool.ts";
import type { AttemptDeps, AttemptJob, AttemptWhere, TaskRow } from "./types.ts";

// What a session is told before its first message (Silk → context packs):
// the task, the job's goal, the skill's guidance, what Silk holds, how the
// folder and git work, the job's servers and its GitHub repo.

/** What every Leg is told about git: the folder stays a worktree, the repo's part is Oraknid's. */
const GIT_TEXT = `# Git

This folder is a git worktree of the project, on the job's branch. Oraknid commits your work there when its checks pass; merging into the work branch and pushing to GitHub are Oraknid's own steps when the job ends. So don't commit into other branches, merge, push, or run git init, and never move, delete or edit a .git or the project's worktrees: such commands are refused.`;

/**
 * What a task may change (M13.22): its scope, the files its checks and
 * instructions name, docs/ for research and planning (taskScope).
 */
export const scopeOf = (task: TaskRow) =>
  taskScope({
    kind: task.kind,
    scope: task.scope,
    verify: task.verify,
    instructions: task.instructions,
  });

/** The context pack of a session of this task, sized to the model's window. */
export function contextPack(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  o: {
    contextWindow: number | null;
    ws: AttemptWhere;
    toolRows: ToolRow[];
    /** The job's servers, as the Leg reaches them (filled when they are prepared). */
    serversText: string;
  },
): string {
  const window = o.contextWindow ?? 200_000;
  const built = buildContextPack({
    task: {
      id: task.id,
      title: task.title,
      instructions: task.instructions,
      scope: scopeOf(task),
      verify: task.verify,
    },
    goal: job.goal,
    skill: [
      skillExcerpt(job.skillBody, `${task.title} ${task.kind}`),
      guidanceFromOthers(
        job.skillBody,
        job.otherSkills ?? [],
        `${task.title} ${task.instructions}`,
      ),
    ]
      .filter(Boolean)
      .join("\n\n"),
    entries: d.silk.all(job.id),
    // What earlier jobs of the project settled, not only what this branch holds (ADR-034).
    earlier: d.silk.earlier(job.id),
    digest: "",
    inputs: job.inputs,
    capTokens: Math.floor(window * 0.15),
  });
  // What had to be shortened is summarised in the background for the next pack.
  if (built.shortened.length >= 2)
    void summarizeShortened(d, job.id, o.ws.cwd, built.shortened).catch((e) =>
      console.error("silk summary failed", e),
    );
  return [
    built.text,
    job.layout ? `# The repos\n\n${job.layout}` : "",
    // A server job's place is its server: no repo, no GitHub (ADR-049).
    job.serverJob ? "" : GIT_TEXT,
    o.serversText,
    job.serverJob ? "" : githubText(d, job, o.ws, o.toolRows),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** How this job does GitHub work: through Oraknid's github tool, never a CLI or a token (ADR-038). */
function githubText(d: AttemptDeps, job: AttemptJob, ws: AttemptWhere, toolRows: ToolRow[]) {
  if (!toolRows.some((t) => t.name === "github" && t.command === BUILT_IN)) return "";
  const link = githubLinkOf(d.db, job.id);
  const repos = githubLinksOf(d.db, job.id);
  const where = ws.tree.several
    ? `This project is several repos; each call names one with \`repo\` (its name in the project). ${repos
        .map((r) =>
          r.github
            ? `**${r.name}** (\`${r.folder}/\`) → **${r.github.owner}/${r.github.name}** (${r.github.visibility}), through ${r.github.account}${r.github.ready ? "" : "; it doesn't exist yet: `create_repo` creates it"}.`
            : `**${r.name}** (\`${r.folder}/\`) has no GitHub repository linked yet: if the task needs one, say so in your report and stop; The Eye asks the owner.`,
        )
        .join(" ")}`
    : link
      ? `This project's GitHub repository is **${link.owner}/${link.name}** (${link.visibility}), through the account ${link.account}${link.ready ? "" : "; it doesn't exist yet: `create_repo` creates it"}.`
      : "This project has no GitHub repository linked yet: if the task needs one, say so in your report and stop; The Eye asks the owner.";
  return `# GitHub\n\n${where}\n\nDo every GitHub action with the \`github\` tool (the oraknid-github MCP server): \`repo_info\`, \`create_repo\`, \`push\` (a local branch to the linked repo), \`open_pull_request\`. Oraknid holds the token and runs git with it. Never install or run the \`gh\` CLI, never look for or ask for a token, never add a remote with credentials or run \`git push\` yourself.`;
}
