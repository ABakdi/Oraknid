import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { describe } from "@/pages/overview";

/** The audit trail (Security → Audit log) and the daemon's log, in tabs (`/logs/<tab>`). */
export function LogsPage({ tab }: { tab?: string }) {
  const tabs: PageTab[] = [
    { id: "audit", label: t("What happened"), content: () => <AuditLog /> },
    { id: "daemon", label: t("Daemon log"), content: () => <DaemonLog /> },
  ];
  return (
    <PageTabs
      base="/logs"
      tab={tab}
      tabs={tabs}
      header={
        <PageHeader
          title={t("Logs")}
          sub={t("Everything Oraknid did, who caused it, and when. Secrets are never stored.")}
        />
      }
    />
  );
}

/** Downloads every event the filters match, as JSON lines (Phase 2 → M2.0). */
async function exportAudit(q: Record<string, unknown>) {
  const all: unknown[] = [];
  let beforeSeq: number | undefined;
  for (let page = 0; page < 100; page++) {
    const batch = await api.audit.search({ ...q, limit: 500, ...(beforeSeq ? { beforeSeq } : {}) });
    all.push(...batch);
    if (batch.length < 500) break;
    beforeSeq = batch.at(-1)?.seq;
  }
  const blob = new Blob([all.map((e) => JSON.stringify(e)).join("\n")], {
    type: "application/x-ndjson",
  });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `oraknid-audit-${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.jsonl`;
  a.click();
  URL.revokeObjectURL(a.href);
  return all.length;
}

/** The daemon's own log, its last lines, refreshed on demand. */
function DaemonLog() {
  const [tick, setTick] = useState(0);
  const log = useLive(() => api.logs.tail({ lines: 500 }), { topics: [], deps: [tick] });
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{log.data?.file}</span>
          <Button variant="secondary" size="sm" onClick={() => setTick((n) => n + 1)}>
            {t("Refresh")}
          </Button>
        </div>
        <ErrorNote error={log.error} />
        {log.loading ? <Loading /> : null}
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap rounded bg-muted p-2 font-mono text-[11px] [overflow-wrap:anywhere]">
          {(log.data?.lines ?? []).join("\n") || t("Nothing logged yet.")}
        </pre>
      </CardContent>
    </Card>
  );
}

function AuditLog() {
  const [text, setText] = useState("");
  const [type, setType] = useState("");
  const [actor, setActor] = useState("any");
  const [before, setBefore] = useState<number | undefined>();
  const q = {
    ...(text ? { text } : {}),
    ...(type ? { type } : {}),
    ...(actor !== "any" ? { actor } : {}),
    ...(before ? { beforeSeq: before } : {}),
    limit: 200,
  };
  const events = useLive(() => api.audit.search(q), {
    topics: [],
    deps: [text, type, actor, before],
  });
  const [exporting, setExporting] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-full sm:w-48"
          placeholder={t("Text…")}
          aria-label={t("Search the text")}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setBefore(undefined);
          }}
        />
        <Input
          className="w-full sm:w-48"
          placeholder={t("Type, or prefix like job.")}
          aria-label={t("Event type")}
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setBefore(undefined);
          }}
        />
        <Select
          value={actor}
          onValueChange={(v) => {
            setActor(v);
            setBefore(undefined);
          }}
        >
          <SelectTrigger className="w-40" aria-label={t("Actor")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("Anyone")}</SelectItem>
            <SelectItem value="owner">{t("Me")}</SelectItem>
            <SelectItem value="eye">{t("The Eye")}</SelectItem>
            <SelectItem value="agent">{t("An agent, on mail")}</SelectItem>
            <SelectItem value="oraknid">{t("Oraknid")}</SelectItem>
          </SelectContent>
        </Select>
        <span className="flex-1" />
        <Button
          variant="secondary"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              const n = await exportAudit({ ...q, beforeSeq: undefined });
              toast.success(t("Exported {n} events.", { n }));
            } catch (e) {
              toast.error(message(e));
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? t("Exporting…") : t("Export")}
        </Button>
      </div>
      <ErrorNote error={events.error} />
      {events.loading ? <Loading /> : null}
      <Card>
        <CardContent className="space-y-1 pt-4 font-mono text-xs">
          {(events.data ?? []).map((e) => (
            <details key={e.seq}>
              <summary className="flex cursor-pointer flex-wrap gap-x-2 marker:content-['']">
                <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                <span className="text-eye">{e.actor}</span>
                <span className="text-primary">{e.type}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground" title={describe(e)}>
                  {describe(e)}
                </span>
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          ))}
          {!events.loading && (events.data ?? []).length === 0 ? (
            <div className="font-sans text-sm text-muted-foreground">
              {text || type || actor !== "any" ? t("Nothing matches.") : t("Nothing yet.")}
            </div>
          ) : null}
          <div className="flex gap-2 pt-1 font-sans">
            {before ? (
              <Button variant="ghost" size="sm" onClick={() => setBefore(undefined)}>
                {t("Back to the newest")}
              </Button>
            ) : null}
            {(events.data ?? []).length === 200 ? (
              <Button variant="ghost" size="sm" onClick={() => setBefore(events.data?.at(-1)?.seq)}>
                {t("Older")}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
