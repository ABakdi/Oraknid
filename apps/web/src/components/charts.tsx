import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart";
import { tokens as fmtTokens } from "@/lib/format";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const key = (s: string) => s.replace(/[^a-zA-Z0-9]/g, "_");

/** Tokens over time, stacked by Leg model (Web-UI → Charts). */
export function TokensChart({
  buckets,
  height = 220,
}: {
  buckets: { t: number; series: string; tokens: number }[];
  height?: number;
}) {
  const series = [...new Set(buckets.map((b) => b.series))];
  const byT = new Map<number, Record<string, number>>();
  for (const b of buckets) {
    const row = byT.get(b.t) ?? { t: b.t };
    row[key(b.series)] = (row[key(b.series)] ?? 0) + b.tokens;
    byT.set(b.t, row);
  }
  const data = [...byT.values()].sort((a, b) => (a.t as number) - (b.t as number));
  const config: ChartConfig = Object.fromEntries(
    series.map((s, i) => [key(s), { label: s, color: COLORS[i % COLORS.length] }]),
  );
  const totals = series
    .map((s, i) => ({
      s,
      color: COLORS[i % COLORS.length] as string,
      n: buckets.filter((b) => b.series === s).reduce((x, b) => x + b.tokens, 0),
    }))
    .sort((a, b) => b.n - a.n);
  return (
    <div className="min-w-0 space-y-3">
      <ChartContainer config={config} className="w-full min-w-0" style={{ height }}>
        <AreaChart data={data} margin={{ left: 0, right: 8, top: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="t"
            tickLine={false}
            axisLine={false}
            minTickGap={32}
            tickFormatter={(v) =>
              new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            }
          />
          <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmtTokens(v)} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(_, p) => new Date(p?.[0]?.payload?.t).toLocaleString()}
              />
            }
          />
          {series.map((s) => (
            <Area
              key={s}
              dataKey={key(s)}
              stackId="a"
              type="monotone"
              fill={`var(--color-${key(s)})`}
              stroke={`var(--color-${key(s)})`}
              fillOpacity={0.35}
            />
          ))}
        </AreaChart>
      </ChartContainer>
      {/* Its own legend: a Leg per line, its model under it, its total; nothing runs off a phone's edge. */}
      <ul className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
        {totals.map(({ s, color, n }) => {
          const [leg, model] = s.split(" · ");
          return (
            <li key={s} className="flex min-w-0 items-center gap-2" title={s}>
              <span
                className="size-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: color }}
              />
              <span className="min-w-0 flex-1 truncate">
                {leg}
                {model ? <span className="text-muted-foreground"> · {model}</span> : null}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{fmtTokens(n)}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Success and tokens per Leg model, side by side (Leg performance comparison). */
export function LegComparison({
  rows,
}: {
  rows: { series: string; tokens: number; attempts: number; successes: number }[];
}) {
  const data = rows.map((r) => ({
    series: r.series,
    success: r.attempts ? Math.round((r.successes / r.attempts) * 100) : 0,
    tokens: r.tokens,
  }));
  const config: ChartConfig = { success: { label: "Success %", color: "var(--chart-5)" } };
  return (
    <ChartContainer
      config={config}
      className="w-full min-w-0"
      style={{ height: Math.max(120, rows.length * 36) }}
    >
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16 }}>
        <XAxis type="number" domain={[0, 100]} hide />
        <YAxis type="category" dataKey="series" width={150} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Bar dataKey="success" fill="var(--color-success)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}

/** A tiny line for resource cards. */
export function Sparkline({
  values,
  color = "var(--chart-1)",
  height = 32,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  const data = values.map((v, i) => ({ i, v }));
  return (
    <ChartContainer
      config={{ v: { label: "", color } }}
      className="w-full min-w-0"
      style={{ height, aspectRatio: "auto" }}
    >
      <LineChart data={data} margin={{ top: 2, bottom: 2, left: 0, right: 0 }}>
        <YAxis hide domain={[0, "auto"]} />
        <Line dataKey="v" stroke={color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    </ChartContainer>
  );
}
