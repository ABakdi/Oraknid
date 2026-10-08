import type { ProjectNowJob, ProjectView } from "@oraknid/contracts";
import { Archive, ChevronRight, FolderGit2, GitBranch, Server } from "lucide-react";
import { memo, useState } from "react";
import { ProjectCiBadge } from "@/components/ci-badge";
import { StateBadge } from "@/components/common";
import { nowRank } from "@/components/project-now";
import { ProjectMenu } from "@/components/project-removal";
import { isSeveral } from "@/components/project-repo";
import { Progress } from "@/components/ui/progress";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** When it last did something: its newest job event, else when it was made. */
export const lastActive = (p: ProjectView) => p.lastActivityAt ?? p.createdAt;

/** Projects to show for words typed in the search: its name, its folder, its repos' names. */
export function matchProjects(projects: ProjectView[], q: string): ProjectView[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return projects;
  return projects.filter((p) => {
    const text = [p.name, p.workspacePath, ...p.repos.map((r) => r.name)].join(" ").toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

/**
 * The Projects list (Web-UI → Projects): the projects I work on, full
 * width, each a card saying what it is doing now (its current job, its
 * state, its progress), when it last did something, its repos, servers
 * and CI, and its … menu (Archive, Delete); the newest activity first.
 * Then the Archived projects in their own section, opened when I ask.
 * A card opens the project as a page of its own.
 */
export function ProjectList({
  projects,
  onOpen,
  searching = false,
}: {
  projects: ProjectView[];
  onOpen: (id: string) => void;
  /** A search is typed: the archived ones it finds are shown, not folded away. */
  searching?: boolean;
}) {
  const [opened, setOpened] = useState(false);
  const showArchived = opened || searching;
  const byActivity = [...projects].sort((a, b) => lastActive(b) - lastActive(a));
  const active = byActivity.filter((p) => !p.archivedAt);
  const archived = byActivity.filter((p) => p.archivedAt);
  return (
    <div className="space-y-4">
      {active.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={t("Projects")}>
          {active.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={onOpen} />
          ))}
        </ul>
      ) : searching ? null : (
        <div className="px-1 py-2 text-sm text-muted-foreground">
          {t("Every project is archived.")}
        </div>
      )}
      {archived.length ? (
        <section aria-label={t("Archived projects")} className="space-y-2 pt-2">
          <button
            type="button"
            data-help="projects.archived"
            aria-expanded={showArchived}
            onClick={() => setOpened(!showArchived)}
            className="flex w-full items-center gap-1 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground pointer-coarse:min-h-11"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", showArchived && "rotate-90")}
            />
            <Archive className="size-3.5" />
            {t("Archived projects ({n})", { n: archived.length })}
          </button>
          {showArchived ? (
            <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {archived.map((p) => (
                <ProjectCard key={p.id} project={p} onOpen={onOpen} />
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** One project in the list: what it is doing now, at a glance. */
const ProjectCard = memo(function ProjectCard({
  project: p,
  onOpen,
}: {
  project: ProjectView;
  onOpen: (id: string) => void;
}) {
  const linked = p.repos.some((r) => r.github);
  return (
    <li
      className={cn(
        "relative flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3 transition-colors focus-within:ring-2 focus-within:ring-ring hover:bg-accent/50",
        p.archivedAt && "opacity-80",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <button
          type="button"
          onClick={() => onOpen(p.id)}
          className="min-w-0 flex-1 truncate text-left font-medium outline-none after:absolute after:inset-0 after:rounded-xl"
          title={p.name}
        >
          {p.name}
        </button>
        <ProjectMenu project={p} className="relative z-10 -my-1 -mr-1" />
      </div>
      <NowLine now={p.now ?? []} />
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1 rounded border px-1.5 py-0.5">
          <GitBranch className="size-3 shrink-0" />
          <span className="truncate">
            {p.archivedWith?.folderDeleted
              ? t("folder deleted, on GitHub")
              : p.shadow
                ? t("no git")
                : isSeveral(p.repos)
                  ? t("{n} repos", { n: p.repos.length })
                  : `${p.releaseBranch} / ${p.workBranch}`}
          </span>
        </span>
        {p.serverIds.length ? (
          <span className="flex items-center gap-1 rounded border px-1.5 py-0.5">
            <Server className="size-3" />
            {t("{n} server(s)", { n: p.serverIds.length })}
          </span>
        ) : null}
        {linked && !p.archivedAt ? (
          <span className="relative z-10">
            <ProjectCiBadge projectId={p.id} />
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 gap-2 text-xs text-muted-foreground">
        <span className="shrink-0">
          {p.lastActivityAt
            ? t("active {when}", { when: ago(p.lastActivityAt) })
            : t("made {when}", { when: ago(p.createdAt) })}
        </span>
        <span className="shrink-0">· {t("{n} job(s)", { n: p.jobCount })}</span>
        <span className="min-w-0 truncate font-mono" title={p.workspacePath}>
          · {p.workspacePath}
        </span>
      </div>
    </li>
  );
});

/** What it is doing now: its newest job going (a draft only when nothing else), and its progress. */
function NowLine({ now }: { now: ProjectNowJob[] }) {
  // The one working first, then waiting, blocked, paused, a draft last; the newest of each.
  const first = [...now].sort((a, b) => nowRank(a.state) - nowRank(b.state))[0];
  if (!first)
    return <div className="text-sm text-muted-foreground">{t("Nothing running now.")}</div>;
  const more = now.length - 1;
  return (
    <div className="min-w-0 space-y-1" data-testid="project-now">
      <div className="flex min-w-0 items-center gap-2 text-sm">
        <StateBadge state={first.state} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={first.title}>
          {first.title}
        </span>
        {first.queued ? (
          <span className="shrink-0 text-xs text-muted-foreground">{t("queued")}</span>
        ) : null}
      </div>
      {first.state !== "draft" && first.total ? (
        <div className="flex items-center gap-2">
          <Progress
            value={(first.done / first.total) * 100}
            className="h-1.5"
            aria-label={t("{done} of {total} tasks done", {
              done: first.done,
              total: first.total,
            })}
          />
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {first.done}/{first.total}
          </span>
        </div>
      ) : null}
      {more > 0 ? (
        <div className="text-xs text-muted-foreground">
          {t("and {n} more not ended", { n: more })}
        </div>
      ) : null}
    </div>
  );
}
