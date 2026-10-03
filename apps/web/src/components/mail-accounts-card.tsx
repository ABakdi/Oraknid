import type {
  MailAccountView,
  MailDetected,
  MailProtocol,
  MailProvider,
  MailSecurity,
  MailTestResult,
} from "@oraknid/contracts";
import { ExternalLink, Mail, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

export const ACCOUNT_STATE: Record<MailAccountView["state"], string> = {
  new: "connecting",
  syncing: "syncing",
  ready: "up to date",
  reconnect: "needs signing in again",
  error: "can't reach the server",
};

/**
 * Email accounts (ADR-032): Gmail, Outlook and any IMAP or POP3 server,
 * with a password (an app password for Gmail and Outlook). Passwords go
 * to the keychain. Adding and removing accounts is done at home, never
 * from away (ADR-029). The Mail page offers the same, account by account.
 */
export function MailAccountsCard() {
  const accounts = useLive(() => api.mail.accounts(), {
    topics: ["mail"],
    refreshOn: (e) => e.type.startsWith("mail.account"),
  });
  const [adding, setAdding] = useState(false);
  const { confirm, dialog } = useConfirm();
  const away = !!remote();
  if (!accounts.data) return <Loading rows={2} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="size-4" />
          {t("Email accounts")}
        </CardTitle>
        <CardDescription>
          {t(
            "Your mail in Oraknid, by IMAP (kept in step with the server) or POP3 (downloaded here). Agents with the email tool can read, sort and draft; what they write waits for your approval unless you turn on auto-send for the account.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {accounts.data.length === 0 && !adding ? (
          <div className="text-muted-foreground">{t("No account yet.")}</div>
        ) : null}
        {accounts.data.map((a) => (
          <div key={a.id} className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{a.name}</span>
              {a.name !== a.email ? <span className="text-muted-foreground">{a.email}</span> : null}
              <Badge
                variant={a.state === "reconnect" || a.state === "error" ? "destructive" : "outline"}
              >
                {t(ACCOUNT_STATE[a.state])}
              </Badge>
              <span className="flex-1" />
              {away ? null : (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Remove {name}", { name: a.email })}
                  onClick={() => void removeAccount(a, confirm)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
            {a.error ? <div className="text-xs text-destructive">{a.error}</div> : null}
            <AccountSettings account={a} away={away} />
          </div>
        ))}
        {away ? (
          <div className="text-xs text-muted-foreground">
            {t(
              "Accounts are added and removed on the computer running Oraknid, not away from home.",
            )}
          </div>
        ) : adding ? (
          <div className="rounded-md border p-3">
            <AddAccountForm onDone={() => setAdding(false)} />
          </div>
        ) : (
          <Button size="sm" variant="secondary" className="gap-1" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t("Add an account")}
          </Button>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}

/** Out of Oraknid, after a second step: its password and what was kept here go; the server keeps its mail. */
export async function removeAccount(
  a: MailAccountView,
  confirm: ReturnType<typeof useConfirm>["confirm"],
): Promise<boolean> {
  const ok = await confirm(
    t("Remove {email}?", { email: a.email }),
    a.protocol === "pop"
      ? t(
          "Its password and the mail downloaded into Oraknid are deleted here. What is still on the server stays there.",
        )
      : t("Its password and the copy kept in Oraknid are deleted. Your mail stays on the server."),
    t("Remove"),
  );
  if (!ok) return false;
  try {
    await api.mail.removeAccount({ id: a.id });
    toast.success(t("Removed; its password is deleted."));
    return true;
  } catch (e) {
    toast.error(message(e));
    return false;
  }
}

/** The servers, when it was checked, and the account's switches. */
export function AccountSettings({ account: a, away }: { account: MailAccountView; away: boolean }) {
  const set = (patch: { autoSend?: boolean; appendSent?: boolean; deleteFromServer?: boolean }) =>
    act(() => api.mail.updateAccount({ id: a.id, ...patch }));
  const toggle = (id: string, checked: boolean, label: string, on: (v: boolean) => void) => (
    <div className="flex items-start gap-2 text-xs">
      <Switch id={`${id}-${a.id}`} checked={checked} disabled={away} onCheckedChange={on} />
      <Label htmlFor={`${id}-${a.id}`} className="text-xs leading-snug font-normal">
        {label}
      </Label>
    </div>
  );
  return (
    <div className="space-y-2">
      <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {a.protocol === "pop"
          ? t("POP3 {host} · SMTP {smtp}", { host: a.incomingHost, smtp: a.smtpHost })
          : t("IMAP {host} · SMTP {smtp}", { host: a.incomingHost, smtp: a.smtpHost })}
        {a.lastSyncAt ? ` · ${t("checked {when}", { when: ago(a.lastSyncAt) })}` : ""}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {toggle("auto", a.autoSend, t("Auto-send: agents' emails go out without asking me"), (v) =>
          set({ autoSend: v }),
        )}
        {toggle(
          "sent",
          a.appendSent,
          a.protocol === "pop"
            ? t("Keep a copy of what I send in Sent")
            : t("File what I send in Sent (off when the provider does it itself)"),
          (v) => set({ appendSent: v }),
        )}
        {a.protocol === "pop"
          ? toggle(
              "delete",
              a.deleteFromServer,
              t(
                "Delete from the server too when I delete a message for good (off: it stays there)",
              ),
              (v) => set({ deleteFromServer: v }),
            )
          : null}
      </div>
      {away ? (
        <div className="text-xs text-muted-foreground">
          {t("These are changed on the computer running Oraknid.")}
        </div>
      ) : null}
    </div>
  );
}

/** "Reconnect": a new password after it changed; or, after a network failure, the one kept. */
export function ReconnectDialog({
  account,
  open,
  onOpenChange,
}: {
  account: MailAccountView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [password, setPassword] = useState("");
  const needed = account.state === "reconnect";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Reconnect {email}", { email: account.email })}</DialogTitle>
          <DialogDescription>
            {needed
              ? t(
                  "Give its new password (an app password for Gmail and Outlook). It goes to the keychain.",
                )
              : t(
                  "Oraknid connects again with the password it keeps. Give a new one only if it changed.",
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await api.mail.reconnect({ id: account.id, ...(password ? { password } : {}) });
              setPassword("");
              onOpenChange(false);
            }, t("Connecting again."));
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            aria-label={t("Password")}
            placeholder={needed ? t("Password") : t("New password (optional)")}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button type="submit" disabled={needed && !password}>
            {t("Reconnect")}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Adding an account, in a dialog: the Mail page's own way in. */
export function AddAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("Add an email account")}</DialogTitle>
          <DialogDescription>
            {t("With an app password for Gmail and Outlook, or any IMAP or POP3 server.")}
          </DialogDescription>
        </DialogHeader>
        {open ? <AddAccountForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

const SECURITY: { value: MailSecurity; label: string }[] = [
  { value: "tls", label: "TLS" },
  { value: "starttls", label: "STARTTLS" },
  { value: "plain", label: "None (this computer only)" },
];

/** Where each provider makes its app passwords, and what POP needs turned on. */
const HINTS: Record<"gmail" | "outlook", { app: string; url: string; label: string; pop: string }> =
  {
    gmail: {
      app: "Gmail: turn on 2-Step Verification, then create an app password and paste it here.",
      url: "https://myaccount.google.com/apppasswords",
      label: "Create a Google app password",
      pop: "For POP, first turn it on in Gmail: Settings → Forwarding and POP/IMAP.",
    },
    outlook: {
      app: "Outlook: turn on two-step verification, then create an app password under Advanced security options.",
      url: "https://account.microsoft.com/security",
      label: "Open Microsoft account security",
      pop: "For POP, first turn it on in Outlook.com: Settings → Mail → Forwarding and IMAP.",
    },
  };

type ServerFields = { host: string; port: number; security: MailSecurity };

/** The default port of each way in, so switching IMAP and POP moves it along. */
const PORTS: Record<MailProtocol, number> = { imap: 993, pop: 995 };

/** The usual port of each side for TLS from the start and for STARTTLS: they move together. */
const USUAL: Record<string, { tls: number; starttls: number }> = {
  imap: { tls: 993, starttls: 143 },
  pop: { tls: 995, starttls: 110 },
  smtp: { tls: 465, starttls: 587 },
};
const securityOf = (port: number): MailSecurity | null =>
  [993, 995, 465].includes(port) ? "tls" : [143, 110, 587].includes(port) ? "starttls" : null;

export function AddAccountForm({ onDone }: { onDone: () => void }) {
  const [provider, setProvider] = useState<MailProvider>("gmail");
  const [protocol, setProtocol] = useState<MailProtocol>("imap");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [incoming, setIncoming] = useState<ServerFields>({
    host: "",
    port: 993,
    security: "tls",
  });
  const [smtp, setSmtp] = useState<ServerFields>({ host: "", port: 465, security: "tls" });
  const [deleteFromServer, setDeleteFromServer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<MailDetected | null>(null);
  const [tested, setTested] = useState<MailTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  /** The servers found from the address's MX records, filled in where I typed nothing. */
  const detect = async () => {
    if (provider !== "imap" || !email.includes("@")) return;
    const d = await api.mail.detect({ email }).catch(() => null);
    setFound(d);
    if (!d) return;
    const theirs = protocol === "pop" ? (d.pop ?? d.imap) : (d.imap ?? d.pop);
    if (protocol === "pop" && !d.pop && d.imap) setProtocol("imap");
    if (theirs && !incoming.host) setIncoming(theirs);
    if (!smtp.host) setSmtp(d.smtp);
  };
  const payload = () => ({
    provider,
    protocol,
    email,
    name,
    password,
    deleteFromServer: protocol === "pop" && deleteFromServer,
    ...(login ? { login } : {}),
    ...(provider === "imap"
      ? protocol === "pop"
        ? { pop: incoming, smtp }
        : { imap: incoming, smtp }
      : {}),
  });
  const pickProtocol = (p: MailProtocol) => {
    setProtocol(p);
    // The other way's default port follows; one I typed stays.
    const theirs = found ? (p === "pop" ? found.pop : found.imap) : null;
    if (
      theirs &&
      (!incoming.host || incoming.host === (protocol === "pop" ? found?.pop : found?.imap)?.host)
    )
      setIncoming(theirs);
    else if (incoming.port === PORTS[protocol]) setIncoming({ ...incoming, port: PORTS[p] });
  };
  const hint = provider === "imap" ? null : HINTS[provider];
  const server = (label: string, v: ServerFields, set: (x: ServerFields) => void, id: string) => (
    <div className="grid gap-2 sm:grid-cols-[1fr_6rem_10rem]">
      <div className="space-y-1">
        <Label htmlFor={`${id}-host`}>{t("{p} server", { p: label })}</Label>
        <Input
          id={`${id}-host`}
          value={v.host}
          required
          onChange={(e) => set({ ...v, host: e.target.value })}
          placeholder={`${id}.example.com`}
        />
      </div>
      <div className="grid grid-cols-[6rem_1fr] gap-2 sm:contents">
        <div className="space-y-1">
          <Label htmlFor={`${id}-port`}>{t("Port")}</Label>
          <Input
            id={`${id}-port`}
            type="number"
            value={v.port}
            onChange={(e) => {
              const port = Number(e.target.value);
              set({ ...v, port, security: securityOf(port) ?? v.security });
            }}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${id}-security`}>{t("Security")}</Label>
          <Select
            value={v.security}
            onValueChange={(s) => {
              const security = s as MailSecurity;
              const usual = USUAL[id];
              // A usual port follows its security; one I typed stays.
              const moved =
                usual && (security === "tls" || security === "starttls") && securityOf(v.port)
                  ? usual[security]
                  : v.port;
              set({ ...v, security, port: moved });
            }}
          >
            <SelectTrigger id={`${id}-security`} className="w-full">
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
    </div>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.mail.addAccount(payload());
          toast.success(t("Connected. Your mail is on its way."));
          onDone();
        } catch (x) {
          setError(message(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Choice
        label={t("Provider")}
        value={provider}
        onChange={setProvider}
        options={[
          { value: "gmail", label: "Gmail" },
          { value: "outlook", label: t("Outlook / Hotmail") },
          { value: "imap", label: t("Another server") },
        ]}
      />
      <Choice
        label={t("Incoming mail")}
        value={protocol}
        onChange={pickProtocol}
        options={[
          { value: "imap", label: "IMAP" },
          { value: "pop", label: "POP3" },
        ]}
      />
      <p className="text-xs text-muted-foreground">
        {protocol === "pop"
          ? t(
              "POP3: new mail is downloaded into Oraknid every two minutes; folders, read and starred are kept here.",
            )
          : t("IMAP: kept in step with the server, so other mail apps see what you do here.")}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="mail-email">{t("Address")}</Label>
          <Input
            id="mail-email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onBlur={() => void detect()}
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
        <div className="space-y-1">
          <Label htmlFor="mail-name">{t("Name (optional)")}</Label>
          <Input
            id="mail-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Work")}
          />
        </div>
      </div>
      {hint ? (
        <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-xs">
          <p>{t(hint.app)}</p>
          <a
            href={hint.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium underline"
          >
            {t(hint.label)}
            <ExternalLink className="size-3" />
          </a>
          {protocol === "pop" ? <p>{t(hint.pop)}</p> : null}
        </div>
      ) : (
        <>
          {found ? (
            <div className="space-y-1 rounded-md bg-muted px-3 py-2 text-xs">
              <p>
                {t("Found from the address: {name}. Its servers are filled in below.", {
                  name: found.name,
                })}
              </p>
              {found.hint ? <p>{t(found.hint)}</p> : null}
              {protocol === "pop" && !found.pop ? (
                <p>{t("This provider has no POP3: use IMAP.")}</p>
              ) : null}
            </div>
          ) : null}
          {server(protocol === "pop" ? "POP3" : "IMAP", incoming, setIncoming, protocol)}
          {server("SMTP", smtp, setSmtp, "smtp")}
          <div className="space-y-1">
            <Label htmlFor="mail-login">{t("Login, if not the address")}</Label>
            <Input id="mail-login" value={login} onChange={(e) => setLogin(e.target.value)} />
          </div>
        </>
      )}
      {protocol === "pop" ? (
        <div className="flex items-start gap-2 text-xs">
          <Switch
            id="mail-delete-from-server"
            checked={deleteFromServer}
            onCheckedChange={setDeleteFromServer}
          />
          <Label htmlFor="mail-delete-from-server" className="text-xs leading-snug font-normal">
            {t("Delete from the server too when I delete a message for good (off: it stays there)")}
          </Label>
        </div>
      ) : null}
      {tested ? (
        <ul className="space-y-1 text-xs" aria-label={t("Test results")}>
          {[tested.incoming, tested.smtp].map((r) => (
            <li
              key={r.message}
              className={r.ok ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}
            >
              {r.ok ? "✓ " : "✗ "}
              {r.message}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive [overflow-wrap:anywhere]">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy || !email || !password}>
          {busy ? t("Checking…") : t("Connect")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={testing || busy || !email || !password}
          onClick={async () => {
            setTesting(true);
            setError(null);
            setTested(null);
            try {
              setTested(await api.mail.testAccount(payload()));
            } catch (x) {
              setError(message(x));
            } finally {
              setTesting(false);
            }
          }}
        >
          {testing ? t("Testing…") : t("Test")}
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

/** A few choices side by side, as one radio group: easy to tap on a phone. */
function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="space-y-1">
      <div className="text-sm font-medium">{label}</div>
      <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
        {options.map((o) => (
          <Button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            size="sm"
            variant={value === o.value ? "default" : "outline"}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
