import type { JobView, TaskView } from "@oraknid/contracts";
import { ChevronRight, MessageSquarePlus, Pause, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Empty, StateBadge } from "@/components/common";
import { JobDetail } from "@/components/job-detail";
import { ACTIVE, legName, TaskDrawer, useModelName, useTaskDrawer } from "@/components/task-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { type FoldedJob, WebGraph } from "@/components/web-graph";
import { api } from "@/lib/api";
import { ago, tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act, jobHref, projectHref } from "@/lib/links";
import { cn } from "@/lib/utils";

const finished = (task: TaskView) => task.state === "done" || task.state === "skipped";

/** The job a project is about now: the newest going, else the newest. */
export function currentJob(jobs: JobView[]): JobView | undefined {
  const started = jobs.filter((j) => j.state !== "draft");
  return (
    started.filter((j) => !["completed", "cancelled"].includes(j.state)).at(-1) ?? started.at(-1)
  );
}

/**
 * The Web of a project's jobs, in the order they ran: the current job's
 * tasks and those of the jobs I opened in full, every other job folded to
 * one node. A job's first tasks come after the job before it.
 */
export function foldWeb(jobs: JobView[], expanded: ReadonlySet<string>) {
  const current = currentJob(jobs);
  const tasks: TaskView[] = [];
  const folded: FoldedJob[] = [];
  let before: string[] = [];
  for (const j of jobs.filter((x) => x.state !== "draft")) {
    if (j.id === current?.id || expanded.has(j.id)) {
      const inJob = new Set(j.tasks.map((x) => x.id));
      const needed = new Set(j.tasks.flatMap((x) => x.dependsOn));
      for (const x of j.tasks)
        tasks.push({
          ...x,
          dependsOn: x.dependsOn.some((d) => inJob.has(d)) ? x.dependsOn : [...before],
        });
      const ends = j.tasks.filter((x) => !needed.has(x.id)).map((x) => x.id);
      if (ends.length) before = ends;
    } else {
      folded.push({
        id: j.id,
        title: j.title,
        state: j.state,
        done: j.tasks.filter(finished).length,
        total: j.tasks.length,
        dependsOn: [...before],
      });
      before = [j.id];
    }
  }
  return { tasks, folded };
}

/**
 * The Web across a project's jobs (ADR-034): the job running now (else
 * the newest) laid out in full, each earlier job folded to one node,
 * opened in place on a click, in the order they ran.
 */
export function ProjectWeb({ projectId, jobs }: { projectId: string; jobs: JobView[] }) {
  const [, go] = useLocation();
  const { open, openTask, closeTask } = useTaskDrawer();
  const { modelName, legs } = useModelName();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const started = jobs.filter((j) => j.state !== "draft");
  const current = currentJob(jobs);

  const { tasks, folded } = useMemo(() => foldWeb(jobs, expanded), [jobs, expanded]);

  if (!started.length)
    return (
      <Empty
        title={t("No work yet")}
        action={
          <Button className="gap-1" onClick={() => go(projectHref(projectId, "eye"))}>
            <MessageSquarePlus className="size-4" />
            {t("Ask The Eye for work")}
          </Button>
        }
      >
        {t("The project's tasks appear here, job after job, as The Eye plans them.")}
      </Empty>
    );
  const task = tasks.find((x) => x.id === open) ?? null;
  const taskJob = task ? started.find((j) => j.id === task.jobId) : undefined;
  const toggle = (id: string) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };
  return (
    <div className="space-y-3">
      {started.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("Earlier jobs:")}</span>
          {started
            .filter((j) => j.id !== current?.id)
            .map((j) => (
              <button
                key={j.id}
                type="button"
                aria-pressed={expanded.has(j.id)}
                onClick={() => toggle(j.id)}
                className={cn(
                  "flex min-h-8 max-w-56 items-center gap-1 rounded-md border px-2 hover:bg-accent pointer-coarse:min-h-11",
                  expanded.has(j.id) && "border-primary bg-accent",
                )}
                title={expanded.has(j.id) ? t("Fold it") : t("Open it here")}
              >
                <ChevronRight
                  className={cn(
                    "size-3 shrink-0 transition-transform",
                    expanded.has(j.id) && "rotate-90",
                  )}
                />
                <span className="truncate">{j.title}</span>
              </button>
            ))}
        </div>
      ) : null}
      <WebGraph
        tasks={tasks}
        folded={folded}
        legName={legName}
        onOpen={openTask}
        onOpenJob={toggle}
      />
      {current ? (
        <div className="text-xs text-muted-foreground">
          {t("Laid out in full: “{title}”.", { title: current.title })}{" "}
          <Link href={jobHref(current)} className="text-primary underline-offset-2 hover:underline">
            {t("Open it in Work")}
          </Link>
        </div>
      ) : null}
      {taskJob ? (
        <TaskDrawer
          job={taskJob}
          task={taskJob.tasks.find((x) => x.id === task?.id) ?? null}
          onClose={closeTask}
          modelName={modelName}
          legs={legs}
        />
      ) : null}
    </div>
  );
}

/**
 * The project's work (ADR-034): its jobs as a timeline, newest first,
 * with their state, branch and cost; one opened shows in place, with
 * everything a job has.
 */
export function ProjectWork({
  projectId,
  jobs,
  jobId,
  sub,
}: {
  projectId: string;
  jobs: JobView[];
  jobId?: string;
  sub?: string;
}) {
  const [, go] = useLocation();
  if (jobId) return <JobDetail key={jobId} id={jobId} sub={sub} />;
  const list = [...jobs].reverse();
  if (!list.length)
    return (
      <div className="overflow-y-auto">
        <Empty
          title={t("No work yet")}
          action={
            <Button className="gap-1" onClick={() => go(projectHref(projectId, "eye"))}>
              <MessageSquarePlus className="size-4" />
              {t("Ask The Eye for work")}
            </Button>
          }
        >
          {t("Each request becomes a job here: its own branch, budget and checkpoints.")}
        </Empty>
      </div>
    );
  return (
    <div className="min-h-0 overflow-y-auto pb-6">
      <ol className="divide-y rounded-xl border bg-card">
        {list.map((j) => (
          <WorkRow key={j.id} job={j} />
        ))}
      </ol>
    </div>
  );
}

function WorkRow({ job: j }: { job: JobView }) {
  const done = j.tasks.filter(finished).length;
  const running = ACTIVE.includes(j.state);
  return (
    <li className="relative flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-3 hover:bg-accent/50">
      <div className="min-w-0 flex-1 basis-48">
        <Link
          href={jobHref(j)}
          className="block truncate font-medium after:absolute after:inset-0"
          title={j.title}
        >
          {j.title}
        </Link>
        <div className="flex min-w-0 flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>
            {j.state === "draft"
              ? t("a draft, on New work")
              : t("started {when}", { when: j.startedAt ? ago(j.startedAt) : t("not yet") })}
          </span>
          {j.branch ? (
            <code className="max-w-full truncate" title={j.branch}>
              {j.branch}
            </code>
          ) : null}
          <span>{t("{n} tokens", { n: tokens(j.tokens) })}</span>
        </div>
        {j.blockedReason || j.pauseReason ? (
          <div
            className="truncate text-xs text-warning"
            title={j.blockedReason ?? j.pauseReason ?? ""}
          >
            {j.blockedReason ?? j.pauseReason}
          </div>
        ) : null}
      </div>
      <div className="flex w-full items-center gap-2 sm:w-44">
        <Progress value={j.tasks.length ? (done / j.tasks.length) * 100 : 0} className="h-1.5" />
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {done}/{j.tasks.length}
        </span>
      </div>
      {j.queuedAt ? <Badge variant="outline">{t("queued")}</Badge> : null}
      <StateBadge state={j.state} />
      <PauseResume job={j} running={running} />
    </li>
  );
}

/** Pause a job going, resume one paused or blocked: above the row's link. */
export function PauseResume({ job: j, running }: { job: JobView; running: boolean }) {
  if (running)
    return (
      <Button
        variant="ghost"
        size="icon"
        className="relative z-10 size-8 pointer-coarse:size-11"
        aria-label={t("Pause “{title}”", { title: j.title })}
        title={t("Pause")}
        onClick={() =>
          act(() => api.jobs.pause({ id: j.id }), t("Pausing at the next safe point…"))
        }
      >
        <Pause className="size-4" />
      </Button>
    );
  if (j.state === "paused" || j.state === "blocked")
    return (
      <Button
        variant="ghost"
        size="icon"
        className="relative z-10 size-8 pointer-coarse:size-11"
        aria-label={t("Resume “{title}”", { title: j.title })}
        title={t("Resume")}
        onClick={() => act(() => api.jobs.resume({ id: j.id }), t("Resumed."))}
      >
        <Play className="size-4" />
      </Button>
    );
  return null;
}
