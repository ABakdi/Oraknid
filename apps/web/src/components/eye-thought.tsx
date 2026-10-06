import type { EyeThought, SessionLogEntry, SessionView } from "@oraknid/contracts";
import { CircleCheck, CircleSlash, CircleX, Loader2, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { live, useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// The Eye thinking out loud in its conversation (M13.25, The-Eye → Thinking
// out loud): each reasoning call live while it runs, folded to one line once
// it ends; and what the agents are doing now, a line per running task.

/** "41 s", "2 min 5 s". */
export function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t("{n} s", { n: s });
  const m = Math.floor(s / 60);
  return s % 60 ? t("{m} min {s} s", { m, s: s % 60 }) : t("{m} min", { m });
}

/** Ticks once a second while `on`, for elapsed times. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [on]);
  return now;
}

/**
 * A session's log while `open`: read once, then what comes, whenever its
 * job's live events name the session (text and reasoning arrive coalesced,
 * a few times a second).
 */
export function useSessionLog(id: string, jobId: string, open: boolean): SessionLogEntry[] {
  const [entries, setEntries] = useState<SessionLogEntry[]>([]);
  const next = useRef(0);
  useEffect(() => {
    if (!open) return;
    let gone = false;
    let busy = false;
    let again = false;
    const read = async () => {
      if (busy) {
        again = true;
        return;
      }
      busy = true;
      try {
        for (;;) {
          const page = await api.sessions.log({ id, after: next.current });
          if (gone) return;
          next.current = page.next;
          if (page.entries.length) setEntries((xs) => joinLog(xs, page.entries));
          if (!page.entries.length && !again) break;
          again = false;
        }
      } catch {
        // A log that can't be read leaves the line as it is.
      } finally {
        busy = false;
      }
    };
    void read();
    const off = live.subscribe([`job:${jobId}`]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (e.topic !== `job:${jobId}`) return;
      const p = e.payload as { sessionId?: string; id?: string } | null;
      if (p?.sessionId !== id && p?.id !== id) return;
      clearTimeout(timer);
      timer = setTimeout(read, 150);
    });
    return () => {
      gone = true;
      off();
      offEvents();
      clearTimeout(timer);
    };
  }, [id, jobId, open]);
  return entries;
}

/** Streamed text and reasoning may be split across reads: joined to the line before. */
export function joinLog(xs: SessionLogEntry[], more: SessionLogEntry[]): SessionLogEntry[] {
  const out = xs.slice();
  for (const e of more) {
    const last = out.at(-1);
    if ((e.kind === "text" || e.kind === "thinking") && last?.kind === e.kind)
      out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push(e);
  }
  return out;
}

const ENDED_ICON = {
  done: CircleCheck,
  failed: CircleX,
  stopped: CircleSlash,
  redone: RotateCcw,
  lost: CircleX,
} as const;

/** What a thought's line says once it ended: "Planned 9 tasks in 41 s". */
export function thoughtLine(th: EyeThought): string {
  const what = th.summary ?? th.purpose;
  if (th.endedAt === null) return what;
  return t("{what} in {time}", { what, time: seconds(th.endedAt - th.startedAt) });
}

/**
 * One reasoning call of The Eye: live, its purpose, model and time and what
 * it writes as it comes; once ended, one line ("Planned 9 tasks in 41 s ·
 * Claude · Opus — show") that opens to what it thought.
 */
export function ThoughtBlock({ thought }: { thought: EyeThought }) {
  const running = thought.outcome === "thinking";
  const [open, setOpen] = useState(running);
  // Folded as soon as it ends (in the same render, never a frame open).
  const [shownRunning, setShownRunning] = useState(running);
  if (shownRunning !== running) {
    setShownRunning(running);
    setOpen(running);
  }
  const now = useNow(running);
  const entries = useSessionLog(thought.id, thought.jobId, open);
  const box = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow what it writes while it runs
  useEffect(() => {
    if (running && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.length, entries.at(-1)?.text.length, running]);
  const Icon = running ? Loader2 : ENDED_ICON[thought.outcome as keyof typeof ENDED_ICON];
  const shown = entries.filter(
    (e) => e.kind === "thinking" || e.kind === "text" || e.kind === "tool",
  );
  return (
    <div data-testid="thought" data-outcome={thought.outcome} className="min-w-0 font-mono text-xs">
      <button
        type="button"
        onClick={() => setOpen((x) => !x)}
        aria-expanded={open}
        className="group flex w-full min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left text-muted-foreground hover:bg-muted/60"
      >
        <Icon
          aria-hidden
          className={cn(
            "size-3.5 shrink-0",
            running && "animate-spin text-eye",
            thought.outcome === "done" && "text-success",
            (thought.outcome === "failed" || thought.outcome === "lost") && "text-destructive",
          )}
        />
        <span
          className={cn(
            "min-w-0 truncate",
            running ? "text-foreground" : thought.outcome === "done" && "text-foreground/80",
          )}
          data-testid="thought-line"
        >
          {running ? `${thought.purpose}…` : thoughtLine(thought)}
        </span>
        <span className="hidden shrink-0 sm:inline">
          {running ? `· ${seconds(now - thought.startedAt)} ` : ""}· {thought.model}
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[10px] uppercase tracking-wide opacity-70 group-hover:opacity-100">
          {open ? t("hide") : t("show")}
        </span>
      </button>
      {open ? (
        <div
          ref={box}
          data-testid="thought-log"
          className="mt-1 ml-1.5 max-h-56 overflow-y-auto border-l border-border pl-3 leading-relaxed"
        >
          {shown.length === 0 ? (
            <div className="text-muted-foreground">
              {running ? t("Waiting for the model…") : t("Nothing was written.")}
            </div>
          ) : (
            shown.map((e, i) =>
              e.kind === "thinking" ? (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at its end
                  key={i}
                  className="whitespace-pre-wrap font-sans italic text-muted-foreground [overflow-wrap:anywhere]"
                >
                  {e.text}
                </div>
              ) : e.kind === "tool" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at its end
                <div key={i} className="truncate text-muted-foreground">
                  → <span className="text-primary">{e.tool}</span> {e.text}
                </div>
              ) : (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: the log only grows at its end
                  key={i}
                  className="whitespace-pre-wrap text-foreground/80 [overflow-wrap:anywhere]"
                >
                  {e.text}
                </div>
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Several thoughts in a row that ended (commands judged, reviews): one line, opened on demand. */
export function ThoughtGroup({ thoughts }: { thoughts: EyeThought[] }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <div className="space-y-0.5">
        {thoughts.map((th) => (
          <ThoughtBlock key={th.id} thought={th} />
        ))}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          {t("fold")}
        </button>
      </div>
    );
  const last = thoughts.at(-1);
  return (
    <button
      type="button"
      data-testid="thought-group"
      onClick={() => setOpen(true)}
      className="flex w-full min-w-0 items-center gap-1.5 rounded px-0.5 py-0.5 text-left font-mono text-xs text-muted-foreground hover:bg-muted/60"
    >
      <CircleCheck aria-hidden className="size-3.5 shrink-0 text-success" />
      <span className="min-w-0 truncate">
        {t("Thought {n} times", { n: thoughts.length })}
        {last ? ` · ${t("last: {what}", { what: last.summary ?? last.purpose })}` : ""}
      </span>
      <span className="ml-auto shrink-0 pl-2 text-[10px] uppercase tracking-wide opacity-70">
        {t("show")}
      </span>
    </button>
  );
}

/** What a tool call does, in a few words. */
function describe(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query;
  return typeof pick === "string" ? (pick.split("\n")[0]?.slice(0, 160) ?? "") : "";
}

/**
 * The agents working now, a compact live line each: the task, what it is
 * doing (its last tool or line), its model. The conversation is never
 * silent while work happens.
 */
export function WorkingNow({ jobIds }: { jobIds: string[] }) {
  const topics = jobIds.map((id) => `job:${id}`);
  const list = useLive(
    () => Promise.all(jobIds.map((jobId) => api.sessions.list({ jobId }))).then((x) => x.flat()),
    {
      topics,
      refreshOn: (e) => e.type === "session.started" || e.type === "session.ended",
      deps: [jobIds.join(",")],
    },
  );
  const [doing, setDoing] = useState<Record<string, string>>({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: topics identify the subscription
  useEffect(() => {
    if (!topics.length) return;
    const off = live.subscribe(topics);
    const offEvents = live.on((e) => {
      if (!topics.includes(e.topic)) return;
      const p = e.payload as { sessionId?: string; tool?: string; input?: unknown; text?: string };
      if (!p?.sessionId) return;
      let line: string | null = null;
      if (e.type === "session.tool.called") line = `${p.tool ?? "tool"} ${describe(p.input)}`;
      else if (e.type === "session.text")
        line =
          (p.text ?? "")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .at(-1) ?? null;
      if (line) setDoing((d) => ({ ...d, [p.sessionId as string]: line.slice(0, 200) }));
    });
    return () => {
      off();
      offEvents();
    };
  }, [topics.join(",")]);
  const now = useNow(true);
  const running = (list.data ?? []).filter(
    (s: SessionView) => s.endedAt === null && s.purpose === "task",
  );
  if (!running.length) return null;
  return (
    <div data-testid="working-now" className="space-y-0.5 border-t border-dashed pt-1.5">
      {running.map((s) => (
        <div
          key={s.id}
          className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground"
        >
          <span aria-hidden className="size-1.5 shrink-0 animate-pulse rounded-full bg-success" />
          <span className="min-w-0 max-w-[40%] shrink-0 truncate font-sans font-medium text-foreground">
            {s.taskTitle ?? t("A task")}
          </span>
          <span className="min-w-0 flex-1 truncate">{doing[s.id] ?? t("starting…")}</span>
          <span className="hidden shrink-0 sm:inline">
            {s.legName} · {s.model} · {seconds(now - s.startedAt)}
          </span>
        </div>
      ))}
    </div>
  );
}
