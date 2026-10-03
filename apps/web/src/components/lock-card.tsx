import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
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
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { unlock } from "@/lib/lock";

const IDLE = [5, 15, 60, 240];

/** The PIN and the idle lock (ADR-029), in Settings → Security. */
export function LockCard() {
  const s = useLive(() => api.lock.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("lock."),
  });
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [busy, setBusy] = useState(false);
  if (!s.data) return <Loading rows={2} />;
  const valid = /^\d{6,12}$/.test(next) || (next.length >= 8 && /\D/.test(next));

  const change = async () => {
    setBusy(true);
    try {
      const { session } = await api.lock.setPin({ current, pin: next });
      unlock.set(session);
      setCurrent("");
      setNext("");
      toast.success(t("PIN changed. Your other devices ask for the new one."));
      s.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("PIN")}</CardTitle>
        <CardDescription>
          {t(
            "Every device opens Oraknid with your PIN, checked by Oraknid itself. Ten wrong tries unpair that device. Closing the browser locks it.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="idle" className="font-normal">
            {t("Lock after no use for")}
          </Label>
          <Select
            value={String(s.data.idleMinutes)}
            onValueChange={(v) =>
              api.lock
                .setIdle({ minutes: Number(v) })
                .then(s.reload)
                .catch((e) => toast.error(message(e)))
            }
            disabled={s.data.remote}
          >
            <SelectTrigger id="idle" data-help="settings.idle-lock" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IDLE.map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {m < 60 ? t("{n} minutes", { n: m }) : t("{n} hours", { n: m / 60 })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="secondary"
            onClick={() =>
              api.lock
                .lock({ everywhere: true })
                .then(() => unlock.locked())
                .catch((e) => toast.error(message(e)))
            }
          >
            {t("Lock every device now")}
          </Button>
        </div>
        {s.data.remote ? (
          <p className="text-muted-foreground">
            {t("The PIN can only be changed on the computer running Oraknid.")}
          </p>
        ) : (
          <form
            data-help="settings.pin"
            className="space-y-3 border-t pt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void change();
            }}
          >
            <div className="font-medium">{t("Change the PIN")}</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="pin-now">{t("Current PIN")}</Label>
                <Input
                  id="pin-now"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pin-new">{t("New PIN")}</Label>
                <Input
                  id="pin-new"
                  type="password"
                  autoComplete="new-password"
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                />
              </div>
            </div>
            <Button type="submit" disabled={!current || !valid || busy}>
              {t("Change it")}
            </Button>
            <p className="text-xs text-muted-foreground">
              {t("Forgot it? Run")} <code className="rounded bg-muted px-1">oraknid pin reset</code>{" "}
              {t("on this computer.")}
            </p>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
