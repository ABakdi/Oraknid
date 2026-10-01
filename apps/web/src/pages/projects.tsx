import { FolderGit2, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { LegComparison, TokensChart } from "@/components/charts";
import { Empty, ErrorNote, Loading, PageHeader, Stat, StateBadge } from "@/components/common";
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
import { api, message } from "@/lib/api";
import { tokens } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

export function ProjectsPage() {
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "project.created" || e.type === "job.created",
  });
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  if (projects.error) return <ErrorNote error={projects.error} />;
  if (projects.loading) return <Loading />;
  const add = (
    <Button className="gap-1" onClick={() => setCreating(true)}>
      <Plus className="size-4" />
      {t("New project")}
    </Button>
  );
  const current = selected ?? projects.data?.[0]?.id ?? null;
  return (
    <div className="space-y-4">
      <PageHeader title={t("Projects")} actions={add} />
      {(projects.data ?? []).length === 0 ? (
        <Empty title={t("No projects yet")} action={add}>
          {t(
            "A project is a folder or repo that jobs work in. Oraknid works in its own worktree and never on your branch.",
          )}
        </Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
          <div className="space-y-1">
            {(projects.data ?? []).map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setSelected(p.id)}
                className={`w-full rounded-lg border px-3 py-2 text-left hover:bg-accent ${p.id === current ? "border-primary bg-accent" : "bg-card"}`}
              >
                <div className="flex items-center gap-2 font-medium">
                  <FolderGit2 className="size-4" />
                  <span className="truncate">{p.name}</span>
                </div>
                <div className="truncate text-xs text-muted-foreground">{p.workspacePath}</div>
                <div className="text-xs text-muted-foreground">
                  {t("{n} job(s)", { n: p.jobCount })} ·{" "}
                  {p.shadow
                    ? t("no git (checkpoints in a shadow repo)")
                    : `${p.releaseBranch} / ${p.workBranch}`}
                </div>
              </button>
            ))}
          </div>
          {current ? <ProjectStats id={current} /> : null}
        </div>
      )}
      <NewProject open={creating} onOpenChange={setCreating} />
    </div>
  );
}

function ProjectStats({ id }: { id: string }) {
  const s = useLive(() => api.stats.summary({ projectId: id }), {
    topics: ["overview"],
    deps: [id],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  const buckets = useLive(
    () =>
      api.stats.tokens({ projectId: id, since: Date.now() - 14 * 86400_000, bucketMs: 86400_000 }),
    { topics: ["overview"], deps: [id] },
  );
  const jobs = useLive(() => api.jobs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("job."),
  });
  if (!s.data) return <Loading />;
  const mine = (jobs.data ?? []).filter((j) => j.projectId === id).reverse();
  const hours = Math.round(s.data.timeMs / 360_000) / 10;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label={t("Tokens")} value={tokens(s.data.tokens)} />
        <Stat label={t("Time")} value={t("{h} h", { h: hours })} />
        <Stat
          label={t("Tasks done")}
          value={s.data.tasks.done}
          hint={t("{n} failed", { n: s.data.tasks.failed })}
        />
        <Stat
          label={t("Success")}
          value={s.data.successRate === null ? "—" : `${Math.round(s.data.successRate * 100)}%`}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Tokens per day, last two weeks")}</CardTitle>
        </CardHeader>
        <CardContent>
          {(buckets.data ?? []).length ? (
            <TokensChart buckets={buckets.data ?? []} />
          ) : (
            <div className="text-sm text-muted-foreground">{t("Nothing yet.")}</div>
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
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("History")}</CardTitle>
        </CardHeader>
        <CardContent className="divide-y p-0">
          {mine.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">{t("No jobs yet.")}</div>
          ) : null}
          {mine.map((j) => (
            <Link
              key={j.id}
              href={`/jobs/${j.id}`}
              className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-accent/50"
            >
              <span className="flex-1 truncate">{j.title}</span>
              <StateBadge state={j.state} />
            </Link>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function NewProject({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [askGit, setAskGit] = useState(false);
  const [error, setError] = useState<unknown>();
  const create = async (initGit?: boolean) => {
    setError(undefined);
    try {
      await api.projects.create({
        name: name || path.split("/").filter(Boolean).at(-1) || "project",
        workspacePath: path,
        ...(initGit === undefined ? {} : { initGit }),
      });
      toast.success(t("Project created."));
      onOpenChange(false);
      setAskGit(false);
    } catch (e) {
      if (message(e).includes("is not a git repo")) setAskGit(true);
      else setError(e);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("New project")}</DialogTitle>
          <DialogDescription>
            {t(
              "A folder on this machine. Nothing is changed in it until a job runs, and then only in a worktree.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="pp">{t("Folder")}</Label>
            <Input
              id="pp"
              placeholder="/home/me/code/app"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="pn">{t("Name")}</Label>
            <Input
              id="pn"
              placeholder={path.split("/").filter(Boolean).at(-1) ?? ""}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <ErrorNote error={error} />
          {askGit ? (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div>
                {t("This folder is not a git repo. How should Oraknid keep its checkpoints?")}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => create(true)}>
                  {t("Make it a git repo")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => create(false)}>
                  {t("Use a shadow repo, leave the folder alone")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button disabled={!path.startsWith("/")} onClick={() => create()}>
            {path.startsWith("/") ? t("Create") : t("Enter a full path")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
