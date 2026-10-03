import { toast } from "sonner";
import { Link } from "wouter";
import { Loading } from "@/components/common";
import { AddServerButton } from "@/components/setup";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** The servers this project's jobs may use (Servers → Servers in projects). */
export function ProjectServersCard({ projectId }: { projectId: string }) {
  const servers = useLive(() => api.servers.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
  });
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "project.servers",
  });
  if (!servers.data || !projects.data) return <Loading rows={1} />;
  const project = projects.data.find((p) => p.id === projectId);
  if (!project) return null;
  const set = project.serverIds;
  const save = (ids: string[]) =>
    api.projects
      .setServers({ id: projectId, serverIds: ids })
      .then(projects.reload)
      .catch((e) => toast.error(message(e)));
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">{t("Servers for this project")}</CardTitle>
        <CardDescription>
          {t(
            "Its jobs get each ticked server's state document and a way in; what they run there still goes through your approvals.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {servers.data.length === 0 ? (
          <div className="text-muted-foreground">{t("No servers yet.")}</div>
        ) : null}
        {servers.data.map((s) => (
          <div key={s.id} className="flex min-h-11 flex-wrap items-center gap-2">
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                className="size-4 shrink-0"
                checked={set.includes(s.id)}
                disabled={s.setup !== "ready"}
                onChange={(e) =>
                  save(e.target.checked ? [...set, s.id] : set.filter((x) => x !== s.id))
                }
              />
              <span className="min-w-0 truncate font-medium" title={s.name}>
                {s.name}
              </span>
              <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground sm:inline">
                {s.user}@{s.host}
              </span>
            </label>
            {s.setup !== "ready" ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={!!s.busy}
                onClick={() =>
                  api.servers
                    .setup({ id: s.id })
                    .then(() => toast.success(t("Set up.")))
                    .catch((e) => toast.error(message(e)))
                }
              >
                {s.busy ?? t("Set it up")}
              </Button>
            ) : null}
            <Link
              href={`/servers/${s.id}`}
              className="text-xs text-muted-foreground underline underline-offset-2"
            >
              {t("Open")}
            </Link>
          </div>
        ))}
        <AddServerButton
          onAdded={(x) => toast.success(t("Set {name} up, then tick it here.", { name: x.name }))}
        />
      </CardContent>
    </Card>
  );
}
