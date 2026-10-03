import type { ServerView } from "@oraknid/contracts";
import { Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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

/** Adding a server over SSH (Servers → Adding one); from Servers, and from a project's servers. */
export function AddServer({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** The server just added, to open it or tick it. */
  onAdded?: (s: ServerView) => void;
}) {
  const [f, setF] = useState({
    name: "",
    host: "",
    port: "22",
    user: "root",
    description: "",
    password: "",
    privateKey: "",
    passphrase: "",
  });
  const [withKey, setWithKey] = useState(true);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      const added = await api.servers.add({
        name: f.name,
        host: f.host.trim(),
        port: Number(f.port) || 22,
        user: f.user.trim(),
        description: f.description,
        ...(withKey
          ? { privateKey: f.privateKey, ...(f.passphrase ? { passphrase: f.passphrase } : {}) }
          : { password: f.password }),
      });
      toast.success(t("Added. Set it up from its page."));
      onOpenChange(false);
      setF({ ...f, password: "", privateKey: "", passphrase: "" });
      onAdded?.(added);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Add a server")}</DialogTitle>
          <DialogDescription>
            {t(
              "Over SSH. Credentials go to the keychain; a password is used once, to install a key of Oraknid's own.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="sv-name">{t("Name")}</Label>
              <Input id="sv-name" value={f.name} onChange={set("name")} placeholder="staging" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sv-host">{t("Host")}</Label>
              <Input
                id="sv-host"
                className="font-mono"
                value={f.host}
                onChange={set("host")}
                placeholder="203.0.113.7"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="sv-port">{t("Port")}</Label>
                <Input id="sv-port" inputMode="numeric" value={f.port} onChange={set("port")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sv-user">{t("User")}</Label>
                <Input id="sv-user" value={f.user} onChange={set("user")} />
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sv-desc">{t("What it is and what it has")}</Label>
            <Textarea
              id="sv-desc"
              rows={3}
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
              onClick={() => setWithKey(true)}
            >
              {t("A private key")}
            </Button>
            <Button
              size="sm"
              variant={withKey ? "secondary" : "default"}
              aria-pressed={!withKey}
              onClick={() => setWithKey(false)}
            >
              {t("A password")}
            </Button>
          </div>
          {withKey ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="sv-key" className="flex-1">
                    {t("Private key")}
                  </Label>
                  <Button asChild size="sm" variant="ghost" className="h-7 gap-1">
                    <label className="cursor-pointer">
                      <Upload className="size-3.5" />
                      {t("From a file")}
                      <input
                        type="file"
                        className="sr-only"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) setF({ ...f, privateKey: await file.text() });
                        }}
                      />
                    </label>
                  </Button>
                </div>
                <Textarea
                  id="sv-key"
                  rows={4}
                  className="font-mono text-xs"
                  value={f.privateKey}
                  onChange={set("privateKey")}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </div>
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
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={
              busy || !f.name || !f.host || !f.user || (withKey ? !f.privateKey : !f.password)
            }
            onClick={save}
          >
            {busy ? t("Adding…") : t("Add")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
