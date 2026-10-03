import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** The terminal in the web UI: off until turned on (ADR-028). */
export function TerminalCard({ onChange }: { onChange?: (on: boolean) => void } = {}) {
  const on = useLive(() => api.settings.terminal(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "settings.updated",
  });
  const { confirm, dialog } = useConfirm();
  if (on.data === undefined) return <Loading rows={1} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Terminal")}</CardTitle>
        <CardDescription>
          {t(
            "A shell in the web UI, on this computer or your servers. It is a full shell as you: turn it on only if that is what you want. Away from home it opens only on a device you gave full rights; it closes when the device locks. Every terminal opened is in the log.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <label
          htmlFor="term-on"
          data-help="settings.terminal-switch"
          className="flex items-center gap-2 text-sm"
        >
          <Switch
            id="term-on"
            checked={on.data}
            onCheckedChange={async (v) => {
              if (
                v &&
                !(await confirm(
                  t("Turn the terminal on?"),
                  t(
                    "Any of your unlocked devices at home, and those with full rights away from home, can then open a full shell as you.",
                  ),
                  t("Turn it on"),
                  { keep: t("Leave it off") },
                ))
              )
                return;
              api.settings
                .setTerminal({ enabled: v })
                .then(() => {
                  on.reload();
                  onChange?.(v);
                })
                .catch((e) => toast.error(message(e)));
            }}
          />
          <Label htmlFor="term-on" className="font-normal">
            {on.data ? t("On") : t("Off")}
          </Label>
        </label>
        {dialog}
      </CardContent>
    </Card>
  );
}
