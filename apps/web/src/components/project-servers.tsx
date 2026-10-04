import { isProduction, type ServerRole, type ServerView } from "@oraknid/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { AddServer } from "@/components/add-server";
import { Loading } from "@/components/common";
import { AddServerButton } from "@/components/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const ROLES = ["testing", "staging", "production"];

/**
 * A server's role in the project (ADR-042): a word of mine, and production
 * when it is named so or I mark it. The Eye always confirms production.
 */
function ServerRoleFields({
  projectId,
  serverId,
  name,
  role,
  onSaved,
}: {
  projectId: string;
  serverId: string;
  name: string;
  role: ServerRole | undefined;
  onSaved: () => void;
}) {
  const [word, setWord] = useState(role?.role ?? "");
  const save = (next: ServerRole) =>
    api.projects
      .setServerRole({ id: projectId, serverId, role: next })
      .then(onSaved)
      .catch((e) => toast.error(message(e)));
  const prod = isProduction({ role: word, production: role?.production ?? null });
  return (
    <span data-help="project.server-role" className="flex items-center gap-2">
      <Input
        list="server-roles"
        aria-label={t("Role of {name} in this project", { name })}
        placeholder={t("role")}
        // As wide as the word in it (a role is a word or two), never the whole row.
        className="h-8 w-auto max-w-40 min-w-24 field-sizing-content"
        value={word}
        maxLength={40}
        onChange={(e) => setWord(e.target.value)}
        onBlur={() => {
          if (word.trim() !== (role?.role ?? ""))
            void save({ role: word.trim(), production: role?.production ?? null });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <datalist id="server-roles">
        {ROLES.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <label
        className="flex items-center gap-1 text-xs"
        title={t("The Eye always asks before using it")}
      >
        <input
          type="checkbox"
          className="size-4"
          checked={prod}
          onChange={(e) => void save({ role: word.trim(), production: e.target.checked })}
        />
        {t("Production")}
      </label>
      {prod ? <Badge variant="destructive">{t("live")}</Badge> : null}
    </span>
  );
}

/** The servers this project's jobs may use (Servers → Servers in projects), each with its role (ADR-042). */
export function ProjectServersCard({ projectId }: { projectId: string }) {
  const servers = useLive(() => api.servers.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
  });
  // A server that can't be reached, fixed from here (Servers → Editing a server).
  const [fixing, setFixing] = useState<ServerView | null>(null);
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
    <Card data-help="project.servers">
      <CardHeader>
        <CardTitle className="text-sm">{t("Servers for this project")}</CardTitle>
        <CardDescription>
          {t(
            "Its jobs get each ticked server's state document and a way in; what they run there still goes through your approvals. Give each a role (testing, staging, production): The Eye uses the one you name, and always asks before production.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {servers.data.length === 0 ? (
          <div className="text-muted-foreground">{t("No servers yet.")}</div>
        ) : null}
        {servers.data.map((s) => (
          <div key={s.id} className="flex min-h-11 flex-wrap items-center gap-2">
            {/* The name keeps room to be read: on a phone the role goes to the next line. */}
            <label className="flex min-w-[min(100%,11rem)] flex-1 items-center gap-2">
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
            {s.error ? (
              <Button
                size="sm"
                variant="secondary"
                title={s.error}
                className="text-destructive"
                onClick={() => setFixing(s)}
              >
                {t("Can't connect: fix it")}
              </Button>
            ) : null}
            {set.includes(s.id) && s.setup === "ready" ? (
              <ServerRoleFields
                key={JSON.stringify(project.serverRoles?.[s.id] ?? null)}
                projectId={projectId}
                serverId={s.id}
                name={s.name}
                role={project.serverRoles?.[s.id]}
                onSaved={projects.reload}
              />
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
        {fixing ? (
          <AddServer
            server={fixing}
            open
            onOpenChange={(o) => {
              if (!o) setFixing(null);
            }}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
