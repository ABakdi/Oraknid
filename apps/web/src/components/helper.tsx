import { HELPER_CLIENT_ACTIONS, type HelperAction, type HelperMessage } from "@oraknid/contracts";
import { BookOpen, Eraser, Send, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Markdown } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { guideFor } from "@/lib/guide";
import { screensText } from "@/lib/help-map";
import { type Ask, onAsk, show } from "@/lib/helper-show";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

const CLIENT = new Set<string>(HELPER_CLIENT_ACTIONS);
/** On a phone the panel covers the page: it steps aside while the helper shows me something. */
const phone = () => typeof matchMedia === "function" && matchMedia("(max-width: 767px)").matches;

/** Shows one action of the helper's in this browser; says so when it can't. */
function useShow() {
  const [location, go] = useLocation();
  const here = useRef(location);
  here.current = location;
  return useCallback(
    async (a: Pick<HelperAction, "name" | "input">) => {
      const r = await show(a, {
        location: () => here.current,
        go: (to) => {
          here.current = to;
          go(to);
        },
      });
      if (!r.ok) toast.error(r.why ?? t("I couldn't show that."));
      return r.ok;
    },
    [go],
  );
}

/**
 * The Oraknid helper (Chats-and-Helper, ADR-024, ADR-041): a floating chat
 * at the bottom left that does what I ask through Oraknid's own API, asks
 * me before the big things, knows the guide and the screens, and shows me
 * pages and controls here in the browser.
 */
export function HelperButton() {
  const [open, setOpen] = useState(false);
  // Stepped aside on a phone while it shows me something; a tap brings it back.
  const [aside, setAside] = useState(false);
  const [about, setAbout] = useState<Ask | null>(null);
  const talk = useLive(() => api.helper.conversation(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("helper."),
  });
  const thinking = useLive(() => api.helper.thinking(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("helper."),
  });
  const run = useShow();

  const showMe = useCallback(
    (a: Pick<HelperAction, "name" | "input">) => {
      if (phone()) {
        setOpen(false);
        setAside(true);
      }
      return run(a);
    },
    [run],
  );

  // What the helper shows me runs once, here, for the replies to what I sent from here:
  // the messages there were when I sent are left alone (another tab, an earlier turn).
  const before = useRef<Set<string> | null>(null);
  const answered = useRef(false);
  useEffect(() => {
    const known = before.current;
    if (!known || !talk.data) return;
    const todo = talk.data.filter((m) => m.author === "helper" && !known.has(m.id));
    if (!todo.length) return;
    for (const m of todo) known.add(m.id);
    const actions = todo.flatMap((m) =>
      m.actions.filter((a) => CLIENT.has(a.name) && a.state === "done"),
    );
    answered.current = true;
    void (async () => {
      for (const a of actions) await showMe(a);
    })();
  }, [talk.data, showMe]);
  // The turn over (it answered, and no longer thinks): later messages are not mine to show.
  // biome-ignore lint/correctness/useExhaustiveDependencies: checked again when the reply arrives after the idle
  useEffect(() => {
    if (thinking.data === false && answered.current) {
      before.current = null;
      answered.current = false;
    }
  }, [thinking.data, talk.data]);

  // "Ask the helper about this" on a guide page.
  useEffect(
    () =>
      onAsk((a) => {
        setAbout(a);
        setAside(false);
        setOpen(true);
      }),
    [],
  );

  const toggle = () => {
    if (aside) {
      setAside(false);
      setOpen(true);
      return;
    }
    setOpen((o) => !o);
  };
  return (
    <>
      <Button
        size="icon"
        data-help="helper.button"
        className={cn(
          "fixed bottom-20 left-3 z-40 size-11 rounded-full shadow-lg md:bottom-4 md:left-4",
          // Aside, it waits on the other edge, off what it points at (most controls start on the left).
          aside &&
            "ring-2 ring-eye ring-offset-2 ring-offset-background max-md:right-3 max-md:left-auto",
        )}
        aria-label={
          aside
            ? t("Back to the helper")
            : open
              ? t("Close the helper")
              : t("Ask the Oraknid helper")
        }
        title={aside ? t("Back to the helper") : undefined}
        onClick={toggle}
      >
        {open ? <X className="size-5" /> : <Sparkles className="size-5" />}
      </Button>
      {open ? (
        <Panel
          talk={talk}
          thinking={thinking}
          about={about}
          onAbout={setAbout}
          onSent={() => {
            before.current = new Set((talk.data ?? []).map((m) => m.id));
            answered.current = false;
          }}
          onShow={showMe}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

function Panel({
  talk,
  thinking,
  about,
  onAbout,
  onSent,
  onShow,
  onClose,
}: {
  talk: ReturnType<typeof useLive<HelperMessage[]>>;
  thinking: ReturnType<typeof useLive<boolean>>;
  about: Ask | null;
  onAbout: (a: Ask | null) => void;
  /** I sent: what the helper shows in answer runs here. */
  onSent: () => void;
  onShow: (a: HelperAction) => Promise<boolean>;
  onClose: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [location] = useLocation();
  // Esc closes it; a dialog open over it closes first.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) onClose();
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [onClose]);
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const count = talk.data?.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the conversation grows
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [count, thinking.data]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page to ask about puts me in the field
  useEffect(() => {
    if (about) input.current?.focus();
  }, [about?.about]);
  const send = async () => {
    const t0 = text.trim();
    if (!t0) return;
    setText("");
    onSent();
    try {
      // What the app knows goes with it: where I am, the guide's related pages, the screens (ADR-041).
      await api.helper.send({
        text: t0,
        context: {
          route: location,
          guide: guideFor(t0, about?.about),
          screens: screensText(),
          ...(about ? { about: about.about } : {}),
        },
      });
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
          title={t("Clear the conversation")}
          onClick={async () => {
            if (
              await confirm(
                t("Clear the conversation?"),
                t("What was said is gone; what the helper did stays done."),
                t("Clear"),
                { keep: t("Keep it") },
              )
            )
              api.helper.clear().catch((e) => toast.error(message(e)));
          }}
        >
          <Eraser className="size-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("Close (Esc)")}
          title={t("Close (Esc)")}
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
        {dialog}
      </header>
      <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {talk.data && count === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t(
              'Ask me to do things in Oraknid, or where something is: "make a project for my site in ~/Dev/site as a new private GitHub repo", "where do I turn the terminal on?", "what did the invoice from Bob say?". I show you on the page, and ask before starting a job, creating a repo or deleting.',
            )}
          </div>
        ) : null}
        {(talk.data ?? []).map((m) => (
          <Bubble key={m.id} m={m} onSettled={talk.reload} onShow={onShow} />
        ))}
        {thinking.data ? (
          <div className="text-xs text-muted-foreground">{t("Thinking…")}</div>
        ) : null}
      </div>
      <form
        className="space-y-1.5 border-t p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {about ? (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <BookOpen className="size-3.5 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 truncate">
              {t("About “{title}” in the guide", { title: about.title })}
            </span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label={t("Not about this page")}
              title={t("Not about this page")}
              onClick={() => onAbout(null)}
            >
              <X className="size-3" />
            </Button>
          </div>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={input}
            rows={2}
            value={text}
            placeholder={
              about ? t("What would you like to know about it?") : t("What should I do?")
            }
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
        </div>
      </form>
    </section>
  );
}

function Bubble({
  m,
  onSettled,
  onShow,
}: {
  m: HelperMessage;
  onSettled: () => void;
  onShow: (a: HelperAction) => Promise<boolean>;
}) {
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
          <Action key={i} a={a} messageId={m.id} index={i} onSettled={onSettled} onShow={onShow} />
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
  onShow,
}: {
  a: HelperAction;
  messageId: string;
  index: number;
  onSettled: () => void;
  onShow: (a: HelperAction) => Promise<boolean>;
}) {
  const [, go] = useLocation();
  const [busy, setBusy] = useState(false);
  const client = CLIENT.has(a.name);
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
          {client && a.state === "done" ? t("shown") : t(STATE[a.state])}
        </Badge>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{a.summary}</span>
      </div>
      {a.state === "proposed" ? (
        // What will run, exactly: the summary is the model's words, this is the action (Audit 2).
        <div className="rounded border bg-muted/40 p-1.5 font-mono text-[11px] [overflow-wrap:anywhere]">
          {a.name} {JSON.stringify(a.input)}
        </div>
      ) : null}
      {a.result && !client ? (
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
        {client && a.state === "done" ? (
          <Button size="sm" variant="secondary" className="h-7" onClick={() => void onShow(a)}>
            {a.name === "navigate" ? t("Open again") : t("Show me again")}
          </Button>
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
