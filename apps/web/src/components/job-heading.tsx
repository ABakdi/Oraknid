import type { JobView } from "@oraknid/contracts";
import { ChevronRight, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { act } from "@/lib/links";
import { cn } from "@/lib/utils";

type Named = Pick<JobView, "id" | "title" | "description" | "namedBy" | "describedAs" | "goal">;

/**
 * A job's name, with a pencil to rename it, and its description: what it's
 * for, then what it did (Jobs-and-Projects → A job's name and description).
 */
export function JobTitle({ job }: { job: Named }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1">
        <h3 className="truncate text-base font-semibold" title={job.title}>
          {job.title}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground pointer-coarse:size-11"
          aria-label={t("Rename the job")}
          title={t("Rename")}
          onClick={() => setRenaming(true)}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
      {job.description ? (
        <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{job.description}</p>
      ) : job.namedBy === null ? (
        <p className="text-xs text-muted-foreground italic">
          {t("The Eye names and describes it as soon as a model can.")}
        </p>
      ) : null}
      <RenameDialog job={job} open={renaming} onOpenChange={setRenaming} />
    </>
  );
}

/** My goal as I wrote it, folded under the description. */
export function JobGoal({ goal }: { goal: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-7 items-center gap-1 text-xs text-muted-foreground hover:text-foreground pointer-coarse:min-h-11"
      >
        <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {t("What I asked")}
      </button>
      {open ? (
        <div
          className="max-h-64 overflow-y-auto rounded-md border bg-muted/30 px-3 py-2 text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
          data-testid="job-goal"
        >
          {goal}
        </div>
      ) : null}
    </div>
  );
}

function RenameDialog({
  job,
  open,
  onOpenChange,
}: {
  job: Named;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [title, setTitle] = useState(job.title);
  const [description, setDescription] = useState(job.description ?? "");
  // Opened again: what the job is called now.
  useEffect(() => {
    if (open) {
      setTitle(job.title);
      setDescription(job.description ?? "");
    }
  }, [open, job.title, job.description]);
  const name = title.replace(/\s+/g, " ").trim();
  const save = () => {
    const patch: { id: string; title?: string; description?: string } = { id: job.id };
    if (name !== job.title) patch.title = name;
    if (description.trim() !== (job.description ?? "")) patch.description = description.trim();
    if (!("title" in patch) && !("description" in patch)) return onOpenChange(false);
    void act(async () => {
      await api.jobs.rename(patch);
      onOpenChange(false);
    }, t("Renamed."));
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Rename the job")}</DialogTitle>
          <DialogDescription>
            {t("What you write here is kept: The Eye no longer changes it.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name) save();
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="job-name">{t("Name")}</Label>
            <Input
              id="job-name"
              value={title}
              maxLength={80}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="job-description">{t("Description")}</Label>
            <Textarea
              id="job-description"
              rows={3}
              maxLength={400}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("One or two sentences: what it's for, or what it did.")}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!name}>
              {t("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
