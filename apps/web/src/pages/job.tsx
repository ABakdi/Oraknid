import type { Event, JobView, TaskView } from "@oraknid/contracts";
import { Ban, ListOrdered, Pause, Play, Plus, ShieldAlert, Signpost, Undo2 } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Agents } from "@/components/agents";
import { LegComparison, TokensChart } from "@/components/charts";
import { ErrorNote, Loading, Markdown, PageHeader, Stat, StateBadge } from "@/components/common";
import { EyeChat } from "@/components/eye-chat";
import { JobResult } from "@/components/job-result";
import { JobSettings } from "@/components/job-settings";
import { OrderDialog } from "@/components/order-dialog";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { PlanComparisonCard } from "@/components/plan-comparison";
import { TaskDiff } from "@/components/task-diff";
import { Badge } from "@/components/ui/badge";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { WebGraph } from "@/components/web-graph";
import { api, message } from "@/lib/api";
import { ago, clock, tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useEvents, useLive } from "@/lib/live";
import { InboxItemCard } from "@/pages/inbox";
import { describe } from "@/pages/overview";

const ACTIVE = ["interviewing", "planning", "running", "verifying", "waiting"];

/** Runs a control and says how it went, in words (BR-17). */
async function act(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) toast.success(done);
  } catch (e) {
    toast.error(message(e));
  }
}

export function JobPage({ id, tab }: { id: string; tab?: string }) {
  const topic = `job:${id}`;
  // Reloaded on what changes the job's view, not on every streamed line (Audit 1 → Q1-06).
  const job = useLive(() => api.jobs.get({ id }), {
    topics: [topic],
    deps: [id],
    refreshOn: (e) =>
      /^(job|task|web|budget|policy\.updated|policy\.waived|eye\.replied)/.test(e.type) &&
      e.type !== "task.waiting",
  });
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [adding, setAdding] = useState(false);
  const [ordering, setOrdering] = useState(false);

  const modelName = useCallback(
    (modelId: string | null) => {
      for (const l of legs.data ?? [])
        for (const m of l.models) if (m.id === modelId) return `${l.name} · ${m.model}`;
      return null;
    },
    [legs.data],
  );
  const legName = useCallback(
    (task: TaskView) =>
      task.state === "running" || task.state === "assigned" || task.state === "done"
        ? task.routing
          ? `${task.routing.model}${task.routing.effort ? ` · ${task.routing.effort}` : ""}`
          : null
        : null,
    [],
  );

  if (job.error) return <ErrorNote error={job.error} />;
  if (job.loading || !job.data) return <Loading rows={6} />;
  const j = job.data;
  const task = j.tasks.find((x) => x.id === open) ?? null;
  const running = ACTIVE.includes(j.state);

  const header = (
    <div className="shrink-0 space-y-2">
      <PageHeader
        title={j.title}
        sub={
          <span className="flex flex-wrap items-center gap-2">
            <StateBadge state={j.state} />
            {j.queuedAt ? (
              <Badge variant="outline">{t("Queued: starts when a slot frees")}</Badge>
            ) : null}
            {j.branch ? <code className="text-xs">{j.branch}</code> : null}
            {j.startedAt ? <span>{t("started {when}", { when: ago(j.startedAt) })}</span> : null}
          </span>
        }
        actions={
          <>
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
            {j.state === "draft" ? (
              <Button
                className="gap-1"
                onClick={() => act(() => api.jobs.start({ id }), t("Started."))}
              >
                <Play className="size-4" />
                {t("Start")}
              </Button>
            ) : null}
            {j.state === "paused" || j.state === "blocked" ? (
              <Button
                className="gap-1"
                onClick={() => act(() => api.jobs.resume({ id }), t("Resumed."))}
              >
                <Play className="size-4" />
                {t("Resume")}
              </Button>
            ) : null}
            {j.state !== "completed" && j.state !== "cancelled" ? (
              <>
                <Button variant="secondary" className="gap-1" onClick={() => setRedirecting(true)}>
                  <Signpost className="size-4" />
                  {t("Redirect")}
                </Button>
                <Select
                  value={String(j.priority)}
                  onValueChange={(v) =>
                    act(
                      () => api.jobs.setPriority({ id, priority: Number(v) }),
                      t("Priority changed."),
                    )
                  }
                >
                  <SelectTrigger className="w-32" aria-label={t("Priority")}>
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
                    <SelectItem value="supervised">{t("Supervised")}</SelectItem>
                    <SelectItem value="standard">{t("Standard")}</SelectItem>
                    <SelectItem value="full">{t("Full")}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  className="gap-1 text-destructive"
                  onClick={() => setCancelling(true)}
                >
                  <Ban className="size-4" />
                  {t("Cancel")}
                </Button>
              </>
            ) : null}
          </>
        }
      />
      {j.missingTools.length ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {t("This job's skill uses {tools}, not set up yet: add it in Settings → Tools.", {
            tools: j.missingTools.join(", "),
          })}
        </div>
      ) : null}
      {j.blockedReason || j.pauseReason ? (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          {j.blockedReason ?? j.pauseReason}
        </div>
      ) : null}
    </div>
  );

  const editable = j.state !== "completed" && j.state !== "cancelled";
  const tabs: PageTab[] = [
    {
      id: "web",
      label: t("The Web"),
      badge: j.tasks.length || undefined,
      content: () => (
        <div className="space-y-3">
          <WebGraph tasks={j.tasks} legName={legName} onOpen={setOpen} />
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
    { id: "eye", label: t("The Eye"), fill: true, content: () => <EyeChat jobId={id} full /> },
    ...(j.state === "completed"
      ? [{ id: "result", label: t("Result"), content: () => <JobResult jobId={id} /> }]
      : []),
    { id: "agents", label: t("Agents"), content: () => <Agents jobId={id} /> },
    { id: "activity", label: t("Activity"), content: () => <Activity jobId={id} /> },
    { id: "silk", label: t("Silk"), content: () => <Silk jobId={id} /> },
    { id: "inbox", label: t("Inbox"), content: () => <JobInbox jobId={id} /> },
    {
      id: "budget",
      label: t("Budget & stats"),
      content: () => (
        <div className="space-y-4">
          <Budget job={j} />
          <Stats jobId={id} />
        </div>
      ),
    },
    { id: "settings", label: t("Settings"), content: () => <JobSettings job={j} /> },
  ];

  return (
    <>
      <PageTabs base={`/jobs/${id}`} tab={tab} tabs={tabs} header={header} />

      <TaskDrawer
        job={j}
        task={task}
        onClose={() => setOpen(null)}
        modelName={modelName}
        legs={legs.data ?? []}
      />
      <RedirectDialog open={redirecting} onOpenChange={setRedirecting} id={id} />
      <AddTaskDialog open={adding} onOpenChange={setAdding} job={j} />
      <OrderDialog job={j} open={ordering} onOpenChange={setOrdering} />
      <Dialog open={cancelling} onOpenChange={setCancelling}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Cancel “{title}”?", { title: j.title })}</DialogTitle>
            <DialogDescription>
              {t(
                "The job stops at a safe point. Its worktree and checkpoints are kept until you delete them.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setCancelling(false)}>
              {t("Keep it")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setCancelling(false);
                void act(() => api.jobs.cancel({ id }), t("Cancelled."));
              }}
            >
              {t("Cancel the job")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function TaskDrawer({
  job,
  task,
  onClose,
  modelName,
  legs,
}: {
  job: JobView;
  task: TaskView | null;
  onClose: () => void;
  modelName: (id: string | null) => string | null;
  legs: { id: string; name: string; models: { id: string; model: string; hidden: boolean }[] }[];
}) {
  const attempts = useLive(
    () => (task ? api.tasks.attempts({ taskId: task.id }) : Promise.resolve([])),
    { topics: [`job:${job.id}`], deps: [task?.id], refreshOn: (e) => e.type === "task.state" },
  );
  const verified = useEvents([`job:${job.id}`], 400).find(
    (e) => e.type === "task.verified" && (e.payload as { taskId?: string }).taskId === task?.id,
  );
  const [editing, setEditing] = useState(false);
  const busy = task ? ["assigned", "running", "verifying"].includes(task.state) : false;
  const finished = task ? task.state === "done" || task.state === "skipped" : false;
  const jobRunning = ACTIVE.includes(job.state);
  return (
    <Sheet open={!!task} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {task ? (
          <>
            <SheetHeader>
              <SheetTitle className="pr-6">{task.title}</SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <StateBadge state={task.state} />
                <span>
                  {task.kind} · {task.difficulty}
                </span>
                {task.ownerHeld ? <Badge variant="secondary">{t("mine")}</Badge> : null}
              </SheetDescription>
            </SheetHeader>
            <div className="space-y-4 px-4 pb-6 text-sm">
              <Markdown text={task.instructions} />
              <Field label={t("May change")}>
                {task.scope.length
                  ? task.scope.map((s) => (
                      <code key={s} className="mr-1 rounded bg-muted px-1 text-xs">
                        {s}
                      </code>
                    ))
                  : t("nothing")}
              </Field>
              <Field label={t("Done when these pass")}>
                {task.verify.map((v) => (
                  <code key={v} className="block rounded bg-muted px-1.5 py-0.5 text-xs">
                    {v}
                  </code>
                ))}
                {verified ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("Last check {when}:", { when: ago(verified.at) })}{" "}
                    {(verified.payload as { ok: boolean }).ok ? t("passed") : t("failed")}
                  </div>
                ) : null}
              </Field>
              {task.routing ? (
                <Field
                  label={t("Why {leg} · {model}", {
                    leg: task.routing.leg,
                    model: task.routing.model,
                  })}
                >
                  <ul className="list-disc pl-4 text-xs text-muted-foreground">
                    {task.routing.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                    {task.routing.excluded.map((x) => (
                      <li key={x.legModelId + x.why}>{x.why}</li>
                    ))}
                  </ul>
                </Field>
              ) : null}
              <Field label={t("Attempts")}>
                {(attempts.data ?? []).length === 0 ? (
                  <span className="text-muted-foreground">{t("none yet")}</span>
                ) : null}
                {(attempts.data ?? []).map((a, i) => (
                  <div key={a.id} className="flex items-center gap-2 text-xs">
                    <span className="w-5 text-muted-foreground">#{i + 1}</span>
                    <span className="truncate">{modelName(a.legModelId) ?? "?"}</span>
                    {a.effort ? <span className="text-muted-foreground">{a.effort}</span> : null}
                    <span className="ml-auto">{a.outcome ?? t("running")}</span>
                    {a.escalations.length ? (
                      <span className="text-warning">{a.escalations.join(", ")}</span>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5"
                      disabled={jobRunning}
                      title={
                        jobRunning
                          ? t("Pause the job before rolling back.")
                          : t("Put the worktree back to before this attempt")
                      }
                      onClick={() =>
                        act(
                          () => api.tasks.rollback({ taskId: task.id, attempt: i + 1 }),
                          t("Rolled back; new files went to the trash."),
                        )
                      }
                    >
                      <Undo2 className="size-3" />
                    </Button>
                  </div>
                ))}
              </Field>
              <Field label={t("Diff")}>
                <TaskDiff key={task.id} taskId={task.id} />
              </Field>
              <Field label={t("Output")}>
                <Agents jobId={job.id} taskId={task.id} compact />
              </Field>
              <Field label={t("Leg model")}>
                <Select
                  value={task.pinnedModelId ?? "auto"}
                  onValueChange={(v) =>
                    act(
                      () => api.tasks.pin({ taskId: task.id, legModelId: v === "auto" ? null : v }),
                      t("Pinned."),
                    )
                  }
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">{t("Let routing choose")}</SelectItem>
                    {legs.flatMap((l) =>
                      l.models
                        .filter((m) => !m.hidden)
                        .map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {l.name} · {m.model}
                          </SelectItem>
                        )),
                    )}
                  </SelectContent>
                </Select>
              </Field>
              <div className="flex flex-wrap gap-2">
                {!task.ownerHeld && !finished ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      act(
                        () => api.tasks.takeOver({ taskId: task.id }),
                        t("It's yours; Oraknid leaves it alone."),
                      )
                    }
                  >
                    {t("Take it over")}
                  </Button>
                ) : null}
                {task.ownerHeld ? (
                  <>
                    <Button
                      size="sm"
                      onClick={() =>
                        act(
                          () => api.tasks.handBack({ taskId: task.id, finished: true }),
                          t("Marked done."),
                        )
                      }
                    >
                      {t("I finished it")}
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() =>
                        act(
                          () => api.tasks.handBack({ taskId: task.id, finished: false }),
                          t("Handed back."),
                        )
                      }
                    >
                      {t("Hand it back")}
                    </Button>
                  </>
                ) : null}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy || finished}
                  onClick={() => setEditing(true)}
                >
                  {t("Edit")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={busy || finished}
                  onClick={() =>
                    act(
                      () =>
                        api.web.edit({ jobId: job.id, edits: [{ op: "remove", taskId: task.id }] }),
                      t("Removed from the plan."),
                    )
                  }
                >
                  {t("Remove")}
                </Button>
              </div>
              {busy ? (
                <div className="text-xs text-muted-foreground">
                  {t("Editing waits until the task isn't running; pause the job to edit now.")}
                </div>
              ) : null}
            </div>
            <EditTaskDialog open={editing} onOpenChange={setEditing} job={job} task={task} />
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div>{children}</div>
    </div>
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);

function EditTaskDialog({
  open,
  onOpenChange,
  job,
  task,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  job: JobView;
  task: TaskView;
}) {
  const [title, setTitle] = useState(task.title);
  const [instructions, setInstructions] = useState(task.instructions);
  const [scope, setScope] = useState(task.scope.join("\n"));
  const [verify, setVerify] = useState(task.verify.join("\n"));
  const [deps, setDeps] = useState<string[]>(task.dependsOn);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Edit the task")}</DialogTitle>
          <DialogDescription>
            {job.autonomy === "supervised"
              ? t("At Supervised, the edited plan asks for your approval again.")
              : t("The next attempt uses it.")}
          </DialogDescription>
        </DialogHeader>
        <TaskFields
          {...{
            title,
            setTitle,
            instructions,
            setInstructions,
            scope,
            setScope,
            verify,
            setVerify,
            deps,
            setDeps,
          }}
          tasks={job.tasks.filter((x) => x.id !== task.id)}
        />
        <DialogFooter>
          <Button
            onClick={() =>
              act(async () => {
                await api.web.edit({
                  jobId: job.id,
                  edits: [
                    {
                      op: "update",
                      taskId: task.id,
                      title,
                      instructions,
                      scope: lines(scope),
                      verify: lines(verify),
                      dependsOn: deps,
                    },
                  ],
                });
                onOpenChange(false);
              }, t("Saved."))
            }
          >
            {t("Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddTaskDialog({
  open,
  onOpenChange,
  job,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  job: JobView;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [scope, setScope] = useState("");
  const [verify, setVerify] = useState("");
  const [deps, setDeps] = useState<string[]>([]);
  const ok = title && instructions && lines(verify).length > 0;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Add a task")}</DialogTitle>
          <DialogDescription>
            {t("Every task that changes things needs a check that proves it is done.")}
          </DialogDescription>
        </DialogHeader>
        <TaskFields
          {...{
            title,
            setTitle,
            instructions,
            setInstructions,
            scope,
            setScope,
            verify,
            setVerify,
            deps,
            setDeps,
          }}
          tasks={job.tasks}
        />
        <DialogFooter>
          <Button
            disabled={!ok}
            onClick={() =>
              act(async () => {
                await api.web.edit({
                  jobId: job.id,
                  edits: [
                    {
                      op: "add",
                      title,
                      instructions,
                      kind: "implement",
                      scope: lines(scope),
                      verify: lines(verify),
                      dependsOn: deps,
                      difficulty: "medium",
                      requiredCapabilities: ["implementation"],
                    },
                  ],
                });
                onOpenChange(false);
                setTitle("");
                setInstructions("");
              }, t("Added to the plan."))
            }
          >
            {ok ? t("Add") : t("Needs a title, instructions and a check")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TaskFields(p: {
  title: string;
  setTitle: (s: string) => void;
  instructions: string;
  setInstructions: (s: string) => void;
  scope: string;
  setScope: (s: string) => void;
  verify: string;
  setVerify: (s: string) => void;
  deps: string[];
  setDeps: (d: string[]) => void;
  tasks: TaskView[];
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="tt">{t("Title")}</Label>
        <Input id="tt" value={p.title} onChange={(e) => p.setTitle(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ti">{t("Instructions")}</Label>
        <Textarea
          id="ti"
          rows={4}
          value={p.instructions}
          onChange={(e) => p.setInstructions(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="ts">{t("May change (one glob per line)")}</Label>
        <Textarea
          id="ts"
          rows={2}
          className="font-mono text-xs"
          value={p.scope}
          onChange={(e) => p.setScope(e.target.value)}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tv">{t("Done when these pass (one command per line)")}</Label>
        <Textarea
          id="tv"
          rows={2}
          className="font-mono text-xs"
          value={p.verify}
          onChange={(e) => p.setVerify(e.target.value)}
        />
      </div>
      {p.tasks.length ? (
        <fieldset className="space-y-1">
          <legend className="text-sm font-medium">{t("Depends on")}</legend>
          {p.tasks.map((x) => (
            <label key={x.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={p.deps.includes(x.id)}
                onChange={(e) =>
                  p.setDeps(e.target.checked ? [...p.deps, x.id] : p.deps.filter((d) => d !== x.id))
                }
              />
              {x.title}
            </label>
          ))}
        </fieldset>
      ) : null}
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

function Activity({ jobId }: { jobId: string }) {
  const seed = useLive(() => api.audit.search({ jobId, limit: 200 }), {
    topics: [],
    deps: [jobId],
  });
  const events = useEvents([`job:${jobId}`], 400, seed.data ?? []);
  const [filter, setFilter] = useState("");
  const shown = events.filter(
    (e: Event) =>
      !filter ||
      e.type.includes(filter) ||
      describe(e).toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <Input
          placeholder={t("Filter…")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
        <div className="max-h-[60vh] space-y-1 overflow-y-auto font-mono text-xs">
          {shown.map((e) => (
            <details key={e.seq} className="group">
              <summary className="flex cursor-pointer gap-2 marker:content-['']">
                <span className="shrink-0 text-muted-foreground">{clock(e.at)}</span>
                <span className="shrink-0 text-primary">{e.type}</span>
                <span className="truncate text-muted-foreground">{describe(e)}</span>
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px]">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Silk({ jobId }: { jobId: string }) {
  const silk = useLive(() => api.silk.list({ jobId, includeSuperseded: false }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type.startsWith("silk."),
    deps: [jobId],
  });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const kinds = [
    "interview-answer",
    "decision",
    "architecture",
    "progress",
    "issue",
    "handoff",
    "fact",
    "later",
  ] as const;
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
          {t("Add a decision")}
        </Button>
      </div>
      {adding ? (
        <Card>
          <CardContent className="space-y-2 pt-4">
            <Input
              placeholder={t("Title")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <Textarea
              placeholder={t("What you decided, and why")}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <Button
              size="sm"
              disabled={!title.trim()}
              onClick={() =>
                act(async () => {
                  await api.silk.add({ jobId, taskId: null, kind: "decision", title, body });
                  setTitle("");
                  setBody("");
                  setAdding(false);
                }, t("Added to Silk."))
              }
            >
              {t("Save")}
            </Button>
          </CardContent>
        </Card>
      ) : null}
      {kinds.map((k) => {
        const entries = (silk.data ?? []).filter((e) => e.kind === k);
        if (!entries.length) return null;
        return (
          <section key={k}>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t(k)}
            </h3>
            <div className="space-y-2">
              {entries.map((e) => (
                <Card key={e.id} className="py-3">
                  <CardHeader className="px-3">
                    <CardTitle className="flex items-center gap-2 text-sm">
                      <span className="flex-1">{e.title}</span>
                      {e.authoredBy === "owner" ? (
                        <Badge variant="secondary">{t("mine")}</Badge>
                      ) : null}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="px-3">
                    <Markdown text={e.body} />
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function JobInbox({ jobId }: { jobId: string }) {
  const items = useLive(() => api.inbox.list({ jobId }), { topics: ["inbox"], deps: [jobId] });
  const mine = items.data ?? [];
  return mine.length === 0 ? (
    <div className="p-4 text-sm text-muted-foreground">{t("Nothing for this job.")}</div>
  ) : (
    <div className="space-y-2">
      {mine.map((i) => (
        <InboxItemCard key={i.id} item={i} />
      ))}
    </div>
  );
}

function Budget({ job }: { job: JobView }) {
  const s = useLive(() => api.stats.summary({ jobId: job.id }), {
    topics: [`job:${job.id}`],
    refreshOn: (e) => e.type === "session.usage",
    deps: [job.id],
  });
  const used = s.data?.tokens ?? 0;
  const elapsed = job.startedAt ? (job.finishedAt ?? Date.now()) - job.startedAt : 0;
  const b = job.budget;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Stat
        label={t("Tokens")}
        value={tokens(used)}
        hint={
          b.tokens
            ? t("of {n} ({kind})", {
                n: tokens(b.tokens.limit),
                kind: b.tokens.hard ? t("hard") : t("alarm"),
              })
            : t("no limit")
        }
      />
      <Stat
        label={t("Time")}
        value={`${Math.floor(elapsed / 3600_000)}h ${Math.round((elapsed % 3600_000) / 60_000)}m`}
        hint={
          b.wallClockMs
            ? t("{kind} at {h} h", {
                kind: b.wallClockMs.hard ? t("stop") : t("alarm"),
                h: b.wallClockMs.limit / 3600_000,
              })
            : t("no limit")
        }
      />
      <Stat
        label={t("Money")}
        value={`$0.00`}
        hint={
          b.money.limit > 0
            ? t("limit: {amount}", { amount: `$${b.money.limit}` })
            : t("none may be spent")
        }
      />
      <Stat
        label={t("Quota share")}
        value={b.quotaShare ? `${Math.round(b.quotaShare.limit * 100)}%` : "100%"}
        hint={t("of any Leg's quota window")}
      />
      {job.state !== "completed" && job.state !== "cancelled" ? (
        <div className="flex items-center sm:col-span-2">
          <BudgetDialog job={job} />
        </div>
      ) : null}
      {job.unsandboxed ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-3">
          <ShieldAlert className="size-4" />
          {t("This job runs without the sandbox, by your choice.")}
        </div>
      ) : null}
    </div>
  );
}

/** Changing a job's budget at any time (Budgets-and-Quotas). */
function BudgetDialog({ job }: { job: JobView }) {
  const b = job.budget;
  const [open, setOpen] = useState(false);
  const [tok, setTok] = useState(b.tokens ? String(b.tokens.limit) : "");
  const [tokHard, setTokHard] = useState(b.tokens?.hard ?? true);
  const [share, setShare] = useState(
    b.quotaShare ? String(Math.round(b.quotaShare.limit * 100)) : "",
  );
  const [hours, setHours] = useState(b.wallClockMs ? String(b.wallClockMs.limit / 3600_000) : "");
  const [hoursHard, setHoursHard] = useState(b.wallClockMs?.hard ?? false);
  const save = async () => {
    await act(
      () =>
        api.jobs.setBudget({
          id: job.id,
          budget: {
            tokens: tok ? { limit: Number(tok), hard: tokHard } : null,
            quotaShare: share ? { limit: Math.min(100, Number(share)) / 100, hard: true } : null,
            wallClockMs: hours ? { limit: Number(hours) * 3600_000, hard: hoursHard } : null,
            money: b.money,
          },
        }),
      job.state === "paused"
        ? t("Budget changed. Resume the job when you're ready.")
        : t("Budget changed; it applies now."),
    );
    setOpen(false);
  };
  const digits = (v: string) => v.replace(/[^\d.]/g, "");
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t("Change the budget")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("The budget of “{title}”", { title: job.title })}</DialogTitle>
            <DialogDescription>
              {t(
                "Empty means no limit. A hard limit pauses the job and asks you; an alarm only tells you.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-tok">{t("Tokens")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="b-tok"
                  inputMode="numeric"
                  placeholder={t("none")}
                  value={tok}
                  onChange={(e) => setTok(digits(e.target.value))}
                />
                <div className="flex shrink-0 items-center gap-1 text-sm">
                  <Switch id="b-tok-hard" checked={tokHard} onCheckedChange={setTokHard} />
                  <Label htmlFor="b-tok-hard">{t("hard")}</Label>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-share">{t("Most of a Leg's quota window to use (%)")}</Label>
              <Input
                id="b-share"
                inputMode="numeric"
                placeholder="100"
                value={share}
                onChange={(e) => setShare(digits(e.target.value).slice(0, 3))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-hours">{t("Time (hours)")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="b-hours"
                  inputMode="decimal"
                  placeholder={t("none")}
                  value={hours}
                  onChange={(e) => setHours(digits(e.target.value))}
                />
                <div className="flex shrink-0 items-center gap-1 text-sm">
                  <Switch id="b-hours-hard" checked={hoursHard} onCheckedChange={setHoursHard} />
                  <Label htmlFor="b-hours-hard">{t("hard")}</Label>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button onClick={save}>{t("Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stats({ jobId }: { jobId: string }) {
  const s = useLive(() => api.stats.summary({ jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "session.ended" || e.type === "task.state",
    deps: [jobId],
  });
  const buckets = useLive(() => api.stats.tokens({ jobId, since: 0, bucketMs: 15 * 60_000 }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "session.usage",
  });
  if (!s.data) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t("Tasks done")} value={`${s.data.tasks.done}/${s.data.tasks.total}`} />
        <Stat label={t("Attempts")} value={s.data.attempts} />
        <Stat
          label={t("Success")}
          value={s.data.successRate === null ? "—" : `${Math.round(s.data.successRate * 100)}%`}
        />
        <Stat label={t("Tokens")} value={tokens(s.data.tokens)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Tokens over time")}</CardTitle>
        </CardHeader>
        <CardContent>
          {(buckets.data ?? []).length ? (
            <TokensChart buckets={buckets.data ?? []} />
          ) : (
            <div className="text-sm text-muted-foreground">{t("No sessions yet.")}</div>
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
