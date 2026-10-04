import type { ServerTestResult, ServerView } from "@oraknid/contracts";
import { CircleAlert, CircleCheck, FileKey, PlugZap, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PolishButton } from "@/components/polish-button";
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
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** What a key file or a pasted key looks like, read here before anything is sent. */
export interface KeyLook {
  /** A private key Oraknid can likely read. */
  ok: boolean;
  /** "OpenSSH private key", or what's wrong with it. */
  label: string;
  /** It has a passphrase (as far as can be seen). */
  encrypted: boolean;
}

/**
 * A light look at a key (Servers → Adding one): the kind of private key it
 * is and whether it has a passphrase, or that it is a public key (.pub) or
 * no key at all. The daemon says the last word when it connects.
 */
export function lookAtKey(text: string): KeyLook {
  const s = text.trim();
  if (!s) return { ok: false, label: t("No key"), encrypted: false };
  if (
    /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+) [A-Za-z0-9+/=]+/.test(s) ||
    /BEGIN SSH2 PUBLIC KEY/.test(s)
  )
    return {
      ok: false,
      label: t("This is a public key (.pub): give the private one, the file without .pub."),
      encrypted: false,
    };
  const pem = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----/.exec(s);
  if (pem) {
    const kind = (pem[1] ?? "").trim();
    if (kind === "OPENSSH")
      return { ok: true, label: t("OpenSSH private key"), encrypted: openSshEncrypted(s) };
    if (kind === "ENCRYPTED") return { ok: true, label: t("PKCS#8 private key"), encrypted: true };
    const encrypted = /Proc-Type:\s*4,ENCRYPTED/.test(s);
    return {
      ok: true,
      label: kind ? t("{kind} private key (PEM)", { kind }) : t("PKCS#8 private key"),
      encrypted,
    };
  }
  if (/^PuTTY-User-Key-File-\d/.test(s))
    return {
      ok: true,
      label: t("PuTTY private key"),
      encrypted: !/Encryption:\s*none/.test(s),
    };
  return { ok: false, label: t("This doesn't look like a private key."), encrypted: false };
}

/** An OpenSSH key names its cipher right after its magic: "none" when it has no passphrase. */
function openSshEncrypted(pem: string): boolean {
  try {
    const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    const bin = atob(body.slice(0, 64));
    const magic = "openssh-key-v1\0";
    if (!bin.startsWith(magic)) return false;
    const at = magic.length;
    const len =
      (bin.charCodeAt(at) << 24) |
      (bin.charCodeAt(at + 1) << 16) |
      (bin.charCodeAt(at + 2) << 8) |
      bin.charCodeAt(at + 3);
    return bin.slice(at + 4, at + 4 + len) !== "none";
  } catch {
    return false;
  }
}

const EMPTY = {
  name: "",
  host: "",
  port: "22",
  user: "root",
  description: "",
  password: "",
  privateKey: "",
  passphrase: "",
};

/**
 * Adding a server over SSH (Servers → Adding one), from Servers and from a
 * project's servers; with `server`, the same dialog edits it (Servers →
 * Editing a server): every field, and credentials left empty are kept.
 * Test connection tries the form as it is, before anything is saved.
 */
export function AddServer({
  open,
  onOpenChange,
  onAdded,
  server,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The server just added (or saved), to open it or tick it. */
  onAdded?: (s: ServerView) => void;
  /** The server to edit; without it, a new one. */
  server?: ServerView;
}) {
  const editing = !!server;
  const fromServer = (s: ServerView) => ({
    ...EMPTY,
    name: s.name,
    host: s.host,
    port: String(s.port),
    user: s.user,
    description: s.description,
  });
  const [f, setF] = useState(() => (server ? fromServer(server) : EMPTY));
  const [withKey, setWithKey] = useState(server?.auth !== "password");
  // The key file is the way to give a key; pasting it is the other.
  const [paste, setPaste] = useState(false);
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<ServerTestResult | null>(null);
  const [opened, setOpened] = useState(open);
  // Opened again: the form starts from the server as it is now.
  if (open !== opened) {
    setOpened(open);
    if (open) {
      setF(server ? fromServer(server) : { ...EMPTY, ...keepTyped(f) });
      setWithKey(server ? server.auth !== "password" : withKey);
      setTested(null);
      setKeyFile(null);
      setPaste(false);
    }
  }
  const change = (patch: Partial<typeof f>) => {
    setF({ ...f, ...patch });
    setTested(null);
  };
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    change({ [k]: e.target.value });
  const look = f.privateKey ? lookAtKey(f.privateKey) : null;
  const readKey = async (file: File | undefined) => {
    if (!file) return;
    // A key is a few KB: anything much bigger is another file.
    if (file.size > 64 * 1024) {
      toast.error(t("That file is too big to be an SSH key."));
      return;
    }
    setKeyFile(file.name);
    change({ privateKey: await file.text() });
  };
  const creds = () =>
    withKey
      ? {
          ...(f.privateKey.trim() ? { privateKey: f.privateKey } : {}),
          ...(f.passphrase ? { passphrase: f.passphrase } : {}),
        }
      : f.password
        ? { password: f.password }
        : {};
  const port = Number(f.port) || 22;
  const test = async () => {
    setTesting(true);
    setTested(null);
    try {
      setTested(
        await api.servers.test({
          ...(server ? { id: server.id } : {}),
          host: f.host.trim(),
          port,
          user: f.user.trim(),
          ...creds(),
        }),
      );
    } catch (e) {
      toast.error(message(e));
    } finally {
      setTesting(false);
    }
  };
  const save = async () => {
    setBusy(true);
    try {
      let saved: ServerView;
      if (server) {
        const fields = {
          name: f.name.trim(),
          host: f.host.trim(),
          port,
          user: f.user.trim(),
          description: f.description,
        };
        saved = await api.servers.update({
          id: server.id,
          // What changed, and new credentials if any.
          ...Object.fromEntries(
            Object.entries(fields).filter(([k, v]) => server[k as keyof typeof fields] !== v),
          ),
          ...creds(),
        });
        toast.success(t("Saved."));
      } else {
        saved = await api.servers.add({
          name: f.name.trim(),
          host: f.host.trim(),
          port,
          user: f.user.trim(),
          description: f.description,
          ...(withKey
            ? { privateKey: f.privateKey, ...(f.passphrase ? { passphrase: f.passphrase } : {}) }
            : { password: f.password }),
        });
        toast.success(t("Added. Set it up from its page."));
      }
      onOpenChange(false);
      setF({ ...f, password: "", privateKey: "", passphrase: "" });
      setKeyFile(null);
      onAdded?.(saved);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const hasCreds = withKey ? !!f.privateKey.trim() : !!f.password;
  const keyBad = withKey && look !== null && !look.ok;
  const canTry = !!f.host.trim() && !!f.user.trim() && (hasCreds || editing) && !keyBad;
  const canSave = !!f.name.trim() && canTry && !busy;
  const keeps = server
    ? server.auth === "oraknid-key"
      ? t("Empty: Oraknid's own key stays in use.")
      : server.auth === "my-key"
        ? t("Empty: the key you gave stays.")
        : t("Empty: the password you gave stays.")
    : null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* One column that never grows past the dialog: a long key scrolls in its box. */}
      <DialogContent className="max-h-[92vh] grid-cols-[minmax(0,1fr)] overflow-x-hidden overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {server ? t("Edit {name}", { name: server.name }) : t("Add a server")}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t(
                  "Change anything, and test it before saving. A new address forgets the pinned host key.",
                )
              : t(
                  "Over SSH. Credentials go to the keychain; a password is used once, to install a key of Oraknid's own.",
                )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="sv-name">{t("Name")}</Label>
              <Input id="sv-name" value={f.name} onChange={set("name")} placeholder="staging" />
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="sv-host">{t("Host")}</Label>
              <Input
                id="sv-host"
                className="font-mono"
                value={f.host}
                onChange={set("host")}
                placeholder="203.0.113.7"
              />
            </div>
            <div className="grid min-w-0 grid-cols-2 gap-2">
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="sv-port">{t("Port")}</Label>
                <Input id="sv-port" inputMode="numeric" value={f.port} onChange={set("port")} />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="sv-user">{t("User")}</Label>
                <Input id="sv-user" value={f.user} onChange={set("user")} />
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="sv-desc" className="flex-1">
                {t("What it is and what it has")}
              </Label>
              <PolishButton
                kind="server-description"
                value={f.description}
                onChange={(description) => change({ description })}
              />
            </div>
            <Textarea
              id="sv-desc"
              rows={3}
              className="max-h-40"
              value={f.description}
              onChange={set("description")}
              placeholder={t("The VPS for my sites: nginx, two Node apps under pm2, Postgres.")}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={withKey ? "default" : "secondary"}
              aria-pressed={withKey}
              onClick={() => {
                setWithKey(true);
                setTested(null);
              }}
            >
              {t("A private key")}
            </Button>
            <Button
              size="sm"
              variant={withKey ? "secondary" : "default"}
              aria-pressed={!withKey}
              onClick={() => {
                setWithKey(false);
                setTested(null);
              }}
            >
              {t("A password")}
            </Button>
          </div>
          {withKey ? (
            <>
              {paste ? (
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Label htmlFor="sv-key" className="flex-1">
                      {t("Private key")}
                    </Label>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7"
                      onClick={() => {
                        setPaste(false);
                        setKeyFile(null);
                        change({ privateKey: "" });
                      }}
                    >
                      {t("Choose a file instead")}
                    </Button>
                  </div>
                  {/* Fixed in size: a pasted key scrolls inside, it never widens the dialog. */}
                  <Textarea
                    id="sv-key"
                    wrap="off"
                    spellCheck={false}
                    autoComplete="off"
                    className="field-sizing-fixed h-28 min-h-28 w-full min-w-0 resize-none overflow-auto font-mono text-xs whitespace-pre md:text-xs"
                    value={f.privateKey}
                    onChange={set("privateKey")}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                  />
                </div>
              ) : (
                <div className="min-w-0 space-y-1.5">
                  <Label htmlFor="sv-key-file">{t("Private key")}</Label>
                  <label
                    htmlFor="sv-key-file"
                    className={cn(
                      "flex min-w-0 cursor-pointer items-center gap-3 rounded-md border border-dashed px-3 py-3 hover:bg-accent",
                      keyBad && "border-destructive",
                    )}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      void readKey(e.dataTransfer.files[0]);
                    }}
                  >
                    {keyFile ? (
                      <FileKey className="size-5 shrink-0" />
                    ) : (
                      <Upload className="size-5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1">
                      {keyFile ? (
                        <span className="block truncate font-medium" title={keyFile}>
                          {keyFile}
                          {look ? ` · ${look.ok ? look.label : t("not a private key")}` : ""}
                        </span>
                      ) : (
                        <span className="block font-medium">{t("Choose the key file")}</span>
                      )}
                      <span className="block text-xs text-muted-foreground">
                        {keyFile
                          ? t(
                              "Read here; sent to the keychain when you save. Click to choose another.",
                            )
                          : t(
                              "Or drop it here. Usually ~/.ssh/id_ed25519 (not the .pub); in the file picker, Ctrl+H shows hidden folders.",
                            )}
                      </span>
                    </span>
                    <input
                      id="sv-key-file"
                      type="file"
                      className="sr-only"
                      onChange={(e) => {
                        void readKey(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2"
                    onClick={() => {
                      setPaste(true);
                      setKeyFile(null);
                      change({ privateKey: "" });
                    }}
                  >
                    {t("Paste it instead")}
                  </button>
                </div>
              )}
              {look ? (
                <div
                  className={cn(
                    "flex items-start gap-1.5 text-xs",
                    look.ok ? "text-muted-foreground" : "text-destructive",
                  )}
                >
                  {look.ok ? (
                    <CircleCheck className="mt-px size-3.5 shrink-0 text-success" />
                  ) : (
                    <CircleAlert className="mt-px size-3.5 shrink-0" />
                  )}
                  <span>
                    {look.ok
                      ? look.encrypted
                        ? t("{kind}, with a passphrase: type it below.", { kind: look.label })
                        : t("{kind} read.", { kind: look.label })
                      : look.label}
                  </span>
                </div>
              ) : keeps ? (
                <div className="text-xs text-muted-foreground">{keeps}</div>
              ) : null}
              <div className="space-y-1.5">
                <Label htmlFor="sv-pass">{t("Its passphrase, if it has one")}</Label>
                <Input
                  id="sv-pass"
                  type="password"
                  autoComplete="off"
                  value={f.passphrase}
                  onChange={set("passphrase")}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="sv-pw">{t("Password")}</Label>
              <Input
                id="sv-pw"
                type="password"
                autoComplete="off"
                value={f.password}
                onChange={set("password")}
              />
              {keeps && !f.password ? (
                <div className="text-xs text-muted-foreground">{keeps}</div>
              ) : null}
            </div>
          )}
          {tested ? (
            <div
              role="status"
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-sm [overflow-wrap:anywhere]",
                tested.ok
                  ? "border-success/40 bg-success/10"
                  : "border-destructive/40 bg-destructive/10 text-destructive",
              )}
            >
              {tested.ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
              ) : (
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
              )}
              <div className="min-w-0 space-y-1">
                <div>{tested.said}</div>
                {tested.fingerprint ? (
                  <div className="font-mono text-xs text-muted-foreground">
                    {t("Host key")} {tested.fingerprint}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter className="sm:items-center">
          <Button
            variant="secondary"
            className="gap-1 sm:mr-auto"
            disabled={!canTry || testing}
            onClick={test}
          >
            <PlugZap className="size-4" />
            {testing ? t("Testing…") : t("Test connection")}
          </Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {editing ? (busy ? t("Saving…") : t("Save")) : busy ? t("Adding…") : t("Add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What I typed in a new server's form stays when I open it again, secrets aside. */
const keepTyped = (f: typeof EMPTY) => ({
  name: f.name,
  host: f.host,
  port: f.port,
  user: f.user,
  description: f.description,
});
