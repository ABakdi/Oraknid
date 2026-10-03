import { spawnSync } from "node:child_process";
import {
  GitHubLinkInput,
  GitHubName,
  type GitHubVisibility,
  normalizeQuestions,
  type Question,
  type QuestionAnswer,
  type QuestionInput,
} from "@oraknid/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, projects } from "../db/schema.ts";
import { AwaitingOwner } from "../engine/effects.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Servers } from "../servers/service.ts";
import type { GitHub } from "../workspace/github.ts";
import type { Projects } from "../workspace/projects.ts";
import { addMessage } from "./talk.ts";

// A project's GitHub repo and servers, chosen once (ADR-038): when a task
// needs GitHub or a server and the project has none linked, The Eye asks in
// the project's conversation with options (ADR-037), saves my answer to the
// project and goes on. With one account (or one server) and nothing else to
// choose, it uses it and says so.

export interface LinkDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  github?: GitHub;
  projects?: Projects;
  servers?: Servers;
  now: () => number;
}

type TaskLike = { id: string; title: string; instructions: string };
type JobLike = { id: string; projectId: string; goal: string };

/** A task that creates, pushes to or opens a pull request on GitHub. */
export const needsGitHub = (t: Pick<TaskLike, "title" | "instructions">) =>
  /\bgit\s?hub\b|\bpull request\b|\bgh\s+(repo|pr)\b/i.test(`${t.title}\n${t.instructions}`);

/** A task that deploys or works on a server. */
export const needsServer = (t: Pick<TaskLike, "title" | "instructions">) =>
  /\bdeploy(s|ed|ing|ment)?\b|\b(on|to) (the|my|a|our) (remote |production |prod )?(server|vps)\b/i.test(
    `${t.title}\n${t.instructions}`,
  );

export const GITHUB_QUESTION = "Which GitHub repo for this project?";
export const SERVER_QUESTION = "Which server for this project?";

const project = (db: Db, id: string) => {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw new Error("The job's project is gone.");
  return p;
};

/** Before a task's attempt: the links it needs, asked once and saved to the project. */
export async function ensureLinks(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  if (d.github && d.projects && needsGitHub(task) && !project(d.db, job.projectId).github)
    await askGitHub(d, ctx, job, task);
  if (
    d.servers &&
    d.projects &&
    needsServer(task) &&
    project(d.db, job.projectId).serverIds.length === 0
  )
    await askServer(d, ctx, job, task);
}

const say = (d: LinkDeps, jobId: string, text: string, questions?: Question[], itemId?: string) =>
  addMessage(d, jobId, "eye", text, null, {
    ...(questions ? { questions } : {}),
    ...(itemId ? { itemId } : {}),
  });

/** The question asked for this task, still open after a crash, is asked no second time. */
const openItem = (d: LinkDeps, job: JobLike, task: TaskLike, title: string) =>
  d.inbox
    .list({ jobId: job.id, kind: "question", state: "open" })
    .find((i) => i.taskId === task.id && i.title === title)?.id;

function ask(
  d: LinkDeps,
  job: JobLike,
  task: TaskLike,
  title: string,
  text: string,
  qs: QuestionInput[],
) {
  const questions = normalizeQuestions(qs);
  const itemId = d.inbox.open({
    kind: "question",
    jobId: job.id,
    taskId: task.id,
    raisedBy: "eye",
    title,
    detail: text,
    options: [],
    defaultOption: null,
    questions,
  });
  say(d, job.id, text, questions, itemId);
  return itemId;
}

/** Whether my words ask for something public: what I said for the job, the task, or to The Eye. */
function wantsPublic(d: LinkDeps, job: JobLike, task: TaskLike): boolean {
  const mine = d.db
    .select({ text: eyeMessages.text, author: eyeMessages.author })
    .from(eyeMessages)
    .where(eq(eyeMessages.projectId, job.projectId))
    .orderBy(asc(eyeMessages.createdAt))
    .all()
    .filter((m) => m.author === "owner")
    .slice(-20)
    .map((m) => m.text);
  return /\bpublic\b/i.test([task.title, task.instructions, job.goal, ...mine].join("\n"));
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "project";

/** The GitHub repo the project's folder already points to (its `origin`), if any. */
function originRepo(path: string): { owner: string; name: string } | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: path, encoding: "utf8" });
  const m = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(\.git)?\/?$/.exec(
    (r.stdout ?? "").trim(),
  );
  return m ? { owner: m[1] as string, name: m[2] as string } : null;
}

async function askGitHub(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  const github = d.github as GitHub;
  const projects = d.projects as Projects;
  for (let n = 1; n <= 6; n++) {
    if (project(d.db, job.projectId).github) return;
    const asked = await ctx.step(`link:github:${task.id}:${n}`, null, async () => {
      const again = openItem(d, job, task, GITHUB_QUESTION);
      if (again) return { itemId: again as string | null };
      const p = project(d.db, job.projectId);
      const accounts = (await github.accounts()).filter((a) => a.login).map((a) => a.login);
      if (!accounts.length) {
        const text = `“${task.title}” needs GitHub, and Oraknid has no GitHub account yet. Add a token in **Settings → Connections → GitHub**, then tell me here.`;
        return {
          itemId: ask(d, job, task, GITHUB_QUESTION, text, [
            {
              id: "connected",
              shape: "single",
              prompt: "Is a GitHub account added?",
              options: [{ id: "added", label: "I've added a GitHub account" }],
              recommended: "added",
              allowOther: false,
            },
          ]),
        };
      }
      const only = accounts.length === 1 ? (accounts[0] as string) : null;
      // One account, and the folder already points to one of its repos: nothing to choose.
      const origin = originRepo(p.workspacePath);
      if (only && origin) {
        let visibility: GitHubVisibility = "private";
        try {
          visibility = (await github.repo(`${origin.owner}/${origin.name}`, only)).private
            ? "private"
            : "public";
        } catch {}
        projects.setGitHub(
          p.id,
          { account: only, ...origin, visibility, origin: "existing" },
          "eye",
        );
        say(
          d,
          job.id,
          `“${task.title}” needs GitHub. I linked this project to **${origin.owner}/${origin.name}**, where its folder already points, through **${only}**, your only GitHub account. Change it in the project's Settings.`,
        );
        return { itemId: null };
      }
      const account = only ?? (accounts[0] as string);
      let repos: { fullName: string; private: boolean }[] = [];
      try {
        repos = (await github.repos(account)).slice(0, 5);
      } catch {}
      const name = slug(p.name);
      const pub = wantsPublic(d, job, task);
      const questions: QuestionInput[] = [];
      if (!only)
        questions.push({
          id: "account",
          shape: "single",
          prompt: "Which GitHub account should Oraknid use for this project?",
          options: accounts.map((login) => ({ id: login.slice(0, 80), label: login })),
          recommended: account.slice(0, 80),
          allowOther: false,
        });
      questions.push({
        id: "repo",
        shape: "single",
        prompt: "Which repository? Or type owner/name of one that exists, or a name for a new one.",
        options: [
          {
            id: "new",
            label: `Create a new repo: ${only ? `${only}/` : ""}${name}`,
            detail: "Oraknid creates it and pushes the work there.",
          },
          ...repos.map((r, i) => ({
            id: `e${i + 1}`,
            label: r.fullName,
            detail: r.private ? "Private, exists" : "Public, exists",
          })),
        ],
        recommended: "new",
        allowOther: true,
      });
      questions.push({
        id: "visibility",
        shape: "single",
        prompt: "If it's a new repo, who can see it?",
        options: [
          { id: "private", label: "Private", detail: "Only you, and who you add." },
          { id: "public", label: "Public", detail: "Anyone on the internet." },
        ],
        recommended: pub ? "public" : "private",
        allowOther: false,
      });
      const text = `“${task.title}” needs a GitHub repo, and this project has none linked yet.${
        only ? ` I'll use **${only}**, your only GitHub account.` : ""
      } Choose once: I keep it in the project's Settings and use it from now on.`;
      return { itemId: ask(d, job, task, GITHUB_QUESTION, text, questions) };
    });
    if (!asked.itemId) return;
    const item = d.inbox.get(asked.itemId);
    if (item?.state === "open")
      throw new AwaitingOwner(asked.itemId, "Waiting for which GitHub repo to use.");
    if (item?.state !== "answered") continue;
    const linked = await ctx.step(`link:github:${task.id}:${n}:answer`, null, async () => {
      const questions = (item.questions ?? []) as Question[];
      if (questions.some((q) => q.id === "connected")) return false;
      const accounts = (await github.accounts()).filter((a) => a.login).map((a) => a.login);
      const p = project(d.db, job.projectId);
      const r = linkFromAnswers(
        questions,
        item.answers ?? null,
        item.answer ?? "",
        accounts,
        slug(p.name),
      );
      if (typeof r === "string") {
        say(d, job.id, `${r} I'll ask again.`);
        return false;
      }
      projects.setGitHub(p.id, r, "eye");
      say(
        d,
        job.id,
        `Linked: **${r.owner}/${r.name}** (${r.visibility}${r.origin === "new" ? ", to be created" : ""}), through **${r.account}**. I keep it in the project's Settings. Going on with “${task.title}”.`,
      );
      return true;
    });
    if (linked) return;
  }
  throw new Error(
    "No GitHub repo could be linked: link one in the project's Settings, then resume the job.",
  );
}

/**
 * The link my answers describe (ADR-038), or why they don't describe one.
 * Answers in words only (an old client) are read as best they can be.
 */
export function linkFromAnswers(
  questions: Question[],
  answers: QuestionAnswer[] | null,
  words: string,
  accounts: string[],
  defaultName: string,
): GitHubLinkInput | string {
  const by = (id: string) => answers?.find((a) => a.questionId === id);
  const q = (id: string) => questions.find((x) => x.id === id);
  const optionLabel = (qid: string, oid: string | undefined) =>
    q(qid)?.options.find((o) => o.id === oid)?.label;
  const accountAnswer = by("account");
  const account =
    optionLabel("account", accountAnswer?.options[0]) ??
    (accountAnswer?.text.trim() || (accounts.length === 1 ? accounts[0] : undefined));
  if (!account || !accounts.includes(account))
    return `I couldn't tell which GitHub account (${accounts.join(", ")}).`;
  const repo = by("repo");
  const chosen = repo?.options[0];
  let typed = repo?.text.trim() ?? "";
  if (!answers && words) typed = /[\w.-]+\/[\w.-]+/.exec(words)?.[0] ?? "";
  let owner = account;
  let name = defaultName;
  let origin: "new" | "existing" = "new";
  if (chosen && chosen !== "new") {
    const label = optionLabel("repo", chosen) ?? "";
    [owner, name] = label.split("/") as [string, string];
    origin = "existing";
  } else if (!chosen && typed) {
    if (typed.includes("/")) {
      [owner, name] = typed
        .replace(/\.git$/, "")
        .split("/")
        .slice(-2) as [string, string];
      origin = "existing";
    } else name = typed;
  }
  const visibility = (by("visibility")?.options[0] ??
    (!answers && /\bpublic\b/i.test(words) ? "public" : null) ??
    q("visibility")?.recommended ??
    "private") as GitHubVisibility;
  if (!GitHubName.safeParse(owner).success || !GitHubName.safeParse(name).success)
    return `“${owner}/${name}” isn't a repository name GitHub takes.`;
  return GitHubLinkInput.parse({ account, owner, name, visibility, origin });
}

async function askServer(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  const servers = d.servers as Servers;
  const projects = d.projects as Projects;
  const asked = await ctx.step(`link:server:${task.id}`, null, async () => {
    const again = openItem(d, job, task, SERVER_QUESTION);
    if (again) return { itemId: again as string | null };
    const list = servers.list();
    if (!list.length) {
      // Nothing to choose from: said once, and the task goes on.
      say(
        d,
        job.id,
        `“${task.title}” looks like it needs a server, and Oraknid has none yet. Add one in **Servers**, then give it to this project in its Servers tab.`,
      );
      return { itemId: null };
    }
    if (list.length === 1) {
      const only = list[0] as (typeof list)[number];
      projects.setServers(job.projectId, [only.id]);
      say(
        d,
        job.id,
        `“${task.title}” needs a server: I gave this project **${only.name}**, your only one. Change it in the project's Servers tab.`,
      );
      return { itemId: null };
    }
    const text = `“${task.title}” needs a server, and this project has none yet. Choose once: I keep it in the project's Servers.`;
    return {
      itemId: ask(d, job, task, SERVER_QUESTION, text, [
        {
          id: "server",
          shape: "single",
          prompt: "Which server should this project's jobs use?",
          options: list.slice(0, 9).map((s) => ({ id: s.id, label: s.name, detail: s.host })),
          recommended: list[0]?.id ?? null,
          allowOther: false,
        },
      ]),
    };
  });
  if (!asked.itemId) return;
  const item = d.inbox.get(asked.itemId);
  if (item?.state === "open")
    throw new AwaitingOwner(asked.itemId, "Waiting for which server to use.");
  await ctx.step(`link:server:${task.id}:answer`, null, async () => {
    const chosen = item?.answers?.find((a) => a.questionId === "server")?.options[0];
    const s = chosen ? servers.list().find((x) => x.id === chosen) : undefined;
    if (!s) {
      say(d, job.id, "No server chosen: the task goes on without one.");
      return null;
    }
    projects.setServers(job.projectId, [s.id]);
    say(d, job.id, `This project uses **${s.name}** now. Going on with “${task.title}”.`);
    return null;
  });
}
