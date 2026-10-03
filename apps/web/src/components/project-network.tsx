import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * A project's ports on this computer (Sandboxing → network): its jobs'
 * sandboxes have the internet but none of this computer's services,
 * except these, reached as localhost inside.
 */
export function ProjectNetworkCard({ projectId }: { projectId: string }) {
  const ports = useLive(() => api.projects.localPorts({ id: projectId }), {
    topics: ["overview"],
    deps: [projectId],
    refreshOn: (e) => e.type === "project.localPorts",
  });
  const [text, setText] = useState("");
  useEffect(() => {
    if (ports.data) setText(ports.data.join(", "));
  }, [ports.data]);
  if (!ports.data) return <Loading rows={1} />;
  const parsed = text
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number);
  const valid = parsed.every((p) => Number.isInteger(p) && p > 0 && p < 65536);
  const save = () =>
    api.projects
      .setLocalPorts({ id: projectId, ports: parsed })
      .then(() => toast.success(t("Saved: the next sessions use it.")))
      .catch((e) => toast.error(message(e)));
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("This computer's services")}</CardTitle>
        <CardDescription>
          {t(
            "Agents in this project reach the internet, but nothing running on this computer: no local database, model or dev server of yours. List the ports they may reach here (for example 5432 for a local Postgres). A Leg's own local model is always reachable by it.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2">
        <Input
          className="w-64 font-mono"
          placeholder="5432, 6379"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={t("Ports")}
        />
        <Button onClick={save} disabled={!valid}>
          {t("Save")}
        </Button>
        {!valid ? (
          <span className="text-xs text-destructive">
            {t("Ports are numbers from 1 to 65535.")}
          </span>
        ) : null}
      </CardContent>
    </Card>
  );
}
