import type { InboxItem } from "@oraknid/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/** One list for every approval and question, open and blocking ones first (Approvals → The inbox). */
export function InboxPage({ focus }: { focus?: string }) {
  const items = useLive(() => api.inbox.list({}), { topics: ["inbox"] });
  const [showDone, setShowDone] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again once the items have arrived
  useEffect(() => {
    if (focus) document.getElementById(`item-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, items.data]);
  if (items.error) return <ErrorNote error={items.error} />;
  if (items.loading) return <Loading />;
  const open = (items.data ?? []).filter((i) => i.state === "open");
  const rest = (items.data ?? []).filter((i) => i.state !== "open");
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        title={t("Inbox")}
        sub={
          open.length ? t("{n} waiting for you", { n: open.length }) : t("Nothing waits for you.")
        }
      />
      {open.length === 0 ? (
        <Empty title={t("All clear")}>
          {t("Approvals and questions from every job appear here, and as notifications.")}
        </Empty>
      ) : null}
      {open.map((i) => (
        <InboxItemCard key={i.id} item={i} highlight={i.id === focus} />
      ))}
      {rest.length ? (
        <Button variant="ghost" size="sm" onClick={() => setShowDone((s) => !s)}>
          {showDone ? t("Hide answered") : t("Show answered ({n})", { n: rest.length })}
        </Button>
      ) : null}
      {showDone ? rest.map((i) => <InboxItemCard key={i.id} item={i} />) : null}
    </div>
  );
}

export function InboxItemCard({ item, highlight }: { item: InboxItem; highlight?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const interview = item.title.startsWith("Interview, round");
  const answer = async (a: string) => {
    setBusy(true);
    try {
      await api.inbox.answer({ id: item.id, answer: a });
      toast.success(t("Answered."));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const open = item.state === "open";
  return (
    <Card
      id={`item-${item.id}`}
      className={cn("gap-3 py-4", highlight && "ring-2 ring-primary", !open && "opacity-70")}
    >
      <CardHeader className="px-4">
        <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant={item.kind === "approval" ? "default" : "secondary"}>
            {item.kind === "approval" ? t("Approval") : interview ? t("Interview") : t("Question")}
          </Badge>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{item.title}</span>
          <Link
            href={`/jobs/${item.jobId}`}
            className="text-xs font-normal text-muted-foreground underline-offset-2 hover:underline"
          >
            {t("the job")}
          </Link>
          <span className="text-xs font-normal text-muted-foreground">{ago(item.createdAt)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 px-4">
        {item.detail ? <Markdown text={item.detail} /> : null}
        {!open ? (
          <div className="text-sm text-muted-foreground">
            {item.state === "withdrawn"
              ? t("Withdrawn: nothing waits for it any more.")
              : t("Answered: {a}", { a: item.answer ?? "" })}
          </div>
        ) : item.kind === "approval" ? (
          <div className="flex flex-wrap gap-2">
            {item.options.map((o) => (
              <Button
                key={o}
                disabled={busy}
                variant={o === "Approve" ? "default" : o === "Deny" ? "destructive" : "secondary"}
                onClick={() => answer(o)}
              >
                {t(o)}
              </Button>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {interview ? null : (
              <div className="flex flex-wrap gap-2">
                {item.options.map((o) => (
                  <Button
                    key={o}
                    variant={o === item.defaultOption ? "default" : "secondary"}
                    size="sm"
                    disabled={busy}
                    onClick={() => answer(o)}
                  >
                    {t(o)}
                  </Button>
                ))}
              </div>
            )}
            <Textarea
              rows={interview ? 5 : 2}
              placeholder={
                interview
                  ? t("Answer in your own words, numbered…")
                  : t("Or answer in your own words…")
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy || !text.trim()} onClick={() => answer(text.trim())}>
                {t("Send")}
              </Button>
              {interview
                ? item.options.map((o) => (
                    <Button
                      key={o}
                      variant="secondary"
                      size="sm"
                      disabled={busy}
                      onClick={() => answer(o)}
                    >
                      {t(o)}
                    </Button>
                  ))
                : null}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
