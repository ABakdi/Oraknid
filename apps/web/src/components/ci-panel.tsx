import type {
  CiJob,
  CiLogSection,
  CiRun,
  CiRunDetail,
  CiWorkflow,
  GitHubRepoRef,
  ProjectRepo,
  ProjectView,
} from "@oraknid/contracts";
import {
  Ban,
  ChevronLeft,
  Download,
  ExternalLink,
  GitBranch,
  Play,
  RotateCcw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { CiMark, CiPill } from "@/components/ci-badge";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { ago, bytes, until } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// GitHub Actions inside Oraknid (ADR-058): a repository's runs, a run's jobs
// and steps, a job's log by step (the failing step first, searchable), its
// artifacts, and re-running, cancelling or running a workflow by hand.
// Polled while something runs (the daemon asks GitHub with ETags), slower
// when GitHub asked to wait, and not at all while the page is out of sight.

const ALL = "__all__";

/** Reloads every `ms` while the page is in sight; never when `ms` is null. */
function useEvery(reload: () => void, ms: number | null) {
  useEffect(() => {
    if (!ms) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, ms);
    return () => clearInterval(id);
  }, [reload, ms]);
}

/** GitHub refused for its limits: the page asks again a minute later, not sooner. */
const limited = (e: unknown) =>
  !!e && typeof e === "object" && (e as { code?: string }).code === "TOO_MANY_REQUESTS";

/** "1 min 12 s". */
export function duration(ms: number | null): string {
  if (ms === null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return t("{s} s", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("{m} min {s} s", { m, s: s % 60 });
  return t("{h} h {m} min", { h: Math.floor(m / 60), m: m % 60 });
}

/**
 * A repository's runs, or one run when `runId` is given (its address made by
 * `hrefFor`). `branches` are offered first in the branch filter.
 */
export function CiRuns({
  r,
  defaultBranch,
  branches = [],
  runId,
  hrefFor,
}: {
  r: GitHubRepoRef;
  defaultBranch: string;
  branches?: string[];
  runId?: number;
  hrefFor: (runId?: number) => string;
}) {
  if (runId) return <CiRunView r={r} runId={runId} back={hrefFor()} />;
  return <CiRunList r={r} defaultBranch={defaultBranch} branches={branches} hrefFor={hrefFor} />;
}

/**
 * A project's CI tab (ADR-058): each linked repo with its release and work
 * branches' badges and its runs; a run opened at /projects/<id>/ci/<run>/<repo>.
 */
export function ProjectCiTab({
  project,
  runId,
  repo,
}: {
  project: ProjectView;
  runId?: number;
  repo?: string;
}) {
  const ci = useLive(() => api.ci.project({ id: project.id }), {
    topics: [],
    deps: [project.id],
  });
  const linked = (project.repos ?? []).filter((r) => r.github?.ready);
  const base = `/projects/${project.id}/ci`;
  const refOf = (r: ProjectRepo): GitHubRepoRef => ({
    owner: r.github?.owner ?? "",
    name: r.github?.name ?? "",
    account: r.github?.account ?? "",
  });
  const hrefFor = (r: ProjectRepo) => (id?: number) =>
    id ? `${base}/${id}/${encodeURIComponent(r.name)}` : base;
  if (!linked.length)
    return (
      <Empty
        title={t("No GitHub repo linked")}
        action={
          <Button asChild size="sm" variant="secondary">
            <Link href={`/projects/${project.id}/repo`}>{t("Link one on the Repo tab")}</Link>
          </Button>
        }
      >
        {t("A project's CI is its linked GitHub repo's Actions.")}
      </Empty>
    );
  const open = runId ? (linked.find((r) => r.name === repo) ?? linked[0]) : undefined;
  if (open)
    return (
      <CiRuns
        r={refOf(open)}
        defaultBranch={open.releaseBranch}
        runId={runId}
        hrefFor={hrefFor(open)}
      />
    );
  return (
    <div className="space-y-6" data-help="project.ci">
      <ErrorNote error={ci.error} />
      {linked.map((r) => {
        const b = ci.data?.find((x) => x.repo === r.name);
        return (
          <section key={r.name} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold">
                {r.github?.owner}/{r.github?.name}
              </h3>
              {b ? (
                <>
                  <CiPill badge={b.release} href={base} />
                  {b.work ? <CiPill badge={b.work} href={base} /> : null}
                </>
              ) : null}
            </div>
            <CiRuns
              r={refOf(r)}
              defaultBranch={r.releaseBranch}
              branches={[r.releaseBranch, r.workBranch]}
              hrefFor={hrefFor(r)}
            />
          </section>
        );
      })}
    </div>
  );
}

function CiRunList({
  r,
  defaultBranch,
  branches,
  hrefFor,
}: {
  r: GitHubRepoRef;
  defaultBranch: string;
  branches: string[];
  hrefFor: (runId?: number) => string;
}) {
  const [branch, setBranch] = useState(ALL);
  const [page, setPage] = useState(1);
  const runs = useLive(() => api.ci.runs({ ...r, ...(branch !== ALL ? { branch } : {}), page }), {
    topics: [],
    deps: [r.owner, r.name, r.account, branch, page],
  });
  const running = runs.data?.items.some((x) => x.status !== "completed");
  useEvery(
    runs.reload,
    runs.data?.stale || limited(runs.error) ? 60_000 : running ? 5_000 : 60_000,
  );
  const choices = [...new Set([...branches, defaultBranch])];
  return (
    <div className="space-y-3" data-help="ci.runs">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={branch}
          onValueChange={(v) => {
            setBranch(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-auto max-w-56 min-w-36 gap-1" aria-label={t("Branch")}>
            <GitBranch className="size-4 shrink-0" />
            <span className="min-w-0 truncate">
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("All branches")}</SelectItem>
            {choices.map((b) => (
              <SelectItem key={b} value={b}>
                {b}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <RunWorkflowButton
          r={r}
          defaultRef={branch !== ALL ? branch : defaultBranch}
          onDone={runs.reload}
        />
      </div>
      {runs.data?.stale && runs.data.retryAt ? (
        <p className="text-sm text-muted-foreground">
          {t("GitHub asked Oraknid to wait: shown as it was, asked again {when}.", {
            when: until(runs.data.retryAt),
          })}
        </p>
      ) : null}
      <ErrorNote error={runs.error} />
      {!runs.data && !runs.error ? <Loading /> : null}
      {runs.data && runs.data.items.length === 0 ? (
        <Empty title={t("No runs")}>
          {branch !== ALL
            ? t("Nothing ran on {branch} yet.", { branch })
            : t("GitHub Actions hasn't run anything in this repository yet.")}
        </Empty>
      ) : null}
      {runs.data?.items.length ? (
        <ul className="divide-y rounded-lg border">
          {runs.data.items.map((run) => (
            <li key={run.id}>
              <RunRow run={run} href={hrefFor(run.id)} />
            </li>
          ))}
        </ul>
      ) : null}
      {runs.data && (page > 1 || runs.data.next) ? (
        <div className="flex justify-between">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            {t("Newer")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!runs.data.next}
            onClick={() => setPage(page + 1)}
          >
            {t("Older")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function RunRow({ run, href }: { run: CiRun; href: string }) {
  return (
    <Link
      href={href}
      className="flex min-w-0 items-start gap-2 px-3 py-2 hover:bg-accent/60"
      data-help="ci.run"
    >
      <CiMark status={run.status} conclusion={run.conclusion} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span className="font-medium">{run.name}</span>
          <span className="min-w-0 truncate text-sm" title={run.title}>
            {run.title}
          </span>
        </span>
        <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{run.branch ?? "?"}</span>
          <span className="font-mono">{run.sha.slice(0, 7)}</span>
          <span>{run.event}</span>
          {run.actor ? <span>{run.actor}</span> : null}
          {run.attempt > 1 ? <span>{t("attempt {n}", { n: run.attempt })}</span> : null}
        </span>
      </span>
      <span className="shrink-0 text-right text-xs text-muted-foreground">
        <span className="block">{duration(run.durationMs)}</span>
        <span className="block">{ago(Date.parse(run.updatedAt))}</span>
      </span>
    </Link>
  );
}

/** One run: its jobs and steps, the chosen job's log, its artifacts, and what can be done. */
function CiRunView({ r, runId, back }: { r: GitHubRepoRef; runId: number; back: string }) {
  const run = useLive(() => api.ci.run({ ...r, runId }), {
    topics: [],
    deps: [r.owner, r.name, r.account, runId],
  });
  const live = run.data && run.data.status !== "completed";
  useEvery(run.reload, limited(run.error) ? 60_000 : live ? 5_000 : null);
  const [picked, setPicked] = useState<number | null>(null);
  const d = run.data;
  const failing = d?.jobs.find((j) => j.failingStep || j.conclusion === "failure");
  const job = d?.jobs.find((j) => j.id === picked) ?? failing ?? d?.jobs[0];
  return (
    <div className="space-y-3" data-help="ci.run-detail">
      <Link
        href={back}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t("All runs")}
      </Link>
      <ErrorNote error={run.error} />
      {!d && !run.error ? <Loading /> : null}
      {d ? (
        <>
          <RunHeader r={r} run={d} onChange={run.reload} />
          <div className="grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]">
            <ul className="space-y-1" aria-label={t("Jobs")}>
              {d.jobs.map((j) => (
                <li key={j.id}>
                  <button
                    type="button"
                    onClick={() => setPicked(j.id)}
                    aria-pressed={job?.id === j.id}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      job?.id === j.id && "bg-accent font-medium",
                    )}
                  >
                    <CiMark status={j.status} conclusion={j.conclusion} />
                    <span className="min-w-0 flex-1 truncate">{j.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {duration(j.durationMs)}
                    </span>
                  </button>
                </li>
              ))}
              {d.jobs.length === 0 ? (
                <li className="text-sm text-muted-foreground">{t("No jobs yet.")}</li>
              ) : null}
            </ul>
            <div className="min-w-0 space-y-3">
              {job ? <JobView r={r} job={job} /> : null}
              <Artifacts r={r} runId={runId} />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function RunHeader({
  r,
  run,
  onChange,
}: {
  r: GitHubRepoRef;
  run: CiRunDetail;
  onChange: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const failed = run.jobs.some((j) => j.conclusion === "failure" || j.conclusion === "timed_out");
  const act = async (
    what: "failed" | "all" | "cancel",
    title: string,
    body: string,
    action: string,
  ) => {
    if (!(await confirm(title, body, action, { safe: what !== "cancel" }))) return;
    setBusy(true);
    try {
      if (what === "cancel") await api.ci.cancel({ ...r, runId: run.id });
      else await api.ci.rerun({ ...r, runId: run.id, failedOnly: what === "failed" });
      toast.success(what === "cancel" ? t("Cancelled.") : t("It runs again."));
      onChange();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-start gap-2">
      <CiMark status={run.status} conclusion={run.conclusion} className="mt-1 size-5" />
      <div className="min-w-0 flex-1">
        <h3 className="font-semibold">
          {run.name} <span className="font-normal text-muted-foreground">#{run.id}</span>
        </h3>
        <p className="truncate text-sm" title={run.title}>
          {run.title}
        </p>
        <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">{run.branch ?? "?"}</span>
          <span className="font-mono">{run.sha.slice(0, 7)}</span>
          <span>{run.event}</span>
          {run.actor ? <span>{run.actor}</span> : null}
          <span>{t("attempt {n}", { n: run.attempt })}</span>
          <span>{duration(run.durationMs)}</span>
          {run.pullRequests.length ? (
            <span>{run.pullRequests.map((n) => `#${n}`).join(", ")}</span>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap gap-1">
        {run.status === "completed" && failed ? (
          <Button
            size="sm"
            className="gap-1"
            disabled={busy}
            onClick={() =>
              act(
                "failed",
                t("Re-run the failed jobs?"),
                t("GitHub runs {name}'s failed jobs again, as attempt {n}.", {
                  name: run.name,
                  n: run.attempt + 1,
                }),
                t("Re-run failed jobs"),
              )
            }
          >
            <RotateCcw className="size-4" />
            {t("Re-run failed jobs")}
          </Button>
        ) : null}
        {run.status === "completed" ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            disabled={busy}
            onClick={() =>
              act(
                "all",
                t("Re-run every job?"),
                t("GitHub runs all of {name} again, as attempt {n}.", {
                  name: run.name,
                  n: run.attempt + 1,
                }),
                t("Re-run all"),
              )
            }
          >
            <RotateCcw className="size-4" />
            {t("Re-run all")}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            disabled={busy}
            onClick={() =>
              act(
                "cancel",
                t("Cancel this run?"),
                t("GitHub stops {name} where it is; its finished jobs keep their results.", {
                  name: run.name,
                }),
                t("Cancel the run"),
              )
            }
          >
            <Ban className="size-4" />
            {t("Cancel")}
          </Button>
        )}
        <Button asChild size="sm" variant="ghost" className="gap-1">
          <a href={run.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            {t("On GitHub")}
          </a>
        </Button>
      </div>
      {dialog}
    </div>
  );
}

/** A job: its steps, and its log by step, the failing step first and open. */
function JobView({ r, job }: { r: GitHubRepoRef; job: CiJob }) {
  const [q, setQ] = useState("");
  const log = useLive(() => api.ci.log({ ...r, jobId: job.id }), {
    topics: [],
    deps: [r.owner, r.name, r.account, job.id],
  });
  const running = job.status !== "completed";
  useEvery(log.reload, running && !limited(log.error) ? 10_000 : null);
  const needle = q.trim().toLowerCase();
  const sections = useMemo(
    () =>
      (log.data?.sections ?? []).map((s) => ({
        ...s,
        hits: needle
          ? s.lines.flatMap((l, i) => (l.toLowerCase().includes(needle) ? [i] : []))
          : [],
      })),
    [log.data, needle],
  );
  const hits = sections.reduce((n, s) => n + s.hits.length, 0);
  return (
    <div className="space-y-2" data-help="ci.log">
      <ol className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {job.steps.map((s) => (
          <li key={s.number} className="flex items-center gap-1">
            <CiMark status={s.status} conclusion={s.conclusion} className="size-3.5" />
            <span className={cn(s.name === job.failingStep && "font-medium text-destructive")}>
              {s.name}
            </span>
          </li>
        ))}
      </ol>
      <div className="relative">
        <Search className="pointer-events-none absolute top-2.5 left-2 size-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("Search the log")}
          aria-label={t("Search the log")}
          className="pl-8"
        />
      </div>
      {needle ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {hits === 1 ? t("1 line matches.") : t("{n} lines match.", { n: hits })}
        </p>
      ) : null}
      <ErrorNote error={log.error} />
      {!log.data && !log.error ? <Loading rows={4} /> : null}
      {log.data?.truncated ? (
        <p className="text-xs text-muted-foreground">
          {t("The log is long: its beginning is left out.")}
        </p>
      ) : null}
      {sections.map((s) => (
        <LogSection key={s.number} s={s} hits={s.hits} searching={!!needle} />
      ))}
    </div>
  );
}

function LogSection({
  s,
  hits,
  searching,
}: {
  s: CiLogSection;
  hits: number[];
  searching: boolean;
}) {
  if (searching && hits.length === 0) return null;
  const shown = searching ? hits.map((i) => ({ i, line: s.lines[i] ?? "" })) : null;
  return (
    <details open={s.failing || searching} className="rounded-md border">
      <summary
        className={cn(
          "flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm",
          s.failing && "font-medium text-destructive",
        )}
      >
        <CiMark status="completed" conclusion={s.conclusion} className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{s.name}</span>
        <span className="text-xs text-muted-foreground">
          {searching ? hits.length : s.lines.length + s.cut}
        </span>
      </summary>
      <pre className="max-h-[28rem] overflow-auto border-t bg-muted/40 p-2 font-mono text-xs leading-relaxed">
        {s.cut && !searching ? (
          <span className="block text-muted-foreground">
            {t("{n} earlier lines left out.", { n: s.cut })}
          </span>
        ) : null}
        {(shown ?? s.lines.map((line, i) => ({ i, line }))).map(({ i, line }) => (
          <span
            key={i}
            className={cn(
              "block whitespace-pre-wrap break-all",
              /##\[error\]/.test(line) && "text-destructive",
              searching && "bg-amber-500/15",
            )}
          >
            <span className="mr-2 inline-block w-10 text-right text-muted-foreground select-none">
              {i + 1 + s.cut}
            </span>
            {line}
          </span>
        ))}
      </pre>
    </details>
  );
}

function Artifacts({ r, runId }: { r: GitHubRepoRef; runId: number }) {
  const list = useLive(() => api.ci.artifacts({ ...r, runId }), {
    topics: [],
    deps: [r.owner, r.name, r.account, runId],
  });
  if (!list.data?.length) return <ErrorNote error={list.error} />;
  const download = async (artifactId: number) => {
    try {
      const link = await api.ci.artifactLink({ ...r, artifactId });
      window.location.assign(link.url);
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <div className="rounded-md border" data-help="ci.artifacts">
      <div className="border-b px-2 py-1.5 text-sm font-medium">{t("Artifacts")}</div>
      <ul className="divide-y">
        {list.data.map((a) => (
          <li key={a.id} className="flex items-center gap-2 px-2 py-1.5 text-sm">
            <span className="min-w-0 flex-1 truncate">{a.name}</span>
            <span className="text-xs text-muted-foreground">
              {a.expired ? t("expired") : bytes(a.sizeBytes)}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              disabled={a.expired}
              onClick={() => download(a.id)}
              aria-label={t("Download {name}", { name: a.name })}
            >
              <Download className="size-4" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Run a workflow by hand: those with `on: workflow_dispatch`, with their inputs. */
function RunWorkflowButton({
  r,
  defaultRef,
  onDone,
}: {
  r: GitHubRepoRef;
  defaultRef: string;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wfs = useLive(() => api.ci.workflows(r), {
    topics: [],
    deps: [r.owner, r.name, r.account],
  });
  const manual = (wfs.data ?? []).filter((w) => w.dispatch);
  if (!manual.length) return null;
  return (
    <>
      <Button size="sm" variant="secondary" className="gap-1" onClick={() => setOpen(true)}>
        <Play className="size-4" />
        {t("Run workflow")}
      </Button>
      {open ? (
        <DispatchDialog
          r={r}
          workflows={manual}
          defaultRef={defaultRef}
          onClose={() => setOpen(false)}
          onDone={onDone}
        />
      ) : null}
    </>
  );
}

function DispatchDialog({
  r,
  workflows,
  defaultRef,
  onClose,
  onDone,
}: {
  r: GitHubRepoRef;
  workflows: CiWorkflow[];
  defaultRef: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [id, setId] = useState(workflows[0]?.id ?? 0);
  const wf = workflows.find((w) => w.id === id) ?? workflows[0];
  const [ref, setRef] = useState(defaultRef);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const value = (name: string, fallback: string | null) => values[name] ?? fallback ?? "";
  const submit = async () => {
    if (!wf) return;
    setBusy(true);
    setError(null);
    try {
      const inputs: Record<string, string> = {};
      for (const i of wf.inputs) {
        const v = value(i.name, i.default);
        if (v !== "" || i.required) inputs[i.name] = v;
      }
      await api.ci.dispatch({ ...r, workflowId: wf.id, ref: ref.trim(), inputs });
      toast.success(t("{name} started on {ref}.", { name: wf.name, ref }));
      onClose();
      // GitHub lists the new run a moment later.
      setTimeout(onDone, 3000);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Run a workflow")}</DialogTitle>
          <DialogDescription>
            {t("GitHub runs it on the branch or tag you name, with these inputs.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {workflows.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="ci-wf">{t("Workflow")}</Label>
              <Select
                value={String(wf?.id ?? "")}
                onValueChange={(v) => {
                  setId(Number(v));
                  setValues({});
                }}
              >
                <SelectTrigger id="ci-wf">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {workflows.map((w) => (
                    <SelectItem key={w.id} value={String(w.id)}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <p className="text-sm font-medium">{wf?.name}</p>
          )}
          <div className="space-y-1">
            <Label htmlFor="ci-ref">{t("Branch or tag")}</Label>
            <Input id="ci-ref" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
          {wf?.inputs.map((i) => (
            <div key={i.name} className="space-y-1">
              <Label htmlFor={`ci-in-${i.name}`}>
                {i.name}
                {i.required ? <span className="text-destructive"> *</span> : null}
              </Label>
              {i.description ? (
                <p className="text-xs text-muted-foreground">{i.description}</p>
              ) : null}
              {i.type === "boolean" ? (
                <Switch
                  id={`ci-in-${i.name}`}
                  checked={value(i.name, i.default) === "true"}
                  onCheckedChange={(on) => setValues({ ...values, [i.name]: String(on) })}
                />
              ) : i.type === "choice" && i.options.length ? (
                <Select
                  value={value(i.name, i.default) || (i.options[0] ?? "")}
                  onValueChange={(v) => setValues({ ...values, [i.name]: v })}
                >
                  <SelectTrigger id={`ci-in-${i.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {i.options.map((o) => (
                      <SelectItem key={o} value={o}>
                        {o}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id={`ci-in-${i.name}`}
                  inputMode={i.type === "number" ? "decimal" : undefined}
                  value={value(i.name, i.default)}
                  onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}
                />
              )}
            </div>
          ))}
          <ErrorNote error={error} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !ref.trim()} onClick={submit} className="gap-1">
            <Play className="size-4" />
            {t("Run")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
