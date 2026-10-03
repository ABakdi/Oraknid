import { spawnSync } from "node:child_process";
import type { GitHubLink } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool, McpDeclaration } from "../tools/registry.ts";
import type { GitHub } from "./github.ts";
import type { Projects } from "./projects.ts";

// The github tool (ADR-038): Oraknid does a project's GitHub work itself,
// with the account of the project's GitHub link. The token stays in the
// daemon (git gets it through GIT_ASKPASS); a Leg only asks. Work on the
// linked repo (creating it when it is new, pushing a branch, a pull
// request) runs without asking; anything else is judged as a gated action.

const NAME = "github";

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
const str = (description: string) => ({ type: "string", description });

const TOOLS: { name: string; description: string; inputSchema: Schema }[] = [
  {
    name: "repo_info",
    description:
      "The project's linked GitHub repository: owner/name, visibility, whether it exists yet, its default branch and address.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_repo",
    description:
      "Create the project's linked repository on GitHub, as the owner chose it (name and visibility). Only when repo_info says it doesn't exist yet. It starts empty: push next.",
    inputSchema: {
      type: "object",
      properties: { description: str("One line describing the project (optional).") },
    },
  },
  {
    name: "push",
    description:
      "Push a branch of the project's repository on this computer to the linked GitHub repository. Oraknid runs git with the token; never run git push yourself.",
    inputSchema: {
      type: "object",
      properties: {
        branch: str("The local branch to push (the job's branch when left out), e.g. dev or main."),
        to: str("The branch name on GitHub (the same name when left out)."),
        force: {
          type: "boolean",
          description: "Rewrite the remote branch: always asks the owner.",
        },
        repo: str("owner/name, only to push somewhere other than the linked repo: asks the owner."),
      },
    },
  },
  {
    name: "open_pull_request",
    description: "Open a pull request in the linked repository, from one pushed branch to another.",
    inputSchema: {
      type: "object",
      properties: {
        head: str("The branch with the changes (pushed first)."),
        base: str("The branch to merge into (the repo's default branch when left out)."),
        title: str("The pull request's title."),
        body: str("Its description, markdown."),
      },
      required: ["head", "title"],
    },
  },
];

/** The github tool's declaration, its calls judged against the job's project's link. */
export function githubTool(db: Db): BuiltInTool {
  return {
    name: NAME,
    description:
      "Oraknid's GitHub, with the project's linked account: create its repo, push a branch, open a pull request. The token never reaches an agent.",
    reads: ["repo_info"],
    held: [],
    // What it returns is GitHub's answer about my own repo, not someone's words.
    untrusted: false,
    judge: (session, name, args) => judgeGitHub(db, session.jobId, name, args),
  };
}

export interface GitHubToolDeps {
  db: Db;
  bus: EventBus;
  github: GitHub;
  projects: Projects;
}

/** The job's project, its link, and where its work is. */
function place(db: Db, jobId: string | null) {
  if (!jobId) throw new Error("The github tool works for a job only.");
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const project = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!project) throw new Error("The job's project is gone.");
  return { job, project, link: project.github as GitHubLink | null };
}

/** The GitHub link of a job's project, if it has one. */
export function githubLinkOf(db: Db, jobId: string): GitHubLink | null {
  try {
    return place(db, jobId).link;
  } catch {
    return null;
  }
}

const full = (l: Pick<GitHubLink, "owner" | "name">) => `${l.owner}/${l.name}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How the policy judges one call (ADR-038): on the project's linked repo,
 * "linked" (no question: the link is my approval); otherwise the gated
 * action it is. Undefined: the tool's own declarations decide.
 */
export function judgeGitHub(
  db: Db,
  jobId: string | null,
  name: string,
  args: Record<string, unknown>,
): McpDeclaration | undefined {
  if (name === "repo_info") return undefined;
  let link: GitHubLink | null = null;
  try {
    link = place(db, jobId).link;
  } catch {
    link = null;
  }
  const repo = typeof args.repo === "string" && args.repo ? args.repo : null;
  const onLink = !!link && (!repo || same(repo, full(link)));
  if (name === "push") {
    // Rewriting history, or pushing anywhere but the linked repo, asks (BR-5, BR-14).
    if (args.force === true || !onLink) return "push";
    return { linked: "push" };
  }
  if (name === "create_repo")
    return onLink && link && !link.ready ? { linked: "external-write" } : "external-write";
  if (name === "open_pull_request") return onLink ? { linked: "external-write" } : "external-write";
  return "external-write";
}

const text = (id: Rpc["id"], t: string, isError = false): Rpc => ({
  jsonrpc: "2.0",
  id,
  result: { content: [{ type: "text", text: t }], isError },
});

/** The github tool as the broker runs it, for one session of a job. */
export function githubServer(d: GitHubToolDeps): BuiltInServer {
  return (session) => {
    const handle: McpHandler = async (m) => {
      if (m.method === "initialize")
        return {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "oraknid-github", version: "1.0.0" },
          },
        };
      if (m.id === undefined) return null;
      if (m.method === "ping") return { jsonrpc: "2.0", id: m.id, result: {} };
      if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } };
      if (m.method !== "tools/call")
        return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
      const name = String(m.params?.name ?? "");
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return text(m.id, await call(d, session.jobId, name, args));
      } catch (error) {
        return text(m.id, error instanceof Error ? error.message : String(error), true);
      }
    };
    return handle;
  };
}

const NO_LINK =
  "This project has no GitHub repository linked yet. Don't work around it (no gh CLI, no token, no remote of your own): say in your report that the task needs a GitHub repo, and The Eye asks the owner.";

async function call(
  d: GitHubToolDeps,
  jobId: string | null,
  name: string,
  a: Record<string, unknown>,
): Promise<string> {
  const s = (k: string) => (typeof a[k] === "string" && a[k] ? (a[k] as string) : undefined);
  const { job, project, link } = place(d.db, jobId);
  const audit = (type: string, payload: Record<string, unknown>) =>
    d.bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload, actor: "eye" });

  if (name === "repo_info") {
    if (!link) return NO_LINK;
    const head = `${full(link)} (${link.visibility}), through the GitHub account ${link.account}.`;
    if (!link.ready) return `${head} It doesn't exist yet: create it with create_repo, then push.`;
    const info = await d.github.repo(full(link), link.account);
    return `${head} Default branch: ${info.defaultBranch}. ${info.url}`;
  }

  if (name === "create_repo") {
    if (!link) throw new Error(NO_LINK);
    if (link.ready) return `${full(link)} exists already: push to it.`;
    const made = await d.github.createRepo(
      {
        name: link.name,
        owner: link.owner,
        private: link.visibility === "private",
        readme: false,
        ...(s("description") ? { description: s("description") as string } : {}),
      },
      link.account,
    );
    d.projects.githubCreated(project.id);
    audit("github.repo-created", { fullName: made.fullName, visibility: link.visibility });
    return `Created ${made.fullName} (${link.visibility}). It is empty: push a branch next.`;
  }

  if (name === "push") {
    const repo = s("repo") ?? (link ? full(link) : null);
    if (!repo) throw new Error(NO_LINK);
    if (link && same(repo, full(link)) && !link.ready)
      throw new Error(`${repo} doesn't exist yet: call create_repo first.`);
    const branch = s("branch") ?? job.branch;
    if (!branch) throw new Error("Say which branch to push.");
    const to = s("to") ?? branch;
    const cwd = job.worktree ?? project.workspacePath;
    if (!/^[\w./-]+$/.test(branch) || !/^[\w./-]+$/.test(to) || branch.startsWith("-"))
      throw new Error(
        "A branch name has only letters, digits, dots, dashes, underscores and slashes.",
      );
    const known = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      encoding: "utf8",
    });
    if (known.status !== 0) throw new Error(`There is no local branch ${branch}.`);
    const r = await d.github.push({
      cwd,
      fullName: repo,
      refspecs: [`refs/heads/${branch}:refs/heads/${to}`],
      force: a.force === true,
      login: link?.account ?? null,
    });
    // Its address for me, never with a token: Oraknid pushes by URL, so nothing is kept in the repo's config.
    audit("github.pushed", { repo, branch, to, force: a.force === true });
    return `Pushed ${branch} to ${repo} as ${to}.${r.output ? `\n${r.output.slice(-1500)}` : ""}`;
  }

  if (name === "open_pull_request") {
    if (!link) throw new Error(NO_LINK);
    const head = s("head");
    const title = s("title");
    if (!head || !title) throw new Error("Give head (a pushed branch) and title.");
    const base = s("base") ?? (await d.github.repo(full(link), link.account)).defaultBranch;
    const pr = await d.github.openPullRequest(
      { fullName: full(link), head, base, title, body: s("body") ?? "" },
      link.account,
    );
    audit("github.pull-request", { repo: full(link), number: pr.number, head, base });
    return `Opened pull request #${pr.number}: ${pr.url}`;
  }

  throw new Error(`The github tool has no ${name}.`);
}
