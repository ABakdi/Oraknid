import type { Event } from "@oraknid/contracts";
import { memo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  condense,
  describe,
  EVENT_KINDS,
  type EventKind,
  eventKind,
  eventTitle,
  isLegOutput,
  legOf,
} from "@/lib/events";
import { clip, clock } from "@/lib/format";
import { t } from "@/lib/i18n";

export interface ActivityFilter {
  job: string;
  leg: string;
  kind: EventKind | "";
}

/** The events a filter keeps: by job, by Leg, by kind (Web-UI → Overview). */
export function filterActivity(events: Event[], f: ActivityFilter): Event[] {
  return events.filter(
    (e) =>
      (!f.job || e.jobId === f.job) &&
      (!f.leg || legOf(e) === f.leg) &&
      (!f.kind || eventKind(e) === f.kind),
  );
}

const SELECT =
  "h-8 min-w-0 rounded-md border bg-field px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

/**
 * The Overview's Activity stream: every Leg's and The Eye's actions as they
 * happen, in words, filterable by job, Leg and kind; a Leg's output is a
 * condensed line that opens to all of it.
 */
export function OverviewActivity({
  events,
  jobs,
  legs,
}: {
  events: Event[];
  jobs: { id: string; title: string }[];
  legs: { id: string; name: string }[];
}) {
  const [f, setF] = useState<ActivityFilter>({ job: "", leg: "", kind: "" });
  const jobName = new Map(jobs.map((j) => [j.id, j.title]));
  const legName = new Map(legs.map((l) => [l.id, l.name]));
  const shown = filterActivity(events, f).slice(0, 150);
  const filtered = !!(f.job || f.leg || f.kind);
  return (
    <Card className="min-w-0 xl:col-span-2" data-help="overview.activity">
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 space-y-0">
        <CardTitle className="mr-auto text-sm">{t("Activity")}</CardTitle>
        <select
          className={SELECT}
          aria-label={t("Only this job")}
          value={f.job}
          onChange={(e) => setF({ ...f, job: e.target.value })}
        >
          <option value="">{t("Every job")}</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title}
            </option>
          ))}
        </select>
        <select
          className={SELECT}
          aria-label={t("Only this Leg")}
          value={f.leg}
          onChange={(e) => setF({ ...f, leg: e.target.value })}
        >
          <option value="">{t("Every Leg")}</option>
          {legs.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          className={SELECT}
          aria-label={t("Only this kind")}
          value={f.kind}
          onChange={(e) => setF({ ...f, kind: e.target.value as EventKind | "" })}
        >
          <option value="">{t("Every kind")}</option>
          {EVENT_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {t(k.name)}
            </option>
          ))}
        </select>
      </CardHeader>
      <CardContent className="max-h-96 space-y-1 overflow-y-auto text-xs">
        {shown.length === 0 ? (
          <div className="text-muted-foreground">
            {filtered ? t("Nothing matches.") : t("Nothing yet.")}
          </div>
        ) : null}
        {shown.map((e) => (
          <ActivityLine
            key={e.seq}
            e={e}
            job={e.jobId ? (jobName.get(e.jobId) ?? null) : null}
            leg={legName.get(legOf(e) ?? "") ?? null}
          />
        ))}
      </CardContent>
    </Card>
  );
}

/** The most of one event's text the stream shows, opened (Web-UI → Performance). */
export const LINE_OPEN_MAX = 20_000;

// Drawn again only when its event changes: the stream redraws twice a second at most.
const ActivityLine = memo(function ActivityLine({
  e,
  job,
  leg,
}: {
  e: Event;
  job: string | null;
  leg: string | null;
}) {
  const full = describe(e);
  // A reason that was a tool's whole output (3 MB, 2026-10-08) is a line that opens, cut short.
  const text = clip(full, LINE_OPEN_MAX);
  const short = isLegOutput(e) || full.length > 600 ? condense(text) : null;
  const head = (
    <>
      <span className="shrink-0 font-mono text-muted-foreground">{clock(e.at)}</span>
      <span className="shrink-0 font-medium text-primary" title={e.type}>
        {t(eventTitle(e))}
      </span>
      {leg ? <span className="max-w-32 shrink-0 truncate">{leg}</span> : null}
      {job ? (
        <span className="hidden max-w-40 shrink-0 truncate text-muted-foreground sm:inline">
          {job}
        </span>
      ) : null}
    </>
  );
  if (short)
    return (
      <details className="group" data-testid="activity-line">
        <summary className="flex min-w-0 cursor-pointer flex-wrap gap-x-2 marker:content-['']">
          {head}
          <span className="min-w-0 basis-full truncate text-muted-foreground sm:basis-0 sm:flex-1">
            {short}
          </span>
        </summary>
        <div className="mt-1 rounded bg-muted p-2 font-mono text-[11px] whitespace-pre-wrap [overflow-wrap:anywhere]">
          {text}
        </div>
      </details>
    );
  return (
    <div className="flex flex-wrap gap-x-2" data-testid="activity-line">
      {head}
      <span className="min-w-0 basis-full text-muted-foreground [overflow-wrap:anywhere] sm:basis-0 sm:flex-1">
        {text}
      </span>
    </div>
  );
});
