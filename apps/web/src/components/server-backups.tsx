import type { ServerDatabase, ServerView } from "@oraknid/contracts";
import { useEffect, useState } from "react";
import { BackupPlans, type DatabaseChoice } from "@/components/backups";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

export type { DatabaseChoice } from "@/components/backups";

/** A database ADR-043 found, as a new plan's starting point. */
export function choiceOf(d: ServerDatabase): DatabaseChoice {
  const inContainer = d.source === "container";
  return {
    kind: d.kind,
    container: inContainer ? d.name : null,
    // In its container the dump reaches it on its own socket or port; on the host, by its port.
    host: null,
    port: inContainer ? null : d.port,
    // What its container's environment says (ADR-043 reads it); never a password.
    database: d.login?.database ?? null,
    user: d.login?.user ?? null,
    passwordInEnv: d.login?.passwordSet ?? false,
    label: `${d.kind === "mysql" ? "MySQL/MariaDB" : d.kind}${d.version ? ` ${d.version}` : ""} · ${inContainer ? t("container {name}", { name: d.name }) : d.name}`,
  };
}

/**
 * Servers → a server → Backups (ADR-043, ADR-044): its backup plans (and
 * those keeping their backups on it), each with its backups, Verify and
 * Restore. The databases found on it (`servers.databases`) are offered to
 * pick from in a new plan; without them I describe one.
 */
export function ServerBackupsTab({
  server,
  databases,
}: {
  server: ServerView;
  /** Given by a caller that has them already; otherwise read here. */
  databases?: DatabaseChoice[];
}) {
  const [found, setFound] = useState<DatabaseChoice[] | undefined>(databases);
  useEffect(() => {
    if (databases || server.setup !== "ready") return;
    let gone = false;
    api.servers
      .databases({ id: server.id })
      .then((r) => !gone && setFound(r.data.databases.map(choiceOf)))
      // Not readable now (the server down, no Docker access): I describe it.
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [server.id, server.setup, databases]);
  return (
    <div className="mx-auto max-w-3xl space-y-3" data-help="server.backups">
      <p className="text-sm text-muted-foreground">
        {t(
          "Its databases' backups: each plan dumps one at its time, compressed and encrypted if you want, to this computer or another server. Keys and every plan are in Settings → Backups.",
        )}
      </p>
      <BackupPlans serverId={server.id} {...(found?.length ? { databases: found } : {})} />
    </div>
  );
}
