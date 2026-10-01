import type { JobView } from "@oraknid/contracts";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const WAITING = new Set(["pending", "ready"]);

/**
 * The order waiting tasks run in when several are ready at once (Web-UI →
 * Plan editor, Phase 2 → M2.0): drag them, or move them with the arrows.
 * Dependencies still come first, whatever the order.
 */
export function OrderDialog({
  job,
  open,
  onOpenChange,
}: {
  job: JobView;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const waiting = job.tasks.filter((x) => WAITING.has(x.state));
  const [order, setOrder] = useState(waiting.map((x) => x.id));
  const [dragging, setDragging] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: start from the plan each time it opens
  useEffect(() => {
    if (open) setOrder(waiting.map((x) => x.id));
  }, [open]);
  const title = (id: string) => job.tasks.find((x) => x.id === id)?.title ?? id;
  const move = (id: string, to: number) =>
    setOrder((o) => {
      const rest = o.filter((x) => x !== id);
      rest.splice(Math.max(0, Math.min(rest.length, to)), 0, id);
      return rest;
    });
  const save = async () => {
    try {
      await api.web.edit({ jobId: job.id, edits: [{ op: "order", taskIds: order }] });
      toast.success(t("Order saved; ready tasks run top first."));
      onOpenChange(false);
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Order of waiting tasks")}</DialogTitle>
          <DialogDescription>
            {t("When several are ready, the top one runs first. Dependencies still come first.")}
          </DialogDescription>
        </DialogHeader>
        {order.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("No task is waiting.")}</div>
        ) : (
          <ol className="space-y-1">
            {order.map((id, i) => (
              <li
                key={id}
                draggable
                onDragStart={() => setDragging(id)}
                onDragEnd={() => setDragging(null)}
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragging && dragging !== id) move(dragging, i);
                }}
                className={cn(
                  "flex items-center gap-2 rounded-md border bg-card px-2 py-1.5 text-sm",
                  dragging === id && "opacity-50",
                )}
              >
                <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{title(id)}</span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={i === 0}
                  aria-label={t("Earlier")}
                  onClick={() => move(id, i - 1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={i === order.length - 1}
                  aria-label={t("Later")}
                  onClick={() => move(id, i + 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </li>
            ))}
          </ol>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={order.length < 2} onClick={save}>
            {t("Save the order")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
