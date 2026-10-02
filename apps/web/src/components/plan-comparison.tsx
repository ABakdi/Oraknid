import type { PlanComparison } from "@oraknid/contracts";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const pct = (x: number) => `${Math.round(x * 100)}%`;
const secs = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

/**
 * A job's plans beside its shadow planner's (ADR-022), and how the plans
 * that ran fared. Shown once a shadow planned the job.
 */
export function PlanComparisonCard({ jobId }: { jobId: string }) {
  const c = useLive(() => api.jobs.planComparisons({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "eye.planned" || e.type === "task.state",
    deps: [jobId],
  });
  const pairs = (c.data?.comparisons ?? []).filter((p) => p.plans.some((x) => x.role === "shadow"));
  if (!c.data || pairs.length === 0) return null;
  const o = c.data.outcome;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("Plans compared")}</CardTitle>
        <CardDescription>
          {t(
            "The plan that ran, beside the shadow planner's for the same job. It ran: {done} of {total} tasks done, {attempts} attempts, {repaired} checks repaired, {replans} replans.",
            {
              done: o.tasksDone,
              total: o.tasksTotal,
              attempts: o.attempts,
              repaired: o.checksRepaired,
              replans: o.replans,
            },
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pairs.map((pair) => (
          <Pair key={pair.pairId} pair={pair} />
        ))}
      </CardContent>
    </Card>
  );
}

function Pair({ pair }: { pair: PlanComparison }) {
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground">
        {pair.call === "plan" ? t("The plan") : t("A replan")} ·{" "}
        {new Date(pair.at).toLocaleString()}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {pair.plans.map((p) => (
          <div key={p.role} className="min-w-0 space-y-1.5 rounded-md border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={p.role === "primary" ? "default" : "outline"}>
                {p.role === "primary" ? t("ran") : t("shadow")}
              </Badge>
              <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{p.model}</span>
            </div>
            {p.error ? (
              <div className="text-destructive [overflow-wrap:anywhere]">{p.error}</div>
            ) : p.measures ? (
              <>
                <div className="grid grid-cols-2 gap-x-3 text-xs text-muted-foreground">
                  <span>{t("{n} tasks", { n: p.measures.tasks })}</span>
                  <span>{t("chain of {n}", { n: p.measures.depth })}</span>
                  <span>{t("{p} with checks", { p: pct(p.measures.withChecks) })}</span>
                  <span>{t("{n} checks a task", { n: p.measures.checksPerTask.toFixed(1) })}</span>
                  <span>{secs(p.ms)}</span>
                  <span>{p.firstTry ? t("valid first time") : t("needed a second try")}</span>
                </div>
                <ol className="list-decimal space-y-0.5 pl-5 text-xs [overflow-wrap:anywhere]">
                  {p.titles.map((title, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: titles can repeat; order is the identity
                    <li key={i}>{title}</li>
                  ))}
                </ol>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
