import type { EyeMessage, JobView, QuestionAnswer } from "@oraknid/contracts";
import { Eye, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Markdown } from "@/components/common";
import { EyeReportView, reportOf } from "@/components/eye-report";
import { QuestionsForm } from "@/components/questions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { jobHref } from "@/lib/links";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

const INTENT: Record<NonNullable<EyeMessage["action"]>["intent"], string> = {
  instruction: "Instruction",
  task: "New work",
  context: "Context",
  later: "For later",
  stop: "Stop",
  question: "Question",
  report: "Report",
};

/**
 * The project's conversation with The Eye (ADR-034): one for the whole
 * project, its messages from every job in order, filling the tab like a
 * chat. I ask for work here: The Eye passes it to the job running, starts
 * a follow-up when the last one has ended, or a first job; each reply
 * links the job it touched.
 */
export function EyeChat({
  projectId,
  jobs,
  archived = false,
}: {
  projectId: string;
  /** The project's jobs: their live topics, and their titles for the links. */
  jobs: JobView[];
  archived?: boolean;
}) {
  const ids = jobs.map((j) => j.id);
  const messages = useLive(() => api.projects.conversation({ id: projectId }), {
    topics: ["overview", ...ids.map((id) => `job:${id}`)],
    refreshOn: (e) =>
      e.type === "eye.message" || e.type === "eye.replied" || e.type === "job.created",
    deps: [projectId],
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [answering, setAnswering] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = messages.data ?? [];
  // The questions I answered already: my answer names the message it answers (ADR-037).
  const replied = new Set(list.map((m) => m.replyTo).filter(Boolean));
  const thinking = list.at(-1)?.author === "owner";
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const going = jobs.filter((j) => !["draft", "completed", "cancelled"].includes(j.state)).at(-1);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message arrives
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [list.length]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      await api.projects.talk({ id: projectId, text: value });
      setText("");
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setSending(false);
    }
  };

  const answer = async (messageId: string, answers: QuestionAnswer[]) => {
    setAnswering(messageId);
    try {
      await api.projects.answer({ id: projectId, messageId, answers });
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setAnswering(null);
    }
  };

  const jobLink = (jobId: string, label: string) => {
    const j = byId.get(jobId);
    return (
      <Link
        href={jobHref({ id: jobId, projectId, ...(j ? { state: j.state } : {}) })}
        className="min-w-0 truncate font-medium text-primary underline-offset-2 hover:underline"
        title={j?.title}
      >
        {label}
      </Link>
    );
  };

  return (
    <Card className="min-h-0 flex-1 gap-0 py-0">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Eye className="size-4 shrink-0 text-primary" />
          {t("The Eye")}
          <span className="hidden min-w-0 truncate font-normal text-muted-foreground sm:inline">
            {going
              ? t("— talking to “{title}”, running now.", { title: going.title })
              : jobs.some((j) => j.state !== "draft")
                ? t("— ask for more: new work starts a follow-up job here.")
                : t("— ask for work: The Eye starts a job here from your message.")}
          </span>
        </div>
        {!messages.data ? (
          <div className="flex-1" />
        ) : !list.length ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {t(
              "Nothing said yet. Ask for work here: The Eye starts a job for it, or passes it to the one running.",
            )}
          </div>
        ) : (
          <div ref={box} className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
            {list.map((m, i) => {
              const prev = list[i - 1];
              const touched = m.action?.jobId && m.action.jobId !== m.jobId ? m.action.jobId : null;
              return (
                <div key={m.id}>
                  {prev && prev.jobId !== m.jobId ? (
                    <div className="my-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="h-px flex-1 bg-border" />
                      <span className="min-w-0 truncate">
                        {byId.get(m.jobId)?.title ?? t("another job")}
                      </span>
                      <span className="h-px flex-1 bg-border" />
                    </div>
                  ) : null}
                  {reportOf(m) ? (
                    // The Eye speaking up on its own (ADR-045).
                    <EyeReportView
                      message={m}
                      report={reportOf(m) as NonNullable<ReturnType<typeof reportOf>>}
                      resultHref={jobHref({
                        id: m.jobId,
                        projectId,
                        ...(byId.get(m.jobId) ? { state: byId.get(m.jobId)?.state } : {}),
                      })}
                    />
                  ) : (
                    <div
                      className={cn("flex", m.author === "owner" ? "justify-end" : "justify-start")}
                    >
                      <div
                        className={cn(
                          "min-w-0 max-w-[85%] rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere]",
                          m.author === "owner" ? "bg-primary text-primary-foreground" : "bg-muted",
                        )}
                      >
                        {m.author === "owner" && !m.answers ? (
                          <div className="whitespace-pre-wrap">{m.text}</div>
                        ) : (
                          <Markdown text={m.text} />
                        )}
                        {m.action ? (
                          <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                            <Badge variant="outline" className="h-5 text-[10px]">
                              {t(INTENT[m.action.intent])}
                            </Badge>
                            {m.action.did.map((x) => (
                              <span key={x}>· {t(x)}</span>
                            ))}
                          </div>
                        ) : null}
                        {m.author === "eye" ? (
                          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
                            {jobLink(m.jobId, byId.get(m.jobId)?.title ?? t("The job"))}
                            {touched
                              ? jobLink(
                                  touched,
                                  t("Open “{title}”", {
                                    title: byId.get(touched)?.title ?? t("the new job"),
                                  }),
                                )
                              : null}
                          </div>
                        ) : null}
                        <div
                          className={cn(
                            "mt-0.5 text-[10px]",
                            m.author === "owner"
                              ? "text-primary-foreground/70"
                              : "text-muted-foreground",
                          )}
                        >
                          {ago(m.createdAt)}
                        </div>
                      </div>
                    </div>
                  )}
                  {m.questions?.length && !replied.has(m.id) ? (
                    <div className="mt-1.5 max-w-full md:max-w-[85%]">
                      <QuestionsForm
                        questions={m.questions}
                        busy={answering === m.id}
                        disabled={archived}
                        onSubmit={(a) => answer(m.id, a)}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
            {thinking ? (
              <div className="animate-pulse text-xs text-muted-foreground">
                {t("The Eye is thinking about it…")}
              </div>
            ) : null}
          </div>
        )}
        <div className="flex items-end gap-2">
          <Textarea
            rows={3}
            className="min-h-0 flex-1 resize-none"
            disabled={archived}
            placeholder={
              archived
                ? t("The project is archived: restore it in Settings to ask for work.")
                : t(
                    "Ask for work, or tell The Eye anything: an instruction, context, “stop that”, an idea for later…",
                  )
            }
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line, as in Chats.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={t("Message to The Eye")}
          />
          <Button
            size="icon"
            disabled={sending || !text.trim() || archived}
            onClick={send}
            aria-label={t("Send")}
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
