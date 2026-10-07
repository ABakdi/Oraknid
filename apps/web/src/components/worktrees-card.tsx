import { FolderX } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, message } from "@/lib/api";
import { bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** What removing a worktree loses, in words, or null when nothing. */
const loss = (w: {
  unmerged: number;
  uncommitted: number;
  branch: string | null;
  into: string | null;
}) =>
  [
    w.unmerged
      ? t("{n} commit(s) not merged into {into}: the branch {branch} stays.", {
          n: w.unmerged,
          into: w.into ?? t("the work branch"),
          branch: w.branch ?? "",
        })
      : null,
    w.uncommitted
      ? t("{n} file(s) changed and not committed: they are lost with it.", { n: w.uncommitted })
      : null,
  ]
    .filter(Boolean)
    .join(" ") || null;

/**
 * Finished jobs' worktrees still on disk (Sandboxing → Worktrees): their
 * sizes, one removed at a time, or every one with nothing to lose at once.
 * A worktree with work not merged or not committed asks first.
 */
export function WorktreesSection() {
  const list = useLive(() => api.storage.worktrees(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "job.worktree-removed",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, dialog } = useConfirm();
  if (!list.data) return <Loading rows={2} />;
  const all = list.data;
  const total = all.reduce((n, w) => n + w.bytes, 0);

  const remove = async (w: (typeof all)[number]) => {
    const lost = loss(w);
    if (
      !(await confirm(
        t("Remove the worktree of “{title}”?", { title: w.title }),
        lost ??
          t("Its folder goes ({size}); its branch stays for review.", { size: bytes(w.bytes) }),
        t("Remove"),
      ))
    )
      return;
    setBusy(w.jobId);
    try {
      const r = await api.storage.removeWorktree({ jobId: w.jobId, confirm: !!lost });
      toast.success(t("Removed ({size}).", { size: bytes(r.bytes) }));
      list.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
    }
  };

  const clean = async () => {
    if (
      !(await confirm(
        t("Clean up finished jobs' worktrees?"),
        t(
          "Every finished job's worktree with nothing unmerged or uncommitted is removed; their branches stay. The others stay too, for you to look at one by one.",
        ),
        t("Clean up"),
      ))
    )
      return;
    setBusy("all");
    try {
      const r = await api.storage.cleanWorktrees();
      toast.success(
        r.kept.length
          ? t("Removed {n} ({size}); {k} kept, with work not merged or not committed.", {
              n: r.removed,
              size: bytes(r.bytes),
              k: r.kept.length,
            })
          : t("Removed {n} ({size}).", { n: r.removed, size: bytes(r.bytes) }),
      );
      list.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-2" data-testid="worktrees">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t("Finished jobs' worktrees")}</span>
        <span className="text-xs text-muted-foreground">
          {all.length ? t("{n}, {size}", { n: all.length, size: bytes(total) }) : t("none")}
        </span>
        <span className="flex-1" />
        <Button variant="outline" size="sm" disabled={!all.length || !!busy} onClick={clean}>
          {t("Clean up finished jobs' worktrees")}
        </Button>
      </div>
      {all.length ? (
        <div className="divide-y rounded-md border">
          {all.map((w) => (
            <div key={w.jobId} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate" title={w.folder}>
                {w.title}
              </span>
              {w.unmerged ? (
                <Badge variant="outline">{t("{n} unmerged", { n: w.unmerged })}</Badge>
              ) : null}
              {w.uncommitted ? (
                <Badge variant="destructive">{t("{n} uncommitted", { n: w.uncommitted })}</Badge>
              ) : null}
              <span className="w-16 text-right text-xs">{bytes(w.bytes)}</span>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("Remove the worktree of “{title}”", { title: w.title })}
                disabled={!!busy}
                onClick={() => remove(w)}
              >
                <FolderX className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}

/** A finished job's own "Remove its worktree" (on its result). */
export function RemoveWorktreeButton({ jobId, onDone }: { jobId: string; onDone?: () => void }) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (
      !(await confirm(
        t("Remove this job's worktree?"),
        t("Its folder goes; its branch stays for review."),
        t("Remove"),
      ))
    )
      return;
    setBusy(true);
    try {
      let r: { bytes: number };
      try {
        r = await api.storage.removeWorktree({ jobId });
      } catch (e) {
        // Work not merged or not committed: said, and asked again.
        const why = message(e);
        if (!/confirm to remove/.test(why)) throw e;
        if (!(await confirm(t("Remove it anyway?"), why, t("Remove anyway")))) return;
        r = await api.storage.removeWorktree({ jobId, confirm: true });
      }
      toast.success(t("Worktree removed ({size}).", { size: bytes(r.bytes) }));
      onDone?.();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="ghost" size="sm" className="gap-1" disabled={busy} onClick={run}>
        <FolderX className="size-4" />
        {t("Remove worktree")}
      </Button>
      {dialog}
    </>
  );
}
