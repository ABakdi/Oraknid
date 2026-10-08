import type { InboxItem, JobView } from "@oraknid/contracts";
import {
  ChevronRight,
  CircleX,
  ExternalLink,
  MessageCircleQuestion,
  Pause,
  Play,
  Rocket,
} from "lucide-react";
import { memo, useEffect, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { StateBadge } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { ACTIVE } from "@/components/task-drawer";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { api, message } from "@/lib/api";
import { ago, clip } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act, jobHref } from "@/lib/links";
import { cn } from "@/lib/utils";
import { InboxItemCard } from "@/pages/inbox";

// A project's current work, in its page's header (Web-UI → Projects → The
// work bar): what runs, waits or is paused there, how far it is, and its
// controls, so nothing needs the Overview to start or follow it.

const ENDED = new Set(["completed", "cancelled"]);
/** Tasks being worked on now. */
const WORKING = new Set(["assigned", "running", "verifying"]);

/**
 * Which comes first in what a project does now: the jobs working, then
 * those waiting for me, blocked, paused, and last its drafts.
 */
export function nowRank(state: string): number {
  if (state === "waiting") return 1;
  if (state === "blocked") return 2;
  if (state === "paused") return 3;
  if (state === "draft") return 4;
  return 0;
}

/**
 * The project's jobs that haven't ended, those working first, then waiting,
 * blocked, paused, and its drafts; newest first within each.
 */
export function goingJobs(jobs: JobView[]): JobView[] {
  return jobs
    .filter((j) => !ENDED.has(j.state))
    .sort((a, b) => nowRank(a.state) - nowRank(b.state) || (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/** Where a job stands, in words. */
export function stateWords(j: JobView): string {
  if (j.queuedAt) return t("Queued: starts when a slot frees");
  switch (j.state) {
    case "draft":
      return t("A draft, not started");
    case "interviewing":
      return t("The Eye asks you about it first");
    case "planning":
      return t("The Eye is planning the work");
    case "running":
      return t("Running");
    case "verifying":
      return t("Checking the work");
    case "waiting":
      return t("Waiting for you");
    case "paused":
      return t("Paused");
    case "blocked":
      return t("Blocked");
    default:
      return t(j.state);
  }
}

/** A length of time, short: "45 s", "12 min", "3 h 5 min", "2 d 4 h". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("{n} s", { n: s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{n} min", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{h} h {m} min", { h, m: m % 60 });
  return t("{d} d {h} h", { d: Math.floor(h / 24), h: h % 24 });
}

/** How long it has run, kept current by itself (a tick every 30 s, nothing out of sight). */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") setNow(Date.now());
    }, 30_000);
    return () => clearInterval(id);
  }, []);
  return <span title={new Date(since).toLocaleString()}>{duration(now - since)}</span>;
}

/**
 * The work bar: every job of the project that hasn't ended, each with its
 * state in words, its progress (tasks done of all, the ones being worked
 * on), how long it has run, why it is blocked or waiting and what to do,
 * and Start, Pause, Resume, Cancel and Open job right there. Nothing going:
 * one line on the last job. It stays at the top of the project's page.
 */
export const ProjectWorkBar = memo(function ProjectWorkBar({
  jobs,
  questions,
  defaultFolded = false,
}: {
  jobs: JobView[];
  /** The project's open inbox items: what the jobs ask me. */
  questions: InboxItem[];
  /** Several jobs shown as their one summary line until opened (a phone with a job open). */
  defaultFolded?: boolean;
}) {
  const [folded, setFolded] = useState(defaultFolded);
  const going = goingJobs(jobs);
  if (!going.length) {
    const last = jobs.filter((j) => j.state !== "draft").at(-1);
    if (!last) return null;
    return (
      <div
        data-help="project.work-bar"
        className="flex min-w-0 shrink-0 items-center gap-2 rounded-lg border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <span className="shrink-0">{t("Nothing running. Last:")}</span>
        <Link
          href={jobHref(last)}
          className="min-w-0 truncate text-foreground underline-offset-2 hover:underline"
          title={last.title}
        >
          {last.title}
        </Link>
        <StateBadge state={last.state} className="shrink-0" />
        {last.finishedAt ? <span className="shrink-0">{ago(last.finishedAt)}</span> : null}
      </div>
    );
  }
  const several = going.length > 1;
  const working = going.filter((j) => nowRank(j.state) === 0).length;
  return (
    <section
      aria-label={t("Current work")}
      data-help="project.work-bar"
      className="flex min-h-0 shrink-0 flex-col overflow-hidden rounded-lg border bg-card"
    >
      {several ? (
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setFolded(!folded)}
          className={cn(
            "flex shrink-0 items-center gap-2 bg-muted/30 px-3 py-1 text-left text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11",
            !folded && "border-b",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", !folded && "rotate-90")}
          />
          <span className="font-medium text-foreground/80">
            {t("{n} jobs not ended", { n: going.length })}
          </span>
          {working ? <span>· {t("{n} working", { n: working })}</span> : null}
        </button>
      ) : null}
      <div
        hidden={several && folded}
        className={cn("min-h-0 overflow-y-auto", several && "max-h-32 divide-y sm:max-h-48")}
      >
        {going.map((j) => (
          <WorkItem
            key={j.id}
            job={j}
            questions={questions.filter((q) => q.jobId === j.id && q.state === "open")}
            compact={several}
          />
        ))}
      </div>
    </section>
  );
});

function WorkItem({
  job: j,
  questions,
  compact,
}: {
  job: JobView;
  questions: InboxItem[];
  compact: boolean;
}) {
  const { confirm, dialog } = useConfirm();
  const [answering, setAnswering] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = j.tasks.filter((x) => x.state === "done" || x.state === "skipped").length;
  const total = j.tasks.length;
  const working = j.tasks.filter((x) => WORKING.has(x.state)).map((x) => x.title);
  const reason =
    j.blockedReason ??
    j.pauseReason ??
    (j.state === "blocked" ? t("Blocked: open the job to see why.") : null);
  // Nothing worked on now: the next task waiting for room, and why (ADR-050).
  const next = working.length ? undefined : j.tasks.find((x) => x.waitingReason);
  const draft = j.state === "draft";
  const running = ACTIVE.includes(j.state);
  const stopped = j.state === "paused" || j.state === "blocked";

  const start = async () => {
    setBusy(true);
    try {
      await api.jobs.start({ id: j.id });
      toast.success(t("Started “{title}”.", { title: j.title }));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (
      !(await confirm(
        t("Cancel “{title}”?", { title: j.title }),
        t(
          "The work so far stays in its folder. It stops at a safe point; what it asked you is withdrawn.",
        ),
        t("Cancel the job"),
        { keep: t("Keep it") },
      ))
    )
      return;
    setBusy(true);
    try {
      await api.jobs.cancel({ id: j.id, reason: "Cancelled from the project's page." });
      toast.success(t("Cancelling “{title}”.", { title: j.title }));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };

  const btn = "h-8 shrink-0 gap-1 px-2 pointer-coarse:min-h-11 pointer-coarse:min-w-11";
  const what = questions[0];
  return (
    <div
      className={cn("px-3", compact ? "space-y-1 py-1.5" : "space-y-1.5 py-2.5")}
      data-testid="work-item"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
          <StateBadge state={j.state} className="shrink-0" />
          <Link
            href={jobHref(j)}
            className="min-w-0 truncate font-medium underline-offset-2 hover:underline"
            title={j.description ? `${j.title}\n${j.description}` : j.title}
          >
            {j.title}
          </Link>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {draft ? (
            <Button
              size="sm"
              className={btn}
              disabled={busy}
              aria-label={t("Start “{title}”", { title: j.title })}
              title={t("Start this draft")}
              onClick={() => void start()}
            >
              <Rocket className="size-4" />
              <span className="hidden sm:inline">{t("Start")}</span>
            </Button>
          ) : null}
          {running ? (
            <Button
              size="sm"
              variant="secondary"
              className={btn}
              disabled={busy}
              aria-label={t("Pause “{title}”", { title: j.title })}
              title={t("Pause at the next safe point")}
              onClick={() =>
                act(() => api.jobs.pause({ id: j.id }), t("Pausing at the next safe point…"))
              }
            >
              <Pause className="size-4" />
              <span className="hidden sm:inline">{t("Pause")}</span>
            </Button>
          ) : null}
          {stopped ? (
            <Button
              size="sm"
              className={btn}
              disabled={busy}
              aria-label={t("Resume “{title}”", { title: j.title })}
              title={t("Resume")}
              onClick={() => act(() => api.jobs.resume({ id: j.id }), t("Resumed."))}
            >
              <Play className="size-4" />
              <span className="hidden sm:inline">{t("Resume")}</span>
            </Button>
          ) : null}
          {draft ? null : (
            <Button
              size="sm"
              variant="ghost"
              className={cn(btn, "text-destructive")}
              disabled={busy}
              aria-label={t("Cancel “{title}”", { title: j.title })}
              title={t("Cancel the job")}
              onClick={() => void cancel()}
            >
              <CircleX className="size-4" />
              <span className="hidden sm:inline">{t("Cancel")}</span>
            </Button>
          )}
          <Button
            asChild
            size="sm"
            variant="ghost"
            className={btn}
            aria-label={
              draft
                ? t("Open the draft “{title}”", { title: j.title })
                : t("Open the job “{title}”", { title: j.title })
            }
            title={draft ? t("Open the draft") : t("Open the job: its tasks, result and settings")}
          >
            <Link href={jobHref(j)}>
              <ExternalLink className="size-4" />
              <span className="hidden md:inline">{draft ? t("Open draft") : t("Open job")}</span>
            </Link>
          </Button>
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span className="shrink-0 font-medium text-foreground/80">{stateWords(j)}</span>
        {!draft && total ? (
          <span className="flex min-w-32 flex-1 items-center gap-2 sm:max-w-64">
            <Progress
              value={(done / total) * 100}
              className="h-1.5"
              aria-label={t("{done} of {total} tasks done", { done, total })}
            />
            <span className="shrink-0 tabular-nums">
              {t("{done}/{total} tasks", { done, total })}
            </span>
          </span>
        ) : null}
        {j.startedAt && !draft ? (
          <span className="shrink-0">
            {t("for")} <Elapsed since={j.startedAt} />
          </span>
        ) : null}
        {next ? (
          <span
            className="min-w-0 flex-1 basis-full truncate sm:basis-0"
            title={`${next.title}\n${next.waitingReason}`}
          >
            {t("Next: {task}, {why}", {
              task: clip(next.title, 80),
              why: clip(next.waitingReason ?? "", 120),
            })}
          </span>
        ) : null}
        {working.length ? (
          <span
            className="min-w-0 flex-1 basis-full truncate sm:basis-0"
            title={working.join("\n")}
          >
            {t("Now: {tasks}", { tasks: clip(working.join(", "), 160) })}
          </span>
        ) : null}
      </div>
      {reason || what ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-2 py-1 text-xs">
          <span
            className="min-w-0 flex-1 truncate"
            title={clip(what ? what.title : (reason ?? ""), 600)}
            data-testid="work-reason"
          >
            {what
              ? questions.length > 1
                ? t("It asks you {n} things: {first}", {
                    n: questions.length,
                    first: clip(what.title, 160),
                  })
                : t("It asks you: {title}", { title: clip(what.title, 160) })
              : clip(reason ?? "", 160)}
          </span>
          {what ? (
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 gap-1 px-2 text-xs pointer-coarse:min-h-11"
              aria-expanded={answering}
              onClick={() => setAnswering((a) => !a)}
            >
              <MessageCircleQuestion className="size-3.5" />
              {answering ? t("Hide") : t("Answer")}
            </Button>
          ) : j.state === "blocked" ? (
            <span className="shrink-0 text-muted-foreground">
              {t("Fix what it says, then Resume.")}
            </span>
          ) : j.state === "paused" ? (
            <span className="shrink-0 text-muted-foreground">{t("Resume when you're ready.")}</span>
          ) : null}
        </div>
      ) : null}
      {answering && questions.length ? (
        <div className="max-h-[50dvh] space-y-2 overflow-y-auto pt-1">
          {questions.map((q) => (
            <InboxItemCard key={q.id} item={q} />
          ))}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}
