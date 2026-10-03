import type { JobView, TaskView } from "@oraknid/contracts";
import { ChevronLeft, MessageSquarePlus, Pause, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Empty, StateBadge } from "@/components/common";
import { JobDetail } from "@/components/job-detail";
import { ACTIVE, legName, TaskDrawer, useModelName, useTaskDrawer } from "@/components/task-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { type FlowJob, WebGraph } from "@/components/web-graph";
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

/** A project's Workflow tab, and a job drilled into in it (ADR-034 → Changed). */
export const workflowHref = (projectId: string, jobId?: string) =>
  `/projects/${projectId}/workflow${jobId ? `/${jobId}` : ""}`;

/**
 * The project's jobs as boxes, in the order they ran, each after the one
 * before it; the job it is about now marked.
 */
export function workflowJobs(jobs: JobView[]): FlowJob[] {
  const current = currentJob(jobs);
  let before: string[] = [];
  return jobs
    .filter((j) => j.state !== "draft")
    .map((j) => {
      const box: FlowJob = {
        id: j.id,
        title: j.title,
        state: j.state,
        done: j.tasks.filter(finished).length,
        total: j.tasks.length,
        current: j.id === current?.id,
        dependsOn: before,
      };
      before = [j.id];
      return box;
    });
}

export type WorkflowMode = "compact" | "expanded";
const modeKey = (projectId: string) => `oraknid.workflow.${projectId}`;

/** Compact or expanded, kept per project on this device (storage may be refused). */
export function readWorkflowMode(projectId: string): WorkflowMode {
  try {
    return localStorage.getItem(modeKey(projectId)) === "expanded" ? "expanded" : "compact";
  } catch {
    return "compact";
  }
}

export function saveWorkflowMode(projectId: string, mode: WorkflowMode) {
  try {
    localStorage.setItem(modeKey(projectId), mode);
  } catch {}
}

/**
 * The project's Workflow (ADR-034 → Changed): only the diagram, filling
 * the tab, its controls floating over it. Compact: a box per job, the
 * current one highlighted; a box opens that job's own workflow (in the
 * address), with a way back. Expanded: every job's workflow in full, each
 * framed and named by its job. A task opens its drawer.
 */
export function ProjectWorkflow({
  projectId,
  jobs,
  jobId,
}: {
  projectId: string;
  jobs: JobView[];
  jobId?: string;
}) {
  const [, go] = useLocation();
  const { open, openTask, closeTask } = useTaskDrawer();
  const { modelName, legs } = useModelName();
  const [mode, setMode] = useState<WorkflowMode>(() => readWorkflowMode(projectId));
  const boxes = useMemo(() => workflowJobs(jobs), [jobs]);
  const groups = useMemo(
    () => boxes.map((box) => ({ job: box, tasks: jobs.find((j) => j.id === box.id)?.tasks ?? [] })),
    [boxes, jobs],
  );
  const started = jobs.filter((j) => j.state !== "draft");

  if (!started.length)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Empty
          title={t("No work yet")}
          action={
            <Button className="gap-1" onClick={() => go(projectHref(projectId, "eye"))}>
              <MessageSquarePlus className="size-4" />
              {t("Ask The Eye for work")}
            </Button>
          }
        >
          {t("The project's workflow appears here, job after job, as The Eye plans them.")}
        </Empty>
      </div>
    );
  const drilled = jobId ? started.find((j) => j.id === jobId) : undefined;
  const task = started.flatMap((j) => j.tasks).find((x) => x.id === open) ?? null;
  const taskJob = task ? started.find((j) => j.id === task.jobId) : undefined;
  // Drilled in from the project's view: back returns there; else (a link, a reload) it goes there.
  const drill = (id: string) => go(workflowHref(projectId, id), { state: { workflow: true } });
  const back = () => {
    const s: unknown = history.state;
    if (s && typeof s === "object" && (s as { workflow?: unknown }).workflow) history.back();
    else go(workflowHref(projectId), { replace: true });
  };
  const choose = (m: WorkflowMode) => {
    setMode(m);
    saveWorkflowMode(projectId, m);
  };
  const canvas =
    "h-full w-full [&_.react-flow__node]:transition-transform [&_.react-flow__node]:duration-500";
  const float =
    "absolute top-2 left-2 z-10 m-0 flex max-w-[calc(100%-1rem)] min-w-0 items-center gap-1 rounded-lg border bg-card/95 p-1 shadow-sm backdrop-blur";
  return (
    <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border bg-card/40">
      {jobId ? (
        <>
          <WebGraph
            key={jobId}
            tasks={drilled?.tasks ?? []}
            legName={legName}
            onOpen={openTask}
            className={canvas}
          />
          <div className={float}>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0 gap-1 pointer-coarse:min-h-11"
              onClick={back}
              title={t("Back to the project's workflow")}
            >
              <ChevronLeft className="size-4" />
              {t("All jobs")}
            </Button>
            {drilled ? (
              <>
                <span className="min-w-0 truncate px-1 text-sm font-medium" title={drilled.title}>
                  {drilled.title}
                </span>
                <StateBadge state={drilled.state} className="shrink-0" />
                <Link
                  href={jobHref(drilled)}
                  className="hidden shrink-0 px-2 text-xs text-primary underline-offset-2 hover:underline sm:inline"
                >
                  {t("Open in Work")}
                </Link>
              </>
            ) : (
              <span className="px-1 text-sm text-muted-foreground">
                {t("This job isn't in this project.")}
              </span>
            )}
          </div>
        </>
      ) : (
        <>
          {mode === "expanded" ? (
            <WebGraph
              tasks={[]}
              groups={groups}
              legName={legName}
              onOpen={openTask}
              onOpenJob={drill}
              className={canvas}
            />
          ) : (
            <WebGraph
              tasks={[]}
              jobs={boxes}
              legName={legName}
              onOpen={openTask}
              onOpenJob={drill}
              className={canvas}
            />
          )}
          <fieldset className={float} aria-label={t("How the jobs are drawn")}>
            {(
              [
                ["compact", t("Compact"), t("A box per job; open one to see its workflow")],
                ["expanded", t("Expanded"), t("Every job's workflow in full")],
              ] as const
            ).map(([m, label, hint]) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                title={hint}
                onClick={() => choose(m)}
                className={cn(
                  "min-h-8 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground pointer-coarse:min-h-11",
                  mode === m && "bg-primary/15 font-medium text-primary",
                )}
              >
                {label}
              </button>
            ))}
          </fieldset>
        </>
      )}
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
