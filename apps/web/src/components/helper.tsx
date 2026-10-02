import type { HelperAction, HelperMessage } from "@oraknid/contracts";
import { Eraser, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Markdown } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * The Oraknid helper (Chats-and-Helper, ADR-024): a floating chat at the
 * bottom left that does what I ask through Oraknid's own API, and asks me
 * before the big things.
 */
export function HelperButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="icon"
        className="fixed bottom-20 left-3 z-40 size-11 rounded-full shadow-lg md:bottom-4 md:left-4"
        aria-label={open ? t("Close the helper") : t("Ask the Oraknid helper")}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <X className="size-5" /> : <Sparkles className="size-5" />}
      </Button>
      {open ? <Panel onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const talk = useLive(() => api.helper.conversation(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("helper."),
  });
  const thinking = useLive(() => api.helper.thinking(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("helper."),
  });
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const count = talk.data?.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the conversation grows
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [count, thinking.data]);
  const send = async () => {
    const t0 = text.trim();
    if (!t0) return;
    setText("");
    try {
      await api.helper.send({ text: t0 });
      thinking.reload();
      talk.reload();
    } catch (e) {
      setText(t0);
      toast.error(message(e));
    }
  };
  return (
    <section
      aria-label={t("Oraknid helper")}
      className="fixed bottom-34 left-3 z-40 flex h-[min(70dvh,36rem)] w-[min(calc(100vw-1.5rem),26rem)] flex-col rounded-xl border bg-card shadow-2xl md:bottom-18 md:left-4"
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Sparkles className="size-4 text-primary" />
        <h2 className="flex-1 text-sm font-medium">{t("Oraknid helper")}</h2>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("Clear the conversation")}
          onClick={() => api.helper.clear().catch((e) => toast.error(message(e)))}
        >
          <Eraser className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("Close")}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </header>
      <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {talk.data && count === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t(
              'Ask me to do things in Oraknid: "make a project for my site in ~/Dev/site as a new private GitHub repo", "a draft to set up Astro there", "how many jobs run at once?". I ask before starting a job, creating a repo or deleting.',
            )}
          </div>
        ) : null}
        {(talk.data ?? []).map((m) => (
          <Bubble key={m.id} m={m} onSettled={talk.reload} />
        ))}
        {thinking.data ? (
          <div className="text-xs text-muted-foreground">{t("Thinking…")}</div>
        ) : null}
      </div>
      <form
        className="flex items-end gap-2 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <Textarea
          rows={2}
          value={text}
          placeholder={t("What should I do?")}
          className="min-h-11 flex-1 resize-none text-sm"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        <Button
          type="submit"
          size="icon"
          aria-label={t("Send")}
          disabled={!text.trim() || !!thinking.data}
        >
          <Send className="size-4" />
        </Button>
      </form>
    </section>
  );
}

function Bubble({ m, onSettled }: { m: HelperMessage; onSettled: () => void }) {
  const mine = m.author === "owner";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[92%] space-y-2 rounded-lg px-3 py-2 text-sm",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {mine ? (
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</div>
        ) : (
          <Markdown text={m.text} />
        )}
        {m.actions.map((a, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a message's actions never move
          <Action key={i} a={a} messageId={m.id} index={i} onSettled={onSettled} />
        ))}
      </div>
    </div>
  );
}

const STATE: Record<HelperAction["state"], string> = {
  done: "done",
  failed: "failed",
  proposed: "waiting for you",
  cancelled: "cancelled",
};

function Action({
  a,
  messageId,
  index,
  onSettled,
}: {
  a: HelperAction;
  messageId: string;
  index: number;
  onSettled: () => void;
}) {
  const [, go] = useLocation();
  const [busy, setBusy] = useState(false);
  const decide = async (confirm: boolean) => {
    setBusy(true);
    try {
      const r = await api.helper.decide({ messageId, index, confirm });
      if (r.state === "failed") toast.error(r.result ?? t("It failed."));
      onSettled();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1 rounded-md border bg-background/60 px-2 py-1.5 text-xs">
      <div className="flex items-center gap-2">
        <Badge
          variant={
            a.state === "failed" ? "destructive" : a.state === "proposed" ? "default" : "outline"
          }
          className="h-5 text-[10px]"
        >
          {t(STATE[a.state])}
        </Badge>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.summary}</span>
      </div>
      {a.state === "proposed" ? (
        // What will run, exactly: the summary is the model's words, this is the action (Audit 2).
        <div className="rounded border bg-muted/40 p-1.5 font-mono text-[11px] [overflow-wrap:anywhere]">
          {a.name} {JSON.stringify(a.input)}
        </div>
      ) : null}
      {a.result ? (
        <div className="text-muted-foreground [overflow-wrap:anywhere]">{a.result}</div>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {a.state === "proposed" ? (
          <>
            <Button size="sm" className="h-7" disabled={busy} onClick={() => decide(true)}>
              {t("Confirm")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7"
              disabled={busy}
              onClick={() => decide(false)}
            >
              {t("Cancel")}
            </Button>
          </>
        ) : null}
        {a.link ? (
          <Button
            size="sm"
            variant="secondary"
            className="h-7"
            onClick={() => go(a.link as string)}
          >
            {t("Open")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
