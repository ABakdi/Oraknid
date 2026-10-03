import type { EyeMessage } from "@oraknid/contracts";
import { Eye, SendHorizontal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Markdown } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

const INTENT: Record<NonNullable<EyeMessage["action"]>["intent"], string> = {
  instruction: "Instruction",
  task: "New work",
  context: "Context",
  later: "For later",
  stop: "Stop",
  question: "Question",
};

/**
 * The prompt to The Eye (Checkpoint 1 → F1-4): I write anything, The Eye
 * decides what it is and acts, then answers in a line. The conversation
 * stays with the job. `full`: the whole height it's given, a conversation
 * as in Chats (Web-UI → Job).
 */
export function EyeChat({ jobId, full = false }: { jobId: string; full?: boolean }) {
  const messages = useLive(() => api.jobs.conversation({ id: jobId }), {
    topics: [`job:${jobId}`],
    refreshOn: (e) => e.type === "eye.message" || e.type === "eye.replied",
    deps: [jobId],
  });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = messages.data ?? [];
  const last = list.at(-1);
  const thinking = last?.author === "owner";
  const shown = all || full ? list : list.slice(-6);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when a message arrives
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [list.length]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    try {
      await api.jobs.talk({ id: jobId, text: value });
      setText("");
      messages.reload();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card className={cn("gap-0 py-0", full && "min-h-0 flex-1")}>
      <CardContent className={cn("space-y-2 p-3", full && "flex min-h-0 flex-1 flex-col")}>
        <div className="flex items-center gap-2 text-sm font-medium">
          <Eye className="size-4 text-primary" />
          {t("The Eye")}
          {full ? (
            <span className="hidden min-w-0 truncate font-normal text-muted-foreground sm:inline">
              {t("— instructions, questions, new work, context: it decides what it is and acts.")}
            </span>
          ) : null}
          {list.length > 6 && !full ? (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto h-6 text-xs"
              onClick={() => setAll((a) => !a)}
            >
              {all ? t("Show the latest") : t("Show all ({n})", { n: list.length })}
            </Button>
          ) : null}
        </div>
        {full && !shown.length ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            {t("Nothing said yet. Whatever you write here, The Eye takes into account.")}
          </div>
        ) : null}
        {shown.length ? (
          <div
            ref={box}
            className={cn("space-y-2 overflow-y-auto", full ? "min-h-0 flex-1 pr-1" : "max-h-72")}
          >
            {shown.map((m) => (
              <div
                key={m.id}
                className={cn("flex", m.author === "owner" ? "justify-end" : "justify-start")}
              >
                <div
                  className={cn(
                    "min-w-0 max-w-[85%] rounded-lg px-3 py-2 text-sm [overflow-wrap:anywhere]",
                    m.author === "owner" ? "bg-primary text-primary-foreground" : "bg-muted",
                  )}
                >
                  {m.author === "owner" ? (
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
                  <div
                    className={cn(
                      "mt-0.5 text-[10px]",
                      m.author === "owner" ? "text-primary-foreground/70" : "text-muted-foreground",
                    )}
                  >
                    {ago(m.createdAt)}
                  </div>
                </div>
              </div>
            ))}
            {thinking ? (
              <div className="animate-pulse text-xs text-muted-foreground">
                {t("The Eye is thinking about it…")}
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            rows={full ? 3 : 2}
            className="min-h-0 flex-1 resize-none"
            placeholder={t(
              "Tell The Eye anything: an instruction, a task to add, context, “stop that”, an idea for later…",
            )}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Full: Enter sends, Shift+Enter is a new line, as in Chats.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey || (full && !e.shiftKey))) {
                e.preventDefault();
                void send();
              }
            }}
            aria-label={t("Message to The Eye")}
          />
          <Button
            size="icon"
            disabled={sending || !text.trim()}
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
