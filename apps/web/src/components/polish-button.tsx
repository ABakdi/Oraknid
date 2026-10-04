import type { TextPolishKind } from "@oraknid/contracts";
import { Undo2, WandSparkles } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * Fix wording (Chats-and-Helper → Fix wording), for any textarea: a quick
 * model rewrites the text (spelling, grammar, clarity; meaning and facts
 * kept) and it replaces mine, which Undo brings back, from the toast or
 * here, until I change the text again.
 */
export function PolishButton({
  value,
  onChange,
  kind = "plain",
  className,
}: {
  value: string;
  onChange: (text: string) => void;
  kind?: TextPolishKind;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  // Mine before the rewrite, while the rewrite is still what's there.
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  const canUndo = undo !== null && undo.after === value;
  const polish = async () => {
    setBusy(true);
    try {
      const { text } = await api.text.polish({ text: value, kind });
      if (text === value) {
        toast.success(t("Nothing to fix."));
        return;
      }
      const before = value;
      setUndo({ before, after: text });
      onChange(text);
      toast.success(t("Rephrased."), {
        action: {
          label: t("Undo"),
          onClick: () => {
            onChange(before);
            setUndo(null);
          },
        },
      });
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className={cn("inline-flex items-center gap-1", className)}>
      {canUndo ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1"
          onClick={() => {
            onChange(undo.before);
            setUndo(null);
          }}
        >
          <Undo2 className="size-3.5" />
          {t("Undo")}
        </Button>
      ) : null}
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-7 gap-1"
        disabled={busy || !value.trim()}
        title={t("Fix the spelling and grammar and make it clear; the meaning stays.")}
        onClick={polish}
      >
        <WandSparkles className="size-3.5" />
        {busy ? t("Rephrasing…") : t("Fix wording")}
      </Button>
    </span>
  );
}
