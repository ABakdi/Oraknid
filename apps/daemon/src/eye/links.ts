import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  GitHubLinkInput,
  GitHubName,
  type GitHubVisibility,
  isProduction,
  normalizeQuestions,
  type ProjectRepo,
  type Question,
  type QuestionAnswer,
  type QuestionInput,
  type ServerView,
} from "@oraknid/contracts";
import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { eyeMessages, projects, tasks } from "../db/schema.ts";
import { AwaitingOwner } from "../engine/effects.ts";
import type { JobContext } from "../engine/runner.ts";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { Servers } from "../servers/service.ts";
import { JobServer, jobServerKey, readSetting, writeSetting } from "../settings.ts";
import type { GitHub } from "../workspace/github.ts";
import { type Projects, viewOf } from "../workspace/projects.ts";
import { isSeveral, reposOfScope } from "../workspace/repos.ts";
import { addMessage } from "./talk.ts";

// A project's GitHub repo and servers, chosen once (ADR-038): when a task
// needs GitHub or a server and the project has none linked, The Eye asks in
// the project's conversation with options (ADR-037), saves my answer to the
// project and goes on. With one account (or one server) and nothing else to
// choose, it uses it and says so. A project of several repos has a link per
// repo, asked once each; a server I name is only confirmed, and production
// always is (ADR-042).

export interface LinkDeps {
  db: Db;
  bus: EventBus;
  inbox: InboxStore;
  github?: GitHub;
  projects?: Projects;
  servers?: Servers;
  now: () => number;
}

/** `ending`: no task row, the job's own end steps (Jobs-and-Projects → Ending a job). */
type TaskLike = {
  id: string;
  title: string;
  instructions: string;
  scope?: string[];
  ending?: boolean;
};
/** The task an item is about: none for the end steps. */
const taskRef = (t: TaskLike) => (t.ending ? null : t.id);
type JobLike = { id: string; projectId: string; goal: string };

/** A task that creates, pushes to or opens a pull request on GitHub. */
export const needsGitHub = (t: Pick<TaskLike, "title" | "instructions">) =>
  /\bgit\s?hub\b|\bpull request\b|\bgh\s+(repo|pr)\b/i.test(`${t.title}\n${t.instructions}`);

/** A task that deploys or works on a server. */
export const needsServer = (t: Pick<TaskLike, "title" | "instructions">) =>
  /\bdeploy(s|ed|ing|ment)?\b|\b(on|to) (the|my|a|our) (remote |production |prod |staging |testing |test )?(server|vps)\b/i.test(
    `${t.title}\n${t.instructions}`,
  );

export const GITHUB_QUESTION = "Which GitHub repo for this project?";
export const SERVER_QUESTION = "Which server for this project?";
export const SERVER_CONFIRM = "Confirm the server";
/** The question that waits while I add a server (ADR-042): answered by itself when one is added. */
export const SERVER_ADD_WAIT = "Waiting for a new server";
export const SERVER_ADDED = "I've added it";
export const NO_SERVER = "Go on without a server";

const project = (db: Db, id: string) => {
  const p = db.select().from(projects).where(eq(projects.id, id)).get();
  if (!p) throw new Error("The job's project is gone.");
  return viewOf(p);
};

/** A word of mine in a text, as a whole word (`vps-2` isn't in `vps-20`). */
const says = (text: string, word: string) =>
  new RegExp(`(^|[^\\w-])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w-]|$)`, "i").test(
    text,
  );

/** The repos a task needing GitHub is about: the ones its scope or its words name, else all. */
export function reposForTask(repos: ProjectRepo[], task: TaskLike): ProjectRepo[] {
  if (!isSeveral(repos)) return repos;
  // A scope that names some of the repos says which; one over all of them leaves it to the words.
  const byScope = task.scope?.length ? reposOfScope(repos, task.scope) : [];
  if (byScope.length && byScope.length < repos.length) return byScope;
  const words = `${task.title}\n${task.instructions}`;
  const byWords = repos.filter((r) => says(words, r.name) || (r.folder && says(words, r.folder)));
  return byWords.length ? byWords : repos;
}

/** Before a task's attempt: the links it needs, asked once and saved to the project. */
export async function ensureLinks(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  if (
    d.github &&
    d.projects &&
    needsGitHub(task) &&
    reposForTask(project(d.db, job.projectId).repos, task).some((r) => !r.github)
  )
    await askGitHub(d, ctx, job, task);
  if (needsGitHub(task)) adaptToGitHub(d.db, job.projectId, task.id);
  if (d.servers && d.projects && needsServer(task)) await chooseServer(d, ctx, job, task);
}

/** Marks a task already adapted to its project's GitHub repo. */
const ADAPTED = "Oraknid's github tool, on";

/** A branch a task's words name: "push the dev branch", "branch dev". */
const branchIn = (text: string) =>
  /\bpush(?:es|ing)?\s+(?:the\s+)?[`'"]?([\w./-]+)[`'"]?\s+branch\b/i.exec(text)?.[1] ??
  /\bbranch\s+[`'"]?([\w./-]+)[`'"]?/i.exec(text)?.[1] ??
  null;

/** A check that reads GitHub with gh, or a git remote: one Oraknid answers itself instead. */
const remoteCheck = (v: string): "gh" | "remote" | null =>
  /(^|[\s;&|(])gh\s/.test(v) ? "gh" : /ls-remote|git\s+remote|git\s+push/.test(v) ? "remote" : null;

/**
 * A task planned before its project had a GitHub repo (or written around
 * the gh CLI) is brought to the link (ADR-038): its instructions say the
 * linked repo wins and the tool does the work; checks that call `gh` or
 * read a git remote become Oraknid's own (`oraknid github-…`), since the
 * sandbox has neither gh, nor the token, nor a remote. Once per task. In a
 * project of several repos, each check names its repo (ADR-042).
 */
export function adaptToGitHub(db: Db, projectId: string, taskId: string) {
  const p = project(db, projectId);
  const linked = p.repos.filter((r) => r.github);
  if (!linked.length) return;
  const row = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!row || row.instructions.includes(ADAPTED)) return;
  const branch = branchIn(row.instructions);
  const several = isSeveral(p.repos);
  const own = (kind: "gh" | "remote", repo: string | null) => {
    const tail = repo ? ` --repo ${repo}` : "";
    if (kind === "gh") return `oraknid github-repo${tail}`;
    return branch ? `oraknid github-branch ${branch}${tail}` : `oraknid github-repo${tail}`;
  };
  const scoped = reposForTask(p.repos, row).filter((r) => r.github);
  const verify = [
    ...new Set(
      (row.verify as string[]).flatMap((v) => {
        const kind = remoteCheck(v);
        if (!kind) return [v];
        if (!several) return [own(kind, null)];
        // The repo the check is about: named in it (`cd api && gh …`), else the task's.
        const named = linked.filter((r) => says(v, r.name) || (r.folder && says(v, r.folder)));
        const targets = named.length ? named : scoped.length ? scoped : linked;
        return targets.map((r) => own(kind, r.name));
      }),
    ),
  ];
  const note = several
    ? `Note from Oraknid: this project is several repos, each with its GitHub repo chosen by its owner: ${linked
        .map(
          (r) =>
            `${r.name} (${r.folder}/) → ${r.github?.owner}/${r.github?.name} (${r.github?.visibility})`,
        )
        .join(
          "; ",
        )}. They win over anything above about a repo, its name or its visibility. Do the GitHub work with ${ADAPTED} those repos, naming each by its name in the project (repo: "${linked[0]?.name}"): repo_info, create_repo, push, open_pull_request; never the gh CLI, a token, or a remote of your own.`
    : `Note from Oraknid: this project's GitHub repo is ${linked[0]?.github?.owner}/${linked[0]?.github?.name} (${linked[0]?.github?.visibility}), chosen by its owner; it wins over anything above about the repo, its name or its visibility. Do the GitHub work with ${ADAPTED} that repo (repo_info, create_repo, push, open_pull_request); never the gh CLI, a token, or a remote of your own.`;
  const instructions = `${row.instructions}\n\n${note}`;
  db.update(tasks).set({ instructions, verify }).where(eq(tasks.id, taskId)).run();
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
    .find((i) => (i.taskId ?? null) === taskRef(task) && i.title === title)?.id;

function ask(
  d: LinkDeps,
  job: JobLike,
  task: TaskLike,
  title: string,
  text: string,
  qs: QuestionInput[],
  options: string[] = [],
) {
  const questions = normalizeQuestions(qs);
  const itemId = d.inbox.open({
    kind: "question",
    jobId: job.id,
    taskId: taskRef(task),
    raisedBy: "eye",
    title,
    detail: text,
    options,
    defaultOption: null,
    questions,
  });
  say(d, job.id, text, questions, itemId);
  return itemId;
}

/** What I said for the job: its goal, the task, and my latest messages to The Eye. */
function myWords(d: LinkDeps, job: JobLike, task: TaskLike, last = 20): string {
  const mine = d.db
    .select({ text: eyeMessages.text, author: eyeMessages.author })
    .from(eyeMessages)
    .where(eq(eyeMessages.projectId, job.projectId))
    .orderBy(asc(eyeMessages.createdAt))
    .all()
    .filter((m) => m.author === "owner")
    .slice(-last)
    .map((m) => m.text);
  return [task.title, task.instructions, job.goal, ...mine].join("\n");
}

/**
 * What I said for a server (ADR-042): the task, the job's goal, and my
 * latest message to The Eye about this job; not my answers to its questions.
 */
function serverWords(d: LinkDeps, job: JobLike, task: TaskLike): string {
  const latest = d.db
    .select({ text: eyeMessages.text, author: eyeMessages.author, replyTo: eyeMessages.replyTo })
    .from(eyeMessages)
    .where(eq(eyeMessages.jobId, job.id))
    .orderBy(asc(eyeMessages.createdAt))
    .all()
    .filter((m) => m.author === "owner" && !m.replyTo)
    .at(-1)?.text;
  return [task.title, task.instructions, job.goal, latest ?? ""].join("\n");
}

/** Whether my words ask for something public: what I said for the job, the task, or to The Eye. */
const wantsPublic = (d: LinkDeps, job: JobLike, task: TaskLike) =>
  /\bpublic\b/i.test(myWords(d, job, task));

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100) || "project";

/** The GitHub repo a folder already points to (its `origin`), if any. */
function originRepo(path: string): { owner: string; name: string } | null {
  const r = spawnSync("git", ["remote", "get-url", "origin"], { cwd: path, encoding: "utf8" });
  const m = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(\.git)?\/?$/.exec(
    (r.stdout ?? "").trim(),
  );
  return m ? { owner: m[1] as string, name: m[2] as string } : null;
}

const folderOf = (projectPath: string, r: ProjectRepo) =>
  r.folder ? join(projectPath, ...r.folder.split("/")) : projectPath;

/** A new repo's name: the project's for its one repo, `<project>-<repo>` for one of several. */
const newName = (projectName: string, r: ProjectRepo, several: boolean) => {
  const base = slug(projectName);
  if (!several || slug(r.name) === base || slug(r.name).startsWith(`${base}-`)) {
    return several ? slug(r.name) : base;
  }
  return `${base}-${slug(r.name)}`.slice(0, 100);
};

/** The question id of a repo's choice: `repo` for a project of one repo, as before. */
const repoQ = (r: ProjectRepo, several: boolean) => (several ? `repo:${r.name}` : "repo");

async function askGitHub(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  const github = d.github as GitHub;
  const projects = d.projects as Projects;
  const missing = () =>
    reposForTask(project(d.db, job.projectId).repos, task).filter((r) => !r.github);
  for (let n = 1; n <= 6; n++) {
    if (!missing().length) return;
    const asked = await ctx.step(`link:github:${task.id}:${n}`, null, async () => {
      const again = openItem(d, job, task, GITHUB_QUESTION);
      if (again) return { itemId: again as string | null };
      const p = project(d.db, job.projectId);
      const several = isSeveral(p.repos);
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
      // One account, and a repo's folder already points to one of its repos: nothing to choose.
      const linkedNow: string[] = [];
      for (const r of missing()) {
        const origin = originRepo(folderOf(p.workspacePath, r));
        if (!only || !origin) continue;
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
          r.name,
        );
        linkedNow.push(several ? `${r.name} to **${origin.owner}/${origin.name}**` : "");
        if (!several)
          say(
            d,
            job.id,
            `“${task.title}” needs GitHub. I linked this project to **${origin.owner}/${origin.name}**, where its folder already points, through **${only}**, your only GitHub account. Change it in the project's Repo tab.`,
          );
      }
      if (several && linkedNow.length)
        say(
          d,
          job.id,
          `“${task.title}” needs GitHub. Through **${only}**, your only GitHub account, I linked ${linkedNow.join(", ")}, where their folders already point. Change them in the project's Repo tab.`,
        );
      const left = missing();
      if (!left.length) return { itemId: null };
      const account = only ?? (accounts[0] as string);
      let repos: { fullName: string; private: boolean }[] = [];
      try {
        repos = (await github.repos(account)).slice(0, several ? 4 : 5);
      } catch {}
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
      for (const r of left)
        questions.push({
          id: repoQ(r, several),
          shape: "single",
          prompt: several
            ? `Which repository for ${r.name} (${r.folder}/)? Or type owner/name of one that exists, or a name for a new one.`
            : "Which repository? Or type owner/name of one that exists, or a name for a new one.",
          options: [
            {
              id: "new",
              label: `Create a new repo: ${only ? `${only}/` : ""}${newName(p.name, r, several)}`,
              detail: "Oraknid creates it and pushes the work there.",
            },
            ...repos.map((x, i) => ({
              id: `e${i + 1}`,
              label: x.fullName,
              detail: x.private ? "Private, exists" : "Public, exists",
            })),
          ],
          recommended: "new",
          allowOther: true,
        });
      questions.push({
        id: "visibility",
        shape: "single",
        prompt: several ? "If one is new, who can see it?" : "If it's a new repo, who can see it?",
        options: [
          { id: "private", label: "Private", detail: "Only you, and who you add." },
          { id: "public", label: "Public", detail: "Anyone on the internet." },
        ],
        recommended: pub ? "public" : "private",
        allowOther: false,
      });
      const text = several
        ? `“${task.title}” needs GitHub repos for ${left.map((r) => `**${r.name}**`).join(" and ")}, and ${left.length > 1 ? "they have" : "it has"} none linked yet.${
            only ? ` I'll use **${only}**, your only GitHub account.` : ""
          } Choose once: I keep each in the project's Repo tab and use it from now on.`
        : `“${task.title}” needs a GitHub repo, and this project has none linked yet.${
            only ? ` I'll use **${only}**, your only GitHub account.` : ""
          } Choose once: I keep it in the project's Settings and use it from now on.`;
      return { itemId: ask(d, job, task, GITHUB_QUESTION, text, questions) };
    });
    if (!asked.itemId) continue;
    const item = d.inbox.get(asked.itemId);
    if (item?.state === "open")
      throw new AwaitingOwner(asked.itemId, "Waiting for which GitHub repo to use.");
    if (item?.state !== "answered") continue;
    const linked = await ctx.step(`link:github:${task.id}:${n}:answer`, null, async () => {
      const questions = (item.questions ?? []) as Question[];
      if (questions.some((q) => q.id === "connected")) return false;
      const accounts = (await github.accounts()).filter((a) => a.login).map((a) => a.login);
      const p = project(d.db, job.projectId);
      const several = isSeveral(p.repos);
      const asked = p.repos.filter((r) => questions.some((q) => q.id === repoQ(r, several)));
      const links: { repo: ProjectRepo; link: GitHubLinkInput }[] = [];
      for (const r of asked) {
        const l = linkFromAnswers(
          questions,
          item.answers ?? null,
          item.answer ?? "",
          accounts,
          newName(p.name, r, several),
          repoQ(r, several),
        );
        if (typeof l === "string") {
          say(d, job.id, `${several ? `${r.name}: ` : ""}${l} I'll ask again.`);
          return false;
        }
        // A repo that exists has the visibility GitHub says, not the one asked for a new one.
        if (l.origin === "existing")
          try {
            l.visibility = (await github.repo(`${l.owner}/${l.name}`, l.account)).private
              ? "private"
              : "public";
          } catch {}
        links.push({ repo: r, link: l });
      }
      for (const { repo, link } of links) projects.setGitHub(p.id, link, "eye", repo.name);
      const said = links
        .map(
          ({ repo, link: r }) =>
            `${several ? `${repo.name} → ` : ""}**${r.owner}/${r.name}** (${r.visibility}${r.origin === "new" ? ", to be created" : ""})`,
        )
        .join(", ");
      say(
        d,
        job.id,
        `Linked: ${said}, through **${links[0]?.link.account}**. I keep ${links.length > 1 ? "them" : "it"} in the project's ${several ? "Repo tab" : "Settings"}. Going on with “${task.title}”.`,
      );
      return true;
    });
    if (linked && !missing().length) return;
  }
  throw new Error(
    "No GitHub repo could be linked: link one in the project's Repo tab, then resume the job.",
  );
}

/**
 * The link my answers describe (ADR-038), or why they don't describe one.
 * Answers in words only (an old client) are read as best they can be.
 * `repoId` is the repo question's id: one per repo in a project of several.
 */
export function linkFromAnswers(
  questions: Question[],
  answers: QuestionAnswer[] | null,
  words: string,
  accounts: string[],
  defaultName: string,
  repoId = "repo",
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
  const repo = by(repoId);
  const chosen = repo?.options[0];
  let typed = repo?.text.trim() ?? "";
  if (!answers && words) typed = /[\w.-]+\/[\w.-]+/.exec(words)?.[0] ?? "";
  let owner = account;
  let name = defaultName;
  let origin: "new" | "existing" = "new";
  if (chosen && chosen !== "new") {
    const label = optionLabel(repoId, chosen) ?? "";
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

// ── Choosing a server (ADR-042) ─────────────────────────────────────

const ROLES = ["production", "staging", "testing"] as const;

/** A role my words name: "production" (or "prod"), "staging", "testing" (or "test"), or one of the project's. */
export function roleIn(text: string, roles: string[] = []): string | null {
  for (const r of roles.filter(Boolean)) if (says(text, r)) return r;
  if (says(text, "production") || says(text, "prod")) return "production";
  if (says(text, "staging")) return "staging";
  if (says(text, "testing") || says(text, "test server")) return "testing";
  return null;
}

/** A server as The Eye offers it: its name, its role in the project, production or not. */
interface Offered {
  server: ServerView;
  role: string;
  production: boolean;
  inProject: boolean;
}

function offered(d: LinkDeps, projectId: string): Offered[] {
  const p = project(d.db, projectId);
  const all = (d.servers as Servers).list();
  const mine = p.serverIds
    .map((id) => all.find((s) => s.id === id))
    .filter((s): s is ServerView => !!s)
    .map((s) => ({
      server: s,
      role: p.serverRoles[s.id]?.role ?? "",
      production: isProduction(p.serverRoles[s.id]),
      inProject: true,
    }));
  const others = all
    .filter((s) => !p.serverIds.includes(s.id))
    .map((s) => ({ server: s, role: "", production: false, inProject: false }));
  // The project's servers first, by role (production last: never the easy pick), then mine.
  const rank = (o: Offered) => (o.production ? 2 : o.role ? 0 : 1);
  return [...mine.sort((a, b) => rank(a) - rank(b)), ...others];
}

/**
 * The server my words name (ADR-042): by its name, among the project's then
 * all mine, or by its role among the project's. Null when they name none.
 */
export function namedServer(
  servers: Offered[],
  words: string,
): { offer: Offered; role: string | null } | null {
  const role = roleIn(
    words,
    servers.filter((o) => o.inProject).map((o) => o.role),
  );
  const byName = servers.find((o) => says(words, o.server.name));
  if (byName) return { offer: byName, role };
  if (!role) return null;
  const byRole =
    servers.find((o) => o.inProject && o.role.toLowerCase() === role.toLowerCase()) ??
    (role === "production" ? servers.find((o) => o.inProject && o.production) : undefined);
  return byRole ? { offer: byRole, role } : null;
}

const jobServer = (db: Db, jobId: string) =>
  readSetting(db, jobServerKey(jobId), JobServer, { serverId: null, declined: [] });

const label = (o: Offered) => (o.role ? `${o.server.name} — ${o.role}` : o.server.name);

/**
 * The server a task's work goes to (ADR-042), chosen once per job: the one
 * my words name, confirmed; else the project's only one when it isn't
 * production; else asked with options (the project's by role, then mine,
 * and Add a new server). Production is always confirmed. My choice is saved
 * to the project with its role.
 */
async function chooseServer(d: LinkDeps, ctx: JobContext, job: JobLike, task: TaskLike) {
  const projects = d.projects as Projects;
  for (let n = 1; n <= 8; n++) {
    const chosen = jobServer(d.db, job.id);
    const list = offered(d, job.projectId);
    const words = serverWords(d, job, task);
    const named = namedServer(
      list.filter((o) => !chosen.declined.includes(o.server.id)),
      words,
    );
    // Chosen for this job already, and not another one named now: nothing to ask.
    if (chosen.serverId === "none" && !named) return;
    if (
      chosen.serverId &&
      chosen.serverId !== "none" &&
      (!named || named.offer.server.id === chosen.serverId)
    )
      return;
    const asked = await ctx.step(`link:server:${task.id}:${n}`, null, async () => {
      for (const title of [SERVER_ADD_WAIT, SERVER_CONFIRM, SERVER_QUESTION]) {
        const again = openItem(d, job, task, title);
        if (again) return { itemId: again as string | null, serverId: null as string | null };
      }
      const confirm = (o: Offered, role: string | null) => {
        const r = o.role || role || "";
        const where = r ? `${r}, ${o.server.name}` : o.server.name;
        const verb = /\bdeploy/i.test(`${task.title}\n${task.instructions}`) ? "Deploy to" : "Use";
        const note = o.inProject
          ? ""
          : ` It isn't one of this project's servers yet: I'll add it${r ? ` as ${r}` : ""}.`;
        return {
          itemId: ask(d, job, task, SERVER_CONFIRM, `“${task.title}” needs a server.${note}`, [
            {
              id: "confirm",
              shape: "confirm",
              prompt: `${verb} ${where}?`,
              options: [
                { id: "yes", label: "Yes", detail: `${o.server.user}@${o.server.host}` },
                { id: "no", label: "No, another" },
              ],
              recommended: "yes",
              allowOther: false,
            },
          ]),
          serverId: o.server.id,
        };
      };
      if (named) return confirm(named.offer, named.role);
      const inProject = list.filter((o) => o.inProject && !chosen.declined.includes(o.server.id));
      if (inProject.length === 1 && list.filter((o) => o.inProject).length === 1) {
        const only = inProject[0] as Offered;
        // Production is never used without my yes, even as the only one.
        if (only.production) return confirm(only, null);
        writeSetting(d.db, jobServerKey(job.id), JobServer, {
          ...chosen,
          serverId: only.server.id,
        });
        say(
          d,
          job.id,
          `“${task.title}” needs a server: I use **${label(only)}**, this project's only one. Change it in the project's Settings.`,
        );
        return { itemId: null, serverId: only.server.id };
      }
      const choices = list.filter((o) => !chosen.declined.includes(o.server.id)).slice(0, 7);
      const role = roleIn(words);
      // Back from adding one: the newest is the one I just added.
      const added = d.inbox
        .list({ jobId: job.id, kind: "question", state: "answered" })
        .some((i) => i.taskId === task.id && i.title === SERVER_ADD_WAIT);
      const newest = added
        ? [...choices]
            .filter((o) => !o.inProject)
            .sort((a, b) => b.server.createdAt - a.server.createdAt)[0]
        : undefined;
      const text = list.length
        ? `“${task.title}” needs a server. Which one? I keep it in the project's Settings with its role.`
        : `“${task.title}” needs a server, and Oraknid has none yet. Add one and I'll ask again.`;
      const questions: QuestionInput[] = [
        {
          id: "server",
          shape: "single",
          prompt: "Which server should this job use?",
          options: [
            ...choices.map((o) => ({
              id: o.server.id,
              label: label(o),
              detail: `${o.inProject ? "" : "Not in this project yet · "}${o.server.user}@${o.server.host}${o.production ? " · production" : ""}`,
            })),
            {
              id: "add",
              label: "Add a new server",
              detail: "Opens Servers; I ask again once it's added.",
            },
            { id: "none", label: NO_SERVER },
          ],
          recommended:
            newest?.server.id ??
            choices.find((o) => o.inProject && !o.production)?.server.id ??
            null,
          allowOther: false,
        },
      ];
      if (list.some((o) => !o.inProject) || !list.length)
        questions.push({
          id: "role",
          shape: "single",
          prompt: "Its role in this project, if it's new to it?",
          options: ROLES.map((r) => ({ id: r, label: r[0]?.toUpperCase() + r.slice(1) })),
          recommended: role,
          allowOther: true,
        });
      return { itemId: ask(d, job, task, SERVER_QUESTION, text, questions), serverId: null };
    });
    if (!asked.itemId) {
      if (asked.serverId) return;
      continue;
    }
    const item = d.inbox.get(asked.itemId);
    if (item?.state === "open")
      throw new AwaitingOwner(asked.itemId, "Waiting for which server to use.");
    if (item?.state !== "answered") continue;
    const done = await ctx.step(`link:server:${task.id}:${n}:answer`, null, async () => {
      const now = jobServer(d.db, job.id);
      const pick = (id: string, role: string | null) => {
        const o = offered(d, job.projectId).find((x) => x.server.id === id);
        if (!o) {
          say(d, job.id, "That server is gone. I'll ask again.");
          return false;
        }
        const r = o.role || role || "";
        if (!o.inProject || (!o.role && r))
          projects.setServerRole(job.projectId, id, { role: r, production: null }, "eye");
        writeSetting(d.db, jobServerKey(job.id), JobServer, { ...now, serverId: id });
        say(
          d,
          job.id,
          `${o.inProject ? "This job uses" : "Added to this project and used by this job:"} **${r ? `${o.server.name} — ${r}` : o.server.name}**. Going on with “${task.title}”.`,
        );
        return true;
      };
      const answer = (qid: string) => item.answers?.find((a) => a.questionId === qid);
      if (item.title === SERVER_ADD_WAIT) {
        if (answer("wait")?.options[0] === "none" || item.answer === NO_SERVER) {
          writeSetting(d.db, jobServerKey(job.id), JobServer, { ...now, serverId: "none" });
          say(d, job.id, `Going on with “${task.title}” without a server.`);
          return true;
        }
        return false;
      }
      if (item.title === SERVER_CONFIRM) {
        const yes = answer("confirm")?.options[0] !== "no" && !/^no\b/i.test(item.answer ?? "");
        if (yes && asked.serverId) return pick(asked.serverId, roleIn(serverWords(d, job, task)));
        if (asked.serverId)
          writeSetting(d.db, jobServerKey(job.id), JobServer, {
            serverId: now.serverId === asked.serverId ? null : now.serverId,
            declined: [...new Set([...now.declined, asked.serverId])],
          });
        return false;
      }
      const chosenId = answer("server")?.options[0];
      const role = answer("role")?.options[0] ?? (answer("role")?.text.trim() || null);
      if (chosenId === "none") {
        writeSetting(d.db, jobServerKey(job.id), JobServer, { ...now, serverId: "none" });
        say(d, job.id, `Going on with “${task.title}” without a server.`);
        return true;
      }
      if (chosenId === "add") {
        // The question waits for the new server: answered by itself when one is added.
        ask(
          d,
          job,
          task,
          SERVER_ADD_WAIT,
          `Add the server in [Servers → Add a server](/servers?add=1); I ask again as soon as it's added. Or tell me to go on without one.`,
          [
            {
              id: "wait",
              shape: "single",
              prompt: "Waiting for the new server",
              options: [
                { id: "added", label: SERVER_ADDED },
                { id: "none", label: NO_SERVER },
              ],
              recommended: null,
              allowOther: false,
            },
          ],
        );
        return false;
      }
      if (!chosenId) {
        say(d, job.id, "No server chosen. I'll ask again.");
        return false;
      }
      // Chosen from the list: my answer is the confirmation, production included.
      return pick(chosenId, role);
    });
    if (done) return;
  }
  throw new Error(
    "No server was chosen: choose one in the project's Settings, then resume the job.",
  );
}

/** A server was added: questions waiting for one go on, and The Eye asks again (ADR-042). */
export function serverAdded(inbox: InboxStore) {
  for (const item of inbox.list({ kind: "question", state: "open" }))
    if (item.title === SERVER_ADD_WAIT) {
      try {
        inbox.answer(item.id, SERVER_ADDED, null, [
          { questionId: "wait", options: ["added"], text: "" },
        ]);
      } catch {}
    }
}
