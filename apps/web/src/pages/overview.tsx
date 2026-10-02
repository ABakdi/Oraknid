import type { Event } from "@oraknid/contracts";
import { AlertTriangle, Bot, Cpu, HardDrive, MemoryStick, Network } from "lucide-react";
import { Link } from "wouter";
import { Sparkline, TokensChart } from "@/components/charts";
import { Empty, ErrorNote, Loading, PageHeader, Stat, StateBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { ago, bytes, clock, tokens, until } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useEvents, useLive, useMetrics } from "@/lib/live";

const midnight = () => new Date(new Date().setHours(0, 0, 0, 0)).getTime();

export function OverviewPage() {
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg.") || e.type.startsWith("session."),
  });
  const activity = useLive(() => api.stats.activity(), {
    topics: ["overview"],
    refreshOn: (e) =>
      e.type.startsWith("session.") || e.type === "job.state" || e.type === "task.state",
  });
  const jobs = useLive(() => api.jobs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  const today = useLive(() => api.stats.tokens({ since: midnight(), bucketMs: 3600_000 }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("session."),
  });
  const inbox = useLive(() => api.inbox.list({ state: "open" }), { topics: ["inbox"] });
  const seed = useLive(() => api.audit.search({ limit: 60 }), { topics: [] });
  const activeJobs = (jobs.data ?? []).filter(
    (j) => !["completed", "cancelled", "draft"].includes(j.state),
  );
  const stream = useEvents(
    ["overview", "inbox", ...activeJobs.map((j) => `job:${j.id}`)],
    150,
    seed.data ?? [],
  );
  const metrics = useMetrics(() => api.metrics.recent({ since: Date.now() - 10 * 60_000 }));

  if (legs.error) return <ErrorNote error={legs.error} />;
  if (legs.loading) return <Loading rows={6} />;

  if ((legs.data ?? []).length === 0) {
    return (
      <div className="mx-auto max-w-xl pt-8">
        <Empty
          title={t("Add your first Leg")}
          action={
            <Button asChild>
              <Link href="/legs">{t("Add a Leg")}</Link>
            </Button>
          }
        >
          {t(
            "A Leg is an agent account or a local model Oraknid can hand work to: a Claude Code login, an Ollama server… Oraknid needs at least one.",
          )}
        </Empty>
      </div>
    );
  }

  const tokensToday = (today.data ?? []).reduce((n, b) => n + b.tokens, 0);
  const problems = stream.filter(isProblem).slice(0, 8);
  const last = metrics.at(-1);

  return (
    <div className="space-y-4">
      <PageHeader title={t("Overview")} sub={t("{n} job(s) active", { n: activeJobs.length })} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t("Tokens today")} value={tokens(tokensToday)} />
        <Stat
          label={t("Jobs running")}
          value={activeJobs.filter((j) => j.state === "running").length}
          hint={t("{n} waiting or paused", {
            n: activeJobs.filter((j) => j.state !== "running").length,
          })}
        />
        <Stat
          label={t("Inbox")}
          value={inbox.data?.length ?? 0}
          hint={inbox.data?.length ? t("needs you") : t("nothing waiting")}
        />
        <Stat
          label={t("Legs")}
          value={`${(legs.data ?? []).filter((l) => l.health === "healthy").length}/${legs.data?.length ?? 0}`}
          hint={t("healthy")}
        />
      </div>

      <section aria-label={t("Legs now")}>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">{t("Legs now")}</h2>
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {(legs.data ?? []).map((leg) => {
            const doing = (activity.data ?? []).filter((a) => a.legId === leg.id);
            return (
              <Card key={leg.id} className="min-w-0 gap-2 py-3">
                <CardHeader className="px-3">
                  <CardTitle className="flex items-center gap-2 text-sm">
                    <Bot className="size-4 shrink-0" />
                    <Link href={`/legs/${leg.id}`} className="truncate hover:underline">
                      {leg.name}
                    </Link>
                    <span className="flex-1" />
                    <StateBadge state={leg.paused ? "paused" : leg.health} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 px-3 text-xs">
                  {doing.length ? (
                    doing.map((a) => (
                      <div key={a.sessionId} className="flex items-center gap-2">
                        <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                        <span className="truncate">
                          {a.eye ? (
                            t("thinking for The Eye")
                          ) : a.task ? (
                            <Link href={`/jobs/${a.jobId}`}>{a.task}</Link>
                          ) : (
                            t("working")
                          )}
                        </span>
                        <span className="ml-auto shrink-0 text-muted-foreground">
                          {a.model}
                          {a.effort ? ` · ${a.effort}` : ""}
                        </span>
                      </div>
                    ))
                  ) : (
                    <div className="text-muted-foreground">
                      {leg.health === "healthy" ? t("idle") : (leg.healthDetail ?? "")}
                    </div>
                  )}
                  {[...leg.quota, ...leg.models.flatMap((m) => m.quota)].map((w) => (
                    <div key={w.name} className="space-y-1">
                      <div className="flex justify-between text-muted-foreground">
                        <span>
                          {w.name}
                          {w.estimated ? ` (${t("estimated")})` : ""}
                        </span>
                        <span>
                          {w.utilization === null
                            ? t("no figure yet")
                            : t("{n}% used", { n: Math.round(w.utilization * 100) })}
                          {w.resetsAt ? ` · ${t("resets")} ${until(w.resetsAt)}` : ""}
                        </span>
                      </div>
                      <Progress value={(w.utilization ?? 0) * 100} className="h-1" />
                    </div>
                  ))}
                  {doing[0]?.contextTokens ? (
                    <div className="text-muted-foreground">
                      {t("Context: {n}", { n: tokens(doing[0].contextTokens) })}
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* min-w-0: a grid cell may shrink below its content, so nothing pushes past a phone's width. */}
      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="min-w-0 xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm">{t("Activity")}</CardTitle>
          </CardHeader>
          <CardContent className="max-h-96 space-y-1 overflow-y-auto font-mono text-xs">
            {stream.length === 0 ? (
              <div className="text-muted-foreground">{t("Nothing yet.")}</div>
            ) : null}
            {stream.slice(0, 120).map((e) => (
              <div key={e.seq} className="flex flex-wrap gap-x-2">
                <span className="shrink-0 text-muted-foreground">{clock(e.at)}</span>
                <span className="shrink-0 text-primary">{e.type}</span>
                <span className="min-w-0 basis-full text-muted-foreground [overflow-wrap:anywhere] sm:basis-0 sm:flex-1">
                  {describe(e)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">
                <AlertTriangle className="size-4" />
                {t("Problems")}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-sm">
              {problems.length === 0 ? (
                <div className="text-muted-foreground">{t("None.")}</div>
              ) : null}
              {problems.map((e) => (
                <Link
                  key={e.seq}
                  href={e.jobId ? `/jobs/${e.jobId}` : "/logs"}
                  className="block rounded px-1 hover:bg-accent"
                >
                  <div className="truncate">{describe(e)}</div>
                  <div className="text-xs text-muted-foreground">
                    {e.type} · {ago(e.at)}
                  </div>
                </Link>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">{t("Resources")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              {last ? (
                <>
                  <Resource
                    icon={Cpu}
                    label={t("CPU")}
                    value={`${last.system.cpuPercent}%`}
                    values={metrics.map((m) => m.system.cpuPercent)}
                  />
                  <Resource
                    icon={MemoryStick}
                    label={t("Memory")}
                    value={`${bytes(last.system.memoryUsedBytes)} / ${bytes(last.system.memoryTotalBytes)}`}
                    values={metrics.map((m) => m.system.memoryUsedBytes)}
                  />
                  <Resource
                    icon={HardDrive}
                    label={t("Disk")}
                    value={`${bytes(last.system.diskReadBytesPerSec)}/s ↓ ${bytes(last.system.diskWriteBytesPerSec)}/s ↑`}
                    values={metrics.map(
                      (m) => m.system.diskWriteBytesPerSec + m.system.diskReadBytesPerSec,
                    )}
                  />
                  <Resource
                    icon={Network}
                    label={t("Network")}
                    value={`${bytes(last.system.netRxBytesPerSec)}/s ↓ ${bytes(last.system.netTxBytesPerSec)}/s ↑`}
                    values={metrics.map(
                      (m) => m.system.netRxBytesPerSec + m.system.netTxBytesPerSec,
                    )}
                  />
                  {last.gpus.map((g) => (
                    <Resource
                      key={g.index}
                      icon={Cpu}
                      label={`${g.name}`}
                      value={`${g.utilizationPercent}% · ${bytes(g.memoryUsedBytes)} / ${bytes(g.memoryTotalBytes)}`}
                      values={metrics.map((m) => m.gpus[g.index]?.utilizationPercent ?? 0)}
                    />
                  ))}
                  <div className="pt-1 text-muted-foreground">{t("Processes")}</div>
                  {last.processes.map((p) => (
                    <div key={p.id} className="flex min-w-0 justify-between gap-2">
                      <span className="min-w-0 truncate">{p.label}</span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {p.cpuPercent}% · {bytes(p.rssBytes)}
                        {p.vramBytes ? ` · VRAM ${bytes(p.vramBytes)}` : ""}
                      </span>
                    </div>
                  ))}
                </>
              ) : (
                <div className="text-muted-foreground">{t("Waiting for the first sample…")}</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="min-w-0">
        <CardHeader>
          <CardTitle className="text-sm">{t("Tokens today, by Leg")}</CardTitle>
        </CardHeader>
        <CardContent>
          {(today.data ?? []).length ? (
            <TokensChart buckets={today.data ?? []} />
          ) : (
            <div className="text-sm text-muted-foreground">{t("No tokens used today.")}</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Resource({
  icon: Icon,
  label,
  value,
  values,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  values: number[];
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
      <div className="col-span-2 min-w-0">
        <Sparkline values={values.slice(-120)} />
      </div>
    </div>
  );
}

export function isProblem(e: Event): boolean {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  return (
    e.type === "job.error" ||
    e.type === "task.drift" ||
    e.type === "budget.reached" ||
    e.type === "job.suspicious-input" ||
    e.type === "job.safe-point-overdue" ||
    (e.type === "job.state" && p.to === "blocked") ||
    (e.type === "session.ended" && (p.reason === "crashed" || p.reason === "rate-limited")) ||
    (e.type === "leg.health" && (p.to === "unavailable" || p.to === "rate-limited"))
  );
}

/** One line per event, in words where the payload allows. */
export function describe(e: Event): string {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  if (typeof p.text === "string") return p.text;
  if (typeof p.message === "string") return p.message;
  if (typeof p.title === "string") return p.title;
  if (typeof p.evidence === "string") return `${p.code}: ${p.evidence} → ${p.step}`;
  if (typeof p.reason === "string" && p.to) return `→ ${p.to}: ${p.reason}`;
  if (p.to) return `→ ${String(p.to)}`;
  if (typeof p.detail === "string") return p.detail;
  if (typeof p.tool === "string")
    return `${p.tool} ${typeof p.input === "object" && p.input && "command" in p.input ? String((p.input as { command: string }).command) : ""}`;
  return "";
}
