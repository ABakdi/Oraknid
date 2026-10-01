import type { JobView } from "@oraknid/contracts";
import { toast } from "sonner";
import { RulesCard } from "@/components/rules-card";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";

const GATES = [
  ["push", "Push to a remote"],
  ["merge", "Merge branches"],
  ["deploy", "Deploy"],
  ["external-write", "Publish or write outside (MCP tools too)"],
  ["install", "Install system or global packages"],
  ["delete", "Delete outside the worktree"],
  ["send", "Send messages or email"],
  ["spend", "Spend money"],
] as const;

/** Without a waiver these ask even at Full autonomy (Approvals → Gated actions). */
const ALWAYS_ASKED = new Set(["send", "push", "deploy", "delete", "spend"]);

/**
 * One place for what a job may do on its own (Web-UI → Job, Settings tab;
 * Phase 2 → M2.0): the gated actions I waived for it, and its own rules.
 * Autonomy and the budget stay in the header and the Budget tab.
 */
export function JobSettings({ job }: { job: JobView }) {
  const ended = job.state === "completed" || job.state === "cancelled";
  const toggle = async (action: string, on: boolean) => {
    const waived = on
      ? [...new Set([...job.waived, action])]
      : job.waived.filter((w) => w !== action);
    try {
      await api.jobs.setWaivers({ id: job.id, waived: waived as never });
      toast.success(on ? t("Waived for this job.") : t("It asks you again."));
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Waived for this job")}</CardTitle>
          <CardDescription>
            {t(
              "A waived action runs without asking you. A task that read untrusted content asks anyway.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {GATES.map(([action, label]) => {
            const id = `waive-${action}`;
            return (
              <div key={action} className="flex items-center gap-2">
                <Switch
                  id={id}
                  disabled={ended}
                  checked={job.waived.includes(action)}
                  onCheckedChange={(on) => toggle(action, on)}
                />
                <Label htmlFor={id} className="font-normal">
                  {t(label)}
                  {ALWAYS_ASKED.has(action) ? (
                    <span className="ml-1 text-xs text-muted-foreground">
                      {t("(asks even at Full, unless waived)")}
                    </span>
                  ) : null}
                </Label>
              </div>
            );
          })}
        </CardContent>
      </Card>
      <RulesCard
        scope={`job-${job.id}`}
        title={t("Commands in this job")}
        description={t(
          "Patterns for this job only. They win over the project's and the global ones; deny beats allow.",
        )}
        load={async () => ({ allow: job.allowRules, deny: job.denyRules })}
        save={(r) => api.jobs.setRules({ id: job.id, ...r })}
      />
    </div>
  );
}
