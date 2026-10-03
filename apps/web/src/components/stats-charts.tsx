import type { ReactNode } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { ErrorNote, Loading } from "@/components/common";
import { LegAvatar } from "@/components/leg-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { api } from "@/lib/api";
import { tokens as fmtTokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

// The charts beyond tokens over time (Web-UI → Charts), for a job, a project
// or everything: throughput, success and failure by Leg and by task kind,
// the Legs compared (tokens and time per verified task), money when any is
// counted, and budget burn against the limit.

export type ChartsData = Awaited<ReturnType<typeof api.stats.charts>>;

/** A span of time, short: 45s, 12m, 1h 5m. */
export function span(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ""}`;
}

const pct = (n: number, of: number) => (of ? Math.round((n / of) * 100) : 0);

/** A legend under a chart, one entry per line on a phone: nothing runs off its edge. */
function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="grid gap-x-4 gap-y-1 text-xs sm:flex sm:flex-wrap">
      {items.map((x) => (
        <li key={x.label} className="flex min-w-0 items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: x.color }} />
          <span className="min-w-0 truncate">{x.label}</span>
          {x.value ? (
            <span className="shrink-0 tabular-nums text-muted-foreground">{x.value}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const when = (at: number, bucketMs: number) =>
  bucketMs >= 86400_000
    ? new Date(at).toLocaleDateString([], { month: "short", day: "numeric" })
    : new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function TimeAxis({ bucketMs }: { bucketMs: number }) {
  return (
    <XAxis
      dataKey="t"
      tickLine={false}
      axisLine={false}
      minTickGap={24}
      tickFormatter={(v) => when(v, bucketMs)}
    />
  );
}

/** Tasks verified and attempts failed, per hour or day. */
export function ThroughputChart({
  points,
  bucketMs,
  height = 180,
}: {
  points: ChartsData["throughput"];
  bucketMs: number;
  height?: number;
}) {
  const config: ChartConfig = {
    done: { label: t("Verified"), color: "var(--success)" },
    failed: { label: t("Failed"), color: "var(--destructive)" },
  };
  const done = points.reduce((n, p) => n + p.done, 0);
  const failed = points.reduce((n, p) => n + p.failed, 0);
  return (
    <div className="min-w-0 space-y-3" data-chart="throughput">
      <ChartContainer config={config} className="w-full min-w-0" style={{ height }}>
        <BarChart data={points} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          {TimeAxis({ bucketMs })}
          <YAxis tickLine={false} axisLine={false} width={28} allowDecimals={false} />
          <ChartTooltip
            content={
              <ChartTooltipContent labelFormatter={(_, p) => when(p?.[0]?.payload?.t, bucketMs)} />
            }
          />
          <Bar dataKey="done" stackId="a" fill="var(--color-done)" />
          <Bar dataKey="failed" stackId="a" fill="var(--color-failed)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
      <Legend
        items={[
          { label: t("Tasks verified"), color: "var(--success)", value: String(done) },
          { label: t("Attempts failed"), color: "var(--destructive)", value: String(failed) },
        ]}
      />
    </div>
  );
}

export interface OutcomeRow {
  key: string;
  label: ReactNode;
  title: string;
  succeeded: number;
  failed: number;
  other: number;
}

/**
 * Success and failure per row (a Leg, a task kind): a bar split by outcome,
 * the share verified said beside it, so colour is never alone.
 */
export function OutcomeBars({ rows }: { rows: OutcomeRow[] }) {
  return (
    <div className="space-y-3" data-chart="outcomes">
      <ul className="space-y-2">
        {rows.map((r) => {
          const all = r.succeeded + r.failed + r.other;
          return (
            <li key={r.key} className="min-w-0 space-y-1">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <span className="flex min-w-0 flex-1 items-center gap-1.5" title={r.title}>
                  {r.label}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {all ? t("{p}% of {n}", { p: pct(r.succeeded, all), n: all }) : t("running")}
                </span>
              </div>
              <div
                className="flex h-2 w-full gap-0.5 overflow-hidden rounded-full bg-muted"
                title={t("{s} verified, {f} failed, {o} handed on or stopped", {
                  s: r.succeeded,
                  f: r.failed,
                  o: r.other,
                })}
              >
                {(
                  [
                    [r.succeeded, "var(--success)"],
                    [r.failed, "var(--destructive)"],
                    [r.other, "var(--muted-foreground)"],
                  ] as const
                ).map(([n, color]) =>
                  n ? (
                    <span
                      key={color}
                      className="h-full"
                      style={{ width: `${(n / all) * 100}%`, backgroundColor: color }}
                    />
                  ) : null,
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <Legend
        items={[
          { label: t("Verified"), color: "var(--success)" },
          { label: t("Failed"), color: "var(--destructive)" },
          { label: t("Handed on or stopped"), color: "var(--muted-foreground)" },
        ]}
      />
    </div>
  );
}

/** Each Leg side by side: success, tokens per verified task, time per verified task. */
export function LegPerformance({ rows }: { rows: ChartsData["byLeg"] }) {
  return (
    <div className="space-y-2" data-chart="leg-performance">
      {rows.map((r) => {
        const all = r.succeeded + r.failed + r.other;
        return (
          <div
            key={r.legId}
            className="grid min-w-0 grid-cols-3 gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-xs"
          >
            <div className="col-span-3 flex min-w-0 items-center gap-2 font-medium">
              <LegAvatar leg={{ name: r.leg, kind: r.kind }} size="xs" />
              <span className="truncate">{r.leg}</span>
            </div>
            <div className="min-w-0">
              <div className="truncate text-muted-foreground">{t("Success")}</div>
              <div className="tabular-nums">{all ? `${pct(r.succeeded, all)}%` : "—"}</div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-muted-foreground">{t("Tokens / task")}</div>
              <div className="tabular-nums">
                {r.tokensPerVerified === null ? "—" : fmtTokens(r.tokensPerVerified)}
              </div>
            </div>
            <div className="min-w-0">
              <div className="truncate text-muted-foreground">{t("Time / task")}</div>
              <div className="tabular-nums">
                {r.msPerVerified === null ? "—" : span(r.msPerVerified)}
              </div>
            </div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        {t("Per task verified, counting the attempts that failed or were handed on.")}
      </p>
    </div>
  );
}

/** Tokens used so far against the limit, over time. */
export function BurnChart({
  burn,
  bucketMs,
  height = 180,
}: {
  burn: NonNullable<ChartsData["burn"]>;
  bucketMs: number;
  height?: number;
}) {
  const config: ChartConfig = { used: { label: t("Tokens used"), color: "var(--chart-1)" } };
  const top = Math.max(burn.used, burn.limit ?? 0) * 1.08 || 1;
  const limitColor = burn.hard ? "var(--destructive)" : "var(--warning)";
  // A single point is drawn from nothing, so it reads as a step and not a dot.
  const first = burn.points[0];
  const data =
    burn.points.length === 1 && first ? [{ t: first.t - bucketMs, used: 0 }, first] : burn.points;
  return (
    <div className="min-w-0 space-y-3" data-chart="burn">
      <ChartContainer config={config} className="w-full min-w-0" style={{ height }}>
        <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          {TimeAxis({ bucketMs })}
          <YAxis
            tickLine={false}
            axisLine={false}
            width={44}
            domain={[0, top]}
            tickFormatter={(v) => fmtTokens(v)}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent labelFormatter={(_, p) => when(p?.[0]?.payload?.t, bucketMs)} />
            }
          />
          {burn.limit !== null ? (
            <ReferenceLine y={burn.limit} stroke={limitColor} strokeDasharray="4 4" />
          ) : null}
          <Area
            dataKey="used"
            type="stepAfter"
            fill="var(--color-used)"
            stroke="var(--color-used)"
            fillOpacity={0.25}
            strokeWidth={2}
          />
        </AreaChart>
      </ChartContainer>
      <Legend
        items={[
          { label: t("Tokens used"), color: "var(--chart-1)", value: fmtTokens(burn.used) },
          ...(burn.limit !== null
            ? [
                {
                  label: burn.hard ? t("Hard limit") : t("Alarm"),
                  color: limitColor,
                  value: `${fmtTokens(burn.limit)} · ${pct(burn.used, burn.limit)}%`,
                },
              ]
            : []),
        ]}
      />
      {burn.limit === null ? (
        <p className="text-xs text-muted-foreground">{t("No token limit is set.")}</p>
      ) : null}
    </div>
  );
}

/** Money spent over time; only shown once a Leg counts money. */
export function CostChart({
  money,
  bucketMs,
  height = 160,
}: {
  money: ChartsData["money"];
  bucketMs: number;
  height?: number;
}) {
  const config: ChartConfig = { money: { label: t("Spent"), color: "var(--chart-2)" } };
  return (
    <div className="min-w-0 space-y-3" data-chart="cost">
      <ChartContainer config={config} className="w-full min-w-0" style={{ height }}>
        <BarChart data={money.points} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          {TimeAxis({ bucketMs })}
          <YAxis tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `$${v}`} />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="money" fill="var(--color-money)" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
      <div className="text-xs text-muted-foreground">
        {t("{n} spent", { n: `$${money.total.toFixed(2)}` })}
      </div>
    </div>
  );
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent className="min-w-0">{children}</CardContent>
    </Card>
  );
}

/** The charts for a scope, from its numbers; each says when there is nothing yet. */
export function ChartsView({ data, burnTitle }: { data: ChartsData; burnTitle?: string }) {
  const none = <div className="text-sm text-muted-foreground">{t("Nothing yet.")}</div>;
  const unit = data.bucketMs >= 86400_000 ? t("per day") : t("per hour");
  return (
    <div className="grid min-w-0 gap-3 lg:grid-cols-2" data-testid="stats-charts">
      {data.burn ? (
        <ChartCard title={burnTitle ?? t("Budget burn")}>
          {data.burn.points.length ? <BurnChart burn={data.burn} bucketMs={data.bucketMs} /> : none}
        </ChartCard>
      ) : null}
      {data.money.total > 0 ? (
        <ChartCard title={t("Cost")}>
          <CostChart money={data.money} bucketMs={data.bucketMs} />
        </ChartCard>
      ) : null}
      <ChartCard title={t("Tasks done, {unit}", { unit })}>
        {data.throughput.length ? (
          <ThroughputChart points={data.throughput} bucketMs={data.bucketMs} />
        ) : (
          none
        )}
      </ChartCard>
      <ChartCard title={t("Success and failure by Leg")}>
        {data.byLeg.length ? (
          <OutcomeBars
            rows={data.byLeg.map((r) => ({
              ...r,
              key: r.legId,
              title: `${r.leg} (${r.kind})`,
              label: (
                <>
                  <LegAvatar leg={{ name: r.leg, kind: r.kind }} size="xs" />
                  <span className="truncate">{r.leg}</span>
                </>
              ),
            }))}
          />
        ) : (
          none
        )}
      </ChartCard>
      <ChartCard title={t("Success and failure by task kind")}>
        {data.byKind.length ? (
          <OutcomeBars
            rows={data.byKind.map((r) => ({
              ...r,
              key: r.kind,
              title: r.kind,
              label: <span className="truncate">{r.kind}</span>,
            }))}
          />
        ) : (
          none
        )}
      </ChartCard>
      <ChartCard title={t("Legs compared")}>
        {data.byLeg.length ? <LegPerformance rows={data.byLeg} /> : none}
      </ChartCard>
    </div>
  );
}

/** The charts of a job, a project or everything, live. */
export function StatsCharts({
  jobId,
  projectId,
  since = 0,
  bucketMs,
  topics,
  burnTitle,
}: {
  jobId?: string;
  projectId?: string;
  since?: number;
  bucketMs: number;
  topics: string[];
  burnTitle?: string;
}) {
  const c = useLive(() => api.stats.charts({ jobId, projectId, since, bucketMs }), {
    topics,
    refreshOn: (e) =>
      e.type === "task.state" || e.type === "session.ended" || e.type.startsWith("job."),
    deps: [jobId, projectId, bucketMs],
  });
  if (c.error) return <ErrorNote error={c.error} />;
  if (!c.data) return <Loading rows={2} />;
  return <ChartsView data={c.data} burnTitle={burnTitle} />;
}
