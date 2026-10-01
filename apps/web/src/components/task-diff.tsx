import { useState } from "react";
import { ErrorNote } from "@/components/common";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** A task's work as a patch, on demand (Web-UI → Task drawer; Phase 2 → M2.0). */
export function TaskDiff({ taskId }: { taskId: string }) {
  const [diff, setDiff] = useState<Awaited<ReturnType<typeof api.tasks.diff>> | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      setDiff(await api.tasks.diff({ taskId }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" disabled={busy} onClick={load}>
        {diff ? t("Refresh the diff") : t("Show the diff")}
      </Button>
      {error ? <ErrorNote error={error} /> : null}
      {diff ? (
        diff.from === "none" ? (
          <div className="text-xs text-muted-foreground">{t("No changes yet.")}</div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {diff.from === "commit" ? t("Its commit.") : t("Its work so far, not committed yet.")}
            </div>
            <pre className="max-h-[50vh] overflow-auto rounded bg-muted p-2 font-mono text-[11px] leading-snug">
              {diff.text.split("\n").map((line, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: a patch's lines never move
                  key={i}
                  className={cn(
                    line.startsWith("+") && !line.startsWith("+++") && "text-success",
                    line.startsWith("-") && !line.startsWith("---") && "text-destructive",
                    line.startsWith("@@") && "text-primary",
                  )}
                >
                  {line || " "}
                </div>
              ))}
            </pre>
          </>
        )
      ) : null}
    </div>
  );
}
