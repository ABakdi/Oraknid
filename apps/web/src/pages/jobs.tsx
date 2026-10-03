import { Plus } from "lucide-react";
import { Link } from "wouter";
import { Empty, ErrorNote, Loading, PageHeader, StateBadge } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

export function JobsPage() {
  const jobs = useLive(() => api.jobs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("job.") || e.type === "task.state",
  });
  const add = (
    <Button asChild className="gap-1">
      <Link href="/new">
        <Plus className="size-4" />
        {t("New work")}
      </Link>
    </Button>
  );
  if (jobs.error) return <ErrorNote error={jobs.error} />;
  if (jobs.loading) return <Loading />;
  const list = [...(jobs.data ?? [])].reverse();
  return (
    <div>
      <PageHeader
        title={t("Jobs")}
        sub={t("Newest first. A draft opens where you left it.")}
        actions={add}
      />
      {list.length === 0 ? (
        <Empty title={t("No jobs yet")} action={add}>
          {t(
            "A job is a goal Oraknid runs to verified completion: give it a project, a goal and a method.",
          )}
        </Empty>
      ) : (
        <div className="divide-y rounded-xl border bg-card">
          {list.map((j) => {
            const done = j.tasks.filter((x) => x.state === "done" || x.state === "skipped").length;
            return (
              <Link
                key={j.id}
                href={j.state === "draft" ? `/new/${j.id}` : `/jobs/${j.id}`}
                className="flex flex-wrap items-center gap-3 px-3 py-3 hover:bg-accent/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium" title={j.title}>
                    {j.title}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {j.blockedReason ??
                      j.pauseReason ??
                      t("started {when}", { when: j.startedAt ? ago(j.startedAt) : t("not yet") })}
                  </div>
                </div>
                <div className="flex w-full items-center gap-2 sm:w-56">
                  <Progress
                    value={j.tasks.length ? (done / j.tasks.length) * 100 : 0}
                    className="h-1.5"
                  />
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {done}/{j.tasks.length}
                  </span>
                </div>
                <StateBadge state={j.state} />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
