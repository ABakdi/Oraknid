import type { GitHubLink, ProjectRepo, ProjectView } from "@oraknid/contracts";
import {
  ExternalLink,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { ProjectGitHubCard } from "@/components/project-github";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { ownerKey, rapi, repoHref } from "@/pages/repos";

/** A project of several repos (ADR-042): more than one, or one in a folder of the project's. */
export const isSeveral = (repos: ProjectRepo[] | undefined) =>
  !!repos && (repos.length > 1 || (repos.length === 1 && repos[0]?.folder !== ""));

/**
 * A project's Repo tab (ADR-038, ADR-040, ADR-042): the GitHub repo it is
 * linked to, what's on it now (recent commits, branches, open pull
 * requests), the way into Repos for its code, and the card to link, change
 * or unlink it; for a project of several repos, each repo with its own.
 * Its repos are listed, found again or added at the bottom (or the top,
 * when there are several).
 */
export function ProjectRepoTab({ project }: { project: ProjectView }) {
  const repos = project.repos ?? [];
  if (isSeveral(repos))
    return (
      <div className="space-y-6">
        <ProjectReposCard project={project} />
        {repos.map((r) => (
          <section key={r.name} data-help="project.repo-each" className="min-w-0 space-y-3">
            <h3 className="flex min-w-0 flex-wrap items-baseline gap-2 text-sm font-semibold">
              <FolderGit2 className="size-4 self-center" />
              <span className="[overflow-wrap:anywhere]">{r.name}</span>
              <code className="text-xs font-normal text-muted-foreground">{r.folder}/</code>
              <span className="text-xs font-normal text-muted-foreground">
                {r.releaseBranch} / {r.workBranch}
              </span>
            </h3>
            <LinkedNow link={r.github} />
            <ProjectGitHubCard project={project} repo={r} />
          </section>
        ))}
      </div>
    );
  return (
    <div className="space-y-4">
      <LinkedNow link={project.github as GitHubLink | null} />
      <ProjectGitHubCard project={project} />
      <ProjectReposCard project={project} />
    </div>
  );
}

function LinkedNow({ link }: { link: GitHubLink | null }) {
  if (!link) return null;
  if (link.ready) return <RepoNow link={link} />;
  return (
    <Empty title={t("Not created yet")}>
      {t(
        "{repo} is created on GitHub the first time a job pushes to it: its commits show here then.",
        { repo: `${link.owner}/${link.name}` },
      )}
    </Empty>
  );
}

/**
 * The project's repos (ADR-042): each with its folder, branches and link;
 * found again in its folder, or one added (a folder of it, a new empty
 * one, a clone).
 */
export function ProjectReposCard({ project }: { project: ProjectView }) {
  const repos = project.repos ?? [];
  const several = isSeveral(repos);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectRepo | null>(null);
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const detect = async () => {
    setBusy(true);
    try {
      const found = await api.projects.detectRepos({ id: project.id });
      const added = found.length - repos.length;
      toast.success(
        added > 0
          ? t("Found {n} more: {names}.", {
              n: added,
              names: found
                .slice(repos.length)
                .map((r) => r.name)
                .join(", "),
            })
          : t("No other repo in its folder."),
      );
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (r: ProjectRepo) => {
    if (
      !(await confirm(
        t("Take {name} out of the project?", { name: r.name }),
        t("Its folder and its history stay as they are; Oraknid's jobs stop working in it."),
        t("Take it out"),
        { keep: t("Keep it") },
      ))
    )
      return;
    api.projects
      .removeRepo({ id: project.id, name: r.name })
      .then(() => toast.success(t("{name} is no longer one of its repos.", { name: r.name })))
      .catch((e) => toast.error(message(e)));
  };
  return (
    <Card data-help="project.repos">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FolderGit2 className="size-4" />
          {several ? t("Its repos") : t("Its repo")}
        </CardTitle>
        <CardDescription>
          {several
            ? t(
                "Each repo has its folder, its branches and its GitHub link. A job works in the ones its tasks touch, commits and merges each on its own.",
              )
            : project.shadow
              ? t("Not a git repo: its checkpoints are kept in a shadow repo.")
              : t(
                  "Its folder is its repo. A project can also hold several repos in its folders (a site and its API): add one, or find them again.",
                )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {repos.length ? (
          <ul className="divide-y rounded-md border">
            {repos.map((r) => (
              <li
                key={r.name}
                className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2"
              >
                <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{r.name}</span>
                <code className="text-xs text-muted-foreground">
                  {r.folder ? `${r.folder}/` : t("the project's folder")}
                </code>
                <span className="text-xs text-muted-foreground">
                  {r.releaseBranch} / {r.workBranch}
                </span>
                {/* Room to be read: it goes to the next line rather than being cut to nothing. */}
                <span className="min-w-[min(100%,8.5rem)] flex-1 truncate text-xs">
                  {r.github ? (
                    <span className="font-mono">
                      {r.github.owner}/{r.github.name}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">{t("not on GitHub yet")}</span>
                  )}
                </span>
                <span className="ml-auto flex shrink-0 items-center">
                  <Button
                    data-help="project.repo-edit"
                    size="icon"
                    variant="ghost"
                    className="size-8"
                    aria-label={t("Change {name}", { name: r.name })}
                    title={t("Rename it, or change its branches")}
                    onClick={() => setEditing(r)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  {several ? (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8"
                      aria-label={t("Take {name} out", { name: r.name })}
                      onClick={() => remove(r)}
                    >
                      <X className="size-4" />
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button
            data-help="project.repos-add"
            size="sm"
            variant="secondary"
            className="gap-1"
            onClick={() => setAdding(true)}
          >
            <Plus className="size-3.5" />
            {t("Add a repo")}
          </Button>
          <Button
            data-help="project.repos-detect"
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={busy}
            onClick={detect}
          >
            <RefreshCw className="size-3.5" />
            {t("Find repos in its folder")}
          </Button>
        </div>
        <AddRepo project={project} open={adding} onOpenChange={setAdding} />
        <EditRepo
          key={editing?.name ?? ""}
          project={project}
          repo={editing}
          onClose={() => setEditing(null)}
        />
        {dialog}
      </CardContent>
    </Card>
  );
}

/** A repo renamed, or its release and work branches changed (ADR-042). */
function EditRepo({
  project,
  repo,
  onClose,
}: {
  project: ProjectView;
  repo: ProjectRepo | null;
  onClose: () => void;
}) {
  const [name, setName] = useState(repo?.name ?? "");
  const [release, setRelease] = useState(repo?.releaseBranch ?? "");
  const [work, setWork] = useState(repo?.workBranch ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!repo) return null;
  const next = { name: name.trim(), release: release.trim(), work: work.trim() };
  const changed =
    next.name !== repo.name || next.release !== repo.releaseBranch || next.work !== repo.workBranch;
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await api.projects.updateRepo({
        id: project.id,
        name: repo.name,
        ...(next.name !== repo.name ? { rename: next.name } : {}),
        ...(next.release !== repo.releaseBranch ? { releaseBranch: next.release } : {}),
        ...(next.work !== repo.workBranch ? { workBranch: next.work } : {}),
      });
      toast.success(t("{name} is saved.", { name: next.name }));
      onClose();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => (o ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Change {name}", { name: repo.name })}</DialogTitle>
          <DialogDescription>
            {t(
              "Its name in the project, and the branches Oraknid uses in it: jobs start from the release branch and merge into the work branch. A branch that doesn't exist yet is made when a job needs it.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (changed && !busy) void save();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="repo-edit-name">{t("Its name in the project")}</Label>
            <Input
              id="repo-edit-name"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="repo-edit-release">{t("Release branch")}</Label>
              <Input
                id="repo-edit-release"
                className="font-mono"
                value={release}
                onChange={(e) => setRelease(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="repo-edit-work">{t("Work branch")}</Label>
              <Input
                id="repo-edit-work"
                className="font-mono"
                value={work}
                onChange={(e) => setWork(e.target.value)}
              />
            </div>
          </div>
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={busy || !changed || !next.name || !next.release || !next.work}
            >
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

type Source = "folder" | "new" | "github-clone" | "git-url";

/** A repo added to a project (ADR-042): a folder of it, a new empty one, or a clone. */
function AddRepo({
  project,
  open,
  onOpenChange,
}: {
  project: ProjectView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [kind, setKind] = useState<Source>("folder");
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [from, setFrom] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const clean = folder.trim().replace(/^\/+|\/+$/g, "");
  const add = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const source =
        kind === "github-clone"
          ? { kind, folder: clean, fullName: from.trim() }
          : kind === "git-url"
            ? { kind, folder: clean, url: from.trim() }
            : { kind, folder: clean };
      const p = await api.projects.addRepo({
        id: project.id,
        ...(name.trim() ? { name: name.trim() } : {}),
        source,
      });
      toast.success(t("{name} is one of its repos now.", { name: p.repos.at(-1)?.name ?? clean }));
      onOpenChange(false);
      setFolder("");
      setName("");
      setFrom("");
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Add a repo")}</DialogTitle>
          <DialogDescription>
            {t(
              "A git repository in a folder of {folder}: one there already, a new empty one, or a clone.",
              { folder: project.workspacePath },
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="space-y-1">
            <Label>{t("Where from")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as Source)}>
              <SelectTrigger className="w-full" aria-label={t("Where from")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="folder">
                  {t("A folder of the project that is a repo")}
                </SelectItem>
                <SelectItem value="new">{t("A new empty repo")}</SelectItem>
                <SelectItem value="github-clone">
                  {t("A clone of one of my GitHub repos")}
                </SelectItem>
                <SelectItem value="git-url">{t("A clone of a git URL")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {kind === "github-clone" || kind === "git-url" ? (
            <div className="space-y-1">
              <Label htmlFor="repo-from">
                {kind === "github-clone" ? t("Repository (owner/name)") : t("Git URL")}
              </Label>
              <Input
                id="repo-from"
                className="font-mono"
                value={from}
                placeholder={kind === "github-clone" ? "me/site-api" : "https://…/api.git"}
                onChange={(e) => {
                  setFrom(e.target.value);
                  const last = e.target.value
                    .split("/")
                    .filter(Boolean)
                    .at(-1)
                    ?.replace(/\.git$/, "");
                  if (!folder && last) setFolder(last);
                }}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="repo-folder">{t("Folder in the project")}</Label>
            <Input
              id="repo-folder"
              className="font-mono"
              placeholder="api"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="repo-name">{t("Its name in the project")}</Label>
            <Input
              id="repo-name"
              placeholder={clean.split("/").at(-1) || "api"}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <ErrorNote error={error} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              busy || !clean || ((kind === "github-clone" || kind === "git-url") && !from.trim())
            }
            onClick={add}
          >
            {t("Add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RepoNow({ link }: { link: GitHubLink }) {
  // A link on GitLab, Gitea or Forgejo is read through its host (ADR-062).
  const ref = { owner: ownerKey(link.host, link.owner), name: link.name, account: link.account };
  const deps = [link.host, link.owner, link.name, link.account];
  const info = useLive(() => rapi.repoInfo(ref), { topics: [], deps });
  const branch = info.data?.defaultBranch;
  const commits = useLive(
    () =>
      branch
        ? rapi.commits({ ...ref, branch, page: 1 })
        : Promise.resolve({ items: [], page: 1, next: false }),
    { topics: [], deps: [...deps, branch] },
  );
  const branches = useLive(() => rapi.branches({ ...ref, page: 1 }), { topics: [], deps });
  const pulls = useLive(() => rapi.pulls({ ...ref, state: "open", page: 1 }), {
    topics: [],
    deps,
  });
  if (info.error) return <ErrorNote error={info.error} />;
  if (!info.data) return <Loading />;
  const repo = info.data;
  return (
    <Card data-help="project.repo">
      <CardHeader className="gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="text-base [overflow-wrap:anywhere]">{repo.fullName}</CardTitle>
          <Badge variant="secondary">{t(repo.visibility)}</Badge>
          <span className="text-xs text-muted-foreground">
            {t("through {account}", { account: repo.account })}
            {repo.pushedAt
              ? ` · ${t("pushed {when}", { when: ago(Date.parse(repo.pushedAt)) })}`
              : ""}
          </span>
        </div>
        {repo.description ? (
          <p className="text-sm text-muted-foreground">{repo.description}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link href={repoHref.base(ref.owner, repo.name)}>{t("Browse the code")}</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={repo.url} target="_blank" rel="noreferrer">
              <ExternalLink />
              {t("Open on GitHub")}
            </a>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="min-w-0 space-y-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium">
            <GitCommitHorizontal className="size-4" />
            {t("Latest commits on {branch}", { branch: repo.defaultBranch })}
          </h3>
          {repo.empty ? (
            <p className="text-sm text-muted-foreground">{t("Nothing pushed yet.")}</p>
          ) : commits.error ? (
            <ErrorNote error={commits.error} />
          ) : !commits.data ? (
            <Loading rows={3} />
          ) : (
            <ul className="divide-y rounded-md border">
              {commits.data.items.slice(0, 6).map((c) => (
                <li key={c.sha}>
                  <Link
                    href={repoHref.commits(ref.owner, repo.name, repo.defaultBranch, c.sha)}
                    className="flex min-w-0 items-baseline gap-3 px-3 py-2 text-sm hover:bg-muted"
                  >
                    <code className="shrink-0 text-xs text-muted-foreground">
                      {c.sha.slice(0, 7)}
                    </code>
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {ago(Date.parse(c.date))}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <div className="min-w-0 space-y-6">
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <GitBranch className="size-4" />
              {t("Branches")}
            </h3>
            {branches.data ? (
              <ul className="flex flex-wrap gap-1.5">
                {branches.data.items.map((b) => (
                  <li key={b.name}>
                    <Link href={repoHref.code(ref.owner, repo.name, b.name)}>
                      <Badge variant={b.name === repo.defaultBranch ? "default" : "outline"}>
                        {b.name}
                      </Badge>
                    </Link>
                  </li>
                ))}
                {branches.data.items.length === 0 ? (
                  <li className="text-sm text-muted-foreground">{t("None yet.")}</li>
                ) : null}
              </ul>
            ) : branches.error ? (
              <ErrorNote error={branches.error} />
            ) : (
              <Loading rows={1} />
            )}
          </section>
          <section className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              <GitPullRequest className="size-4" />
              {t("Open pull requests")}
            </h3>
            {pulls.data ? (
              pulls.data.items.length ? (
                <ul className="space-y-1">
                  {pulls.data.items.slice(0, 5).map((p) => (
                    <li key={p.number} className="min-w-0 text-sm">
                      <Link
                        href={repoHref.pulls(ref.owner, repo.name, "open", p.number)}
                        className="block truncate hover:underline"
                      >
                        #{p.number} {p.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t("None open.")}</p>
              )
            ) : pulls.error ? (
              <ErrorNote error={pulls.error} />
            ) : (
              <Loading rows={1} />
            )}
          </section>
        </div>
      </CardContent>
    </Card>
  );
}
