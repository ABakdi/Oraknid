import { ExternalLink, LogIn } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote } from "@/components/common";
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
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/**
 * Logs a Claude Code or Antigravity Leg in from here (Legs → Adding a
 * Leg, BR-22): the official sign-in page opens in a new tab, and the
 * code it shows comes back here. Oraknid never sees the password.
 */
export function LegLogin({
  legId,
  legName,
  kind = "claude-code",
}: {
  legId: string;
  legName: string;
  kind?: "claude-code" | "antigravity";
}) {
  const google = kind === "antigravity";
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const begin = async () => {
    setOpen(true);
    setUrl(null);
    setCode("");
    setError(undefined);
    setBusy(true);
    try {
      setUrl((await api.legs.loginStart({ id: legId })).url);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.legs.loginFinish({ id: legId, code });
      if (r.ok) {
        toast.success(r.detail);
        setOpen(false);
      } else setError(new Error(r.detail));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button size="sm" className="gap-1" onClick={begin}>
        <LogIn className="size-3.5" />
        {t("Log in")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Log {name} in", { name: legName })}</DialogTitle>
            <DialogDescription>
              {google
                ? t(
                    "Sign in on Google's own page, then paste the code it shows. This account's login stays in this Leg's own folder.",
                  )
                : t(
                    "Sign in on Claude's own page, then paste the code it shows. This account's login stays in this Leg's own folder.",
                  )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <div className="font-medium">{t("1. Sign in")}</div>
              {url && /^https:\/\//.test(url) ? (
                <Button asChild variant="secondary" className="gap-1">
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" />
                    {google ? t("Open Google's sign-in page") : t("Open Claude's sign-in page")}
                  </a>
                </Button>
              ) : (
                <div className="text-muted-foreground">
                  {busy
                    ? google
                      ? t("Asking Antigravity for the link…")
                      : t("Asking Claude Code for the link…")
                    : null}
                </div>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`code-${legId}`} className="font-medium">
                {t("2. Paste the code")}
              </Label>
              <Input
                id={`code-${legId}`}
                className="font-mono"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t("The code from the page")}
                disabled={!url}
              />
            </div>
            <ErrorNote error={error} />
          </div>
          <DialogFooter>
            {error && !url ? (
              <Button variant="secondary" onClick={begin}>
                {t("Try again")}
              </Button>
            ) : null}
            <Button disabled={busy || !url || !code.trim()} onClick={finish}>
              {busy && url ? t("Logging in…") : t("Log in")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
