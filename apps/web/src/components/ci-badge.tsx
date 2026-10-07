import type { CiBadge as Badge, CiConclusion, CiStatus } from "@oraknid/contracts";
import { CircleCheck, CircleDashed, CircleX, LoaderCircle } from "lucide-react";
import { useEffect } from "react";
import { Link } from "wouter";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// A branch's CI at a glance (ADR-058): passing, failing, running, on a
// project's header and a job's page; it opens the CI tab.

/** A run, a job or a step: its mark, coloured by how it ended. */
export function CiMark({
  status,
  conclusion,
  className,
}: {
  status: CiStatus;
  conclusion: CiConclusion;
  className?: string;
}) {
  const c = cn("size-4 shrink-0", className);
  if (status !== "completed")
    return (
      <LoaderCircle
        className={cn(c, "animate-spin text-amber-500 motion-reduce:animate-none")}
        aria-label={t("running")}
      />
    );
  if (conclusion === "success")
    return <CircleCheck className={cn(c, "text-emerald-500")} aria-label={t("passed")} />;
  if (conclusion === "failure" || conclusion === "timed_out" || conclusion === "startup_failure")
    return <CircleX className={cn(c, "text-destructive")} aria-label={t("failed")} />;
  return <CircleDashed className={cn(c, "text-muted-foreground")} aria-label={conclusion ?? ""} />;
}

const WORDS: Record<Badge["state"], string> = {
  passing: "CI passing",
  failing: "CI failing",
  running: "CI running",
  none: "No CI",
  unknown: "CI unknown",
};

/** The pill itself. */
export function CiPill({ badge, href }: { badge: Badge; href: string }) {
  const tone =
    badge.state === "passing"
      ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400"
      : badge.state === "failing"
        ? "border-destructive/50 text-destructive"
        : badge.state === "running"
          ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
          : "text-muted-foreground";
  const title = [
    `${badge.fullName} · ${badge.branch}`,
    badge.failing ? t("Failing: {what}", { what: badge.failing }) : null,
    badge.error,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Link
      href={href}
      title={title}
      data-help="ci.badge"
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium hover:bg-accent",
        tone,
      )}
    >
      {badge.run ? (
        <CiMark status={badge.run.status} conclusion={badge.run.conclusion} className="size-3.5" />
      ) : null}
      {t(WORDS[badge.state])}
    </Link>
  );
}

/** Reloads every `ms` while the page is in sight. */
function useEvery(reload: () => void, ms: number) {
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, ms);
    return () => clearInterval(id);
  }, [reload, ms]);
}

/** The project's CI: its first linked repo's release branch, else its work branch. */
export function ProjectCiBadge({ projectId }: { projectId: string }) {
  const ci = useLive(() => api.ci.project({ id: projectId }), { topics: [], deps: [projectId] });
  const first = ci.data?.[0];
  const badge =
    first && first.release.state !== "none" ? first.release : (first?.work ?? first?.release);
  useEvery(ci.reload, badge?.state === "running" ? 15_000 : 60_000);
  if (!badge || badge.state === "none" || badge.state === "unknown") return null;
  return <CiPill badge={badge} href={`/projects/${projectId}/ci`} />;
}

/** A job's CI in The Eye's report of it (ADR-045): the badge and, failing, where. */
export function JobCiLine({ jobId, projectId }: { jobId: string; projectId: string }) {
  const ci = useLive(() => api.ci.forJob({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "github.pushed" || e.type === "github.pull-request",
    deps: [jobId],
  });
  useEvery(ci.reload, ci.data?.badge.state === "running" ? 15_000 : 120_000);
  const d = ci.data;
  if (!d || d.badge.state === "none" || d.badge.state === "unknown") return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs" data-testid="report-ci">
      <span className="text-muted-foreground">
        {d.pullRequest
          ? t("CI of pull request #{n}", { n: d.pullRequest })
          : t("CI of {branch}", { branch: d.branch })}
      </span>
      <CiPill badge={d.badge} href={`/projects/${projectId}/ci`} />
      {d.badge.failing ? <span className="text-destructive">{d.badge.failing}</span> : null}
    </div>
  );
}

/** A job's CI: its pull request's, or the branch it pushed; nothing when it put nothing on GitHub. */
export function JobCiBadge({ jobId, projectId }: { jobId: string; projectId: string }) {
  const ci = useLive(() => api.ci.forJob({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "github.pushed" || e.type === "github.pull-request",
    deps: [jobId],
  });
  useEvery(ci.reload, ci.data?.badge.state === "running" ? 15_000 : 60_000);
  const d = ci.data;
  if (!d || d.badge.state === "none" || d.badge.state === "unknown") return null;
  const run = d.badge.run;
  return (
    <CiPill
      badge={d.badge}
      href={
        run
          ? `/repos/${encodeURIComponent(d.owner)}/${encodeURIComponent(d.name)}/ci/${run.id}`
          : `/projects/${projectId}/ci`
      }
    />
  );
}
