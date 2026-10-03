import { BackupPlans, type DatabaseChoice } from "@/components/backups";
import { t } from "@/lib/i18n";

export type { DatabaseChoice } from "@/components/backups";

/**
 * Servers → a server → Backups (ADR-043, ADR-044): its backup plans (and
 * those keeping their backups on it), each with its backups, Verify and
 * Restore. `databases` are the ones found on it, to pick from in a new
 * plan; without them I describe one.
 */
export function ServerBackupsTab({
  serverId,
  databases,
}: {
  serverId: string;
  databases?: DatabaseChoice[];
}) {
  return (
    <div className="mx-auto max-w-3xl space-y-3" data-help="server.backups">
      <p className="text-sm text-muted-foreground">
        {t(
          "Its databases' backups: each plan dumps one at its time, compressed and encrypted if you want, to this computer or another server. Keys and every plan are in Settings → Backups.",
        )}
      </p>
      <BackupPlans serverId={serverId} {...(databases ? { databases } : {})} />
    </div>
  );
}
