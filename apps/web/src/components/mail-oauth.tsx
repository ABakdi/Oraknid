import type { MailOAuthProvider, MailOAuthStart } from "@oraknid/contracts";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { remote } from "@/lib/remote";

// Gmail and Outlook signed in with Google or Microsoft (ADR-063): the app I
// registered with each (its client id, and Google's secret, kept by
// Oraknid), and a sign-in from here: Google's page in a new tab coming back
// to this computer, or Microsoft's code typed on its page.

const NAME: Record<MailOAuthProvider, string> = { google: "Google", microsoft: "Microsoft" };

/** How to register the app, step by step, with the address to give it. */
const STEPS: Record<MailOAuthProvider, string[]> = {
  google: [
    "On console.cloud.google.com: create a project, enable the Gmail API, and set up the OAuth consent screen (External, in testing, with your address as a test user; scope https://mail.google.com/).",
    "Credentials → Create credentials → OAuth client ID → Desktop app. Its redirect is any address on 127.0.0.1, so there is nothing more to register.",
    "Paste the client ID and the client secret here.",
  ],
  microsoft: [
    "On entra.microsoft.com: App registrations → New registration, for accounts in any organisation and personal Microsoft accounts.",
    "Authentication → Allow public client flows: Yes (the code typed on Microsoft's page). For the browser instead, add the platform Mobile and desktop applications with the redirect shown below.",
    "API permissions → Add → APIs my organisation uses → Office 365 Exchange Online: IMAP.AccessAsUser.All and SMTP.Send (delegated), plus offline_access. Paste the Application (client) ID here; no secret.",
  ],
};

/** The apps I registered: client ids, Google's secret, where the browser comes back. */
export function MailOAuthAppsCard() {
  const apps = useLive(() => api.mail.oauthApps(), {
    topics: ["mail"],
    refreshOn: (e) => e.type === "mail.oauth.updated",
  });
  const away = !!remote();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4" />
          {t("Sign-in with Google and Microsoft")}
        </CardTitle>
        <CardDescription>
          {t(
            "Gmail and Outlook can sign in with Google or Microsoft instead of an app password, through an app you register with them once. Its secret stays in the keychain; the tokens too.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!apps.data ? <Loading rows={2} /> : null}
        {apps.data?.map((a) => (
          <AppForm key={a.provider} app={a} away={away} />
        ))}
      </CardContent>
    </Card>
  );
}

function AppForm({
  app,
  away,
}: {
  app: {
    provider: MailOAuthProvider;
    clientId: string;
    hasSecret: boolean;
    redirectUri: string;
    ready: boolean;
  };
  away: boolean;
}) {
  const [clientId, setClientId] = useState(app.clientId);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => setClientId(app.clientId), [app.clientId]);
  const save = async () => {
    setBusy(true);
    try {
      await api.mail.setOAuthApp({
        provider: app.provider,
        clientId: clientId.trim(),
        ...(secret.trim() ? { clientSecret: secret.trim() } : {}),
      });
      setSecret("");
      toast.success(
        clientId.trim()
          ? t("{name}'s app is saved.", { name: NAME[app.provider] })
          : t("{name}'s app is forgotten.", { name: NAME[app.provider] }),
      );
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2 font-medium">
        {NAME[app.provider]}
        <Badge variant={app.ready ? "secondary" : "outline"}>
          {app.ready ? t("ready") : t("not set up")}
        </Badge>
      </div>
      <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
        {STEPS[app.provider].map((s) => (
          <li key={s}>{t(s)}</li>
        ))}
      </ol>
      <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">{t("Redirect")}</span>
        <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5">{app.redirectUri}</code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1"
          onClick={() => void navigator.clipboard?.writeText(app.redirectUri)}
        >
          <Copy className="size-3" />
          {t("Copy")}
        </Button>
      </div>
      <form
        className="grid gap-2 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`oauth-${app.provider}-id`}>{t("Client ID")}</Label>
          <Input
            id={`oauth-${app.provider}-id`}
            value={clientId}
            autoComplete="off"
            onChange={(e) => setClientId(e.target.value)}
          />
        </div>
        {app.provider === "google" ? (
          <div className="min-w-0 space-y-1">
            <Label htmlFor="oauth-google-secret">{t("Client secret")}</Label>
            <Input
              id="oauth-google-secret"
              type="password"
              autoComplete="off"
              value={secret}
              placeholder={app.hasSecret ? t("Kept; type to replace it") : ""}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        ) : null}
        <div className="flex justify-end sm:col-span-2">
          <Button
            type="submit"
            size="sm"
            disabled={away || busy || (clientId.trim() === app.clientId && !secret.trim())}
          >
            {t("Save")}
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Sign in with Google or Microsoft, for a new account or one to sign in
 * again: the buttons of the apps set up, then the page to open or the code
 * to type, waiting for the answer.
 */
export function OAuthSignIn({
  accountId,
  only,
  onDone,
}: {
  accountId?: string;
  /** Only this provider (signing an account in again). */
  only?: MailOAuthProvider;
  onDone?: (email: string) => void;
}) {
  const apps = useLive(() => api.mail.oauthApps(), {
    topics: ["mail"],
    refreshOn: (e) => e.type === "mail.oauth.updated",
  });
  const [started, setStarted] = useState<(MailOAuthStart & { provider: MailOAuthProvider }) | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const ready = (apps.data ?? []).filter((a) => a.ready && (!only || a.provider === only));
  // Waiting for the provider's answer: asked every second until done or failed.
  useEffect(() => {
    if (!started) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const s = await api.mail.oauthStatus({ id: started.id }).catch(() => null);
      if (stop) return;
      if (s?.state === "done") {
        toast.success(t("{email} is connected.", { email: s.email ?? "" }));
        setStarted(null);
        onDone?.(s.email ?? "");
        return;
      }
      if (s?.state === "failed") {
        setError(s.error);
        setStarted(null);
        return;
      }
      setTimeout(() => void tick(), 1000);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [started, onDone]);
  if (!apps.data) return null;
  if (!ready.length)
    return only ? (
      <div className="text-xs text-muted-foreground">
        {t("Set up {name}'s app in Settings → Mail to sign in again.", { name: NAME[only] })}
      </div>
    ) : null;
  const start = async (provider: MailOAuthProvider) => {
    setError(null);
    try {
      const s = await api.mail.oauthStart({ provider, ...(accountId ? { accountId } : {}) });
      setStarted({ ...s, provider });
      if (s.kind === "browser") window.open(s.url, "_blank", "noopener");
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {ready.map((a) => (
          <Button
            key={a.provider}
            type="button"
            size="sm"
            variant="secondary"
            disabled={!!started}
            onClick={() => void start(a.provider)}
          >
            {t("Sign in with {name}", { name: NAME[a.provider] })}
          </Button>
        ))}
      </div>
      {started?.kind === "browser" ? (
        <div className="text-xs text-muted-foreground">
          {t("Finish signing in on {name}'s page, opened in a new tab.", {
            name: NAME[started.provider],
          })}{" "}
          <a href={started.url} target="_blank" rel="noreferrer" className="text-primary underline">
            {t("Open it again")}
          </a>
        </div>
      ) : null}
      {started?.kind === "device" ? (
        <div className="space-y-1 rounded-md border p-2 text-xs">
          <div>
            {t("On {url}, type this code:", { url: started.verificationUri })}{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-sm">
              {started.userCode}
            </code>
          </div>
          <a
            href={started.verificationUri}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-primary underline"
          >
            <ExternalLink className="size-3" />
            {t("Open Microsoft's page")}
          </a>
          <div className="text-muted-foreground">{t("Waiting for you to sign in there…")}</div>
        </div>
      ) : null}
      {error ? <div className="text-xs text-destructive">{error}</div> : null}
    </div>
  );
}
