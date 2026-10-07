import type { JobView, TaskView } from "@oraknid/contracts";
import { Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Agents } from "@/components/agents";
import { Markdown, StateBadge } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { TaskDiff } from "@/components/task-diff";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act } from "@/lib/links";
import { useEvents, useLive } from "@/lib/live";

// A task, opened from The Web (Web-UI → Task drawer): what it is, its
// checks, attempts, diff and output, and what I can do with it.

export const ACTIVE = ["interviewing", "planning", "running", "verifying", "waiting"];

/** The task whose drawer this history entry opened, if any. */
const taskIn = (state: unknown): string | null =>
  state && typeof state === "object" && typeof (state as { task?: unknown }).task === "string"
    ? (state as { task: string }).task
    : null;

/** The task drawer is a step of its own in history: back (or Esc, or ✕) closes it. */
export function useTaskDrawer() {
  const [open, setOpen] = useState<string | null>(() => taskIn(history.state));
  useEffect(() => {
    const on = () => setOpen(taskIn(history.state));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  const openTask = useCallback((taskId: string) => {
    history.pushState({ ...(history.state ?? {}), task: taskId }, "", location.href);
    setOpen(taskId);
  }, []);
  const closeTask = useCallback(() => {
    if (taskIn(history.state)) history.back();
    else setOpen(null);
  }, []);
  return { open, openTask, closeTask };
}

/** A Leg model's name, from the Legs list. */
export function useModelName() {
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const modelName = useCallback(
    (modelId: string | null) => {
      for (const l of legs.data ?? [])
        for (const m of l.models) if (m.id === modelId) return `${l.name} · ${m.model}`;
      return null;
    },
    [legs.data],
  );
  return { modelName, legs: legs.data ?? [] };
}

/** What a task node shows of its Leg: the model routing chose, while it matters. */
export const legName = (task: TaskView) =>
  task.state === "running" || task.state === "assigned" || task.state === "done"
    ? task.routing
      ? `${task.routing.model}${task.routing.effort ? ` · ${task.routing.effort}` : ""}`
      : null
    : null;

export function TaskDrawer({
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
  const { confirm, dialog } = useConfirm();
  const busy = task ? ["assigned", "running", "verifying"].includes(task.state) : false;
  const finished = task ? task.state === "done" || task.state === "skipped" : false;
  const jobRunning = ACTIVE.includes(job.state);
  return (
    <Sheet open={!!task} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        {task ? (
          <>
            <SheetHeader>
              <SheetTitle className="pr-10 [overflow-wrap:anywhere]">{task.title}</SheetTitle>
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
                      aria-label={t("Roll back attempt {n}", { n: i + 1 })}
                      onClick={async () => {
                        if (
                          await confirm(
                            t("Roll back to before attempt {n}?", { n: i + 1 }),
                            t(
                              "The worktree goes back to how it was before this attempt; files it added go to the trash.",
                            ),
                            t("Roll back"),
                          )
                        )
                          void act(
                            () => api.tasks.rollback({ taskId: task.id, attempt: i + 1 }),
                            t("Rolled back; new files went to the trash."),
                          );
                      }}
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
              {task.waitingForLegId ? (
                <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2">
                  {t("It waits for {leg}, paused: it goes on when the Leg is resumed.", {
                    leg: legs.find((l) => l.id === task.waitingForLegId)?.name ?? t("its Leg"),
                  })}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2">
                {task.waitingForLegId || (busy && task.assignedLegId) ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      act(
                        () =>
                          api.jobs.cancelLegWork({
                            id: job.id,
                            legId: (task.waitingForLegId ?? task.assignedLegId) as string,
                            taskId: task.id,
                          }),
                        t("It goes on another Leg."),
                      )
                    }
                  >
                    {task.waitingForLegId
                      ? t("Reassign")
                      : t("Stop {leg} on it", {
                          leg: legs.find((l) => l.id === task.assignedLegId)?.name ?? t("its Leg"),
                        })}
                  </Button>
                ) : null}
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
                  onClick={async () => {
                    if (
                      await confirm(
                        t("Remove “{title}” from the plan?", { title: task.title }),
                        t("It leaves the plan for good; add it again if you need it."),
                        t("Remove"),
                        { keep: t("Keep it") },
                      )
                    )
                      void act(
                        () =>
                          api.web.edit({
                            jobId: job.id,
                            edits: [{ op: "remove", taskId: task.id }],
                          }),
                        t("Removed from the plan."),
                      ).then(onClose);
                  }}
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
            {dialog}
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
            {job.autonomy === "careful"
              ? t("At Careful, the edited plan asks for your approval again.")
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
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
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

export function AddTaskDialog({
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
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
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
        <fieldset className="min-w-0 space-y-1">
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
