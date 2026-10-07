import type { ChatMessage, ChatView, LegView } from "@oraknid/contracts";
import { MessageSquarePlus, Pencil, Send, Square, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useLocation, useSearch } from "wouter";
import { BackButton, Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { AddLegButtons } from "@/components/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

/**
 * Chats with my models (Chats-and-Helper, ADR-025): talk and research,
 * with projects I attach readable.
 */
export function ChatsPage({ id }: { id?: string }) {
  const [, go] = useLocation();
  const chats = useLive(() => api.chats.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("chat."),
  });
  // `/chats?new` (the command palette's New chat) opens the new chat dialog.
  const search = useSearch();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (new URLSearchParams(search).has("new")) setCreating(true);
  }, [search]);
  if (chats.error) return <ErrorNote error={chats.error} />;
  if (chats.loading) return <Loading />;
  const list = chats.data ?? [];
  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-0 flex-col gap-3 md:h-[calc(100dvh-5rem)]">
      {/* On a phone an open chat takes the whole screen; its own header has the way back. */}
      <div className={cn(id && "hidden md:block")}>
        <PageHeader
          title={t("Chats")}
          sub={t("Talk and research with any of your models. Attached projects are readable.")}
          actions={
            <Button data-help="chats.new" className="gap-1" onClick={() => setCreating(true)}>
              <MessageSquarePlus className="size-4" />
              {t("New chat")}
            </Button>
          }
        />
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <nav
          aria-label={t("My chats")}
          className={cn(
            "min-h-0 w-full shrink-0 space-y-1 overflow-y-auto md:block md:w-64",
            id ? "hidden" : "block",
          )}
        >
          {list.length === 0 ? (
            <Empty
              title={t("No chats yet")}
              action={
                <Button className="gap-1" onClick={() => setCreating(true)}>
                  <MessageSquarePlus className="size-4" />
                  {t("New chat")}
                </Button>
              }
            >
              {t("Talk with any of your models; attach a project and it can read it.")}
            </Empty>
          ) : null}
          {list.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => go(`/chats/${c.id}`, { replace: !!id })}
              className={cn(
                "block w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent",
                c.id === id && "bg-accent",
              )}
            >
              <div className="truncate font-medium" title={c.title}>
                {c.title}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {c.modelLabel} · {ago(c.updatedAt)}
              </div>
            </button>
          ))}
        </nav>
        {id ? (
          <Conversation key={id} id={id} onGone={() => go("/chats", { replace: true })} />
        ) : (
          <div className="hidden flex-1 items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground md:flex">
            {t("Pick a chat, or start a new one.")}
          </div>
        )}
      </div>
      <NewChat open={creating} onOpenChange={setCreating} onCreated={(c) => go(`/chats/${c.id}`)} />
    </div>
  );
}

function Conversation({ id, onGone }: { id: string; onGone: () => void }) {
  const { confirm, dialog } = useConfirm();
  const chat = useLive(() => api.chats.get({ id }), {
    topics: ["overview"],
    refreshOn: (e) =>
      e.type.startsWith("chat.") && (e.payload as { chatId?: string }).chatId === id,
    deps: [id],
  });
  const projects = useLive(() => api.projects.list(), { topics: ["overview"] });
  const [text, setText] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const answering = chat.data?.chat.answering ?? null;
  // While it answers, what it has said so far is read a few times a second.
  useEffect(() => {
    if (answering === null) return;
    const timer = setInterval(() => chat.reload(), 400);
    return () => clearInterval(timer);
  }, [answering, chat.reload]);
  const count = chat.data?.messages.length ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolls when the conversation grows
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [count, answering]);
  if (chat.error) return <ErrorNote error={chat.error} />;
  if (!chat.data) return <Loading />;
  const { chat: c, messages } = chat.data;
  const send = async () => {
    const t0 = text.trim();
    if (!t0) return;
    setText("");
    try {
      await api.chats.send({ id, text: t0 });
      chat.reload();
    } catch (e) {
      setText(t0);
      toast.error(message(e));
    }
  };
  const attached = (projects.data ?? []).filter((p) => c.projectIds.includes(p.id));
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg border bg-card">
      <header className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <BackButton fallback="/chats" label={t("All chats")} className="ml-0 md:hidden" />
        {renaming !== null ? (
          <form
            className="flex min-w-0 flex-1 gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              await api.chats.rename({ id, title: renaming }).catch((x) => toast.error(message(x)));
              setRenaming(null);
            }}
          >
            <Input
              value={renaming}
              aria-label={t("Name")}
              onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
              autoFocus
            />
            <Button size="sm" type="button" variant="secondary" onClick={() => setRenaming(null)}>
              {t("Cancel")}
            </Button>
            <Button size="sm" type="submit" disabled={!renaming.trim()}>
              {t("Save")}
            </Button>
          </form>
        ) : (
          <>
            <h2 className="min-w-0 flex-1 truncate font-medium" title={c.title}>
              {c.title}
            </h2>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("Rename")}
              onClick={() => setRenaming(c.title)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </>
        )}
        <Badge variant="outline" className="max-w-40 truncate" title={c.modelLabel}>
          {c.modelLabel}
        </Badge>
        <Select
          value=""
          onValueChange={(v) =>
            api.chats
              .setProjects({
                id,
                projectIds: c.projectIds.includes(v)
                  ? c.projectIds.filter((x) => x !== v)
                  : [...c.projectIds, v],
              })
              .catch((x) => toast.error(message(x)))
          }
        >
          <SelectTrigger className="h-8 w-auto max-w-56 text-xs" aria-label={t("Attach a project")}>
            <SelectValue
              placeholder={
                attached.length
                  ? t("Reads: {p}", { p: attached.map((p) => p.name).join(", ") })
                  : t("Attach a project")
              }
            />
          </SelectTrigger>
          <SelectContent>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {c.projectIds.includes(p.id) ? "✓ " : ""}
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("Delete the chat")}
          onClick={async () => {
            if (
              !(await confirm(
                t("Delete “{title}”?", { title: c.title }),
                t("The conversation is gone for good."),
                t("Delete"),
                { keep: t("Keep it") },
              ))
            )
              return;
            try {
              await api.chats.remove({ id });
              onGone();
            } catch (x) {
              toast.error(message(x));
            }
          }}
        >
          <Trash2 className="size-3.5" />
        </Button>
        {dialog}
      </header>
      <div ref={box} className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {messages.map((m) => (
          <Bubble key={m.id} m={m} />
        ))}
        {answering !== null ? (
          <Bubble
            m={{
              id: "answering",
              author: "model",
              text: answering || "…",
              model: null,
              error: null,
              at: Date.now(),
            }}
          />
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
          placeholder={t("Write a message… (Enter sends, Shift+Enter for a new line)")}
          className="min-h-11 flex-1 resize-none"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
        />
        {answering !== null ? (
          <Button
            type="button"
            variant="secondary"
            aria-label={t("Stop")}
            onClick={() => api.chats.stop({ id }).catch((x) => toast.error(message(x)))}
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button type="submit" aria-label={t("Send")} disabled={!text.trim()}>
            <Send className="size-4" />
          </Button>
        )}
      </form>
    </section>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const mine = m.author === "owner";
  return (
    <div className={cn("flex", mine ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "min-w-0 max-w-[92%] rounded-lg px-3 py-2 text-sm md:max-w-[80%]",
          mine ? "bg-primary text-primary-foreground" : "bg-muted",
        )}
      >
        {mine ? <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{m.text}</div> : null}
        {!mine && m.text ? <Markdown text={m.text} /> : null}
        {m.error ? <div className="mt-1 text-xs text-destructive">{m.error}</div> : null}
        {!mine && m.model ? (
          <div className="mt-1 text-[10px] text-muted-foreground">{m.model}</div>
        ) : null}
      </div>
    </div>
  );
}

function NewChat({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (c: ChatView) => void;
}) {
  const legs = useLive(() => api.legs.list(), { topics: ["overview"] });
  const projects = useLive(() => api.projects.list(), { topics: ["overview"] });
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const usable = (legs.data ?? []).filter((l) => l.health === "healthy" && !l.paused);
  const choices = usable.flatMap((l: LegView) =>
    l.models.filter((m) => !m.hidden).map((m) => ({ leg: l, m })),
  );
  const chosen = choices.find((c) => c.m.id === model) ?? choices[0];
  const create = async () => {
    if (!chosen) return;
    setBusy(true);
    try {
      const c = await api.chats.create({
        legModelId: chosen.m.id,
        effort: effort || null,
        projectIds,
        ...(text.trim() ? { text: text.trim() } : {}),
      });
      onOpenChange(false);
      setText("");
      onCreated(c);
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("New chat")}</DialogTitle>
          <DialogDescription>
            {t(
              "It can read the projects you attach and look things up on the web; it never changes anything.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("Model")}</Label>
            {choices.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <div>{t("No Leg is healthy right now: add one, or log one in on Legs.")}</div>
                <div className="flex flex-wrap gap-2">
                  <AddLegButtons size="sm" />
                </div>
              </div>
            ) : (
              <Select value={chosen?.m.id ?? ""} onValueChange={setModel}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map(({ leg, m }) => (
                    <SelectItem key={m.id} value={m.id}>
                      {leg.name} · {m.displayName || m.model}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {chosen?.m.effortLevels.length ? (
            <div className="space-y-1.5">
              <Label>{t("Effort")}</Label>
              <Select
                value={effort || "default"}
                onValueChange={(v) => setEffort(v === "default" ? "" : v)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">{t("The model's default")}</SelectItem>
                  {chosen.m.effortLevels.map((e) => (
                    <SelectItem key={e} value={e}>
                      {e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {(projects.data ?? []).length ? (
            <fieldset className="min-w-0 space-y-1">
              <legend className="text-sm font-medium">{t("Projects it may read")}</legend>
              {(projects.data ?? []).map((p) => (
                <label key={p.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={projectIds.includes(p.id)}
                    onChange={(e) =>
                      setProjectIds((ids) =>
                        e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id),
                      )
                    }
                  />
                  {p.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          <div className="space-y-1.5">
            <Label htmlFor="first">{t("First message")}</Label>
            <Textarea id="first" rows={4} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button disabled={busy || !chosen} onClick={create}>
            {busy ? t("Starting…") : t("Start the chat")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
