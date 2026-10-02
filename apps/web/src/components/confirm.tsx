import { type ReactNode, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { t } from "@/lib/i18n";

/**
 * A second step for what can't be taken back or opens my computer
 * (Audit 2): it says exactly what will happen, and Cancel has the focus.
 */
export function useConfirm() {
  const [ask, setAsk] = useState<{
    title: string;
    body: ReactNode;
    action: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = (title: string, body: ReactNode, action: string) =>
    new Promise<boolean>((resolve) => setAsk({ title, body, action, resolve }));
  const close = (ok: boolean) => {
    ask?.resolve(ok);
    setAsk(null);
  };
  const dialog = (
    <Dialog open={!!ask} onOpenChange={(o) => !o && close(false)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{ask?.title}</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2 text-sm">{ask?.body}</div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" autoFocus onClick={() => close(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="destructive" onClick={() => close(true)}>
            {ask?.action}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
  return { confirm, dialog };
}
