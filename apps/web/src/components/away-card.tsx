import QRCode from "qrcode";
import type React from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** The public Nest offered first (ADR-031). */
const PUBLIC_NEST = "https://oraknid.abakdi.com";

/**
 * Reaching Oraknid away from home through The Nest (Phase 4, Nest-Protocol):
 * a public Nest this daemon registers on in one step (ADR-031), or my own
 * with its id and secret; and whether the daemon is connected to it.
 */
export function AwayCard() {
  const status = useLive(() => api.nest.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("nest."),
  });
  const [choice, setChoice] = useState<"public" | "own" | null>(null);
  const [publicUrl, setPublicUrl] = useState(PUBLIC_NEST);
  const [invite, setInvite] = useState("");
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [daemonId, setDaemonId] = useState("home-1");
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const mode = choice ?? (s?.configured ? "own" : "public");

  const register = async () => {
    setBusy(true);
    try {
      await api.nest.register({ url: publicUrl.trim(), invite: invite.trim() || undefined });
      setInvite("");
      toast.success(t("Registered; the daemon connects to The Nest."));
      status.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };

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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t("The Nest")}
          {s?.configured ? (
            <Badge variant={s.connected ? "default" : "secondary"}>
              {s.connected ? t("connected to The Nest") : t("not connected")}
            </Badge>
          ) : null}
        </CardTitle>
        <CardDescription>
          {t(
            "Through The Nest, a relay: it carries only encrypted traffic between your devices and this daemon, and can't read it. Use a public one, or host your own.",
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
        <div className="flex flex-wrap gap-2">
          <Button
            data-help="settings.nest-public"
            size="sm"
            variant={mode === "public" ? "default" : "outline"}
            aria-pressed={mode === "public"}
            onClick={() => setChoice("public")}
          >
            {t("Use a public Nest")}
          </Button>
          <Button
            size="sm"
            variant={mode === "own" ? "default" : "outline"}
            aria-pressed={mode === "own"}
            onClick={() => setChoice("own")}
          >
            {t("My own Nest")}
          </Button>
        </div>
        {mode === "public" ? (
          <>
            <div className="text-xs text-muted-foreground">
              {t(
                "The daemon registers itself there and gets its own id and secret. The Nest sees when you connect and how much, never what.",
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="nest-public-url">{t("The Nest's address")}</Label>
                <Input
                  id="nest-public-url"
                  className="font-mono"
                  value={publicUrl}
                  onChange={(e) => setPublicUrl(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="nest-invite">{t("Invite code (if it asks for one)")}</Label>
                <Input
                  id="nest-invite"
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                />
              </div>
            </div>
            <Button disabled={busy || !publicUrl.trim()} onClick={register}>
              {t("Register")}
            </Button>
          </>
        ) : (
          <>
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
              <Label htmlFor="nest-id">
                {t("This daemon's id at The Nest (as in NEST_DAEMONS)")}
              </Label>
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
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * My phone, from anywhere, in one step (ADR-029): what is missing first
 * (The Nest, the PIN), then one button and a big code to scan. The code
 * expires unused after ten minutes; this card says when the phone used it.
 */
export function PhoneCard() {
  const nest = useLive(() => api.nest.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("nest."),
  });
  const lock = useLive(() => api.lock.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("lock."),
  });
  const devices = useLive(() => api.devices.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("device."),
  });
  const [name, setName] = useState("My phone");
  const [full, setFull] = useState(false);
  const [pin, setPin] = useState("");
  const [pairing, setPairing] = useState<{ link: string; deviceId: string; until: number } | null>(
    null,
  );
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new code starts the watch; reload is stable enough
  useEffect(() => {
    if (!pairing) return setQr(null);
    QRCode.toDataURL(pairing.link, { margin: 2, width: 360, errorCorrectionLevel: "L" })
      .then(setQr)
      .catch(() => setQr(null));
    const tick = setInterval(() => {
      setNow(Date.now());
      devices.reload();
    }, 2000);
    return () => clearInterval(tick);
  }, [pairing]);

  const device = pairing ? devices.data?.find((d) => d.id === pairing.deviceId) : undefined;
  const used = !!device?.lastSeenAt;
  const expired = !!pairing && !used && (now > pairing.until || !!device?.revokedAt);
  const ready = nest.data?.connected && lock.data?.pinSet;

  const start = async () => {
    try {
      const r = await api.nest.pairAway({
        name: name.trim() || "My phone",
        full,
        ...(full ? { pin } : {}),
      });
      setPin("");
      setPairing({ ...r, until: Date.now() + 10 * 60_000 });
    } catch (e) {
      toast.error(message(e));
    }
  };
  const cancel = async () => {
    if (pairing && !used) await api.devices.revoke({ id: pairing.deviceId }).catch(() => {});
    setPairing(null);
  };

  return (
    <Card data-help="settings.pair-phone">
      <CardHeader>
        <CardTitle>{t("Pair your phone")}</CardTitle>
        <CardDescription>
          {t(
            "Approve, answer and follow your jobs from your phone, anywhere, end-to-end encrypted. Your phone then opens Oraknid with your PIN.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {!ready ? (
          <ol className="space-y-2">
            <Step done={!!nest.data?.connected}>
              {t("The Nest is connected")}{" "}
              {!nest.data?.connected ? (
                <span className="text-muted-foreground">
                  {t("(set it up below: a public Nest, or your own)")}
                </span>
              ) : null}
            </Step>
            <Step done={!!lock.data?.pinSet}>
              {t("Your PIN is set")}{" "}
              {!lock.data?.pinSet ? (
                <Link
                  href="/settings/security"
                  replace
                  className="text-primary underline underline-offset-2"
                >
                  {t("Set it in Security")}
                </Link>
              ) : null}
            </Step>
          </ol>
        ) : !pairing ? (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="phone-name">{t("Its name")}</Label>
              <Input
                id="phone-name"
                className="max-w-xs"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <label htmlFor="phone-full" className="flex items-start gap-2">
              <Switch id="phone-full" checked={full} onCheckedChange={setFull} className="mt-0.5" />
              <span>
                <span className="font-medium">{t("Full rights from this device")}</span>
                <span className="block text-xs text-muted-foreground">
                  {t(
                    "Away from home too: the terminal, your servers, projects, Legs, tools and command rules. With it, this phone is as powerful as your keyboard: only your PIN stands between a thief and your computer.",
                  )}
                </span>
              </span>
            </label>
            {full ? (
              <div className="space-y-1.5">
                <Label htmlFor="phone-pin">{t("Your PIN, to give full rights")}</Label>
                <Input
                  id="phone-pin"
                  type="password"
                  className="max-w-xs"
                  autoComplete="current-password"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                />
              </div>
            ) : null}
            <Button onClick={start} disabled={full && !pin}>
              {t("Show the code")}
            </Button>
          </div>
        ) : used ? (
          <div className="space-y-2">
            <div className="font-medium text-success">
              {t("Paired: {name} reached Oraknid.", { name: device?.name ?? name })}
            </div>
            <div className="text-muted-foreground">
              {t("Enter your PIN on the phone. Add it to your home screen to open it like an app.")}
            </div>
            <Button variant="secondary" onClick={() => setPairing(null)}>
              {t("Done")}
            </Button>
          </div>
        ) : expired ? (
          <div className="space-y-2">
            <div>{t("That code expired unused, and can't be used any more.")}</div>
            <Button variant="secondary" onClick={() => setPairing(null)}>
              {t("Start again")}
            </Button>
          </div>
        ) : (
          <div className="grid items-start gap-4 sm:grid-cols-[auto_1fr]">
            {qr ? (
              <img
                src={qr}
                alt={t("Pairing code")}
                className="size-72 max-w-full rounded-lg bg-white p-2"
              />
            ) : (
              <div className="size-72 animate-pulse rounded-lg bg-muted" />
            )}
            <div className="space-y-3">
              <ol className="list-decimal space-y-1.5 pl-5">
                <li>{t("Open your phone's camera.")}</li>
                <li>{t("Point it at the code, and tap the link that appears.")}</li>
                <li>{t("Enter your PIN on the phone.")}</li>
              </ol>
              {nest.data?.loaderHash ? (
                <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {t("The bottom of the phone's first screen should read: Loader {hash}", {
                    hash: nest.data.loaderHash,
                  })}
                </div>
              ) : null}
              <div className="text-xs text-muted-foreground">
                {t(
                  "Waiting for your phone… The code works for {m} more minutes. Don't share it or screenshot it.",
                  { m: Math.max(0, Math.ceil((pairing.until - now) / 60_000)) },
                )}
              </div>
              <Button variant="secondary" onClick={() => void cancel()}>
                {t("Cancel")}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span
        className={`flex size-5 items-center justify-center rounded-full text-xs ${done ? "bg-success text-white" : "border"}`}
      >
        {done ? "✓" : ""}
      </span>
      <span>{children}</span>
    </li>
  );
}
