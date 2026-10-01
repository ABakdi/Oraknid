import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

type Rules = { allow: string[]; deny: string[] };

/** My allow and deny patterns at one level: global (Settings) or one project's. */
export function RulesCard({
  title,
  description,
  load,
  save,
  scope,
}: {
  title: string;
  description: string;
  load: () => Promise<Rules>;
  save: (r: Rules) => Promise<unknown>;
  /** Reloads when it changes (a project id). */
  scope: string;
}) {
  const p = useLive(load, { topics: [], deps: [scope] });
  const [allow, setAllow] = useState<string | null>(null);
  const [deny, setDeny] = useState<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new scope starts from its own rules
  useEffect(() => {
    setAllow(null);
    setDeny(null);
  }, [scope]);
  if (!p.data) return <Loading rows={2} />;
  const lines = (s: string) =>
    s
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
  const id = `rules-${scope}`;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-allow`}>{t("Allow")}</Label>
          <Textarea
            id={`${id}-allow`}
            rows={4}
            className="font-mono text-xs"
            value={allow ?? p.data.allow.join("\n")}
            onChange={(e) => setAllow(e.target.value)}
            placeholder="^docker compose "
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-deny`}>{t("Deny")}</Label>
          <Textarea
            id={`${id}-deny`}
            rows={4}
            className="font-mono text-xs"
            value={deny ?? p.data.deny.join("\n")}
            onChange={(e) => setDeny(e.target.value)}
            placeholder="rm -rf build"
          />
        </div>
        <Button
          className="sm:col-span-2"
          onClick={() =>
            save({
              allow: lines(allow ?? p.data?.allow.join("\n") ?? ""),
              deny: lines(deny ?? p.data?.deny.join("\n") ?? ""),
            })
              .then(() => toast.success(t("Saved; the next decision uses them.")))
              .catch((e) => toast.error(message(e)))
          }
        >
          {t("Save")}
        </Button>
      </CardContent>
    </Card>
  );
}
