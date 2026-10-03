import type { ServerView } from "@oraknid/contracts";
import { t } from "@/lib/i18n";

/** A server's Backups tab (ADR-044): its backup plans, runs and restores. */
export function ServerBackupsTab(_: { server: ServerView }) {
  return <div className="text-sm text-muted-foreground">{t("Backups are set up here")}</div>;
}
