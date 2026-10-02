import { toast } from "sonner";
import { Link } from "wouter";
import { Loading } from "@/components/common";
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
      <CardContent className="space-y-1.5 text-sm">
        {servers.data.length === 0 ? (
          <div className="text-muted-foreground">
            {t("No servers yet:")}{" "}
            <Link href="/servers" className="underline">
              {t("add one")}
            </Link>
            .
          </div>
        ) : null}
        {servers.data.map((s) => (
          <label key={s.id} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={set.includes(s.id)}
              disabled={s.setup !== "ready"}
              onChange={(e) =>
                save(e.target.checked ? [...set, s.id] : set.filter((x) => x !== s.id))
              }
            />
            <span className="font-medium">{s.name}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {s.user}@{s.host}
            </span>
            {s.setup !== "ready" ? (
              <span className="text-xs text-muted-foreground">({t("set it up first")})</span>
            ) : null}
          </label>
        ))}
      </CardContent>
    </Card>
  );
}
