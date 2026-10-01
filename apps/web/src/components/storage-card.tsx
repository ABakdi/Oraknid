import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const ENDED = new Set(["completed", "cancelled", "unknown"]);

/**
 * What takes room in Oraknid's data folder, and pruning raw Leg logs of
 * chosen finished jobs (Persistence-and-Recovery → Backups and pruning).
 */
export function StorageCard() {
  const u = useLive(() => api.storage.usage(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "storage.pruned",
  });
  const [chosen, setChosen] = useState<string[]>([]);
  const [age, setAge] = useState("30");
  const [busy, setBusy] = useState(false);
  if (!u.data) return <Loading rows={3} />;
  const d = u.data;
  const logs = d.jobs.reduce((n, j) => n + j.bytes, 0);
  const prune = async () => {
    setBusy(true);
    try {
      const r = await api.storage.prune({
        jobIds: chosen,
        before: Date.now() - Number(age) * 86_400_000,
      });
      toast.success(t("Removed {n} log files ({size}).", { n: r.files, size: bytes(r.bytes) }));
      setChosen([]);
      u.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Storage")}</CardTitle>
        <CardDescription>
          {t(
            "In {dir}. Pruning removes only raw Leg logs; Silk, stats and the audit log stay until you delete the job.",
            { dir: d.dataDir },
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            [t("Database"), d.database],
            [t("Leg logs"), logs],
            [t("Backups ({n})", { n: d.backups.files.length }), d.backups.bytes],
            [t("Audit export"), d.audit],
            [t("Daemon log"), d.daemonLog],
          ].map(([label, n]) => (
            <div key={String(label)} className="rounded-md border px-3 py-2">
              <div className="text-xs text-muted-foreground">{label}</div>
              <div className="font-medium">{bytes(Number(n))}</div>
            </div>
          ))}
        </div>
        {d.jobs.length ? (
          <div className="divide-y rounded-md border">
            {d.jobs.map((j) => {
              const ended = ENDED.has(j.state);
              const id = `prune-${j.jobId}`;
              return (
                <div key={j.jobId} className="flex items-center gap-2 px-3 py-2">
                  <input
                    id={id}
                    type="checkbox"
                    disabled={!ended || j.bytes === 0}
                    checked={chosen.includes(j.jobId)}
                    onChange={(e) =>
                      setChosen((c) =>
                        e.target.checked ? [...c, j.jobId] : c.filter((x) => x !== j.jobId),
                      )
                    }
                  />
                  <Label htmlFor={id} className="min-w-0 flex-1 truncate font-normal">
                    {j.title}
                  </Label>
                  <span className="text-xs text-muted-foreground">
                    {j.files ? t("{n} files", { n: j.files }) : ""}
                    {j.oldest ? ` · ${t("oldest {when}", { when: ago(j.oldest) })}` : ""}
                    {ended ? "" : ` · ${t("running")}`}
                  </span>
                  <span className="w-16 text-right text-xs">{bytes(j.bytes)}</span>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          <span>{t("Remove their raw logs older than")}</span>
          <Select value={age} onValueChange={setAge}>
            <SelectTrigger className="w-32" aria-label={t("Age")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="0">{t("any age")}</SelectItem>
              <SelectItem value="7">{t("7 days")}</SelectItem>
              <SelectItem value="30">{t("30 days")}</SelectItem>
              <SelectItem value="90">{t("90 days")}</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="destructive" disabled={busy || !chosen.length} onClick={prune}>
            {t("Prune {n} job(s)", { n: chosen.length })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
