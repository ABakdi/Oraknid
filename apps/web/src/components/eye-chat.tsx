import type { EyeMessage, EyeThought, JobView, QuestionAnswer } from "@oraknid/contracts";
import { correctsThinking } from "@oraknid/core";
import { ChevronDown, CircleX, Eye, SendHorizontal, Square } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { Markdown } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { EyeReportView, reportOf } from "@/components/eye-report";
import { ThoughtBlock, ThoughtGroup, WorkingNow } from "@/components/eye-thought";
import { QuestionsForm } from "@/components/questions";
import {
  jumpTo,
  PromptJump,
  PromptLine,
  PromptRail,
  promptTitle,
  useActivePrompt,
} from "@/components/transcript";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { jobHref, jobIdHref, projectHref } from "@/lib/links";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/** A job that hasn't ended: running, waiting on me, blocked or paused (anything but a draft or an end). */
const ENDED = new Set(["draft", "completed", "cancelled", "failed"]);

/**
 * Cancel from the conversation (The-Eye → Cancelling from the chat): the
 * job it is about, whatever it is doing, after a short confirm; with
 * several going, a small menu picks which first.
 */
function CancelJob({ going, disabled }: { going: JobView[]; disabled?: boolean }) {
  const { confirm, dialog } = useConfirm();
  const [menu, setMenu] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!going.length) return null;
  const cancel = async (j: JobView) => {
    setMenu(false);
    if (
      !(await confirm(
        t("Cancel “{title}”?", { title: j.title }),
        t(
          "The work so far stays in its folder. It stops at a safe point; what it asked you is withdrawn.",
        ),
        t("Cancel the job"),
        { keep: t("Keep it") },
      ))
    )
      return;
    setBusy(true);
    try {
      await api.jobs.cancel({ id: j.id, reason: "Cancelled from the chat." });
      toast.success(t("Cancelling “{title}”.", { title: j.title }));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const one = going.length === 1 ? going[0] : undefined;
  return (
    <div className="relative shrink-0">
      <Button
        size="sm"
        variant="outline"
        className="h-7 gap-1 px-2 text-xs"
        disabled={disabled || busy}
        aria-haspopup={one ? undefined : "menu"}
        aria-expanded={one ? undefined : menu}
        title={one ? t("Cancel “{title}”", { title: one.title }) : t("Cancel a job")}
        onClick={() => (one ? void cancel(one) : setMenu((m) => !m))}
      >
        <CircleX className="size-3.5" />
        {t("Cancel")}
        {one ? null : <ChevronDown className="size-3" />}
      </Button>
      {menu && !one ? (
        <div
          role="menu"
          aria-label={t("Which job to cancel")}
          className="absolute right-0 z-20 mt-1 w-72 max-w-[80vw] rounded-md border bg-popover p-1 text-sm shadow-lg"
        >
          {going.map((j) => (
            <button
              key={j.id}
              type="button"
              role="menuitem"
              className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              onClick={() => void cancel(j)}
            >
              <span className="min-w-0 flex-1 truncate">{j.title}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{t(j.state)}</span>
            </button>
          ))}
        </div>
      ) : null}
      {dialog}
    </div>
  );
}

const INTENT: Record<NonNullable<EyeMessage["action"]>["intent"], string> = {
  instruction: "Instruction",
  task: "New work",
  context: "Context",
  later: "For later",
  stop: "Stop",
  question: "Question",
  report: "Report",
};

/** One row of the transcript: a message, a thought, or thoughts in a row that ended. */
export type TranscriptItem =
  | { kind: "message"; at: number; message: EyeMessage }
  | { kind: "thought"; at: number; thought: EyeThought }
  | { kind: "thoughts"; at: number; thoughts: EyeThought[] };

/**
 * The conversation in order (M13.25): messages and The Eye's thoughts by
 * time; three or more thoughts in a row that ended (commands judged,
 * reviews) folded into one line.
 */
export function transcript(messages: EyeMessage[], thoughts: EyeThought[]): TranscriptItem[] {
  const merged: (
    | { kind: "message"; at: number; message: EyeMessage }
    | { kind: "thought"; at: number; thought: EyeThought }
  )[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...thoughts.map((th) => ({ kind: "thought" as const, at: th.startedAt, thought: th })),
  ];
  // Stable: a message and a thought at the same moment keep the message first.
  merged.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1));
  const out: TranscriptItem[] = [];
  let run: EyeThought[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "thoughts", at: run[0]?.startedAt ?? 0, thoughts: run });
    else for (const th of run) out.push({ kind: "thought", at: th.startedAt, thought: th });
    run = [];
  };
  for (const item of merged) {
    if (
      item.kind === "thought" &&
      item.thought.outcome !== "thinking" &&
      !item.thought.interruptible
    ) {
      run.push(item.thought);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/**
 * The project's conversation with The Eye (ADR-034), read like a terminal's
 * transcript (M13.25): one column, my prompts marked, its replies, its
 * thinking live then folded, the agents' work as compact lines; a rail of
 * my prompts beside it. I ask for work here: The Eye passes it to the job
 * running, starts a follow-up when the last one has ended, or a first job;
 * each reply links the job it touched. While it thinks I can stop it, or
 * send a message that has it think again or is added for what comes next.
 *
 * A server's conversation (ADR-049) is the same, through the server: a
 * question is answered from its state document without a job; work
 * becomes a job on the server.
 */
export function EyeChat({
  projectId,
  jobs,
  archived = false,
  server,
}: {
  /** The project; a server's own, null until its first message. */
  projectId: string | null;
  /** The project's jobs: their live topics, and their titles for the links. */
  jobs: JobView[];
  archived?: boolean;
  /** The server whose conversation this is (ADR-049). */
  server?: { id: string; name: string };
}) {
  const ids = jobs.map((j) => j.id);
  const topics = ["overview", ...ids.map((id) => `job:${id}`)];
  const messages = useLive(
    () =>
      server
        ? api.servers.conversation({ id: server.id })
        : api.projects.conversation({ id: projectId as string }),
    {
      topics,
      refreshOn: (e) =>
        e.type === "eye.message" || e.type === "eye.replied" || e.type === "job.created",
      deps: [projectId, server?.id],
    },
  );
  const thinking = useLive(
    () => (projectId ? api.projects.thinking({ id: projectId }) : Promise.resolve([])),
    {
      topics,
      refreshOn: (e) => e.type === "eye.thinking.started" || e.type === "eye.thinking.ended",
      deps: [projectId],
    },
  );
  // A job new to the project: what it thinks is read again once its topic is followed, so a
  // thought that started before then is shown.
  const jobKey = ids.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the project's jobs change
  useEffect(() => {
    thinking.reload();
    messages.reload();
  }, [jobKey]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  /** How my message goes while The Eye thinks, when I chose; else guessed from my words. */
  const [picked, setPicked] = useState<"redo" | "context" | null>(null);
  const [answering, setAnswering] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const list = messages.data ?? [];
  const thoughts = thinking.data ?? [];
  const items = transcript(list, thoughts);
  // The questions I answered already: my answer names the message it answers (ADR-037).
  const replied = new Set(list.map((m) => m.replyTo).filter(Boolean));
  const busy = thoughts.filter((th) => th.outcome === "thinking" && th.interruptible);
  // Read before any thought is shown (a stand-in brain, the first instant): said in a line.
  const reading =
    list.at(-1)?.author === "owner" && !thoughts.some((th) => th.outcome === "thinking");
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const going = jobs.filter((j) => !ENDED.has(j.state));
  const current = going.at(-1);
  const prompts = list
    .filter((m) => m.author === "owner")
    .map((m) => ({ id: m.id, title: promptTitle(m.text) }));
  const [active, setActive] = useActivePrompt(
    box,
    prompts.map((p) => p.id),
  );
  const mode = picked ?? (correctsThinking(text) ? "redo" : "context");
  const jump = (id: string) => {
    setActive(id);
    jumpTo(id);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: follow the newest row as it arrives
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [items.length]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      if (server) await api.servers.talk({ id: server.id, text: value });
      else
        await api.projects.talk({
          id: projectId as string,
          text: value,
          mode: busy.length ? mode : "auto",
        });
      setText("");
      setPicked(null);
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setSending(false);
    }
  };

  const stop = async () => {
    setStopping(true);
    try {
      if (projectId) await api.projects.stopThinking({ id: projectId });
      thinking.reload();
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setStopping(false);
    }
  };

  const answer = async (messageId: string, answers: QuestionAnswer[]) => {
    setAnswering(messageId);
    try {
      if (server) await api.servers.answer({ id: server.id, messageId, answers });
      else await api.projects.answer({ id: projectId as string, messageId, answers });
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setAnswering(null);
    }
  };

  // A question a job asked through the inbox goes with it when it ends (withdrawn).
  const withdrawn = (m: EyeMessage) =>
    !!m.itemId &&
    !!m.jobId &&
    ["completed", "cancelled", "failed"].includes(byId.get(m.jobId)?.state ?? "");

  const jobLink = (jobId: string | null, label: string) => {
    if (!jobId) return null;
    const j = byId.get(jobId);
    return (
      <Link
        href={
          // A job of another place (a server's chat it was taken to) opens through its id.
          j ? jobHref({ id: jobId, projectId: j.projectId, state: j.state }) : jobIdHref(jobId)
        }
        className="min-w-0 truncate font-medium text-primary underline-offset-2 hover:underline"
        title={j?.title}
      >
        {label}
      </Link>
    );
  };

  const row = (m: EyeMessage) => {
    const report = reportOf(m);
    if (report)
      // The Eye speaking up on its own (ADR-045).
      return (
        <EyeReportView
          message={m}
          report={report}
          resultHref={
            m.jobId
              ? jobHref({
                  id: m.jobId,
                  projectId: m.projectId,
                  ...(byId.get(m.jobId) ? { state: byId.get(m.jobId)?.state } : {}),
                })
              : ""
          }
        />
      );
    if (m.author === "owner")
      return (
        <PromptLine id={m.id} active={m.id === active} meta={ago(m.createdAt)}>
          {m.answers ? (
            <Markdown text={m.text} className="font-normal" />
          ) : (
            <div className="whitespace-pre-wrap">{m.text}</div>
          )}
        </PromptLine>
      );
    const touched = m.action?.jobId && m.action.jobId !== m.jobId ? m.action.jobId : null;
    return (
      <div data-testid="reply" className="min-w-0 pl-4 text-sm">
        <Markdown text={m.text} />
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
          {m.action ? (
            <>
              <Badge variant="outline" className="h-5 text-[10px]">
                {t(INTENT[m.action.intent])}
              </Badge>
              {m.action.did.map((x) => (
                <span key={x} className="font-mono text-[11px]">
                  · {t(x)}
                </span>
              ))}
            </>
          ) : null}
          {m.jobId ? jobLink(m.jobId, byId.get(m.jobId)?.title ?? t("The job")) : null}
          {touched
            ? jobLink(
                touched,
                t("Open “{title}”", { title: byId.get(touched)?.title ?? t("the new job") }),
              )
            : null}
          {m.action?.place ? (
            // Where it took my request (The-Eye → Resolving what it doesn't know).
            <Link
              href={
                m.action.place.kind === "server"
                  ? `/servers/${m.action.place.id}/chat`
                  : projectHref(m.action.place.id, "eye")
              }
              className="min-w-0 truncate font-medium text-primary underline-offset-2 hover:underline"
            >
              {m.action.place.kind === "server"
                ? t("{name}'s chat", { name: m.action.place.name })
                : t("{name}'s conversation", { name: m.action.place.name })}
            </Link>
          ) : null}
          <span className="text-[10px]">{ago(m.createdAt)}</span>
        </div>
      </div>
    );
  };

  return (
    <Card className="min-h-0 flex-1 gap-0 py-0">
      <CardContent className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <Eye className="size-4 shrink-0 text-primary" />
          {t("The Eye")}
          <span className="hidden min-w-0 flex-1 truncate font-normal text-muted-foreground sm:inline">
            {current
              ? t("— talking to “{title}”, running now.", { title: current.title })
              : server
                ? t("— ask about {name}, or for work on it: a job goes into the server.", {
                    name: server.name,
                  })
                : jobs.some((j) => j.state !== "draft")
                  ? t("— ask for more: new work starts a follow-up job here.")
                  : t("— ask for work: The Eye starts a job here from your message.")}
          </span>
          <span className="flex-1 sm:hidden" />
          <CancelJob going={going} disabled={archived} />
          <PromptJump prompts={prompts} active={active} onJump={jump} />
        </div>
        {!messages.data ? (
          <div className="flex-1" />
        ) : !list.length && !thoughts.length ? (
          <div className="flex flex-1 items-center justify-center px-4 text-center text-sm text-muted-foreground">
            {server
              ? t(
                  "Nothing said yet. Ask what runs on {name}, or for work on it (“install fail2ban”, “why does nginx return 502 for x.com”): The Eye answers from its state document, or sends an agent into the server and tells you what will change first.",
                  { name: server.name },
                )
              : t(
                  "Nothing said yet. Ask for work here: The Eye starts a job for it, or passes it to the one running.",
                )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3">
            <div
              ref={box}
              data-testid="transcript"
              className="min-h-0 min-w-0 flex-1 space-y-2.5 overflow-y-auto pr-1"
            >
              {items.map((item, i) => {
                const jobOf = (x: TranscriptItem) =>
                  x.kind === "message"
                    ? x.message.jobId
                    : x.kind === "thought"
                      ? x.thought.jobId
                      : x.thoughts[0]?.jobId;
                const prev = items[i - 1];
                const key =
                  item.kind === "message"
                    ? item.message.id
                    : item.kind === "thought"
                      ? item.thought.id
                      : `g-${item.thoughts[0]?.id}`;
                return (
                  <Fragment key={key}>
                    {prev && jobOf(prev) !== jobOf(item) && item.kind === "message" ? (
                      <div className="my-2 flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="h-px flex-1 bg-border" />
                        <span className="min-w-0 truncate">
                          {jobOf(item)
                            ? (byId.get(jobOf(item) ?? "")?.title ?? t("another job"))
                            : t("no job")}
                        </span>
                        <span className="h-px flex-1 bg-border" />
                      </div>
                    ) : null}
                    {item.kind === "thought" ? (
                      <ThoughtBlock thought={item.thought} />
                    ) : item.kind === "thoughts" ? (
                      <ThoughtGroup thoughts={item.thoughts} />
                    ) : (
                      <div>
                        {row(item.message)}
                        {item.message.questions?.length &&
                        !replied.has(item.message.id) &&
                        withdrawn(item.message) ? (
                          <div className="mt-1 pl-4 text-xs text-muted-foreground">
                            {t("No longer asked: the job has ended.")}
                          </div>
                        ) : item.message.questions?.length && !replied.has(item.message.id) ? (
                          <div className="mt-1.5 max-w-full pl-4 md:max-w-[85%]">
                            <QuestionsForm
                              questions={item.message.questions}
                              busy={answering === item.message.id}
                              disabled={archived}
                              onSubmit={(a) => answer(item.message.id, a)}
                            />
                          </div>
                        ) : null}
                      </div>
                    )}
                  </Fragment>
                );
              })}
              {reading ? (
                <div className="animate-pulse pl-4 font-mono text-xs text-muted-foreground">
                  {t("The Eye is reading your message…")}
                </div>
              ) : null}
              <WorkingNow jobIds={going.map((j) => j.id)} />
            </div>
            <PromptRail prompts={prompts} active={active} onJump={jump} />
          </div>
        )}
        {busy.length ? (
          <div
            data-testid="thinking-bar"
            className="flex min-w-0 flex-wrap items-center gap-2 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground"
          >
            <span className="min-w-0 truncate font-mono">
              {t("The Eye is {what}…", {
                what: (busy[0]?.purpose ?? "").replace(/^./, (c) => c.toLowerCase()),
              })}
            </span>
            {text.trim() ? (
              <fieldset className="flex overflow-hidden rounded border">
                <legend className="sr-only">{t("What your message does")}</legend>
                {(["redo", "context"] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "cursor-pointer px-2 py-0.5 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      mode === m ? "bg-primary text-primary-foreground" : "hover:bg-muted",
                    )}
                  >
                    <input
                      type="radio"
                      name={`eye-send-mode-${projectId ?? server?.id}`}
                      className="sr-only"
                      checked={mode === m}
                      onChange={() => setPicked(m)}
                    />
                    {m === "redo" ? t("Stop and redo with this") : t("Add as context")}
                  </label>
                ))}
              </fieldset>
            ) : (
              <span className="hidden sm:inline">
                {t("Write to correct it or add to it, or stop it.")}
              </span>
            )}
            <Button
              size="sm"
              variant="outline"
              className="ml-auto h-6 gap-1 px-2 text-xs"
              disabled={stopping}
              onClick={stop}
            >
              <Square className="size-3 fill-current" />
              {t("Stop")}
            </Button>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            rows={3}
            className="min-h-0 flex-1 resize-none"
            disabled={archived}
            placeholder={
              archived
                ? t("The project is archived: restore it in Settings to ask for work.")
                : busy.length
                  ? t(
                      "The Eye is thinking: correct it (“no, use Postgres”) or add to it; Enter sends.",
                    )
                  : server
                    ? t("Ask about {name}, or for work on it…", { name: server.name })
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
            aria-label={
              busy.length
                ? mode === "redo"
                  ? t("Stop and redo with this")
                  : t("Add as context")
                : t("Send")
            }
          >
            <SendHorizontal className="size-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
