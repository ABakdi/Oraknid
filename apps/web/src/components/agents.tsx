import type { SessionLogEntry, SessionView } from "@oraknid/contracts";
import { useEffect, useRef, useState } from "react";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago, clock, tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { live, useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * Each agent of a job and what it is doing (Checkpoint 1 → F1-3): every
 * session, a task's or one of The Eye's calls, and its output as a
 * terminal-like log that follows along while it runs.
 */
export function Agents({ jobId, taskId }: { jobId: string; taskId?: string }) {
  const sessions = useLive(() => api.sessions.list({ jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "session.started" || e.type === "session.ended",
    deps: [jobId],
  });
  const [picked, setPicked] = useState<string | null>(null);
  if (sessions.error) return <ErrorNote error={sessions.error} />;
  if (sessions.loading) return <Loading />;
  const list = (sessions.data ?? []).filter((s) => !taskId || s.taskId === taskId);
  if (!list.length)
    return (
      <Empty title={t("No agent has worked yet")}>
        {t("Each Leg's session appears here as soon as it starts.")}
      </Empty>
    );
  // The running one first; else the newest.
  const current =
    list.find((s) => s.id === picked) ?? list.find((s) => s.endedAt === null) ?? list[0];
  return (
    <div className="grid gap-3 md:grid-cols-[16rem_1fr]">
      <div className="flex gap-2 overflow-x-auto md:max-h-[60vh] md:flex-col md:overflow-y-auto">
        {list.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setPicked(s.id)}
            className={cn(
              "min-w-52 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted md:min-w-0",
              s.id === current?.id && "border-primary bg-muted",
            )}
          >
            <div className="flex items-center gap-2">
              {s.endedAt === null ? (
                <span className="size-2 shrink-0 animate-pulse rounded-full bg-primary" />
              ) : null}
              <span className="truncate font-medium">
                {s.purpose === "task"
                  ? (s.taskTitle ?? t("A task"))
                  : t("The Eye: {call}", { call: s.purpose })}
              </span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {s.legName} · {s.model}
              {s.effort ? ` · ${s.effort}` : ""}
            </div>
            <div className="text-xs text-muted-foreground">
              {ago(s.startedAt)} · {tokens(s.tokens)}
              {s.endedAt !== null && s.endReason && s.endReason !== "completed"
                ? ` · ${s.endReason}`
                : ""}
            </div>
          </button>
        ))}
      </div>
      {current ? <SessionLog key={current.id} jobId={jobId} session={current} /> : null}
    </div>
  );
}

function SessionLog({ jobId, session }: { jobId: string; session: SessionView }) {
  const [entries, setEntries] = useState<SessionLogEntry[]>([]);
  const [error, setError] = useState<unknown>();
  const [follow, setFollow] = useState(true);
  const next = useRef(0);
  const busy = useRef(false);
  const again = useRef(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let gone = false;
    const read = async () => {
      if (busy.current) {
        again.current = true;
        return;
      }
      busy.current = true;
      try {
        for (;;) {
          const page = await api.sessions.log({ id: session.id, after: next.current });
          if (gone) return;
          next.current = page.next;
          if (page.entries.length) setEntries((xs) => join(xs, page.entries));
          if (!page.entries.length && !again.current) break;
          again.current = false;
        }
      } catch (e) {
        if (!gone) setError(e);
      } finally {
        busy.current = false;
      }
    };
    void read();
    const off = live.subscribe([`job:${jobId}`]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (e.topic !== `job:${jobId}`) return;
      if ((e.payload as { sessionId?: string } | null)?.sessionId !== session.id) return;
      clearTimeout(timer);
      timer = setTimeout(read, 200);
    });
    return () => {
      gone = true;
      off();
      offEvents();
      clearTimeout(timer);
    };
  }, [jobId, session.id]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new lines arrive
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [entries.length, follow, entries.at(-1)?.text.length]);

  return (
    <Card className="min-w-0 py-0">
      <CardContent className="p-0">
        <div className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          <Badge variant={session.endedAt === null ? "default" : "secondary"}>
            {session.endedAt === null ? t("Live") : (session.endReason ?? t("Ended"))}
          </Badge>
          <span className="truncate">
            {session.legName} · {session.model}
          </span>
          <label className="ml-auto flex items-center gap-1">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            {t("Follow")}
          </label>
        </div>
        {error ? <ErrorNote error={error} className="m-3" /> : null}
        <div
          ref={box}
          onWheel={() => {
            const b = box.current;
            if (b && b.scrollTop + b.clientHeight < b.scrollHeight - 40) setFollow(false);
          }}
          className="h-[60vh] overflow-y-auto bg-muted/40 p-3 font-mono text-xs leading-relaxed"
        >
          {entries.length === 0 ? (
            <div className="text-muted-foreground">{t("Nothing yet…")}</div>
          ) : null}
          {entries.map((e, i) => (
            <Line key={`${e.at}-${i}`} e={e} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function Line({ e }: { e: SessionLogEntry }) {
  const time = <span className="mr-2 select-none text-muted-foreground">{clock(e.at)}</span>;
  switch (e.kind) {
    case "text":
      return (
        <div className="my-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {time}
          {e.text}
        </div>
      );
    case "tool":
      return (
        <div className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">
          {time}
          <span className="font-semibold text-primary">{e.tool}</span> <span>{e.text}</span>
        </div>
      );
    case "result":
      return e.text ? (
        <details className="ml-4">
          <summary
            className={cn("cursor-pointer text-muted-foreground", !e.ok && "text-destructive")}
          >
            {e.ok ? t("output") : t("failed")} · {e.text.split("\n")[0]?.slice(0, 120)}
          </summary>
          <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-background p-2 [overflow-wrap:anywhere]">
            {e.text}
          </pre>
        </details>
      ) : null;
    case "permission":
      return (
        <div className={cn("ml-4", e.ok ? "text-muted-foreground" : "text-warning")}>
          {time}
          {e.text}
        </div>
      );
    default:
      return (
        <div
          className={cn(
            "my-1 border-t pt-1 text-muted-foreground",
            e.ok === false && "text-destructive",
          )}
        >
          {time}
          {e.text}
        </div>
      );
  }
}

/** Streamed text may be split across reads: join it to the line before. */
function join(xs: SessionLogEntry[], more: SessionLogEntry[]): SessionLogEntry[] {
  const out = xs.slice();
  for (const e of more) {
    const last = out.at(-1);
    if (e.kind === "text" && last?.kind === "text")
      out[out.length - 1] = { ...last, text: last.text + e.text };
    else out.push(e);
  }
  return out;
}
