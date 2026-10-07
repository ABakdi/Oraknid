import type { MetricsSample, ProcessMetrics } from "@oraknid/contracts";
import { Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { MetricChart, Sparkline } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, message } from "@/lib/api";
import { bytes } from "@/lib/format";
import { t } from "@/lib/i18n";

/**
 * Overview → Resources (Web-UI): the computer (CPU, memory, disk I/O,
 * network, each GPU), then per Leg its sessions' processes (CPU, RSS, VRAM,
 * disk I/O), local models and Oraknid's own; every sparkline opens its full
 * chart over a time range.
 */

/** One measure over time: what a sparkline shows, and its full chart. */
export interface Measure {
  id: string;
  label: string;
  value: (s: MetricsSample) => number | null;
  format: (v: number) => string;
}

const pct = (v: number) => `${Math.round(v)}%`;
const rate = (v: number) => `${bytes(v)}/s`;
const procOf = (s: MetricsSample, id: string) => s.processes.find((p) => p.id === id);

export const SYSTEM_MEASURES: Measure[] = [
  { id: "cpu", label: "CPU", value: (s) => s.system.cpuPercent, format: pct },
  { id: "memory", label: "Memory", value: (s) => s.system.memoryUsedBytes, format: bytes },
  {
    id: "disk",
    label: "Disk I/O",
    value: (s) => s.system.diskReadBytesPerSec + s.system.diskWriteBytesPerSec,
    format: rate,
  },
  {
    id: "network",
    label: "Network",
    value: (s) => s.system.netRxBytesPerSec + s.system.netTxBytesPerSec,
    format: rate,
  },
];

export const processMeasures = (p: { id: string; label: string }): Measure[] => [
  {
    id: `proc:${p.id}:cpu`,
    label: `${p.label} · CPU`,
    value: (s) => procOf(s, p.id)?.cpuPercent ?? null,
    format: pct,
  },
  {
    id: `proc:${p.id}:rss`,
    label: `${p.label} · RAM`,
    value: (s) => procOf(s, p.id)?.rssBytes ?? null,
    format: bytes,
  },
];

const gpuMeasures = (g: { index: number; name: string }): Measure[] => [
  {
    id: `gpu:${g.index}`,
    label: `${g.name} · GPU`,
    value: (s) => s.gpus.find((x) => x.index === g.index)?.utilizationPercent ?? null,
    format: pct,
  },
  {
    id: `vram:${g.index}`,
    label: `${g.name} · VRAM`,
    value: (s) => s.gpus.find((x) => x.index === g.index)?.memoryUsedBytes ?? null,
    format: bytes,
  },
];

/** A measure's points, the samples where it has a value. */
export const pointsOf = (samples: MetricsSample[], m: Measure) =>
  samples.flatMap((s) => {
    const v = m.value(s);
    return v === null ? [] : [{ t: s.at, v }];
  });

export interface ProcessGroup {
  key: string;
  name: string;
  processes: ProcessMetrics[];
  cpuPercent: number;
  rssBytes: number;
  vramBytes: number;
  ioBytesPerSec: number;
}

/**
 * The processes per Leg: a Leg session's tree under its Leg, a local model
 * under Local models, the rest (the daemon, checks) under Oraknid.
 */
export function groupProcesses(
  processes: ProcessMetrics[],
  sessions: { sessionId: string; legId: string }[],
  legs: { id: string; name: string }[],
): ProcessGroup[] {
  const legOfSession = new Map(sessions.map((s) => [s.sessionId, s.legId]));
  const legName = new Map(legs.map((l) => [l.id, l.name]));
  const groups = new Map<string, ProcessGroup>();
  for (const p of processes) {
    const leg = legOfSession.get(p.id);
    const [key, name] = leg
      ? [`leg:${leg}`, legName.get(leg) ?? leg]
      : p.id.startsWith("model:")
        ? ["models", "Local models"]
        : ["oraknid", "Oraknid"];
    const g = groups.get(key) ?? {
      key,
      name,
      processes: [],
      cpuPercent: 0,
      rssBytes: 0,
      vramBytes: 0,
      ioBytesPerSec: 0,
    };
    g.processes.push(p);
    g.cpuPercent += p.cpuPercent;
    g.rssBytes += p.rssBytes;
    g.vramBytes += p.vramBytes;
    g.ioBytesPerSec += p.readBytesPerSec + p.writeBytesPerSec;
    groups.set(key, g);
  }
  // The Legs first, the busiest first; Oraknid's own last.
  return [...groups.values()].sort(
    (a, b) =>
      Number(a.key === "oraknid") - Number(b.key === "oraknid") || b.cpuPercent - a.cpuPercent,
  );
}

export function ResourcesCard({
  samples,
  sessions,
  legs,
}: {
  samples: MetricsSample[];
  sessions: { sessionId: string; legId: string }[];
  legs: { id: string; name: string }[];
}) {
  const [open, setOpen] = useState<Measure | null>(null);
  const last = samples.at(-1);
  const spark = (m: Measure) => (
    <button
      type="button"
      className="col-span-2 block w-full min-w-0 cursor-zoom-in rounded outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring"
      aria-label={t("{what}: the full chart", { what: t(m.label) })}
      onClick={() => setOpen(m)}
    >
      <Sparkline
        values={pointsOf(samples, m)
          .map((p) => p.v)
          .slice(-120)}
      />
    </button>
  );
  return (
    <Card data-help="overview.resources">
      <CardHeader>
        <CardTitle className="text-sm">{t("Resources")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {last ? (
          <>
            {SYSTEM_MEASURES.map((m) => {
              const Icon = { cpu: Cpu, memory: MemoryStick, disk: HardDrive, network: Network }[
                m.id as "cpu"
              ];
              const value =
                m.id === "memory"
                  ? `${bytes(last.system.memoryUsedBytes)} / ${bytes(last.system.memoryTotalBytes)}`
                  : m.id === "disk"
                    ? `${rate(last.system.diskReadBytesPerSec)} ↓ ${rate(last.system.diskWriteBytesPerSec)} ↑`
                    : m.id === "network"
                      ? `${rate(last.system.netRxBytesPerSec)} ↓ ${rate(last.system.netTxBytesPerSec)} ↑`
                      : m.format(m.value(last) ?? 0);
              return (
                <Row key={m.id} icon={Icon} label={t(m.label)} value={value}>
                  {spark(m)}
                </Row>
              );
            })}
            {last.gpus.map((g) => {
              const [util, vram] = gpuMeasures(g) as [Measure, Measure];
              return (
                <Row
                  key={g.index}
                  icon={Cpu}
                  label={g.name}
                  value={`${g.utilizationPercent}% · VRAM ${bytes(g.memoryUsedBytes)} / ${bytes(g.memoryTotalBytes)}`}
                >
                  {spark(util)}
                  <button
                    type="button"
                    className="col-span-2 text-left text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => setOpen(vram)}
                  >
                    {t("VRAM over time")}
                  </button>
                </Row>
              );
            })}
            <ProcessGroups
              groups={groupProcesses(last.processes, sessions, legs)}
              onOpen={setOpen}
            />
            <div className="text-[11px] text-muted-foreground">
              {t("Network is measured for the whole computer, not per process.")}
            </div>
          </>
        ) : (
          <div className="text-muted-foreground">{t("Waiting for the first sample…")}</div>
        )}
      </CardContent>
      <ChartDialog measure={open} live={samples} onClose={() => setOpen(null)} />
    </Card>
  );
}

function Row({
  icon: Icon,
  label,
  value,
  children,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2">
      <span className="flex min-w-0 items-center gap-1.5 truncate">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {label}
      </span>
      <span className="text-right tabular-nums text-muted-foreground [overflow-wrap:anywhere]">
        {value}
      </span>
      {children}
    </div>
  );
}

function ProcessGroups({
  groups,
  onOpen,
}: {
  groups: ProcessGroup[];
  onOpen: (m: Measure) => void;
}) {
  if (!groups.length) return null;
  return (
    <div className="space-y-2 pt-1" data-testid="process-groups">
      {groups.map((g) => (
        <div key={g.key} className="min-w-0 space-y-0.5">
          <div className="flex min-w-0 justify-between gap-2 font-medium">
            <span className="min-w-0 truncate" title={g.name}>
              {g.key === "oraknid" || g.key === "models" ? t(g.name) : g.name}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round(g.cpuPercent)}% · {bytes(g.rssBytes)}
              {g.vramBytes ? ` · VRAM ${bytes(g.vramBytes)}` : ""}
            </span>
          </div>
          {g.processes.map((p) => {
            const [cpu, rss] = processMeasures(p) as [Measure, Measure];
            const io = p.readBytesPerSec + p.writeBytesPerSec;
            return (
              <div
                key={p.id}
                className="flex min-w-0 items-center justify-between gap-2 pl-3"
                data-testid="process-row"
              >
                <span className="min-w-0 truncate" title={`${p.label} (pid ${p.pid})`}>
                  {p.label}
                  {p.processes > 1 ? (
                    <span className="text-muted-foreground"> ×{p.processes}</span>
                  ) : null}
                </span>
                <span className="flex shrink-0 gap-1.5 tabular-nums text-muted-foreground">
                  <button
                    type="button"
                    className="hover:text-foreground hover:underline"
                    title={t("CPU over time")}
                    onClick={() => onOpen(cpu)}
                  >
                    {Math.round(p.cpuPercent)}%
                  </button>
                  ·
                  <button
                    type="button"
                    className="hover:text-foreground hover:underline"
                    title={t("RAM over time")}
                    onClick={() => onOpen(rss)}
                  >
                    {bytes(p.rssBytes)}
                  </button>
                  {p.vramBytes ? <span>· VRAM {bytes(p.vramBytes)}</span> : null}
                  {io ? (
                    <span title={t("Disk read and written")}>
                      · {rate(p.readBytesPerSec)} ↓ {rate(p.writeBytesPerSec)} ↑
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** How far back the full chart reaches; the daemon keeps the last hour. */
export const RANGES = [
  { minutes: 5, name: "5 min" },
  { minutes: 15, name: "15 min" },
  { minutes: 60, name: "1 hour" },
];

/** A measure's full chart, over a range I pick, from the samples the daemon keeps. */
export function ChartDialog({
  measure,
  live,
  onClose,
}: {
  measure: Measure | null;
  live: MetricsSample[];
  onClose: () => void;
}) {
  const [minutes, setMinutes] = useState(15);
  const [older, setOlder] = useState<MetricsSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!measure) return;
    let gone = false;
    setError(null);
    api.metrics.recent({ since: Date.now() - minutes * 60_000 }).then(
      (s) => !gone && setOlder(s),
      (e) => !gone && setError(message(e)),
    );
    return () => {
      gone = true;
    };
  }, [measure, minutes]);
  // What was fetched, then what arrived live since.
  const since = Date.now() - minutes * 60_000;
  const lastOld = older.at(-1)?.at ?? 0;
  const samples = [...older, ...live.filter((s) => s.at > lastOld)].filter((s) => s.at >= since);
  const points = measure ? pointsOf(samples, measure) : [];
  const now = measure && points.length ? measure.format(points.at(-1)?.v ?? 0) : null;
  return (
    <Dialog open={!!measure} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{measure ? t(measure.label) : ""}</DialogTitle>
          <DialogDescription>
            {now ? t("Now: {value}", { value: now }) : t("No samples in this range.")}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="flex gap-1" aria-label={t("Time range")}>
          {RANGES.map((r) => (
            <Button
              key={r.minutes}
              size="sm"
              variant={r.minutes === minutes ? "default" : "outline"}
              aria-pressed={r.minutes === minutes}
              className="h-8"
              onClick={() => setMinutes(r.minutes)}
            >
              {t(r.name)}
            </Button>
          ))}
        </fieldset>
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        {measure && points.length ? (
          <MetricChart points={points} format={measure.format} label={t(measure.label)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
