import type { GitHubLink, ProjectView } from "@oraknid/contracts";
import { ExternalLink, GitBranch, GitCommitHorizontal, GitPullRequest } from "lucide-react";
import { Link } from "wouter";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { ProjectGitHubCard } from "@/components/project-github";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { repoHref } from "@/pages/repos";

/**
 * A project's Repo tab (ADR-038, ADR-040): the GitHub repo it is linked to,
 * what's on it now (recent commits, branches, open pull requests), the way
 * into Repos for its code, and the card to link, change or unlink it.
 */
export function ProjectRepoTab({ project }: { project: ProjectView }) {
  const link = project.github as GitHubLink | null;
  return (
    <div className="space-y-4">
      {link ? (
        link.ready ? (
          <RepoNow link={link} />
        ) : (
          <Empty title={t("Not created yet")}>
            {t(
              "{repo} is created on GitHub the first time a job pushes to it: its commits show here then.",
              { repo: `${link.owner}/${link.name}` },
            )}
          </Empty>
        )
      ) : null}
      <ProjectGitHubCard project={project} />
    </div>
  );
}

function RepoNow({ link }: { link: GitHubLink }) {
  const ref = { owner: link.owner, name: link.name, account: link.account };
  const deps = [link.owner, link.name, link.account];
  const info = useLive(() => api.github.repoInfo(ref), { topics: [], deps });
  const branch = info.data?.defaultBranch;
  const commits = useLive(
    () =>
      branch
        ? api.github.commits({ ...ref, branch, page: 1 })
        : Promise.resolve({ items: [], page: 1, next: false }),
    { topics: [], deps: [...deps, branch] },
  );
  const branches = useLive(() => api.github.branches({ ...ref, page: 1 }), { topics: [], deps });
  const pulls = useLive(() => api.github.pulls({ ...ref, state: "open", page: 1 }), {
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
            <Link href={repoHref.base(repo.owner, repo.name)}>{t("Browse the code")}</Link>
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
                    href={repoHref.commits(repo.owner, repo.name, repo.defaultBranch, c.sha)}
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
                    <Link href={repoHref.code(repo.owner, repo.name, b.name)}>
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
                        href={repoHref.pulls(repo.owner, repo.name, "open", p.number)}
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
