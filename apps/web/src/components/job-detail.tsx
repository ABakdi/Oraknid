import type { JobView } from "@oraknid/contracts";
import { Ban, ChevronLeft, ListOrdered, Pause, Play, Plus, Signpost } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { ActivityFeed } from "@/components/activity-feed";
import { Agents } from "@/components/agents";
import { Empty, ErrorNote, Loading, StateBadge } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { JobBudget, JobStats } from "@/components/job-budget";
import { JobGoal, JobTitle } from "@/components/job-heading";
import { JobResult } from "@/components/job-result";
import { JobSettings } from "@/components/job-settings";
import { TasksAtOnce } from "@/components/machine-health";
import { OrderDialog } from "@/components/order-dialog";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { PlanComparisonCard } from "@/components/plan-comparison";
import { ToolsSetupButton } from "@/components/setup";
import { JobSilk } from "@/components/silk-list";
import {
  ACTIVE,
  AddTaskDialog,
  legName,
  TaskDrawer,
  useModelName,
  useTaskDrawer,
} from "@/components/task-drawer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { WebGraph } from "@/components/web-graph";
import { api } from "@/lib/api";
import { ago, tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act, projectHref } from "@/lib/links";
import { useLive } from "@/lib/live";
import { InboxItemCard } from "@/pages/inbox";

/**
 * One job of a project, opened in place in its Work tab (ADR-034):
 * everything the job page had. Its tasks and their drawer, its result,
 * its agents' output, activity, Silk, inbox, budget and settings, in tabs
 * in the address (`/projects/<p>/work/<job>/<part>`), with its own
 * controls above them. Its conversation is the project's (The Eye tab).
 */
export function JobDetail({ id, sub }: { id: string; sub?: string }) {
  const topic = `job:${id}`;
  // Reloaded on what changes the job's view, not on every streamed line (Audit 1 → Q1-06).
  const job = useLive(() => api.jobs.get({ id }), {
    topics: [topic],
    deps: [id],
    refreshOn: (e) =>
      /^(job|task|web|budget|policy\.updated|policy\.waived|eye\.replied)/.test(e.type) &&
      e.type !== "task.waiting",
  });
  const { open, openTask, closeTask } = useTaskDrawer();
  const { modelName, legs } = useModelName();
  const [redirecting, setRedirecting] = useState(false);
  const { confirm, dialog } = useConfirm();
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState(false);

  if (job.error) return <ErrorNote error={job.error} />;
  if (job.loading || !job.data) return <Loading rows={6} />;
  const j = job.data;
  const task = j.tasks.find((x) => x.id === open) ?? null;
  const cancel = async () => {
    if (
      await confirm(
        t("Cancel “{title}”?", { title: j.title }),
        t(
          "The job stops at a safe point. Its worktree and checkpoints are kept until you delete them.",
        ),
        t("Cancel the job"),
        { keep: t("Keep it") },
      )
    )
      void act(() => api.jobs.cancel({ id }), t("Cancelled."));
  };
  const running = ACTIVE.includes(j.state);
  const editable = j.state !== "completed" && j.state !== "cancelled";
  const base = `${projectHref(j.projectId, "work")}/${id}`;

  const header = (
    <div className="shrink-0 space-y-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 items-start gap-1">
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="-ml-2 shrink-0"
            aria-label={t("All the project's work")}
            title={t("All the project's work")}
          >
            <Link href={projectHref(j.projectId, "work")}>
              <ChevronLeft className="size-5" />
            </Link>
          </Button>
          <div className="min-w-0 flex-1 space-y-1">
            <JobTitle job={j} />
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <StateBadge state={j.state} />
              {j.queuedAt ? (
                <Badge variant="outline">{t("Queued: starts when a slot frees")}</Badge>
              ) : null}
              {j.branch ? (
                <code className="max-w-full truncate" title={j.branch}>
                  {j.branch}
                </code>
              ) : null}
              <TasksAtOnce tasks={j.tasks} />
              <span>{tokens(j.tokens)} tokens</span>
              {j.startedAt ? <span>{t("started {when}", { when: ago(j.startedAt) })}</span> : null}
            </div>
            <JobGoal goal={j.goal} />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {editable ? (
            <>
              <Select
                value={String(j.priority)}
                onValueChange={(v) =>
                  act(
                    () => api.jobs.setPriority({ id, priority: Number(v) }),
                    t("Priority changed."),
                  )
                }
              >
                <SelectTrigger className="w-36" aria-label={t("Priority")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="5">{t("High priority")}</SelectItem>
                  <SelectItem value="0">{t("Normal priority")}</SelectItem>
                  <SelectItem value="-5">{t("Low priority")}</SelectItem>
                </SelectContent>
              </Select>
              <Select
                value={j.autonomy}
                onValueChange={(v) =>
                  act(
                    () => api.jobs.setAutonomy({ id, autonomy: v as JobView["autonomy"] }),
                    t("Autonomy changed; the next decision uses it."),
                  )
                }
              >
                <SelectTrigger className="w-36" aria-label={t("Autonomy")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("Auto")}</SelectItem>
                  <SelectItem value="careful">{t("Careful")}</SelectItem>
                  <SelectItem value="full">{t("Full")}</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="secondary" className="gap-1" onClick={() => setRedirecting(true)}>
                <Signpost className="size-4" />
                {t("Redirect")}
              </Button>
              <Button variant="ghost" className="gap-1 text-destructive" onClick={cancel}>
                <Ban className="size-4" />
                {t("Cancel")}
              </Button>
            </>
          ) : null}
          {running ? (
            <Button
              variant="secondary"
              className="gap-1"
              onClick={() =>
                act(() => api.jobs.pause({ id }), t("Pausing at the next safe point…"))
              }
            >
              <Pause className="size-4" />
              {t("Pause")}
            </Button>
          ) : null}
          {running
            ? [
                ...new Set(
                  j.tasks
                    .filter((x) => ["assigned", "running", "verifying"].includes(x.state))
                    .map((x) => x.assignedLegId)
                    .filter((x): x is string => !!x),
                ),
              ].map((legId) => {
                const name = legs.find((l) => l.id === legId)?.name ?? t("a Leg");
                return (
                  <Button
                    key={legId}
                    variant="ghost"
                    className="gap-1"
                    title={t(
                      "Its sessions in this job end at a safe point; its tasks go on without it.",
                    )}
                    onClick={async () => {
                      if (
                        await confirm(
                          t("Stop {leg}'s work in this job?", { leg: name }),
                          t(
                            "Its sessions here end at a safe point and its tasks go back to ready, on other Legs. Other jobs keep it.",
                          ),
                          t("Stop its work"),
                          { keep: t("Keep it") },
                        )
                      )
                        void act(
                          () => api.jobs.cancelLegWork({ id, legId }),
                          t("{leg}'s work here stopped.", { leg: name }),
                        );
                    }}
                  >
                    <Ban className="size-4" />
                    {t("Stop {leg} here", { leg: name })}
                  </Button>
                );
              })
            : null}
          {j.state === "paused" || j.state === "blocked" ? (
            <Button
              className="gap-1"
              onClick={() => act(() => api.jobs.resume({ id }), t("Resumed."))}
            >
              <Play className="size-4" />
              {t("Resume")}
            </Button>
          ) : null}
        </div>
      </div>
      {j.missingTools.length ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            {t("This job's skill uses {tools}, not set up yet.", {
              tools: j.missingTools.join(", "),
            })}
          </span>
          <ToolsSetupButton missing={j.missingTools} />
        </div>
      ) : null}
      {j.blockedReason || j.pauseReason ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
          {j.blockedReason ?? j.pauseReason}
        </div>
      ) : null}
    </div>
  );

  const tabs: PageTab[] = [
    {
      id: "tasks",
      label: t("Tasks"),
      badge: j.tasks.length || undefined,
      content: () => (
        <div className="space-y-3">
          <WebGraph tasks={j.tasks} legName={legName} onOpen={openTask} />
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() => setAdding(true)}
              disabled={!editable}
            >
              <Plus className="size-4" />
              {t("Add a task")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              onClick={() => setOrdering(true)}
              disabled={!editable}
            >
              <ListOrdered className="size-4" />
              {t("Order")}
            </Button>
          </div>
          <PlanComparisonCard jobId={id} />
        </div>
      ),
    },
    ...(j.state === "completed"
      ? [{ id: "result", label: t("Result"), content: () => <JobResult jobId={id} /> }]
      : []),
    { id: "agents", label: t("Agents"), content: () => <Agents jobId={id} /> },
    {
      id: "activity",
      label: t("Activity"),
      content: () => <ActivityFeed jobId={id} jobIds={[id]} />,
    },
    { id: "silk", label: t("Silk"), content: () => <JobSilk jobId={id} /> },
    { id: "inbox", label: t("Inbox"), content: () => <JobInbox jobId={id} /> },
    {
      id: "budget",
      label: t("Budget & stats"),
      content: () => (
        <div className="space-y-4">
          <JobBudget job={j} />
          <JobStats jobId={id} />
        </div>
      ),
    },
    { id: "settings", label: t("Settings"), content: () => <JobSettings job={j} /> },
  ];

  return (
    <>
      <PageTabs
        base={base}
        tab={sub}
        tabs={tabs}
        header={header}
        keys={false}
        className="mb-0 h-full md:mb-0 md:h-full"
      />
      <TaskDrawer job={j} task={task} onClose={closeTask} modelName={modelName} legs={legs} />
      <RedirectDialog open={redirecting} onOpenChange={setRedirecting} id={id} />
      <AddTaskDialog open={adding} onOpenChange={setAdding} job={j} />
      <OrderDialog job={j} open={ordering} onOpenChange={setOrdering} />
      {dialog}
    </>
  );
}

function JobInbox({ jobId }: { jobId: string }) {
  const items = useLive(() => api.inbox.list({ jobId }), { topics: ["inbox"], deps: [jobId] });
  const mine = items.data ?? [];
  return mine.length === 0 ? (
    <Empty title={t("Nothing for this job")}>
      {t("Its approvals and questions appear here, and in the inbox.")}
    </Empty>
  ) : (
    <div className="space-y-2">
      {mine.map((i) => (
        <InboxItemCard key={i.id} item={i} />
      ))}
    </div>
  );
}

function RedirectDialog({
  open,
  onOpenChange,
  id,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  id: string;
}) {
  const [text, setText] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Redirect the job")}</DialogTitle>
          <DialogDescription>
            {t("Your instruction goes into Silk as your decision; every next session reads it.")}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("e.g. Use SQLite, not Postgres.")}
        />
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!text.trim()}
            onClick={() =>
              act(async () => {
                await api.jobs.redirect({ id, instruction: text.trim() });
                setText("");
                onOpenChange(false);
              }, t("Noted in Silk."))
            }
          >
            {t("Redirect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
