import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** The terminal in the web UI: off until turned on (ADR-028). */
export function TerminalCard() {
  const on = useLive(() => api.settings.terminal(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  if (on.data === undefined) return <Loading rows={1} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Terminal")}</CardTitle>
        <CardDescription>
          {t(
            "A shell in the web UI, on this computer or your servers. It is a full shell as you, for any paired device: turn it on only if that is what you want. Every terminal opened is in the log.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label htmlFor="term-on" className="flex items-center gap-2 text-sm">
          <Switch
            id="term-on"
            checked={on.data}
            onCheckedChange={(v) =>
              api.settings
                .setTerminal({ enabled: v })
                .then(on.reload)
                .catch((e) => toast.error(message(e)))
            }
          />
          <Label htmlFor="term-on" className="font-normal">
            {on.data ? t("On") : t("Off")}
          </Label>
        </label>
      </CardContent>
    </Card>
  );
}
