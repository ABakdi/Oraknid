import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * Reaching Oraknid away from home through The Nest (Phase 4, Nest-Protocol):
 * where my Nest is, whether the daemon is connected to it, and a phone
 * paired for away by scanning a code shown here.
 */
export function AwayCard() {
  const status = useLive(() => api.nest.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("nest."),
  });
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [daemonId, setDaemonId] = useState("home-1");
  const [name, setName] = useState("My phone");
  const [link, setLink] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.data;

  useEffect(() => {
    if (!link) return setQr(null);
    QRCode.toDataURL(link, { margin: 1, width: 280 })
      .then(setQr)
      .catch(() => setQr(null));
  }, [link]);

  const configure = async () => {
    setBusy(true);
    try {
      await api.nest.configure({ url: url.trim(), secret, daemonId: daemonId.trim() });
      setSecret("");
      toast.success(t("Saved; the daemon connects to The Nest."));
      status.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const pair = async () => {
    try {
      setLink((await api.nest.pairAway({ name })).link);
    } catch (e) {
      toast.error(message(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("Away from home")}
          {s?.configured ? (
            <Badge variant={s.connected ? "default" : "secondary"}>
              {s.connected ? t("connected to The Nest") : t("not connected")}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {t(
            "Through The Nest, the relay you host: it carries only encrypted traffic between your devices and this daemon, and keeps nothing.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {s?.error ? <div className="text-destructive">{s.error}</div> : null}
        {s?.configured ? (
          <div className="space-y-1 text-xs text-muted-foreground">
            <div className="[overflow-wrap:anywhere]">
              {t("Nest: {url} · this daemon: {id}", { url: s.url ?? "", id: s.daemonId ?? "" })}
            </div>
            <div className="[overflow-wrap:anywhere]">
              {t("This daemon's key: {key}", { key: s.publicKey ?? "" })}
            </div>
            {s.loaderHash ? (
              <div className="[overflow-wrap:anywhere]">
                {t("Loader {hash}: the Nest's page should show the same; if not, don't use it.", {
                  hash: s.loaderHash,
                })}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="nest-url">{t("The Nest's address")}</Label>
            <Input
              id="nest-url"
              className="font-mono"
              placeholder="https://nest.example.com"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nest-secret">{t("This daemon's secret at The Nest")}</Label>
            <Input
              id="nest-secret"
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="nest-id">{t("This daemon's id at The Nest (as in NEST_DAEMONS)")}</Label>
          <Input
            id="nest-id"
            className="w-48 font-mono"
            value={daemonId}
            onChange={(e) => setDaemonId(e.target.value)}
          />
        </div>
        <Button
          disabled={busy || !url.trim() || secret.length < 16 || !daemonId.trim()}
          onClick={configure}
        >
          {s?.configured ? t("Change and reconnect") : t("Connect to The Nest")}
        </Button>
        {s?.configured ? (
          <div className="space-y-2 border-t pt-4">
            <div className="font-medium">{t("Pair a device for away")}</div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="away-name">{t("Its name")}</Label>
                <Input id="away-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <Button variant="secondary" disabled={!name.trim()} onClick={pair}>
                {t("Make its link")}
              </Button>
            </div>
            {link ? (
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">
                  {t(
                    "Scan it with that device, or open the link on it. The keys are in the part after #, which a browser never sends to The Nest. Don't share it: it is that device's key.",
                  )}
                </div>
                {qr ? (
                  <img src={qr} alt={t("Pairing code")} className="size-56 rounded bg-white p-1" />
                ) : null}
                <div className="flex gap-2">
                  <Input readOnly className="font-mono text-xs" value={link} />
                  <Button
                    variant="secondary"
                    onClick={() =>
                      navigator.clipboard
                        ?.writeText(link)
                        .then(() => toast.success(t("Copied.")))
                        .catch(() => {})
                    }
                  >
                    {t("Copy")}
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
