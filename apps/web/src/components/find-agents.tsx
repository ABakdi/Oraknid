import type { FoundAgent } from "@oraknid/contracts";
import { Check, Search } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";

/** The kind's own shape for `legs.create`. */
const create = (f: FoundAgent, name: string) =>
  api.legs.create({ kind: f.kind, name, config: f.config } as Parameters<
    typeof api.legs.create
  >[0]);

/**
 * Finding agents on this machine (Legs → Finding agents): what Oraknid
 * can drive here, each made a Leg with one click, or all at once.
 */
export function FindAgents() {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<FoundAgent[] | null>(null);
  const [error, setError] = useState<unknown>();
  const [made, setMade] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const look = async () => {
    setOpen(true);
    setFound(null);
    setError(undefined);
    setMade(new Set());
    try {
      setFound(await api.legs.discover());
    } catch (e) {
      setError(e);
    }
  };
  const add = async (list: FoundAgent[]) => {
    setBusy(true);
    let n = 0;
    try {
      for (const f of list) {
        await create(f, f.suggestedName);
        n++;
        setMade((m) => new Set(m).add(f.where));
      }
      toast.success(
        n === 1
          ? t("Added; it is being tested.")
          : t("{n} Legs added; they are being tested.", { n }),
      );
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const fresh = (found ?? []).filter((f) => f.usedBy.length === 0 && !made.has(f.where));
  return (
    <>
      <Button variant="secondary" className="gap-1" onClick={look}>
        <Search className="size-4" />
        {t("Find agents on this machine")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("Agents on this machine")}</DialogTitle>
            <DialogDescription>
              {t(
                "What Oraknid can drive here. Nothing is added until you choose; an account Leg then logs in from its own card.",
              )}
            </DialogDescription>
          </DialogHeader>
          {error ? <ErrorNote error={error} /> : null}
          {!found && !error ? <Loading rows={3} /> : null}
          {found && found.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              {t(
                "None found: no claude, opencode or agy program, and no model server on the usual ports (Ollama, LM Studio, llama.cpp, vLLM). Add one by hand instead.",
              )}
            </div>
          ) : null}
          {found?.length ? (
            <div className="space-y-2">
              {found.map((f) => {
                const done = made.has(f.where);
                return (
                  <div
                    key={`${f.kind}:${f.where}`}
                    className="flex flex-wrap items-start gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{f.label}</span>
                        {f.usedBy.length ? (
                          <Badge variant="outline">
                            {t("already: {legs}", { legs: f.usedBy.join(", ") })}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {f.where}
                      </div>
                      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                        {f.detail}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant={f.usedBy.length ? "secondary" : "default"}
                      disabled={busy || done}
                      className="gap-1"
                      onClick={() => add([f])}
                      title={
                        f.usedBy.length
                          ? t("Another Leg with it: another account")
                          : t("As {name}", { name: f.suggestedName })
                      }
                    >
                      {done ? <Check className="size-3.5" /> : null}
                      {done
                        ? t("Added")
                        : f.usedBy.length
                          ? t("Add another")
                          : t("Create “{name}”", { name: f.suggestedName })}
                    </Button>
                  </div>
                );
              })}
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  {t("Close")}
                </Button>
                <Button disabled={busy || fresh.length === 0} onClick={() => add(fresh)}>
                  {fresh.length
                    ? t("Create all new ({n})", { n: fresh.length })
                    : t("All are Legs already")}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
