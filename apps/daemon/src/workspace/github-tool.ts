import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { GitHubLink, ProjectRepo } from "@oraknid/contracts";
import { eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projects } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { BuiltInServer, McpHandler, Rpc } from "../tools/broker.ts";
import type { BuiltInTool, McpDeclaration } from "../tools/registry.ts";
import type { GitHub } from "./github.ts";
import { type Projects, viewOf } from "./projects.ts";
import { isSeveral } from "./repos.ts";

// The github tool (ADR-038): Oraknid does a project's GitHub work itself,
// with the account of the project's GitHub link. The token stays in the
// daemon (git gets it through GIT_ASKPASS); a Leg only asks. Work on the
// linked repo (creating it when it is new, pushing a branch, a pull
// request) runs without asking; anything else is judged as a gated action.
// A project of several repos (ADR-042) has a link per repo: a call names
// the repo by its name in the project.

const NAME = "github";

type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[] };
const str = (description: string) => ({ type: "string", description });
const REPO = str(
  "In a project of several repos, which one: its name in the project (e.g. web). Left out when the project has one repo.",
);

const TOOLS: { name: string; description: string; inputSchema: Schema }[] = [
  {
    name: "repo_info",
    description:
      "The project's linked GitHub repository: owner/name, visibility, whether it exists yet, its default branch and address. In a project of several repos, every repo's when none is named.",
    inputSchema: { type: "object", properties: { repo: REPO } },
  },
  {
    name: "create_repo",
    description:
      "Create the project's linked repository on GitHub, as the owner chose it (name and visibility). Only when repo_info says it doesn't exist yet. It starts empty: push next.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
        description: str("One line describing the project (optional)."),
      },
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
        repo: str(
          "In a project of several repos, the repo's name in the project (e.g. web). An owner/name only to push somewhere other than the linked repo: that asks the owner.",
        ),
      },
    },
  },
  {
    name: "open_pull_request",
    description: "Open a pull request in the linked repository, from one pushed branch to another.",
    inputSchema: {
      type: "object",
      properties: {
        repo: REPO,
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

/** The job's project, its repos, and where its work is. */
function place(db: Db, jobId: string | null) {
  if (!jobId) throw new Error("The github tool works for a job only.");
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const row = db.select().from(projects).where(eq(projects.id, job.projectId)).get();
  if (!row) throw new Error("The job's project is gone.");
  const project = viewOf(row);
  return { job, project, repos: project.repos };
}

/** A repo of the project by its name, or, named by nothing, the only one, or the only one linked. */
function repoFor(repos: ProjectRepo[], name: string | null): ProjectRepo | null {
  if (name) return repos.find((r) => r.name.toLowerCase() === name.toLowerCase()) ?? null;
  if (repos.length === 1) return repos[0] as ProjectRepo;
  const linked = repos.filter((r) => r.github);
  return linked.length === 1 ? (linked[0] as ProjectRepo) : null;
}

/** The GitHub link of a job's project's repo (the only one when not named), if it has one. */
export function githubLinkOf(db: Db, jobId: string, repo?: string | null): GitHubLink | null {
  try {
    return repoFor(place(db, jobId).repos, repo ?? null)?.github ?? null;
  } catch {
    return null;
  }
}

/** Every repo of a job's project, with its link or none (ADR-042). */
export function githubLinksOf(db: Db, jobId: string): ProjectRepo[] {
  try {
    return place(db, jobId).repos;
  } catch {
    return [];
  }
}

const full = (l: Pick<GitHubLink, "owner" | "name">) => `${l.owner}/${l.name}`;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** `repo` as a call gives it: an owner/name, or a repo's name in the project. */
const isFullName = (s: string) => s.includes("/");

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
  let repos: ProjectRepo[] = [];
  try {
    repos = place(db, jobId).repos;
  } catch {
    repos = [];
  }
  const given = typeof args.repo === "string" && args.repo ? args.repo : null;
  // An owner/name is on a link when it is one of the project's repos' links.
  const link =
    given && isFullName(given)
      ? (repos.find((r) => r.github && same(given, full(r.github)))?.github ??
        repoFor(repos, null)?.github ??
        null)
      : (repoFor(repos, given)?.github ?? null);
  // Several repos linked and none named: the tool asks the Leg to name one; nothing to ask me.
  const unnamed = !given && repos.filter((r) => r.github).length > 1;
  const onLink = unnamed || (!!link && (!given || !isFullName(given) || same(given, full(link))));
  if (name === "push") {
    // Rewriting history, or pushing anywhere but the linked repo, asks (BR-5, BR-14).
    if (args.force === true || !onLink) return "push";
    return { linked: "push" };
  }
  if (name === "create_repo")
    return unnamed || (onLink && link && !link.ready)
      ? { linked: "external-write" }
      : "external-write";
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

const noLinkFor = (r: ProjectRepo) =>
  `The repo ${r.name} of this project has no GitHub repository linked yet. Don't work around it (no gh CLI, no token, no remote of your own): say in your report that it needs a GitHub repo, and The Eye asks the owner.`;

async function call(
  d: GitHubToolDeps,
  jobId: string | null,
  name: string,
  a: Record<string, unknown>,
): Promise<string> {
  const s = (k: string) => (typeof a[k] === "string" && a[k] ? (a[k] as string) : undefined);
  const { job, project, repos } = place(d.db, jobId);
  const several = isSeveral(repos);
  const audit = (type: string, payload: Record<string, unknown>) =>
    d.bus.publish({ type, topic: `job:${job.id}`, jobId: job.id, payload, actor: "eye" });
  const given = s("repo") ?? null;
  const named = given && !isFullName(given) ? given : null;
  /** The project's repo this call is about: named, or the only one (linked). */
  const target = (): ProjectRepo => {
    const r = repoFor(repos, named);
    if (r) return r;
    if (named)
      throw new Error(
        `This project has no repo named ${named}: its repos are ${repos.map((x) => x.name).join(", ")}.`,
      );
    throw new Error(
      `This project has several repos: name one with repo (${repos.map((x) => x.name).join(", ")}).`,
    );
  };
  const linkOf = (r: ProjectRepo) => {
    if (!r.github) throw new Error(several ? noLinkFor(r) : NO_LINK);
    return r.github;
  };

  if (name === "repo_info") {
    const describe = async (r: ProjectRepo) => {
      const link = r.github;
      if (!link) return several ? noLinkFor(r) : NO_LINK;
      const head = `${several ? `${r.name} (${r.folder}/): ` : ""}${full(link)} (${link.visibility}), through the GitHub account ${link.account}.`;
      if (!link.ready)
        return `${head} It doesn't exist yet: create it with create_repo, then push.`;
      const info = await d.github.repo(full(link), link.account);
      return `${head} Default branch: ${info.defaultBranch}. ${info.url}`;
    };
    if (several && !named) return (await Promise.all(repos.map(describe))).join("\n");
    return describe(target());
  }

  if (name === "create_repo") {
    if (!repos.some((r) => r.github)) throw new Error(NO_LINK);
    const r = target();
    const link = linkOf(r);
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
    d.projects.githubCreated(project.id, r.name);
    audit("github.repo-created", {
      fullName: made.fullName,
      visibility: link.visibility,
      ...(several ? { repo: r.name } : {}),
    });
    return `Created ${made.fullName} (${link.visibility}). It is empty: push a branch next.`;
  }

  if (name === "push") {
    const elsewhere = given && isFullName(given) ? given : null;
    const r = elsewhere ? (repoFor(repos, null) ?? repos[0]) : target();
    const link = r?.github ?? null;
    const repo = elsewhere ?? (link ? full(link) : null);
    if (!repo || !r) throw new Error(r && several ? noLinkFor(r) : NO_LINK);
    if (link && same(repo, full(link)) && !link.ready)
      throw new Error(`${repo} doesn't exist yet: call create_repo first.`);
    const branch = s("branch") ?? job.branch;
    if (!branch) throw new Error("Say which branch to push.");
    const to = s("to") ?? branch;
    // A repo of several is pushed from its own folder: its branches, the job's included, are there.
    const cwd = several
      ? join(project.workspacePath, ...r.folder.split("/").filter(Boolean))
      : (job.worktree ?? project.workspacePath);
    if (!/^[\w./-]+$/.test(branch) || !/^[\w./-]+$/.test(to) || branch.startsWith("-"))
      throw new Error(
        "A branch name has only letters, digits, dots, dashes, underscores and slashes.",
      );
    const known = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd,
      encoding: "utf8",
    });
    if (known.status !== 0)
      throw new Error(`There is no local branch ${branch}${several ? ` in ${r.name}` : ""}.`);
    const out = await d.github.push({
      cwd,
      fullName: repo,
      refspecs: [`refs/heads/${branch}:refs/heads/${to}`],
      force: a.force === true,
      login: link?.account ?? null,
    });
    // Its address for me, never with a token: Oraknid pushes by URL, so nothing is kept in the repo's config.
    audit("github.pushed", {
      repo,
      branch,
      to,
      force: a.force === true,
      ...(several ? { projectRepo: r.name } : {}),
    });
    return `Pushed ${branch}${several ? ` of ${r.name}` : ""} to ${repo} as ${to}.${out.output ? `\n${out.output.slice(-1500)}` : ""}`;
  }

  if (name === "open_pull_request") {
    if (!repos.some((r) => r.github)) throw new Error(NO_LINK);
    const link = linkOf(target());
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
