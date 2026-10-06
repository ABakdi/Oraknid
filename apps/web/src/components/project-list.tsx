import type { ProjectView } from "@oraknid/contracts";
import { Archive, ChevronRight, FolderGit2 } from "lucide-react";
import { useState } from "react";
import { ProjectMenu } from "@/components/project-removal";
import { isSeveral } from "@/components/project-repo";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * The Projects list (Web-UI → Projects): the projects I work on, each with
 * its … menu (Archive, Delete), then the Archived projects in their own
 * section, opened when I ask or when the one open is archived.
 */
export function ProjectList({
  projects,
  shownId,
  onOpen,
}: {
  projects: ProjectView[];
  shownId?: string;
  onOpen: (id: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const active = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => p.archivedAt);
  const archivedOpen = showArchived || archived.some((p) => p.id === shownId);
  const card = (p: ProjectView) => (
    <div key={p.id} className="relative">
      <button
        type="button"
        onClick={() => onOpen(p.id)}
        className={cn(
          "w-full rounded-lg border bg-card px-3 py-2 pr-10 text-left hover:bg-accent",
          p.id === shownId && "border-primary bg-accent",
          p.archivedAt && "opacity-80",
        )}
      >
        <div className="flex items-center gap-2 font-medium">
          <FolderGit2 className="size-4 shrink-0" />
          <span className="truncate" title={p.name}>
            {p.name}
          </span>
        </div>
        <div className="truncate text-xs text-muted-foreground" title={p.workspacePath}>
          {p.workspacePath}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {p.archivedWith?.folderDeleted
            ? t("{n} job(s) · folder deleted, on GitHub", { n: p.jobCount })
            : `${t("{n} job(s)", { n: p.jobCount })} · ${
                p.shadow
                  ? t("no git (checkpoints in a shadow repo)")
                  : isSeveral(p.repos)
                    ? t("{n} repos", { n: p.repos.length })
                    : `${p.releaseBranch} / ${p.workBranch}`
              }`}
        </div>
      </button>
      <ProjectMenu project={p} className="absolute top-1.5 right-1.5" />
    </div>
  );
  return (
    <>
      {active.map(card)}
      {!active.length ? (
        <div className="px-1 py-2 text-sm text-muted-foreground">
          {t("Every project is archived.")}
        </div>
      ) : null}
      {archived.length ? (
        <section aria-label={t("Archived projects")} className="space-y-1 pt-3">
          <button
            type="button"
            data-help="projects.archived"
            aria-expanded={archivedOpen}
            onClick={() => setShowArchived(!archivedOpen)}
            className="flex w-full items-center gap-1 px-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase hover:text-foreground"
          >
            <ChevronRight
              className={cn("size-3.5 transition-transform", archivedOpen && "rotate-90")}
            />
            <Archive className="size-3.5" />
            {t("Archived projects ({n})", { n: archived.length })}
          </button>
          {archivedOpen ? archived.map(card) : null}
        </section>
      ) : null}
    </>
  );
}
