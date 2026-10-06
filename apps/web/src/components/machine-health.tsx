import type { MachineHealth } from "@oraknid/contracts";
import { AlertTriangle, Gauge } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// Parallel by default, admitted by resources (ADR-050): tasks at once, why
// a ready task waits, and the computer in danger, said plainly.

const RUNNING = ["assigned", "running", "verifying"];

/** "4 tasks running at once · 2 waiting: waiting for memory…" for a job's tasks; null when none runs or waits. */
export function atOnceLine(
  tasks: { state: string; waitingReason?: string | null }[],
): { running: string; waiting: string | null } | null {
  const running = tasks.filter((x) => RUNNING.includes(x.state)).length;
  const waiting = tasks.filter((x) => x.waitingReason);
  if (!running && !waiting.length) return null;
  return {
    running:
      running === 1
        ? t("1 task running")
        : running > 1
          ? t("{n} tasks running at once", { n: running })
          : t("No task running"),
    waiting: waiting.length
      ? waiting.length === 1
        ? t("1 waiting: {why}", { why: waiting[0]?.waitingReason ?? "" })
        : t("{n} waiting: {why}", { n: waiting.length, why: waiting[0]?.waitingReason ?? "" })
      : null,
  };
}

/** A job's tasks at once, in its header. */
export function TasksAtOnce({
  tasks,
}: {
  tasks: { state: string; waitingReason?: string | null }[];
}) {
  const line = atOnceLine(tasks);
  if (!line) return null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1" data-testid="tasks-at-once">
      <Gauge className="size-3.5 shrink-0" />
      <span>{line.running}</span>
      {line.waiting ? (
        <span className="truncate" title={line.waiting}>
          · {line.waiting}
        </span>
      ) : null}
    </span>
  );
}

const useHealth = () =>
  useLive(() => api.machine.health(), {
    topics: ["overview"],
    refreshOn: (e) =>
      e.type.startsWith("machine.") ||
      e.type === "settings.updated" ||
      e.type === "job.state" ||
      e.type === "task.state",
  });

/** Across every page: the computer in danger, what is happening and what Oraknid did. */
export function MachineBanner() {
  const health = useHealth().data;
  return <DangerBanner health={health} />;
}

export function DangerBanner({ health }: { health: MachineHealth | undefined }) {
  if (health?.state !== "danger") return null;
  const incidents = health.incidents.filter((i) => i.level === "danger");
  return (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/60 bg-destructive/10 px-3 py-2 text-sm"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 space-y-1">
        <div className="font-medium">{t("Your computer is in danger")}</div>
        {incidents.map((i) => (
          <p key={i.kind} className="[overflow-wrap:anywhere]">
            {i.message}
            {i.did ? <span className="text-muted-foreground"> {i.did}</span> : null}
          </p>
        ))}
      </div>
    </div>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The Overview's health card: the state, tasks at once, anything wrong, what was paused. */
export function MachineHealthCard() {
  const h = useHealth().data;
  return (
    <Card data-help="overview.health">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4" />
          {t("Health")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-sm">
        {h ? <HealthBody h={h} /> : <div className="text-muted-foreground">…</div>}
      </CardContent>
    </Card>
  );
}

export function HealthBody({ h }: { h: MachineHealth }) {
  return (
    <>
      <div
        className={cn(
          "font-medium",
          h.state === "danger" && "text-destructive",
          h.state === "busy" && "text-warning",
        )}
      >
        {h.state === "ok" ? t("All good") : h.state === "busy" ? t("Needs a look") : t("In danger")}
      </div>
      <div className="text-xs text-muted-foreground">
        {t("{n} of at most {max} tasks running at once ({how})", {
          n: h.running,
          max: h.limit,
          how: h.limitIsAuto ? t("decided by this computer") : t("my limit"),
        })}
      </div>
      {h.reading ? (
        <div className="text-xs text-muted-foreground">
          {t("Memory {m} used · CPU {c}", { m: pct(h.reading.memoryUsed), c: pct(h.reading.cpu) })}
          {h.reading.swapUsed !== null ? ` · ${t("swap {s}", { s: pct(h.reading.swapUsed) })}` : ""}
        </div>
      ) : null}
      {h.incidents.map((i) => (
        <div key={i.kind} className="text-xs [overflow-wrap:anywhere]">
          <span className={i.level === "danger" ? "text-destructive" : "text-warning"}>
            {i.message}
          </span>
          {i.did ? <span className="text-muted-foreground"> {i.did}</span> : null}
        </div>
      ))}
      {h.pausedForRoom.length ? (
        <div className="text-xs text-muted-foreground">
          {t("Paused to make room: {list}", {
            list: h.pausedForRoom.map((p) => `“${p.title}”`).join(", "),
          })}
        </div>
      ) : null}
    </>
  );
}
