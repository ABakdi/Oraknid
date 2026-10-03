import type { ProjectView } from "@oraknid/contracts";
import { FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { LegComparison, TokensChart } from "@/components/charts";
import {
  BackButton,
  Empty,
  ErrorNote,
  Loading,
  PageHeader,
  Stat,
  StateBadge,
} from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { ProjectNetworkCard } from "@/components/project-network";
import { ProjectServersCard } from "@/components/project-servers";
import { ProjectSkillsCard } from "@/components/project-skills";
import { RulesCard } from "@/components/rules-card";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { api, message } from "@/lib/api";
import { tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

export function ProjectsPage({ id, tab }: { id?: string; tab?: string }) {
  const [, go] = useLocation();
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("project.") || e.type === "job.created",
  });
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (projects.loading) return <Loading />;
  const add = (
    <Button className="gap-1" size="sm" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
      {t("New project")}
    </Button>
  );
  const all = projects.data ?? [];
  if (all.length === 0)
    return (
      <div className="space-y-4">
        <PageHeader title={t("Projects")} />
        <Empty title={t("No projects yet")} action={add}>
          {t(
            "A project is a folder or repo that jobs work in. Oraknid works in its own worktree and never on your branch.",
          )}
        </Empty>
        <NewProject open={creating} onOpenChange={setCreating} />
      </div>
    );
  const archived = all.filter((p) => p.archivedAt);
  const listed = all.filter((p) => showArchived || !p.archivedAt);
  // A project open: its id in the address; on a computer the first one by default.
  const selected = all.find((p) => p.id === id);
  const shown =
    selected ?? (typeof window !== "undefined" && window.innerWidth >= 768 ? listed[0] : undefined);
  return (
    <div className="-mb-24 flex h-[calc(100dvh-7.5rem)] min-h-0 gap-4 md:-mb-8 md:h-[calc(100dvh-4.5rem)]">
      <aside
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col gap-2 md:w-72",
          selected && "hidden md:flex",
        )}
      >
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-lg font-semibold">{t("Projects")}</h1>
          {add}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {listed.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => go(`/projects/${p.id}`)}
              className={cn(
                "w-full rounded-lg border bg-card px-3 py-2 text-left hover:bg-accent",
                p.id === shown?.id && "border-primary bg-accent",
              )}
            >
              <div className="flex items-center gap-2 font-medium">
                <FolderGit2 className="size-4 shrink-0" />
                <span className="truncate" title={p.name}>
                  {p.name}
                </span>
                {p.archivedAt ? (
                  <span className="text-xs font-normal text-muted-foreground">{t("archived")}</span>
                ) : null}
              </div>
              <div className="truncate text-xs text-muted-foreground" title={p.workspacePath}>
                {p.workspacePath}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {t("{n} job(s)", { n: p.jobCount })} ·{" "}
                {p.shadow
                  ? t("no git (checkpoints in a shadow repo)")
                  : `${p.releaseBranch} / ${p.workBranch}`}
              </div>
            </button>
          ))}
          {archived.length ? (
            <Button variant="ghost" size="sm" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? t("Hide archived") : t("Show archived ({n})", { n: archived.length })}
            </Button>
          ) : null}
        </div>
      </aside>
      <section className={cn("min-h-0 min-w-0 flex-1", !selected && "hidden md:block")}>
        {shown ? <ProjectDetail key={shown.id} project={shown} tab={tab} /> : null}
      </section>
      <NewProject open={creating} onOpenChange={setCreating} />
    </div>
  );
}

/** One project: Jobs · Stats · Skills · Servers · Commands · About, in tabs. */
function ProjectDetail({ project, tab }: { project: ProjectView; tab?: string }) {
  const [, go] = useLocation();
  const id = project.id;
  const header = (
    <div className="flex shrink-0 items-center gap-2">
      <BackButton fallback="/projects" label={t("All projects")} className="md:hidden" />
      <h2 className="min-w-0 truncate text-lg font-semibold" title={project.name}>
        {project.name}
      </h2>
      <span
        className="hidden min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground sm:inline"
        title={project.workspacePath}
      >
        {project.workspacePath}
      </span>
      <span className="flex-1 sm:hidden" />
      <Button
        size="sm"
        className="shrink-0 gap-1"
        disabled={!!project.archivedAt}
        onClick={() => go("/new", { state: { projectId: id } })}
      >
        <Plus className="size-4" />
        {t("New work")}
      </Button>
    </div>
  );
  const tabs: PageTab[] = [
    {
      id: "jobs",
      label: t("Jobs"),
      badge: project.jobCount || undefined,
      content: () => <ProjectJobs id={id} />,
    },
    { id: "stats", label: t("Stats"), content: () => <ProjectStats id={id} /> },
    { id: "skills", label: t("Skills"), content: () => <ProjectSkillsCard projectId={id} /> },
    { id: "servers", label: t("Servers"), content: () => <ProjectServersCard projectId={id} /> },
    { id: "network", label: t("Network"), content: () => <ProjectNetworkCard projectId={id} /> },
    {
      id: "commands",
      label: t("Commands"),
      content: () => (
        <RulesCard
          scope={id}
          title={t("Commands in this project")}
          description={t(
            "Patterns for this project's jobs: a job's own rules win, these come next, then the global ones.",
          )}
          load={() => api.projects.policy({ id })}
          save={(r) => api.projects.setPolicy({ id, ...r })}
        />
      ),
    },
    { id: "about", label: t("About"), content: () => <ProjectActions project={project} /> },
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

/** The project's jobs, newest first. */
function ProjectJobs({ id }: { id: string }) {
  const jobs = useLive(() => api.jobs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  const [, go] = useLocation();
  if (jobs.loading) return <Loading />;
  const mine = (jobs.data ?? []).filter((j) => j.projectId === id).reverse();
  if (mine.length === 0)
    return (
      <Empty
        title={t("No jobs yet")}
        action={
          <Button className="gap-1" onClick={() => go("/new", { state: { projectId: id } })}>
            <Plus className="size-4" />
            {t("New work in this project")}
          </Button>
        }
      >
        {t("A job works in its own worktree here and never on your branch.")}
      </Empty>
    );
  return (
    <Card className="py-0">
      <CardContent className="divide-y p-0">
        {mine.map((j) => (
          <Link
            key={j.id}
            href={j.state === "draft" ? `/new/${j.id}` : `/jobs/${j.id}`}
            className="flex min-h-11 items-center gap-2 px-4 py-2 text-sm hover:bg-accent/50"
          >
            <span className="min-w-0 flex-1 truncate" title={j.title}>
              {j.title}
            </span>
            <StateBadge state={j.state} />
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

/** Archive (hidden, kept for stats) or delete (gone from Oraknid, my folder untouched). */
function ProjectActions({ project }: { project: ProjectView }) {
  const [, go] = useLocation();
  const { confirm, dialog } = useConfirm();
  const archive = async () => {
    try {
      await api.projects.archive({ id: project.id, archived: !project.archivedAt });
      toast.success(project.archivedAt ? t("Back in the list.") : t("Archived."));
    } catch (e) {
      toast.error(message(e));
    }
  };
  const remove = async () => {
    if (
      !(await confirm(
        t("Delete “{name}”?", { name: project.name }),
        t(
          "Its jobs and their history (tasks, sessions, Silk, logs) leave Oraknid for good. Your folder, the job branches and worktrees in it stay as they are.",
        ),
        t("Delete"),
        { keep: t("Keep it") },
      ))
    )
      return;
    try {
      const r = await api.projects.delete({ id: project.id });
      toast.success(
        t("Deleted, with {n} job(s). {folder} is untouched.", { n: r.jobs, folder: r.folder }),
      );
      go("/projects", { replace: true });
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <div className="space-y-3 text-sm">
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
            : t("Release branch {release}, work branch {work}", {
                release: project.releaseBranch,
                work: project.workBranch,
              })}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {project.archivedAt
          ? t("Archived: hidden from the lists and New work, kept for stats.")
          : t("Archive hides it from the lists and New work and keeps its stats.")}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={archive}>
          {project.archivedAt ? t("Restore") : t("Archive")}
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={remove}>
          {t("Delete")}
        </Button>
      </div>
      {dialog}
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
    </div>
  );
}

function NewProject({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [askGit, setAskGit] = useState(false);
  const [error, setError] = useState<unknown>();
  const create = async (initGit?: boolean) => {
    setError(undefined);
    try {
      await api.projects.create({
        name: name || path.split("/").filter(Boolean).at(-1) || "project",
        workspacePath: path,
        ...(initGit === undefined ? {} : { initGit }),
      });
      toast.success(t("Project created."));
      onOpenChange(false);
      setAskGit(false);
    } catch (e) {
      if (message(e).includes("is not a git repo")) setAskGit(true);
      else setError(e);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("New project")}</DialogTitle>
          <DialogDescription>
            {t(
              "A folder on this machine. Nothing is changed in it until a job runs, and then only in a worktree.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp">{t("Folder")}</Label>
            <Input
              id="pp"
              placeholder="/home/me/code/app"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pn">{t("Name")}</Label>
            <Input
              id="pn"
              placeholder={path.split("/").filter(Boolean).at(-1) ?? ""}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <ErrorNote error={error} />
          {askGit ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div>
                {t("This folder is not a git repo. How should Oraknid keep its checkpoints?")}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => create(true)}>
                  {t("Make it a git repo")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => create(false)}>
                  {t("Use a shadow repo, leave the folder alone")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={!path.startsWith("/")} onClick={() => create()}>
            {path.startsWith("/") ? t("Create") : t("Enter a full path")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
