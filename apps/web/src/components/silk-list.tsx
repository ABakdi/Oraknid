import type { SilkEntry } from "@oraknid/contracts";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Link } from "wouter";
import { Empty, Loading, Markdown, StateBadge } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { act, jobHref } from "@/lib/links";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

const KINDS = [
  "interview-answer",
  "decision",
  "architecture",
  "progress",
  "issue",
  "handoff",
  "fact",
  "later",
] as const;

/** A job's Silk entries, by kind (Silk → What it holds). */
export function SilkEntries({ entries }: { entries: SilkEntry[] }) {
  return (
    <div className="space-y-3">
      {KINDS.map((k) => {
        const list = entries.filter((e) => e.kind === k);
        if (!list.length) return null;
        return (
          <section key={k}>
            <h3 className="mb-1 font-mono text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t(k)}
            </h3>
            <div className="space-y-2">
              {list.map((e) => (
                <Card key={e.id} className="py-3">
                  <CardHeader className="px-3">
                    <CardTitle className="flex min-w-0 items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{e.title}</span>
                      {e.authoredBy === "owner" ? (
                        <Badge variant="secondary">{t("mine")}</Badge>
                      ) : null}
                    </CardTitle>
                  </CardHeader>
                  {e.body.trim() ? (
                    <CardContent className="min-w-0 px-3 [overflow-wrap:anywhere]">
                      <Markdown text={e.body} />
                    </CardContent>
                  ) : null}
                </Card>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** I add a decision of mine to a job's Silk: every next session reads it. */
function AddDecision({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  return (
    <Card>
      <CardContent className="space-y-2 pt-4">
        <Input
          placeholder={t("Title")}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label={t("Title")}
        />
        <Textarea
          placeholder={t("What you decided, and why")}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          aria-label={t("What you decided, and why")}
        />
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="secondary" onClick={onDone}>
            {t("Cancel")}
          </Button>
          <Button
            size="sm"
            disabled={!title.trim()}
            onClick={() =>
              act(async () => {
                await api.silk.add({ jobId, taskId: null, kind: "decision", title, body });
                onDone();
              }, t("Added to Silk."))
            }
          >
            {t("Save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** One job's Silk (the Work tab, a job opened). */
export function JobSilk({ jobId }: { jobId: string }) {
  const silk = useLive(() => api.silk.list({ jobId, includeSuperseded: false }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type.startsWith("silk."),
    deps: [jobId],
  });
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="secondary" disabled={adding} onClick={() => setAdding(true)}>
          {t("Add a decision")}
        </Button>
      </div>
      {adding ? <AddDecision jobId={jobId} onDone={() => setAdding(false)} /> : null}
      {silk.data && silk.data.length === 0 && !adding ? (
        <Empty title={t("Nothing in Silk yet")}>
          {t(
            "What the job learns and decides lands here: answers, decisions, progress, handoffs. Add your own decision and every next session reads it.",
          )}
        </Empty>
      ) : null}
      <SilkEntries entries={silk.data ?? []} />
    </div>
  );
}

/**
 * A project's Silk, kept by job (ADR-034): a group per job, newest first,
 * the newest open. A decision I add goes to the job The Eye talks to now.
 */
export function ProjectSilk({
  projectId,
  jobIds,
  target,
}: {
  projectId: string;
  jobIds: string[];
  /** The job a new decision of mine goes to. */
  target: string | null;
}) {
  const silk = useLive(() => api.silk.byProject({ projectId }), {
    topics: jobIds.map((id) => `job:${id}`),
    refreshOn: (e) => e.type.startsWith("silk."),
    deps: [projectId],
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Set<string> | null>(null);
  if (!silk.data) return <Loading />;
  const groups = silk.data;
  const opened = open ?? new Set(groups.slice(0, 1).map((g) => g.jobId));
  const toggle = (id: string) => {
    const next = new Set(opened);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">
          {t(
            "Each job keeps its own Silk. A new job's sessions also read the decisions, architecture and facts of the jobs before it.",
          )}
        </p>
        <Button
          size="sm"
          variant="secondary"
          disabled={adding || !target}
          title={target ? undefined : t("No job yet: ask The Eye for work first.")}
          onClick={() => setAdding(true)}
        >
          {t("Add a decision")}
        </Button>
      </div>
      {adding && target ? <AddDecision jobId={target} onDone={() => setAdding(false)} /> : null}
      {groups.length === 0 && !adding ? (
        <Empty title={t("Nothing in Silk yet")}>
          {t(
            "What the project's jobs learn and decide lands here, kept by job: answers, decisions, progress, handoffs.",
          )}
        </Empty>
      ) : null}
      {groups.map((g) => (
        <section key={g.jobId} className="rounded-xl border bg-card/40">
          <button
            type="button"
            aria-expanded={opened.has(g.jobId)}
            onClick={() => toggle(g.jobId)}
            className="flex min-h-11 w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
          >
            <ChevronRight
              className={cn(
                "size-4 shrink-0 transition-transform",
                opened.has(g.jobId) && "rotate-90",
              )}
            />
            <span className="min-w-0 flex-1 truncate font-medium" title={g.title}>
              {g.title}
            </span>
            <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
              {t("{n} entries", { n: g.entries.length })} · {ago(g.createdAt)}
            </span>
            <StateBadge state={g.state} />
          </button>
          {opened.has(g.jobId) ? (
            <div className="space-y-2 border-t px-3 py-3">
              <SilkEntries entries={g.entries} />
              <Link
                href={jobHref({ id: g.jobId, projectId, state: g.state }, "silk")}
                className="inline-block text-xs text-primary underline-offset-2 hover:underline"
              >
                {t("Open the job")}
              </Link>
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
