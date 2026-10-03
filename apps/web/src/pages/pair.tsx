import { useState } from "react";
import { deviceName } from "@/App";
import { ErrorNote } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, auth } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Pairing (Security → The daemon's own surface): a six-digit code from `oraknid pair`. */
export function PairPage({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState(deviceName);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { token } = await api.devices.pairComplete({ code, name });
      auth.set(token);
      onPaired();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="mb-2 flex items-center gap-2">
            <img src="/logo.svg" alt="" className="size-8" />
            <span className="text-lg font-semibold">Oraknid</span>
          </div>
          <CardTitle>{t("Pair this device")}</CardTitle>
          <CardDescription>
            {t("On the machine running Oraknid, run")}{" "}
            <code className="rounded bg-muted px-1">oraknid pair</code>{" "}
            {t(
              "and enter the code it shows; or, on a device already paired, open Settings → Devices & phone → Pair a new device.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="code">{t("Code")}</Label>
              <Input
                id="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                className="text-center font-mono text-lg tracking-[0.4em]"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="name">{t("This device's name")}</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <ErrorNote error={error} />
            <Button type="submit" className="w-full" disabled={code.length !== 6 || !name || busy}>
              {busy ? t("Pairing…") : code.length !== 6 ? t("Enter the six digits") : t("Pair")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
