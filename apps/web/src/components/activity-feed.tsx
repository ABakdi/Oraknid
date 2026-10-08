import type { Event } from "@oraknid/contracts";
import { memo, useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { describe, eventTitle, wasCut } from "@/lib/events";
import { clip, clock } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useEvents, useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * Everything that happened, newest first, live: one job's, or a project's
 * across its jobs (ADR-034). Each line opens to its payload.
 */
export function ActivityFeed({
  jobId,
  projectId,
  jobIds,
  label,
}: {
  jobId?: string;
  projectId?: string;
  /** The jobs whose live events it follows. */
  jobIds: string[];
  /** Names a line's job, when there are several. */
  label?: (e: Event) => string | null;
}) {
  const seed = useLive(
    () => api.audit.search({ ...(jobId ? { jobId } : { projectId }), limit: 200 }),
    { topics: [], deps: [jobId, projectId] },
  );
  const events = useEvents(
    jobIds.map((id) => `job:${id}`),
    400,
    seed.data ?? [],
  );
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
          aria-label={t("Filter the activity")}
        />
        <div className="space-y-1 font-mono text-xs">
          {shown.length === 0 ? (
            <div className="font-sans text-sm text-muted-foreground">
              {filter ? t("Nothing matches.") : t("Nothing yet.")}
            </div>
          ) : null}
          {shown.map((e) => (
            <FeedLine key={e.seq} e={e} job={label?.(e) ?? null} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/** The most of a payload shown when a line is opened (Web-UI → Performance). */
const PAYLOAD_MAX = 100_000;

/**
 * One event: its line, and its payload once opened (never drawn closed: a
 * payload can be a tool's whole output). Drawn again only when it changes.
 */
const FeedLine = memo(function FeedLine({ e, job }: { e: Event; job: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="group" onToggle={(x) => setOpen(x.currentTarget.open)}>
      <summary className="flex min-w-0 cursor-pointer gap-2 marker:content-['']">
        <span className="shrink-0 text-muted-foreground">{clock(e.at)}</span>
        <span className="shrink-0 text-primary" title={e.type}>
          {t(eventTitle(e))}
        </span>
        {job ? (
          <span className="hidden max-w-40 shrink-0 truncate font-sans sm:inline">{job}</span>
        ) : null}
        <span className="min-w-0 truncate text-muted-foreground">{clip(describe(e), 300)}</span>
      </summary>
      {open ? <EventPayload e={e} className="text-[11px]" /> : null}
    </details>
  );
});

/**
 * An opened event's payload: a list carries each long string's start and
 * end only, so one cut short is read whole, then shown (at most 100 KB).
 */
export function EventPayload({ e, className }: { e: Event; className?: string }) {
  const [whole, setWhole] = useState<Event | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: one event, read once
  useEffect(() => {
    if (!wasCut(e)) return;
    let gone = false;
    api.audit.event({ seq: e.seq }).then(
      (x) => !gone && setWhole(x),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [e.seq]);
  return (
    <pre className={cn("mt-1 overflow-x-auto rounded bg-muted p-2", className)}>
      {clip(JSON.stringify((whole ?? e).payload, null, 2), PAYLOAD_MAX)}
    </pre>
  );
}
