import type { InboxItem, QuestionAnswer } from "@oraknid/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { CodeSpans, Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { choiceOf, OptionChoices } from "@/components/option-choices";
import { QuestionsForm } from "@/components/questions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { jobHref } from "@/lib/links";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

const ALL = "all";

/** An item's states, as the State filter lists them (Web-UI → Inbox). */
export const INBOX_STATES = [
  { state: "open", name: "Open" },
  { state: "answered", name: "Answered" },
  { state: "withdrawn", name: "Withdrawn" },
  { state: "expired", name: "Expired" },
] as const;

export interface InboxFilters {
  project: string;
  job: string;
  kind: string;
  /** "open", "answered", "withdrawn", "expired", or "all". */
  state: string;
  q: string;
}

export const NO_FILTERS: InboxFilters = { project: ALL, job: ALL, kind: ALL, state: "open", q: "" };

/** The items the filters keep; the one I came to see is always kept. */
export function filterInbox(items: InboxItem[], f: InboxFilters, focus?: string): InboxItem[] {
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  return items.filter(
    (i) =>
      i.id === focus ||
      ((f.project === ALL || i.projectId === f.project) &&
        (f.job === ALL || i.jobId === f.job) &&
        (f.kind === ALL || i.kind === f.kind) &&
        (f.state === ALL || i.state === f.state) &&
        words.every((w) =>
          [i.title, i.detail, i.jobTitle, i.projectName, i.taskTitle, i.answer]
            .join("\n")
            .toLowerCase()
            .includes(w),
        )),
  );
}

/**
 * One list for every approval and question, open and blocking ones first
 * (Approvals → The inbox). Filters by project, job, kind and state, and a
 * search, for when several projects run at once (Checkpoint 1 → F1-2).
 */
export function InboxPage({ focus }: { focus?: string }) {
  const items = useLive(() => api.inbox.list({}), { topics: ["inbox"] });
  const [f, setF] = useState<InboxFilters>(NO_FILTERS);
  const set = (p: Partial<InboxFilters>) => setF((x) => ({ ...x, ...p }));
  const { project, job, kind, state, q } = f;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again once the items have arrived
  useEffect(() => {
    if (focus) document.getElementById(`item-${focus}`)?.scrollIntoView({ block: "center" });
  }, [focus, items.data]);
  if (items.error) return <ErrorNote error={items.error} />;
  if (items.loading) return <Loading />;
  const data = items.data ?? [];
  const projects = unique(data.map((i) => [i.projectId ?? "", i.projectName ?? ""]));
  const jobs = unique(
    data
      .filter((i) => project === ALL || i.projectId === project)
      .map((i) => [i.jobId, i.jobTitle ?? i.jobId]),
  );
  const shown = filterInbox(data, f, focus);
  const filtered =
    project !== ALL || job !== ALL || kind !== ALL || state !== "open" || q.trim() !== "";
  const open = shown.filter((i) => i.state === "open");
  const rest = shown.filter((i) => i.state !== "open");
  // Answered and the rest, when the filter is on open ones: a step away.
  const settled = data.filter((i) => i.state !== "open").length;
  const waiting = data.filter((i) => i.state === "open").length;
  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <PageHeader
        title={t("Inbox")}
        back={focus ? { fallback: "/inbox" } : undefined}
        sub={waiting ? t("{n} waiting for you", { n: waiting }) : t("Nothing waits for you.")}
      />
      {data.length ? (
        <div className="flex flex-wrap gap-2">
          <Input
            data-help="inbox.search"
            className="w-full sm:w-auto sm:min-w-48 sm:flex-1"
            placeholder={t("Search the inbox…")}
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label={t("Search the inbox")}
          />
          <Select value={project} onValueChange={(v) => set({ project: v, job: ALL })}>
            <SelectTrigger
              data-help="inbox.project"
              className="min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label={t("Project")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("Every project")}</SelectItem>
              {projects.map(([id, name]) => (
                <SelectItem key={id} value={id}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={job} onValueChange={(v) => set({ job: v })}>
            <SelectTrigger
              data-help="inbox.job"
              className="min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label={t("Job")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("Every job")}</SelectItem>
              {jobs.map(([id, title]) => (
                <SelectItem key={id} value={id}>
                  {title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={(v) => set({ kind: v })}>
            <SelectTrigger
              data-help="inbox.kind"
              className="min-w-0 flex-1 sm:w-40 sm:flex-none"
              aria-label={t("Kind")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("Everything")}</SelectItem>
              <SelectItem value="approval">{t("Approvals")}</SelectItem>
              <SelectItem value="question">{t("Questions")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={state} onValueChange={(v) => set({ state: v })}>
            <SelectTrigger
              data-help="inbox.state"
              className="min-w-0 flex-1 sm:w-36 sm:flex-none"
              aria-label={t("State")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {INBOX_STATES.map((x) => (
                <SelectItem key={x.state} value={x.state}>
                  {t(x.name)}
                </SelectItem>
              ))}
              <SelectItem value={ALL}>{t("Every state")}</SelectItem>
            </SelectContent>
          </Select>
          {filtered ? (
            <Button
              variant="ghost"
              size="sm"
              className="self-center"
              onClick={() => setF(NO_FILTERS)}
            >
              {t("Clear")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {shown.length === 0 ? (
        filtered ? (
          <Empty
            title={t("Nothing matches")}
            action={
              <Button variant="secondary" onClick={() => setF(NO_FILTERS)}>
                {t("Clear the filters")}
              </Button>
            }
          >
            {t("No item matches these filters.")}
          </Empty>
        ) : (
          <Empty title={t("All clear")}>
            {t("Approvals and questions from every job appear here, and as notifications.")}
          </Empty>
        )
      ) : null}
      {open.map((i) => (
        <InboxItemCard key={i.id} item={i} highlight={i.id === focus} />
      ))}
      {rest.map((i) => (
        <InboxItemCard key={i.id} item={i} highlight={i.id === focus} />
      ))}
      {state === "open" && settled ? (
        <Button variant="ghost" size="sm" onClick={() => set({ state: ALL })}>
          {t("Show answered ({n})", { n: settled })}
        </Button>
      ) : null}
    </div>
  );
}

function unique(pairs: string[][]): [string, string][] {
  const m = new Map<string, string>();
  for (const [id, name] of pairs) if (id && !m.has(id)) m.set(id, name ?? id);
  return [...m].sort((a, b) => a[1].localeCompare(b[1]));
}

export function InboxItemCard({ item, highlight }: { item: InboxItem; highlight?: boolean }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const interview = item.title.startsWith("Interview, round");
  const answer = async (a: string | QuestionAnswer[]) => {
    setBusy(true);
    try {
      await api.inbox.answer(
        typeof a === "string" ? { id: item.id, answer: a } : { id: item.id, answers: a },
      );
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
      <CardHeader className="min-w-0 space-y-1.5 px-4">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={item.kind === "approval" ? "default" : "secondary"}>
            {item.kind === "approval" ? t("Approval") : interview ? t("Interview") : t("Question")}
          </Badge>
          <span className="flex-1" />
          <span className="shrink-0">{ago(item.createdAt)}</span>
        </div>
        <CardTitle className="text-sm leading-snug [overflow-wrap:anywhere]">
          <CodeSpans text={item.title} />
        </CardTitle>
        {/* Where it comes from, on its own line: each part may wrap, nothing squeezes the title. */}
        <Link
          href={
            item.projectId
              ? jobHref({ id: item.jobId, projectId: item.projectId })
              : `/jobs/${item.jobId}`
          }
          className="block text-xs text-muted-foreground underline-offset-2 [overflow-wrap:anywhere] hover:underline"
          title={item.jobDescription ?? undefined}
        >
          {item.projectName && item.jobTitle
            ? `${item.projectName} · ${item.jobTitle}`
            : t("the job")}
          {item.taskTitle ? ` · ${item.taskTitle}` : ""}
        </Link>
      </CardHeader>
      <CardContent className="min-w-0 space-y-3 px-4">
        {item.detail ? (
          <Markdown
            text={item.detail}
            className="min-w-0 [overflow-wrap:anywhere] [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:whitespace-pre-wrap"
          />
        ) : null}
        {!open ? (
          item.answers?.length ? (
            <div className="space-y-1 text-sm text-muted-foreground">
              <div>{t("Answered:")}</div>
              <Markdown text={item.answer ?? ""} />
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              {item.state === "withdrawn"
                ? t("Withdrawn: nothing waits for it any more.")
                : t("Answered: {a}", { a: item.answer ?? "" })}
            </div>
          )
        ) : item.kind === "approval" ? (
          // Each answer with what it leads to (ADR-045).
          <OptionChoices
            options={item.options}
            question={choiceOf(item.questions, item.options)}
            busy={busy}
            onAnswer={(o) => answer(o)}
          />
        ) : item.questions?.length ? (
          // Asked with options (ADR-037): the same component as The Eye's conversation.
          <QuestionsForm
            questions={item.questions}
            busy={busy}
            onSubmit={(a) => answer(a)}
            // An item's own options are already the question's (ADR-045); others stay beside Submit.
            extra={(choiceOf(item.questions, item.options) ? [] : item.options).map((o) => (
              <Button
                key={o}
                type="button"
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => answer(o)}
              >
                {t(o)}
              </Button>
            ))}
          />
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
