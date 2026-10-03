import type { MailAccountView, MailProvider, MailSecurity } from "@oraknid/contracts";
import { Mail, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { remote } from "@/lib/remote";

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(message(e));
  }
}

const STATE: Record<MailAccountView["state"], string> = {
  new: "connecting",
  syncing: "syncing",
  ready: "up to date",
  reconnect: "needs signing in again",
  error: "can't reach the server",
};

/**
 * Email accounts (ADR-032): Gmail, Outlook and any IMAP server, with a
 * password (app password) now, or OAuth once I add Google's or Microsoft's
 * app ids. Passwords and tokens go to the keychain. Adding and removing
 * accounts is done at home, never from away (ADR-029).
 */
export function MailAccountsCard() {
  const accounts = useLive(() => api.mail.accounts(), {
    topics: ["mail"],
    refreshOn: (e) => e.type.startsWith("mail.account") || e.type === "mail.oauth.updated",
  });
  const oauth = useLive(() => api.mail.oauthSettings(), {
    topics: ["mail"],
    refreshOn: (e) => e.type === "mail.oauth.updated",
  });
  const [adding, setAdding] = useState(false);
  const away = !!remote();
  if (!accounts.data || !oauth.data) return <Loading rows={2} />;
  const google = oauth.data.google.clientId && oauth.data.google.hasSecret;
  const microsoft = oauth.data.microsoft.clientId && oauth.data.microsoft.hasSecret;
  const signIn = (provider: "google" | "microsoft") =>
    act(async () => {
      const { url } = await api.mail.oauthStart({ provider });
      window.open(url, "_blank", "noopener");
    });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          {t("Email accounts")}
        </CardTitle>
        <CardDescription>
          {t(
            "Your mail in Oraknid, kept in step with the server. Agents with the email tool can read, sort and draft; what they write waits for your approval unless you turn on auto-send for the account.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {accounts.data.length === 0 && !adding ? (
          <div className="text-muted-foreground">{t("No account yet.")}</div>
        ) : null}
        {accounts.data.map((a) => (
          <AccountRow key={a.id} a={a} away={away} />
        ))}
        {away ? (
          <div className="text-xs text-muted-foreground">
            {t(
              "Accounts are added and removed on the computer running Oraknid, not away from home.",
            )}
          </div>
        ) : adding ? (
          <AddAccount onDone={() => setAdding(false)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" className="gap-1" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              {t("Add an account")}
            </Button>
            {google ? (
              <Button size="sm" variant="secondary" onClick={() => signIn("google")}>
                {t("Connect with Google")}
              </Button>
            ) : null}
            {microsoft ? (
              <Button size="sm" variant="secondary" onClick={() => signIn("microsoft")}>
                {t("Connect with Microsoft")}
              </Button>
            ) : null}
          </div>
        )}
        {away ? null : <OAuthApps redirectUri={oauth.data.redirectUri} settings={oauth.data} />}
      </CardContent>
    </Card>
  );
}

function AccountRow({ a, away }: { a: MailAccountView; away: boolean }) {
  return (
    <div className="space-y-2 rounded-md border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{a.name}</span>
        {a.name !== a.email ? <span className="text-muted-foreground">{a.email}</span> : null}
        <Badge variant={a.state === "reconnect" || a.state === "error" ? "destructive" : "outline"}>
          {t(STATE[a.state])}
        </Badge>
        <Badge variant="outline">
          {a.auth === "password" ? t("password") : a.auth === "google" ? "Google" : "Microsoft"}
        </Badge>
        <span className="flex-1" />
        {away ? null : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Remove {name}", { name: a.email })}
            onClick={() => {
              if (
                confirm(
                  t("Remove {email} from Oraknid? Your mail stays on the server.", {
                    email: a.email,
                  }),
                )
              )
                void act(
                  () => api.mail.removeAccount({ id: a.id }),
                  t("Removed; its password is deleted."),
                );
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
      {a.error ? <div className="text-xs text-destructive">{a.error}</div> : null}
      <div className="text-xs text-muted-foreground">
        {t("IMAP {imap} · SMTP {smtp}", { imap: a.imapHost, smtp: a.smtpHost })}
        {a.lastSyncAt ? ` · ${t("checked {when}", { when: ago(a.lastSyncAt) })}` : ""}
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <div className="flex items-center gap-2 text-xs">
          <Switch
            id={`auto-${a.id}`}
            checked={a.autoSend}
            disabled={away}
            onCheckedChange={(v) => act(() => api.mail.updateAccount({ id: a.id, autoSend: v }))}
          />
          <Label htmlFor={`auto-${a.id}`} className="text-xs font-normal">
            {t("Auto-send: agents' emails go out without asking me")}
          </Label>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <Switch
            id={`sent-${a.id}`}
            checked={a.appendSent}
            disabled={away}
            onCheckedChange={(v) => act(() => api.mail.updateAccount({ id: a.id, appendSent: v }))}
          />
          <Label htmlFor={`sent-${a.id}`} className="text-xs font-normal">
            {t("File what I send in Sent (off when the provider does it itself)")}
          </Label>
        </div>
      </div>
    </div>
  );
}

const SECURITY: { value: MailSecurity; label: string }[] = [
  { value: "tls", label: "TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "plain", label: "None (this computer only)" },
];

function AddAccount({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<MailProvider>("gmail");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [imap, setImap] = useState({ host: "", port: 993, security: "tls" as MailSecurity });
  const [smtp, setSmtp] = useState({ host: "", port: 465, security: "tls" as MailSecurity });
  const [busy, setBusy] = useState(false);
  const server = (label: string, v: typeof imap, set: (x: typeof imap) => void, id: string) => (
    <div className="grid gap-2 sm:grid-cols-[1fr_6rem_10rem]">
      <div className="space-y-1">
        <Label htmlFor={`${id}-host`}>{t("{p} server", { p: label })}</Label>
        <Input
          id={`${id}-host`}
          value={v.host}
          onChange={(e) => set({ ...v, host: e.target.value })}
          placeholder={`${id}.example.com`}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${id}-port`}>{t("Port")}</Label>
        <Input
          id={`${id}-port`}
          type="number"
          value={v.port}
          onChange={(e) => set({ ...v, port: Number(e.target.value) })}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Security")}</Label>
        <Select
          value={v.security}
          onValueChange={(s) => set({ ...v, security: s as MailSecurity })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SECURITY.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {t(s.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
  return (
    <form
      className="space-y-3 rounded-md border p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          await api.mail.addAccount({
            provider,
            email,
            name,
            password,
            ...(login ? { login } : {}),
            ...(provider === "imap" ? { imap, smtp } : {}),
          });
          toast.success(t("Connected. Your mail is on its way."));
          onDone();
        } catch (x) {
          toast.error(message(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label>{t("Provider")}</Label>
          <Select value={provider} onValueChange={(p) => setProvider(p as MailProvider)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="gmail">Gmail</SelectItem>
              <SelectItem value="outlook">{t("Outlook / Hotmail")}</SelectItem>
              <SelectItem value="imap">{t("Another IMAP server")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="mail-email">{t("Address")}</Label>
          <Input
            id="mail-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mail-name">{t("Name (optional)")}</Label>
          <Input
            id="mail-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Work")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="mail-password">
            {provider === "imap" ? t("Password") : t("App password")}
          </Label>
          <Input
            id="mail-password"
            type="password"
            required
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
      </div>
      {provider === "gmail" ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "Gmail: turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords.",
          )}
        </p>
      ) : provider === "outlook" ? (
        <p className="text-xs text-muted-foreground">
          {t(
            "Outlook: create an app password under Security → Advanced security options at account.microsoft.com.",
          )}
        </p>
      ) : (
        <>
          {server("IMAP", imap, setImap, "imap")}
          {server("SMTP", smtp, setSmtp, "smtp")}
          <div className="space-y-1">
            <Label htmlFor="mail-login">{t("Login, if not the address")}</Label>
            <Input id="mail-login" value={login} onChange={(e) => setLogin(e.target.value)} />
          </div>
        </>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !email || !password}>
          {busy ? t("Checking…") : t("Connect")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

/** Google's and Microsoft's app ids, for "Connect with…": until then, app passwords. */
function OAuthApps({
  redirectUri,
  settings,
}: {
  redirectUri: string;
  settings: {
    google: { clientId: string; hasSecret: boolean };
    microsoft: { clientId: string; hasSecret: boolean };
  };
}) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <button
        type="button"
        className="text-xs text-muted-foreground underline"
        onClick={() => setOpen(true)}
      >
        {t("Sign in with Google or Microsoft instead of app passwords…")}
      </button>
    );
  return (
    <div className="space-y-3 rounded-md border p-3">
      <p className="text-xs text-muted-foreground">
        {t(
          "Register Oraknid as an app with Google (Cloud Console → Credentials → OAuth client, type Desktop or Web) or Microsoft (Entra → App registrations), with this redirect address, then paste its client id and secret. The secret goes to the keychain.",
        )}
      </p>
      <code className="block rounded bg-muted px-2 py-1 text-xs [overflow-wrap:anywhere]">
        {redirectUri}
      </code>
      <OAuthApp provider="google" label="Google" current={settings.google} />
      <OAuthApp provider="microsoft" label="Microsoft" current={settings.microsoft} />
    </div>
  );
}

function OAuthApp({
  provider,
  label,
  current,
}: {
  provider: "google" | "microsoft";
  label: string;
  current: { clientId: string; hasSecret: boolean };
}) {
  const [clientId, setClientId] = useState(current.clientId);
  const [secret, setSecret] = useState("");
  return (
    <form
      className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        void act(
          async () => {
            await api.mail.setOAuth({
              provider,
              clientId,
              ...(secret ? { clientSecret: secret } : {}),
            });
            setSecret("");
          },
          clientId
            ? t("Saved: “Connect with {p}” is on.", { p: label })
            : t("{p} sign-in is off.", { p: label }),
        );
      }}
    >
      <div className="space-y-1">
        <Label htmlFor={`${provider}-id`}>{t("{p} client id", { p: label })}</Label>
        <Input
          id={`${provider}-id`}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`${provider}-secret`}>
          {current.hasSecret ? t("Client secret (kept; type to replace)") : t("Client secret")}
        </Label>
        <Input
          id={`${provider}-secret`}
          type="password"
          autoComplete="off"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        disabled={!!clientId && !current.hasSecret && !secret}
      >
        {t("Save")}
      </Button>
    </form>
  );
}
