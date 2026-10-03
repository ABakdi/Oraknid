import { Copy, FolderOpen, GitMerge } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "@/components/common";
import { Badge } from "@/components/ui/badge";
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
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * Where a finished job's work is (Jobs-and-Projects → Ending a job,
 * Checkpoint 1 → F1-5): the folder, the branch and its commits; open it,
 * or merge it into the work branch, which is my action.
 */
export function JobResult({ jobId }: { jobId: string }) {
  const result = useLive(() => api.jobs.result({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type.startsWith("job."),
    deps: [jobId],
  });
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<string[]>([]);
  if (result.error) return <ErrorNote error={result.error} />;
  const r = result.data;
  if (!r) return null;

  const merge = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const m = await api.jobs.merge({ id: jobId });
      if (m.ok) {
        setConflicts([]);
        toast.success(t("Merged into {into}.", { into: r.into }));
      } else {
        setConflicts(m.conflicts);
        toast.error(m.reason);
      }
      result.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const copy = (text: string) =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success(t("Copied.")))
      .catch(() => toast.error(t("Couldn't copy.")));

  return (
    <Card className="gap-3 border-success/40 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          {t("The result")}
          {r.merged ? (
            <Badge variant="secondary">{t("Merged into {into}", { into: r.into })}</Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4 text-sm">
        {r.folder ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("Folder")}</span>
            <code className="min-w-0 flex-1 truncate text-xs" title={r.folder}>
              {r.folder}
            </code>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t("Copy the path")}
              onClick={() => r.folder && copy(r.folder)}
            >
              <Copy className="size-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="gap-1"
              onClick={() =>
                api.jobs
                  .openFolder({ id: jobId })
                  .then(() => toast.success(t("Opened on this computer.")))
                  .catch((e) => toast.error(message(e)))
              }
            >
              <FolderOpen className="size-4" />
              {t("Open")}
            </Button>
          </div>
        ) : null}
        {r.repos.length ? (
          // A project of several repos (ADR-042): each repo's branch, its commits, merged or not.
          <div className="space-y-3">
            {r.repos.map((x) => (
              <div key={x.name} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{x.name}</span>
                  <code className="text-xs text-muted-foreground">{x.folder}/</code>
                  <code className="text-xs">{x.branch}</code>
                  <span className="text-muted-foreground">→</span>
                  <code className="text-xs">{x.into}</code>
                  {x.merged ? <Badge variant="secondary">{t("merged")}</Badge> : null}
                </div>
                {x.commits.length ? (
                  <ul className="max-h-32 space-y-1 overflow-y-auto font-mono text-xs">
                    {x.commits.map((c) => (
                      <li key={c.sha} className="flex gap-2">
                        <span className="shrink-0 text-muted-foreground">{c.sha.slice(0, 8)}</span>
                        <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                        <span className="shrink-0 text-muted-foreground">{ago(c.at)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="text-xs text-muted-foreground">{t("No commits to merge.")}</div>
                )}
              </div>
            ))}
          </div>
        ) : null}
        {r.branch && !r.repos.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted-foreground">{t("Branch")}</span>
            <code className="text-xs">{r.branch}</code>
            <span className="text-muted-foreground">→</span>
            <code className="text-xs">{r.into}</code>
          </div>
        ) : null}
        {r.commits.length && !r.repos.length ? (
          <ul className="max-h-48 space-y-1 overflow-y-auto font-mono text-xs">
            {r.commits.map((c) => (
              <li key={c.sha} className="flex gap-2">
                <span className="shrink-0 text-muted-foreground">{c.sha.slice(0, 8)}</span>
                <span className="min-w-0 flex-1 truncate">{c.subject}</span>
                <span className="shrink-0 text-muted-foreground">{ago(c.at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {conflicts.length ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs">
            {t("These files conflict with {into}; nothing was merged:", { into: r.into })}
            <ul className="mt-1 list-inside list-disc font-mono">
              {conflicts.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {r.cannotMerge ? (
          <div className="text-xs text-muted-foreground">{r.cannotMerge}</div>
        ) : (
          <Button className="gap-1" disabled={busy} onClick={() => setConfirming(true)}>
            <GitMerge className="size-4" />
            {t("Merge into {into}", { into: r.into })}
          </Button>
        )}
      </CardContent>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Merge into {into}?", { into: r.into })}</DialogTitle>
            <DialogDescription>
              {t(
                "{n} commits from {branch} go into {into} as one merge commit. If {into} is checked out with uncommitted changes, or the branches conflict, nothing is merged.",
                { n: r.commits.length, branch: r.branch ?? "", into: r.into },
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              {t("Not now")}
            </Button>
            <Button onClick={merge}>{t("Merge")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
