import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildContextPack,
  estimateTokens,
  guidanceFromOthers,
  type PackSize,
  skillExcerpt,
  taskScope,
} from "@oraknid/core";
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
 * The context diet (ADR-066 §4): the pack aims under this many tokens, Silk
 * under its share, the handoff under its cap, the skill's excerpt under its
 * own; what is cut stays whole in the worktree for the agent to read.
 */
export const PACK_TOKENS = 4000;
export const SILK_TOKENS = 1500;
export const HANDOFF_TOKENS = 1200;
const SKILL_CHARS = 2400;
const OTHERS_CHARS = 1200;
/** Where the whole method is, in the worktree and out of git (`/.oraknid/*` is excluded). */
export const SKILL_FILE = ".oraknid/skill.md";

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

interface PackOptions {
  contextWindow: number | null;
  ws: AttemptWhere;
  toolRows: ToolRow[];
  /** The job's servers, as the Leg reaches them (filled when they are prepared). */
  serversText: string;
}

/** The context pack of a session of this task, sized to the model's window. */
export function contextPack(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  o: PackOptions,
): string {
  return contextPackSized(d, job, task, o).text;
}

/**
 * The pack and what it weighs (ADR-066 §4: the attempt log's `ContextSize`):
 * the pack itself, each of its parts, and the rest (repos, git, servers, GitHub).
 */
export function contextPackSized(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  o: PackOptions,
): { text: string; pack: number; size: PackSize; rest: number } {
  const window = o.contextWindow ?? 200_000;
  // The whole method, for the agent to read when the excerpt isn't enough.
  const skillFile = writeSkill(o.ws.cwd, job.skillBody);
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
      skillExcerpt(job.skillBody, `${task.title} ${task.kind}`, SKILL_CHARS),
      guidanceFromOthers(
        job.skillBody,
        job.otherSkills ?? [],
        `${task.title} ${task.instructions}`,
      ).slice(0, OTHERS_CHARS),
      skillFile && job.skillBody.length > SKILL_CHARS
        ? `The whole method is in \`${SKILL_FILE}\`: read the section you need there.`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    entries: d.silk.all(job.id),
    // What earlier jobs of the project settled, not only what this branch holds (ADR-034).
    earlier: d.silk.earlier(job.id),
    digest: "",
    inputs: job.inputs,
    capTokens: Math.min(PACK_TOKENS, Math.floor(window * 0.15)),
    silkTokens: SILK_TOKENS,
    handoffTokens: HANDOFF_TOKENS,
    memoryPath: ".oraknid/silk/",
  });
  // What had to be shortened is summarised in the background for the next pack.
  if (built.shortened.length >= 2)
    void summarizeShortened(d, job.id, o.ws.cwd, built.shortened).catch((e) =>
      console.error("silk summary failed", e),
    );
  const rest = [
    job.layout ? `# The repos\n\n${job.layout}` : "",
    // A server job's place is its server: no repo, no GitHub (ADR-049).
    job.serverJob ? "" : GIT_TEXT,
    o.serversText,
    job.serverJob ? "" : githubText(d, job, o.ws, o.toolRows),
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    text: [built.text, rest].filter(Boolean).join("\n\n"),
    pack: built.tokens,
    size: built.size,
    rest: estimateTokens(rest),
  };
}

/** The job's method, whole, in the worktree's own folder; false when it can't be written. */
function writeSkill(cwd: string, body: string): boolean {
  if (body.length <= SKILL_CHARS || !existsSync(cwd)) return false;
  try {
    const file = join(cwd, SKILL_FILE);
    if (existsSync(file) && readFileSync(file, "utf8") === body) return true;
    mkdirSync(join(cwd, ".oraknid"), { recursive: true });
    writeFileSync(file, body);
    return true;
  } catch {
    return false;
  }
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
