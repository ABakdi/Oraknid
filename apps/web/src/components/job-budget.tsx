import type { JobView, ProjectBudget } from "@oraknid/contracts";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { LegComparison, TokensChart } from "@/components/charts";
import { Loading, Stat } from "@/components/common";
import { StatsCharts } from "@/components/stats-charts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/lib/api";
import { tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act } from "@/lib/links";
import { useLive } from "@/lib/live";

// Budgets and their burn (Budgets-and-Quotas): a job's, and a project's
// across its jobs (ADR-034).

/** A job's budget against what it used (Budgets-and-Quotas). */
export function JobBudget({ job }: { job: JobView }) {
  const s = useLive(() => api.stats.summary({ jobId: job.id }), {
    topics: [`job:${job.id}`],
    refreshOn: (e) => e.type === "session.usage",
    deps: [job.id],
  });
  const used = s.data?.tokens ?? 0;
  const elapsed = job.startedAt ? (job.finishedAt ?? Date.now()) - job.startedAt : 0;
  const b = job.budget;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <Stat
        label={t("Tokens")}
        value={tokens(used)}
        hint={
          b.tokens
            ? t("of {n} ({kind})", {
                n: tokens(b.tokens.limit),
                kind: b.tokens.hard ? t("hard") : t("alarm"),
              })
            : t("no limit")
        }
      />
      <Stat
        label={t("Time")}
        value={`${Math.floor(elapsed / 3600_000)}h ${Math.round((elapsed % 3600_000) / 60_000)}m`}
        hint={
          b.wallClockMs
            ? t("{kind} at {h} h", {
                kind: b.wallClockMs.hard ? t("stop") : t("alarm"),
                h: b.wallClockMs.limit / 3600_000,
              })
            : t("no limit")
        }
      />
      <Stat
        label={t("Money")}
        value={b.money.limit > 0 ? `$${b.money.limit}` : t("None")}
        hint={b.money.limit > 0 ? t("may be spent") : t("nothing may be spent")}
      />
      <Stat
        label={t("Quota share")}
        value={b.quotaShare ? `${Math.round(b.quotaShare.limit * 100)}%` : "100%"}
        hint={t("of any Leg's quota window")}
      />
      {job.state !== "completed" && job.state !== "cancelled" ? (
        <div className="flex items-center sm:col-span-2">
          <BudgetDialog job={job} />
        </div>
      ) : null}
      {job.unsandboxed ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive sm:col-span-3">
          <ShieldAlert className="size-4" />
          {t("This job runs without the sandbox, by your choice.")}
        </div>
      ) : null}
    </div>
  );
}

/** Changing a job's budget at any time (Budgets-and-Quotas). */
function BudgetDialog({ job }: { job: JobView }) {
  const b = job.budget;
  const [open, setOpen] = useState(false);
  const [tok, setTok] = useState(b.tokens ? String(b.tokens.limit) : "");
  const [tokHard, setTokHard] = useState(b.tokens?.hard ?? true);
  const [share, setShare] = useState(
    b.quotaShare ? String(Math.round(b.quotaShare.limit * 100)) : "",
  );
  const [hours, setHours] = useState(b.wallClockMs ? String(b.wallClockMs.limit / 3600_000) : "");
  const [hoursHard, setHoursHard] = useState(b.wallClockMs?.hard ?? false);
  const save = async () => {
    await act(
      () =>
        api.jobs.setBudget({
          id: job.id,
          budget: {
            tokens: tok ? { limit: Number(tok), hard: tokHard } : null,
            quotaShare: share ? { limit: Math.min(100, Number(share)) / 100, hard: true } : null,
            wallClockMs: hours ? { limit: Number(hours) * 3600_000, hard: hoursHard } : null,
            money: b.money,
          },
        }),
      job.state === "paused"
        ? t("Budget changed. Resume the job when you're ready.")
        : t("Budget changed; it applies now."),
    );
    setOpen(false);
  };
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        {t("Change the budget")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("The budget of “{title}”", { title: job.title })}</DialogTitle>
            <DialogDescription>
              {t(
                "Empty means no limit. A hard limit pauses the job and asks you; an alarm only tells you.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="b-tok">{t("Tokens")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="b-tok"
                  inputMode="numeric"
                  placeholder={t("none")}
                  value={tok}
                  onChange={(e) => setTok(digits(e.target.value))}
                />
                <div className="flex shrink-0 items-center gap-1 text-sm">
                  <Switch id="b-tok-hard" checked={tokHard} onCheckedChange={setTokHard} />
                  <Label htmlFor="b-tok-hard">{t("hard")}</Label>
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-share">{t("Most of a Leg's quota window to use (%)")}</Label>
              <Input
                id="b-share"
                inputMode="numeric"
                placeholder="100"
                value={share}
                onChange={(e) => setShare(digits(e.target.value).slice(0, 3))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="b-hours">{t("Time (hours)")}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="b-hours"
                  inputMode="decimal"
                  placeholder={t("none")}
                  value={hours}
                  onChange={(e) => setHours(digits(e.target.value))}
                />
                <div className="flex shrink-0 items-center gap-1 text-sm">
                  <Switch id="b-hours-hard" checked={hoursHard} onCheckedChange={setHoursHard} />
                  <Label htmlFor="b-hours-hard">{t("hard")}</Label>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t("Cancel")}
            </Button>
            <Button onClick={save}>{t("Save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** A job's numbers and charts. */
export function JobStats({ jobId }: { jobId: string }) {
  const s = useLive(() => api.stats.summary({ jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "session.ended" || e.type === "task.state",
    deps: [jobId],
  });
  const buckets = useLive(() => api.stats.tokens({ jobId, since: 0, bucketMs: 15 * 60_000 }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "session.usage",
  });
  if (!s.data) return <Loading />;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label={t("Tasks done")} value={`${s.data.tasks.done}/${s.data.tasks.total}`} />
        <Stat label={t("Attempts")} value={s.data.attempts} />
        <Stat
          label={t("Success")}
          value={s.data.successRate === null ? "—" : `${Math.round(s.data.successRate * 100)}%`}
        />
        <Stat label={t("Tokens")} value={tokens(s.data.tokens)} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Tokens over time")}</CardTitle>
        </CardHeader>
        <CardContent>
          {(buckets.data ?? []).length ? (
            <TokensChart buckets={buckets.data ?? []} />
          ) : (
            <div className="text-sm text-muted-foreground">{t("No sessions yet.")}</div>
          )}
        </CardContent>
      </Card>
      {s.data.byLeg.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("By Leg model")}</CardTitle>
          </CardHeader>
          <CardContent>
            <LegComparison rows={s.data.byLeg} />
          </CardContent>
        </Card>
      ) : null}
      <StatsCharts
        jobId={jobId}
        bucketMs={3600_000}
        topics={[`job:${jobId}`]}
        burnTitle={t("The job's budget burn")}
      />
    </div>
  );
}

const digits = (v: string) => v.replace(/[^\d.]/g, "");

/**
 * A project's budget across its jobs (ADR-034): what its jobs used against
 * its limits, and the default a new job in it starts with. Editable here.
 */
export function ProjectBudgetCard({ projectId, jobIds }: { projectId: string; jobIds: string[] }) {
  const view = useLive(() => api.projects.budget({ id: projectId }), {
    topics: ["overview", ...jobIds.map((id) => `job:${id}`)],
    refreshOn: (e) =>
      e.type === "session.usage" || e.type.startsWith("budget.") || e.type === "project.budget",
    deps: [projectId],
  });
  const [open, setOpen] = useState(false);
  if (!view.data) return <Loading rows={2} />;
  const { budget: b, used, asking } = view.data;
  return (
    <Card data-help="project.budget">
      <CardHeader>
        <CardTitle className="text-sm">{t("The project's budget")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {t(
            "Across all of its jobs. A job that would go past a hard limit pauses and asks, like a job's own limit. A new job here starts with these limits.",
          )}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Stat
            label={t("Tokens, all its jobs")}
            value={tokens(used.tokens)}
            hint={
              b.tokens
                ? t("of {n} ({kind})", {
                    n: tokens(b.tokens.limit),
                    kind: b.tokens.hard ? t("hard") : t("alarm"),
                  })
                : t("no limit")
            }
          />
          <Stat
            label={t("Money")}
            value={b.money && b.money.limit > 0 ? `$${b.money.limit}` : t("None")}
            hint={b.money && b.money.limit > 0 ? t("may be spent") : t("nothing may be spent")}
          />
        </div>
        {asking ? (
          <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {t(
              "A job of this project is paused at its limit and waits for your answer in the inbox.",
            )}
          </div>
        ) : null}
        <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
          {t("Change the project's budget")}
        </Button>
        {open ? (
          <ProjectBudgetDialog
            projectId={projectId}
            budget={b}
            onClose={() => {
              setOpen(false);
              view.reload();
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProjectBudgetDialog({
  projectId,
  budget,
  onClose,
}: {
  projectId: string;
  budget: ProjectBudget;
  onClose: () => void;
}) {
  const [tok, setTok] = useState(budget.tokens ? String(budget.tokens.limit) : "");
  const [tokHard, setTokHard] = useState(budget.tokens?.hard ?? true);
  const [money, setMoney] = useState(budget.money ? String(budget.money.limit) : "");
  const save = async () => {
    await act(
      () =>
        api.projects.setBudget({
          id: projectId,
          budget: {
            tokens: tok ? { limit: Number(tok), hard: tokHard } : null,
            money: money && Number(money) > 0 ? { limit: Number(money), hard: true } : null,
          },
        }),
      t("The project's budget changed; it applies now, and to its next jobs."),
    );
    onClose();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("The project's budget")}</DialogTitle>
          <DialogDescription>
            {t(
              "Across all of its jobs. Empty means no limit. A hard limit pauses its jobs and asks you; an alarm only tells you.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pb-tok">{t("Tokens")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="pb-tok"
                inputMode="numeric"
                placeholder={t("none")}
                value={tok}
                onChange={(e) => setTok(digits(e.target.value))}
              />
              <div className="flex shrink-0 items-center gap-1 text-sm">
                <Switch id="pb-tok-hard" checked={tokHard} onCheckedChange={setTokHard} />
                <Label htmlFor="pb-tok-hard">{t("hard")}</Label>
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pb-money">{t("Money (US dollars)")}</Label>
            <Input
              id="pb-money"
              inputMode="decimal"
              placeholder="0"
              value={money}
              onChange={(e) => setMoney(digits(e.target.value))}
            />
            <div className="text-xs text-muted-foreground">
              {t("Only paid Legs spend money; none is spent unless you allow it here.")}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={save}>{t("Save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
