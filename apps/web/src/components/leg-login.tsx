import type { LegView } from "@oraknid/contracts";
import { Copy, ExternalLink, LogIn } from "lucide-react";
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

type LoginKind = "claude-code" | "antigravity" | "codex";

/** A Leg that signs in from its card: Claude Code, Antigravity, Codex without an API key. */
export function canLogIn(leg: LegView): leg is LegView & { kind: LoginKind } {
  return (
    leg.kind === "claude-code" ||
    leg.kind === "antigravity" ||
    (leg.kind === "codex" && leg.config.auth !== "api-key")
  );
}

/**
 * Logs a Claude Code, Antigravity or Codex Leg in from here (Legs → Adding
 * a Leg, BR-22): the official sign-in page opens in a new tab, and the
 * code it shows comes back here; for Codex (ADR-057) the page asks for a
 * code shown here instead. Oraknid never sees the password.
 */
export function LegLogin({
  legId,
  legName,
  kind = "claude-code",
}: {
  legId: string;
  legName: string;
  kind?: LoginKind;
}) {
  if (kind === "codex") return <CodexLogin legId={legId} legName={legName} />;
  return <PastedCodeLogin legId={legId} legName={legName} kind={kind} />;
}

/**
 * Codex's device sign-in (ADR-057): a link and a one-time code to enter on
 * OpenAI's page; Codex sees it done by itself, so Done only checks.
 */
function CodexLogin({ legId, legName }: { legId: string; legName: string }) {
  const [open, setOpen] = useState(false);
  const [started, setStarted] = useState<{ url: string; userCode?: string; note?: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const begin = async () => {
    setOpen(true);
    setStarted(null);
    setError(undefined);
    setBusy(true);
    try {
      setStarted(await api.legs.loginStart({ id: legId }));
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
      const r = await api.legs.loginFinish({ id: legId, code: "done" });
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
  const url = started?.url ?? null;
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
              {t(
                "Sign in on OpenAI's own page with your ChatGPT account and enter the code below there. This account's login stays in this Leg's own folder.",
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <div className="space-y-1.5">
              <div className="font-medium">{t("1. Open the page and sign in")}</div>
              {url && /^https:\/\//.test(url) ? (
                <Button asChild variant="secondary" className="gap-1">
                  <a href={url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" />
                    {t("Open OpenAI's sign-in page")}
                  </a>
                </Button>
              ) : (
                <div className="text-muted-foreground">
                  {busy ? t("Asking Codex for the link…") : null}
                </div>
              )}
            </div>
            {started?.userCode ? (
              <div className="space-y-1.5">
                <div className="font-medium">{t("2. Enter this code there")}</div>
                <div className="flex items-center gap-2">
                  <code className="rounded-md border px-3 py-1.5 font-mono text-lg tracking-widest">
                    {started.userCode}
                  </code>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("Copy the code")}
                    onClick={() => void navigator.clipboard?.writeText(started.userCode ?? "")}
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            ) : null}
            {started?.note ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                {started.note}
              </div>
            ) : null}
            <ErrorNote error={error} />
          </div>
          <DialogFooter>
            {error && !url ? (
              <Button variant="secondary" onClick={begin}>
                {t("Try again")}
              </Button>
            ) : null}
            <Button disabled={busy || !url} onClick={finish}>
              {busy && url ? t("Checking…") : t("Done, I've signed in")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function PastedCodeLogin({
  legId,
  legName,
  kind,
}: {
  legId: string;
  legName: string;
  kind: "claude-code" | "antigravity";
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
