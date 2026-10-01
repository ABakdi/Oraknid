import { useState } from "react";
import { ErrorNote, Loading, PageHeader } from "@/components/common";
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
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { describe } from "@/pages/overview";

/** The audit trail (Security → Audit log): search by type, actor and text. */
export function LogsPage() {
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
  return (
    <div className="space-y-3">
      <PageHeader
        title={t("Logs")}
        sub={t("Everything Oraknid did, who caused it, and when. Secrets are never stored.")}
      />
      <div className="flex flex-wrap gap-2">
        <Input
          className="w-48"
          placeholder={t("Text…")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Input
          className="w-48"
          placeholder={t("Type, or prefix like job.")}
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <Select value={actor} onValueChange={setActor}>
          <SelectTrigger className="w-36" aria-label={t("Actor")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t("Anyone")}</SelectItem>
            <SelectItem value="owner">{t("Me")}</SelectItem>
            <SelectItem value="eye">{t("The Eye")}</SelectItem>
            <SelectItem value="oraknid">{t("Oraknid")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <ErrorNote error={events.error} />
      {events.loading ? <Loading /> : null}
      <Card>
        <CardContent className="space-y-1 pt-4 font-mono text-xs">
          {(events.data ?? []).map((e) => (
            <details key={e.seq}>
              <summary className="flex cursor-pointer flex-wrap gap-x-2 marker:content-['']">
                <span className="text-muted-foreground">{new Date(e.at).toLocaleString()}</span>
                <span className="text-chart-2">{e.actor}</span>
                <span className="text-primary">{e.type}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{describe(e)}</span>
              </summary>
              <pre className="mt-1 overflow-x-auto rounded bg-muted p-2">
                {JSON.stringify(e.payload, null, 2)}
              </pre>
            </details>
          ))}
          {(events.data ?? []).length === 200 ? (
            <Button variant="ghost" size="sm" onClick={() => setBefore(events.data?.at(-1)?.seq)}>
              {t("Older")}
            </Button>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
