import type { LegPlanUsage, PlanHistory, PlanWindowView } from "@oraknid/contracts";
import { Gauge } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { ago, tokens, until } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// A Leg's plan usage in front of me (ADR-039): each window's fill, its
// reset, how old the figure is, and Oraknid's own share of it.

/** Near the limit from 80%, at it from 100%: said in words, never colour alone. */
export function windowMark(w: { utilization: number | null }): "at" | "near" | null {
  if (w.utilization === null) return null;
  if (w.utilization >= 1) return "at";
  if (w.utilization >= 0.8) return "near";
  return null;
}

const fullest = (u: LegPlanUsage) => u.windows[0]?.utilization ?? -1;

/** The Legs with something to show, the one closest to a limit first. */
export function planRows(usage: LegPlanUsage[]): LegPlanUsage[] {
  return usage
    .filter((u) => u.kind === "claude-code" || u.windows.length > 0)
    .map((u) => ({
      ...u,
      windows: [...u.windows].sort((a, b) => (b.utilization ?? -1) - (a.utilization ?? -1)),
    }))
    .sort((a, b) => fullest(b) - fullest(a));
}

/** When a window resets, short: "in 2 h 10 min", "in 3 d 4 h". */
export function resetIn(at: number, now = Date.now()): string {
  const h = Math.max(0, at - now) / 3600_000;
  if (h < 24) return until(at, now);
  const hours = Math.round(h);
  return t("in {d} d {h} h", { d: Math.floor(hours / 24), h: hours % 24 });
}

/** How old a figure is, in words. */
export const asOf = (at: number, now = Date.now()) => t("as of {when}", { when: ago(at, now) });

/** The newest figure among a Leg's windows. */
const newest = (u: LegPlanUsage) => Math.max(0, ...u.windows.map((w) => w.observedAt));

/**
 * The windows, kept fresh while I look: the daemon is asked for a new
 * reading now and every minute (it reads at most every 5 minutes, or
 * prompts at most every 15), and live events bring others' readings.
 */
export function usePlanUsage() {
  const usage = useLive(() => api.legs.planUsage(), {
    topics: ["overview"],
    refreshOn: (e) =>
      e.type === "leg.quota" ||
      e.type === "leg.health" ||
      e.type === "leg.created" ||
      e.type === "leg.removed",
  });
  // Whichever answered last: a refresh, or a reload after an event.
  const [latest, setLatest] = useState<LegPlanUsage[]>();
  useEffect(() => {
    if (usage.data) setLatest(usage.data);
  }, [usage.data]);
  useEffect(() => {
    let alive = true;
    const ask = () =>
      api.legs
        .refreshPlanUsage()
        .then((u) => alive && setLatest(u))
        .catch(() => {});
    void ask();
    const timer = setInterval(ask, 60_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return { data: latest, loading: !latest };
}

/** The clock the "as of" and "resets" words are counted from, ticking. */
export function useNow(everyMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}

function MarkTag({ mark }: { mark: "at" | "near" | null }) {
  if (!mark) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 font-mono text-[10px] uppercase",
        mark === "at" ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning",
      )}
    >
      {mark === "at" ? t("at limit") : t("near limit")}
    </span>
  );
}

function Bar({ w, big = false }: { w: PlanWindowView; big?: boolean }) {
  const mark = windowMark(w);
  const pct = Math.round((w.utilization ?? 0) * 100);
  return (
    // The percentage beside it says the same in words.
    <div
      aria-hidden
      className={cn("w-full overflow-hidden rounded-full bg-muted", big ? "h-2.5" : "h-1.5")}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          mark === "at" ? "bg-destructive" : mark === "near" ? "bg-warning" : "bg-primary",
        )}
        style={{ width: `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}

const percent = (w: PlanWindowView) =>
  w.utilization === null ? t("no figure") : `${Math.round(w.utilization * 100)}%`;
const total = (w: PlanWindowView) => w.tokens.reduce((n, x) => n + x.tokens, 0);

/** The rows of the Overview's card: a row per Leg, its fullest window first. */
export function PlanUsageRows({ usage, now }: { usage: LegPlanUsage[]; now: number }) {
  return (
    <ul className="divide-y">
      {planRows(usage).map((u) => {
        const worst = windowMark(u.windows[0] ?? { utilization: null });
        const seen = newest(u);
        return (
          <li key={u.legId} data-leg={u.name} className="space-y-1.5 py-2.5 first:pt-0 last:pb-0">
            <div className="flex min-w-0 items-center gap-2 text-sm">
              <Link
                href={`/legs/${u.legId}`}
                className="min-w-0 truncate font-medium hover:underline"
                title={u.name}
              >
                {u.name}
              </Link>
              <MarkTag mark={worst} />
              <span className="ml-auto shrink-0 text-xs text-muted-foreground" data-age>
                {seen ? asOf(seen, now) : null}
              </span>
            </div>
            {u.windows.length === 0 ? (
              <div className="text-xs text-muted-foreground">{u.note}</div>
            ) : (
              u.windows.map((w) => (
                <div
                  key={w.name}
                  data-window={w.name}
                  className="grid grid-cols-[5.5rem_minmax(0,1fr)_3rem] items-center gap-x-2 gap-y-0.5 text-xs sm:grid-cols-[6.5rem_minmax(0,1fr)_3rem_minmax(0,11rem)]"
                >
                  <span className="truncate text-muted-foreground" title={w.label}>
                    {w.label}
                  </span>
                  <Bar w={w} />
                  <span className="text-right font-mono tabular-nums">
                    {percent(w)}
                    {w.estimated ? "*" : ""}
                  </span>
                  <span className="col-span-3 truncate text-muted-foreground sm:col-span-1">
                    {w.resetsAt ? t("resets {when}", { when: resetIn(w.resetsAt, now) }) : ""}
                    {total(w)
                      ? `${w.resetsAt ? " · " : ""}${t("Oraknid {n}", { n: tokens(total(w)) })}`
                      : ""}
                  </span>
                </div>
              ))
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The Overview's "Plan usage" card; nothing when no Leg has a plan. */
export function PlanUsageCard() {
  const { data } = usePlanUsage();
  const now = useNow();
  const rows = planRows(data ?? []);
  if (!rows.length) return null;
  return (
    <Card className="min-w-0 gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4" />
          {t("Plan usage")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <PlanUsageRows usage={rows} now={now} />
        {rows.some((u) => u.windows.some((w) => w.estimated)) ? (
          <div className="mt-2 text-[11px] text-muted-foreground">
            {t("* estimated by Oraknid from its own use")}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** A window's fill over the last days, as a step line, with its fills and resets marked. */
function HistoryLine({
  points,
  marks,
  since,
  now,
}: {
  points: PlanHistory["points"];
  marks: PlanHistory["marks"];
  since: number;
  now: number;
}) {
  const x = (at: number) => ((at - since) / Math.max(1, now - since)) * 1000;
  const y = (u: number | null) => 38 - (u ?? 0) * 36;
  let d = "";
  points.forEach((p, i) => {
    d += i === 0 ? `M${x(p.at)},${y(p.utilization)}` : `H${x(p.at)}V${y(p.utilization)}`;
  });
  if (points.length) d += `H${x(now)}`;
  return (
    <svg
      viewBox="0 0 1000 40"
      preserveAspectRatio="none"
      className="h-10 w-full rounded bg-muted/40"
      role="img"
      aria-label={t("How full it was over the last days")}
    >
      <line x1="0" x2="1000" y1={y(1)} y2={y(1)} stroke="var(--border)" strokeDasharray="6 6" />
      <path
        d={d}
        fill="none"
        stroke="var(--primary)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      {marks.map((m) => (
        <line
          key={`${m.kind}-${m.at}`}
          x1={x(m.at)}
          x2={x(m.at)}
          y1="0"
          y2="40"
          stroke={m.kind === "filled" ? "var(--destructive)" : "var(--success)"}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

const DAYS = 8;

/**
 * A Leg's plan usage in its details (ADR-039): each window larger, who
 * used it (Oraknid's models' share), and how it filled and reset over the
 * last days. Another kind says what it has instead.
 */
export function LegPlanUsageDetail({ legId }: { legId: string }) {
  const { data } = usePlanUsage();
  const now = useNow();
  const history = useLive(() => api.legs.planHistory({ id: legId, days: DAYS }), {
    topics: [`leg:${legId}`],
    refreshOn: (e) => e.type === "leg.quota",
    deps: [legId],
  });
  const u = data?.find((x) => x.legId === legId);
  if (!u) return null;
  const since = now - DAYS * 86400_000;
  return (
    <section className="space-y-3 rounded-lg border bg-card p-3" aria-label={t("Plan usage")}>
      <div className="flex items-center gap-2 text-sm font-medium">
        <Gauge className="size-4" />
        {t("Plan usage")}
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {u.windows.length
            ? asOf(newest(u), now)
            : u.checkedAt
              ? t("checked {when}", { when: ago(u.checkedAt, now) })
              : ""}
        </span>
      </div>
      {u.windows.length === 0 ? (
        <div className="text-xs text-muted-foreground">{u.note}</div>
      ) : null}
      {u.windows.map((w) => {
        const all = total(w);
        const points = (history.data?.points ?? []).filter((p) => p.window === w.name);
        const marks = (history.data?.marks ?? []).filter((m) => m.window === w.name);
        return (
          <div key={w.name} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
              <span className="font-medium">{w.label}</span>
              <MarkTag mark={windowMark(w)} />
              <span className="ml-auto font-mono text-base tabular-nums">{percent(w)}</span>
            </div>
            <Bar w={w} big />
            <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {w.resetsAt ? (
                <span>{t("resets {when}", { when: resetIn(w.resetsAt, now) })}</span>
              ) : null}
              <span>
                {asOf(w.observedAt, now)}
                {w.source === "usage"
                  ? ` · ${t("read from its CLI")}`
                  : w.source === "session"
                    ? ` · ${t("from a session")}`
                    : ""}
                {w.estimated ? ` · ${t("estimated")}` : ""}
              </span>
            </div>
            {all ? (
              <div className="space-y-1">
                <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  {w.tokens.map((m, i) => (
                    <div
                      key={m.legModelId}
                      className="h-full"
                      style={{
                        width: `${(m.tokens / all) * 100}%`,
                        background: `var(--chart-${(i % 5) + 1})`,
                      }}
                    />
                  ))}
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{t("Oraknid in this window: {n}", { n: tokens(all) })}</span>
                  {w.tokens.map((m, i) => (
                    <span key={m.legModelId} className="flex items-center gap-1">
                      <span
                        className="inline-block size-2 rounded-sm"
                        style={{ background: `var(--chart-${(i % 5) + 1})` }}
                      />
                      {m.displayName} {tokens(m.tokens)} ({Math.round((m.tokens / all) * 100)}%)
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                {t("Oraknid used none of it yet.")}
              </div>
            )}
            {points.length ? (
              <div className="space-y-1">
                <HistoryLine points={points} marks={marks} since={since} now={now} />
                {marks.length ? (
                  <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {marks.map((m) => (
                      <span key={`${m.kind}-${m.at}`}>
                        {m.kind === "filled" ? t("Filled") : t("Reset")}{" "}
                        {new Date(m.at).toLocaleString([], {
                          weekday: "short",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
