import type { ProjectView } from "@oraknid/contracts";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  FolderOpen,
  Plus,
  Search,
  SquareTerminal,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, Redirect, useLocation } from "wouter";
import { ActivityFeed } from "@/components/activity-feed";
import { LegComparison, TokensChart } from "@/components/charts";
import { ProjectCiBadge } from "@/components/ci-badge";
import { ProjectCiTab } from "@/components/ci-panel";
import { Empty, ErrorNote, Loading, PageHeader, Stat } from "@/components/common";
import { ProjectWorkSettingsCard } from "@/components/evaluations";
import { EyeChat } from "@/components/eye-chat";
import { ProjectBudgetCard } from "@/components/job-budget";
import { CloneAgainButton, ExportRecordsButton } from "@/components/moving";
import { NewProjectDialog } from "@/components/new-project";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { matchProjects, ProjectList } from "@/components/project-list";
import { ProjectNetworkCard } from "@/components/project-network";
import { nowRank, ProjectWorkBar, ReviewsWaiting } from "@/components/project-now";
import { ProjectMenu, ProjectRemovalDialog, type RemovalKind } from "@/components/project-removal";
import { isSeveral, ProjectReposCard, ProjectRepoTab } from "@/components/project-repo";
import { ProjectSecretsCard } from "@/components/project-secrets";
import { ProjectServersCard } from "@/components/project-servers";
import { ProjectSkillsCard } from "@/components/project-skills";
import { currentJob, ProjectWork, ProjectWorkflow } from "@/components/project-work";
import { RulesCard } from "@/components/rules-card";
import { ProjectSilk } from "@/components/silk-list";
import { StatsCharts } from "@/components/stats-charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, message } from "@/lib/api";
import { tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { currentProjectPath } from "@/lib/links";
import { useLive } from "@/lib/live";
import { remote } from "@/lib/remote";
import { InboxItemCard } from "@/pages/inbox";

/**
 * Projects (Web-UI → Projects): `/projects` is the list of projects, full
 * width; `/projects/<id>/<tab>…` is one project as a page of its own.
 */
export function ProjectsPage({
  id,
  tab,
  job,
  sub,
}: {
  id?: string;
  tab?: string;
  job?: string;
  sub?: string;
}) {
  const moved = id ? currentProjectPath(id, tab, job, sub) : null;
  if (moved) return <Redirect to={moved} replace />;
  return id ? <ProjectPage id={id} tab={tab} job={job} sub={sub} /> : <ProjectsList />;
}

/**
 * The list: every project as a card saying what it is doing now, live
 * (its jobs' and tasks' changes reload it, at most once a second), with
 * search and New project; a card opens the project's page.
 */
function ProjectsList() {
  const [, go] = useLocation();
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) =>
      e.type.startsWith("project.") || e.type.startsWith("job.") || e.type === "task.state",
    everyMs: 1000,
  });
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState("");
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (projects.loading) return <Loading />;
  const add = (
    <Button data-help="projects.new" className="gap-1" size="sm" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
      {t("New project")}
    </Button>
  );
  const dialog = (
    <NewProjectDialog
      open={creating}
      onOpenChange={setCreating}
      onCreated={(pid) => go(`/projects/${pid}`)}
    />
  );
  // A server's own project is never listed (ADR-049); its jobs' links open it.
  const all = (projects.data ?? []).filter((p) => !p.serverId);
  if (all.length === 0)
    return (
      <div className="space-y-4">
        <PageHeader title={t("Projects")} />
        <Empty title={t("No projects yet")} action={add}>
          {t(
            "A project is a folder or repo that jobs work in. Oraknid works in its own worktree and never on your branch.",
          )}
        </Empty>
        {dialog}
      </div>
    );
  const shown = matchProjects(all, q);
  const working = all.filter((p) => !p.archivedAt && p.now?.some((j) => nowRank(j.state) === 0));
  return (
    <div className="space-y-4 pb-6">
      <PageHeader
        title={t("Projects")}
        sub={t("{n} project(s) · {w} working now", {
          n: all.filter((p) => !p.archivedAt).length,
          w: working.length,
        })}
        actions={add}
      />
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="search"
          data-help="projects.search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Find a project: its name, folder or repos")}
          aria-label={t("Find a project")}
          className="pl-8"
        />
      </div>
      {shown.length ? (
        <ProjectList
          projects={shown}
          searching={!!q.trim()}
          onOpen={(pid) => go(`/projects/${pid}`)}
        />
      ) : (
        <div className="px-1 py-2 text-sm text-muted-foreground">
          {t("No project matches “{q}”.", { q: q.trim() })}
        </div>
      )}
      {dialog}
    </div>
  );
}

/** One project as a page of its own, with a way back to the list. */
function ProjectPage({
  id,
  tab,
  job,
  sub,
}: {
  id: string;
  tab?: string;
  job?: string;
  sub?: string;
}) {
  // A server's own project opens here too, by its jobs' links (ADR-049).
  const projects = useLive(() => api.projects.list({ servers: true }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("project."),
  });
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (projects.loading) return <Loading />;
  const project = projects.data?.find((p) => p.id === id);
  if (!project)
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("Projects")}
          back={{ fallback: "/projects", label: t("All projects") }}
        />
        <Empty
          title={t("No such project")}
          action={
            <Button asChild size="sm" variant="secondary">
              <Link href="/projects">{t("All projects")}</Link>
            </Button>
          }
        >
          {t("It may have been deleted.")}
        </Empty>
      </div>
    );
  return <ProjectDetail key={project.id} project={project} tab={tab} job={job} sub={sub} />;
}

/**
 * One project, the place I work (ADR-034): its current work at the top
 * (the work bar, with its controls), then The Eye, the Workflow of its
 * jobs, Work (its jobs as a timeline, one opened in place), Inbox, Silk by
 * job, Activity, Budget & stats, Settings, Skills, Servers and Network, in
 * tabs in the address.
 */
function ProjectDetail({
  project,
  tab,
  job,
  sub,
}: {
  project: ProjectView;
  tab?: string;
  job?: string;
  sub?: string;
}) {
  const [, go] = useLocation();
  const id = project.id;
  const [ids, setIds] = useState<string[]>([]);
  // Each job's own changes (its tasks, its tokens) reach Workflow and Work live.
  const jobs = useLive(() => api.jobs.list({ projectId: id }), {
    topics: ["overview", ...ids.map((x) => `job:${x}`)],
    refreshOn: (e) =>
      e.type.startsWith("job.") ||
      (/^(task|web|session\.ended)/.test(e.type) && e.type !== "task.waiting"),
    deps: [id],
  });
  const list = jobs.data ?? [];
  const started = list
    .filter((j) => j.state !== "draft")
    .map((j) => j.id)
    .join();
  useEffect(() => setIds(started ? started.split(",") : []), [started]);
  const target = currentJob(list);
  const inbox = useLive(() => api.inbox.list({ projectId: id, state: "open" }), {
    topics: ["inbox"],
    deps: [id],
  });
  const header = (
    <div className="flex shrink-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <Link
          href="/projects"
          data-help="project.back"
          className="-ml-1 flex shrink-0 items-center gap-0.5 rounded-md px-1 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:min-h-11"
          aria-label={t("All projects")}
          title={t("All projects")}
        >
          <ChevronLeft className="size-4" />
          <span className="hidden sm:inline">{t("Projects")}</span>
        </Link>
        <h2 className="min-w-0 truncate text-lg font-semibold" title={project.name}>
          {project.name}
        </h2>
        {/* Its linked repo's CI at a glance (ADR-058). */}
        <ProjectCiBadge projectId={id} />
        {project.archivedAt ? (
          <span className="flex shrink-0 items-center gap-1 rounded border px-1.5 text-xs text-muted-foreground">
            <Archive className="size-3" />
            {t("Archived")}
          </span>
        ) : null}
        {project.serverId ? (
          // A server's own project (ADR-049): its place is the server's page.
          <Link
            href={`/servers/${project.serverId}/chat`}
            className="shrink-0 text-xs text-primary underline-offset-2 hover:underline"
          >
            {t("Its server")}
          </Link>
        ) : null}
        <span
          className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:inline"
          title={project.workspacePath}
        >
          {project.workspacePath}
        </span>
        <span className="flex-1 sm:hidden" />
        <ProjectFolderButtons id={id} path={project.workspacePath} />
        <Button
          data-help="project.new-work"
          size="sm"
          className="shrink-0 gap-1"
          disabled={!!project.archivedAt}
          title={t("Ask The Eye for work in this project")}
          aria-label={t("New work")}
          onClick={() => go(`/projects/${id}/eye`, { state: history.state })}
        >
          <Plus className="size-4" />
          <span className="hidden min-[420px]:inline">{t("New work")}</span>
        </Button>
        <ProjectMenu project={project} help="project.menu" />
      </div>
      {/* What it is doing now, with its controls: it stays at the top while the tabs scroll. */}
      <ProjectWorkBar
        jobs={list}
        questions={inbox.data ?? []}
        // A job open on a phone keeps the room: several jobs fold to one line.
        defaultFolded={!!job && typeof window !== "undefined" && window.innerWidth < 768}
      />
      {/* A review waiting for me (ADR-064), in case its tab didn't open. */}
      <ReviewsWaiting projectId={id} />
    </div>
  );
  if (jobs.error) return <ErrorNote error={jobs.error} />;
  const tabs: PageTab[] = [
    {
      id: "eye",
      label: t("The Eye"),
      fill: true,
      content: () => <EyeChat projectId={id} jobs={list} archived={!!project.archivedAt} />,
    },
    {
      id: "workflow",
      label: t("Workflow"),
      fill: true,
      content: () => (
        <ProjectWorkflow projectId={id} jobs={list} jobId={tab === "workflow" ? job : undefined} />
      ),
    },
    {
      id: "work",
      label: t("Work"),
      badge: list.length || undefined,
      fill: true,
      content: () => (
        <ProjectWork
          projectId={id}
          jobs={list}
          jobId={tab === "work" ? job : undefined}
          sub={sub}
        />
      ),
    },
    {
      id: "repo",
      label: t("Repo"),
      content: () => <ProjectRepoTab project={project} />,
    },
    {
      id: "ci",
      label: t("CI"),
      content: () => (
        <ProjectCiTab
          project={project}
          runId={tab === "ci" && job && /^\d+$/.test(job) ? Number(job) : undefined}
          repo={tab === "ci" && sub ? decodeURIComponent(sub) : undefined}
        />
      ),
    },
    {
      id: "inbox",
      label: t("Inbox"),
      badge: inbox.data?.length || undefined,
      content: () => <ProjectInbox id={id} />,
    },
    {
      id: "silk",
      label: t("Silk"),
      content: () => <ProjectSilk projectId={id} jobIds={ids} target={target?.id ?? null} />,
    },
    {
      id: "activity",
      label: t("Activity"),
      content: () => (
        <ActivityFeed
          projectId={id}
          jobIds={ids}
          label={(e) => list.find((j) => j.id === e.jobId)?.title ?? null}
        />
      ),
    },
    {
      id: "budget",
      label: t("Budget & stats"),
      content: () => (
        <div className="space-y-4">
          <ProjectBudgetCard projectId={id} jobIds={ids} />
          <ProjectStats id={id} />
        </div>
      ),
    },
    {
      id: "settings",
      label: t("Settings"),
      content: () => (
        <div className="space-y-4">
          {/* Its GitHub repo is on the Repo tab; its servers, with their roles, here (ADR-038, ADR-042). */}
          <ProjectServersCard projectId={id} />
          <ProjectWorkSettingsCard projectId={id} />
          <ProjectReposCard project={project} />
          <ProjectActions project={project} />
          <RulesCard
            help="project.rules"
            scope={id}
            title={t("Commands in this project")}
            description={t(
              "Patterns for this project's jobs: a job's own rules win, these come next, then the global ones.",
            )}
            load={() => api.projects.policy({ id })}
            save={(r) => api.projects.setPolicy({ id, ...r })}
          />
        </div>
      ),
    },
    { id: "skills", label: t("Skills"), content: () => <ProjectSkillsCard projectId={id} /> },
    { id: "servers", label: t("Servers"), content: () => <ProjectServersCard projectId={id} /> },
    { id: "network", label: t("Network"), content: () => <ProjectNetworkCard projectId={id} /> },
    { id: "secrets", label: t("Secrets"), content: () => <ProjectSecretsCard projectId={id} /> },
  ];
  return (
    <PageTabs
      base={`/projects/${id}`}
      tab={tab}
      tabs={tabs}
      header={header}
      className="mb-0 h-full md:mb-0 md:h-full"
    />
  );
}

/** The project's approvals and questions, from all its jobs. */
function ProjectInbox({ id }: { id: string }) {
  const items = useLive(() => api.inbox.list({ projectId: id }), {
    topics: ["inbox"],
    deps: [id],
  });
  if (items.loading) return <Loading />;
  const all = items.data ?? [];
  return all.length === 0 ? (
    <Empty title={t("Nothing for this project")}>
      {t("Its jobs' approvals and questions appear here, and in the inbox.")}
    </Empty>
  ) : (
    <div className="space-y-2">
      {all.map((i) => (
        <InboxItemCard key={i.id} item={i} />
      ))}
    </div>
  );
}

/**
 * Archive (to Archived projects, everything kept; its GitHub repos and
 * folder as I choose) or delete (gone from Oraknid; its folder and GitHub
 * repos as I choose), each in its dialog (project-removal.tsx).
 */
function ProjectActions({ project }: { project: ProjectView }) {
  const [open, setOpen] = useState<RemovalKind | null>(null);
  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 text-sm">
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{t("Folder")}</div>
        <code className="block font-mono text-xs [overflow-wrap:anywhere]">
          {project.workspacePath}
        </code>
      </div>
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{t("Branches")}</div>
        <div>
          {project.shadow
            ? t("no git (checkpoints in a shadow repo)")
            : isSeveral(project.repos)
              ? project.repos
                  .map((r) => `${r.name}: ${r.releaseBranch} / ${r.workBranch}`)
                  .join(" · ")
              : t("Release branch {release}, work branch {work}", {
                  release: project.releaseBranch,
                  work: project.workBranch,
                })}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {project.archivedAt
          ? project.archivedWith?.folderDeleted
            ? t(
                "Archived, its folder deleted: unarchiving clones it back from GitHub. Everything else is kept.",
              )
            : t("Archived: hidden from the lists and New work, everything kept.")
          : t(
              "Archive moves it to Archived projects, everything kept. Delete removes it from Oraknid, and its folder and GitHub repos if you choose.",
            )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          data-help="project.archive"
          variant="secondary"
          size="sm"
          className="gap-1"
          onClick={() => setOpen("archive")}
        >
          {project.archivedAt ? (
            <ArchiveRestore className="size-4" />
          ) : (
            <Archive className="size-4" />
          )}
          {project.archivedAt ? t("Unarchive…") : t("Archive…")}
        </Button>
        <Button
          data-help="project.delete"
          variant="ghost"
          size="sm"
          className="gap-1 text-destructive"
          onClick={() => setOpen("delete")}
        >
          <Trash2 className="size-4" />
          {t("Delete…")}
        </Button>
        <ExportRecordsButton projectId={project.id} />
        {project.repos.some((r) => r.github) ? <CloneAgainButton projectId={project.id} /> : null}
      </div>
      <ProjectRemovalDialog
        project={project}
        kind={open}
        onOpenChange={(o) => !o && setOpen(null)}
      />
    </div>
  );
}

function ProjectStats({ id }: { id: string }) {
  const s = useLive(() => api.stats.summary({ projectId: id }), {
    topics: ["overview"],
    deps: [id],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  const buckets = useLive(
    () =>
      api.stats.tokens({ projectId: id, since: Date.now() - 14 * 86400_000, bucketMs: 86400_000 }),
    { topics: ["overview"], deps: [id] },
  );
  if (!s.data) return <Loading />;
  const hours = Math.round(s.data.timeMs / 360_000) / 10;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label={t("Tokens")} value={tokens(s.data.tokens)} />
        <Stat label={t("Time")} value={t("{h} h", { h: hours })} />
        <Stat
          label={t("Tasks done")}
          value={s.data.tasks.done}
          hint={t("{n} failed", { n: s.data.tasks.failed })}
        />
        <Stat
          label={t("Success")}
          value={s.data.successRate === null ? "—" : `${Math.round(s.data.successRate * 100)}%`}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Tokens per day, last two weeks")}</CardTitle>
        </CardHeader>
        <CardContent>
          {(buckets.data ?? []).length ? (
            <TokensChart buckets={buckets.data ?? []} />
          ) : (
            <div className="text-sm text-muted-foreground">{t("Nothing yet.")}</div>
          )}
        </CardContent>
      </Card>
      {s.data.byLeg.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("By Leg model")}</CardTitle>
          </CardHeader>
          <CardContent>
            <LegComparison rows={s.data.byLeg} />
          </CardContent>
        </Card>
      ) : null}
      <StatsCharts
        projectId={id}
        since={Date.now() - 30 * 86400_000}
        bucketMs={86400_000}
        topics={["overview"]}
        burnTitle={t("The project's budget burn")}
      />
    </div>
  );
}

/**
 * The project's folder, to go and look or test by hand: opened in this
 * computer's file manager, or a terminal started in it. Away from home the
 * file manager would open on the computer, not here: its path is copied.
 */
function ProjectFolderButtons({ id, path }: { id: string; path: string }) {
  const [, go] = useLocation();
  const away = !!remote();
  return (
    <>
      <Button
        data-help="project.open-folder"
        size="sm"
        variant="outline"
        className="shrink-0 gap-1"
        title={away ? t("Copy the folder's path: {path}", { path }) : path}
        onClick={async () => {
          if (away) {
            await navigator.clipboard?.writeText(path).catch(() => {});
            toast.success(t("Path copied: {path}", { path }));
            return;
          }
          try {
            await api.projects.openFolder({ id });
          } catch (e) {
            toast.error(message(e));
          }
        }}
      >
        <FolderOpen className="size-4" />
        <span className="hidden sm:inline">{away ? t("Copy path") : t("Open folder")}</span>
      </Button>
      <Button
        data-help="project.terminal-here"
        size="sm"
        variant="outline"
        className="shrink-0 gap-1"
        title={t("A terminal in {path}", { path })}
        onClick={() => go(`/terminal/${encodeURIComponent(`project:${id}`)}`)}
      >
        <SquareTerminal className="size-4" />
        <span className="hidden sm:inline">{t("Terminal here")}</span>
      </Button>
    </>
  );
}
