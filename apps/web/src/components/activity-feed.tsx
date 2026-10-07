import type { Event } from "@oraknid/contracts";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { describe, eventTitle } from "@/lib/events";
import { clock } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useEvents, useLive } from "@/lib/live";

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
          {shown.map((e) => {
            const job = label?.(e);
            return (
              <details key={e.seq} className="group">
                <summary className="flex min-w-0 cursor-pointer gap-2 marker:content-['']">
                  <span className="shrink-0 text-muted-foreground">{clock(e.at)}</span>
                  <span className="shrink-0 text-primary" title={e.type}>
                    {t(eventTitle(e))}
                  </span>
                  {job ? (
                    <span className="hidden max-w-40 shrink-0 truncate font-sans sm:inline">
                      {job}
                    </span>
                  ) : null}
                  <span className="min-w-0 truncate text-muted-foreground">{describe(e)}</span>
                </summary>
                <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px]">
                  {JSON.stringify(e.payload, null, 2)}
                </pre>
              </details>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
