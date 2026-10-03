import type {
  MailAccountView,
  MailDraftView,
  MailFolderView,
  MailMessageView,
  MailThreadSummary,
} from "@oraknid/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Archive,
  ArrowLeft,
  Bot,
  ChevronDown,
  FolderInput,
  Forward,
  Hourglass,
  Inbox,
  LogOut,
  Mail,
  MailOpen,
  MoreHorizontal,
  PanelLeft,
  Paperclip,
  PenSquare,
  Plug,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings2,
  Star,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import {
  ACCOUNT_STATE,
  AccountSettings,
  AddAccountDialog,
  ReconnectDialog,
  removeAccount,
} from "@/components/mail-accounts-card";
import { Composer, type Draft } from "@/components/mail-composer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, message } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { live, useLive } from "@/lib/live";
import { cleanMailHtml, textMail } from "@/lib/mail-html";
import { remote } from "@/lib/remote";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

/** The drafts waiting for my approval, shown as a folder of their own. */
const WAITING = "waiting";
const PAGE = 100;

const isMail = (e: { type: string }) => e.type.startsWith("mail.");
const accountOf = (e: { payload: unknown }) =>
  (e.payload as { accountId?: string } | null)?.accountId;

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(message(e));
  }
}

/** Actions on the open conversation, for the keyboard. */
interface ThreadActions {
  archive(): void;
  remove(): void;
  reply(all: boolean): void;
  forward(): void;
  star(): void;
  unread(): void;
}

/** An account's dialogs, opened from its menu in the folder list. */
type Managing = { kind: "settings" | "reconnect"; account: MailAccountView } | null;

/**
 * Mail (Web-UI → Mail, ADR-032): accounts and folders, a virtual list of
 * conversations, the open one. Three panes on a wide screen; on a phone
 * the list, with the folders in a drawer, or the open conversation.
 * Accounts are added, reconnected, set and removed here too. Keys: c
 * write, / search, j/k next and previous, e archive, # delete, r reply,
 * a reply all, f forward, s star, u unread, Esc back.
 */
export function MailPage({
  account,
  folder,
  thread,
}: {
  account?: string;
  folder?: string;
  thread?: string;
}) {
  const [, go] = useLocation();
  const accounts = useLive(() => api.mail.accounts(), {
    topics: ["mail"],
    refreshOn: (e) =>
      e.type.startsWith("mail.account") || e.type === "mail.new" || e.type === "mail.synced",
  });
  const drafts = useLive(() => api.mail.drafts({}), {
    topics: ["mail"],
    refreshOn: (e) => e.type === "mail.draft" || e.type === "mail.sent",
  });
  const [composing, setComposing] = useState<Draft | null>(null);
  const [query, setQuery] = useState("");
  // On a phone: the folders, in a drawer over the list.
  const [drawer, setDrawer] = useState(false);
  const [adding, setAdding] = useState(false);
  const [managing, setManaging] = useState<Managing>(null);
  const { confirm, dialog } = useConfirm();
  const search = useRef<HTMLInputElement>(null);
  const threads = useRef<MailThreadSummary[]>([]);
  const actions = useRef<ThreadActions | null>(null);
  const threadId = thread ? decodeURIComponent(thread) : undefined;
  const away = !!remote();

  const list = accounts.data ?? [];
  const current = list.find((a) => a.id === account) ?? list[0];
  const folders = useLive(
    () => (current ? api.mail.folders({ accountId: current.id }) : Promise.resolve([])),
    {
      topics: ["mail"],
      refreshOn: (e) => isMail(e) && (accountOf(e) === current?.id || e.type === "mail.draft"),
      deps: [current?.id],
    },
  );
  const inbox = folders.data?.find((f) => f.specialUse === "\\Inbox");
  const folderId = folder ?? inbox?.id;

  // /mail, or an account, opens its inbox.
  useEffect(() => {
    if (!folder && current && inbox) go(`/mail/${current.id}/${inbox.id}`, { replace: true });
  }, [folder, current, inbox, go]);

  const base = current && folderId ? `/mail/${current.id}/${folderId}` : "/mail";
  const open = useCallback(
    (id: string | null) => go(id ? `${base}/${encodeURIComponent(id)}` : base),
    [base, go],
  );

  const write = useCallback(
    (d?: Partial<Draft>) => {
      if (!current) return;
      setComposing({
        accountId: current.id,
        to: [],
        cc: [],
        bcc: [],
        subject: "",
        html: "",
        text: "",
        replyToId: null,
        forwardOfId: null,
        attachments: [],
        ...d,
      });
    },
    [current],
  );

  // The keyboard: only when no field has the focus and no dialog is open.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      if (document.querySelector("[role=dialog]")) return;
      const at = threads.current.findIndex((x) => x.threadId === threadId);
      const step = (d: number) => {
        const next = threads.current[Math.max(0, Math.min(threads.current.length - 1, at + d))];
        if (next) open(next.threadId);
      };
      const keys: Record<string, () => void> = {
        c: () => write(),
        "/": () => search.current?.focus(),
        j: () => step(1),
        k: () => step(-1),
        e: () => actions.current?.archive(),
        "#": () => actions.current?.remove(),
        r: () => actions.current?.reply(false),
        a: () => actions.current?.reply(true),
        f: () => actions.current?.forward(),
        s: () => actions.current?.star(),
        u: () => actions.current?.unread(),
        Escape: () => open(null),
      };
      const fn = keys[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [threadId, open, write]);

  if (accounts.error) return <ErrorNote error={accounts.error} />;
  if (accounts.loading) return <Loading />;
  if (!current)
    return (
      <>
        <Empty
          title={t("No mail account yet")}
          action={
            away ? undefined : (
              <Button className="gap-1" onClick={() => setAdding(true)}>
                <Plus className="size-4" />
                {t("Add an account")}
              </Button>
            )
          }
        >
          {away
            ? t("Accounts are added on the computer running Oraknid, not away from home.")
            : t(
                "Connect Gmail, Outlook or any IMAP or POP3 account. Oraknid keeps your mail here, and agents can read and draft, never send without you.",
              )}
        </Empty>
        <AddAccountDialog open={adding} onOpenChange={setAdding} />
      </>
    );

  const waiting = (drafts.data ?? []).filter((d) => d.state === "waiting");
  const pane = threadId ? "thread" : "list";
  const folderName =
    folderId === WAITING
      ? t("Waiting for you")
      : (folders.data?.find((f) => f.id === folderId)?.name ?? "");
  const sidebar = (onPick: () => void) => (
    <MailSidebar
      accounts={list}
      current={current}
      folders={folders.data ?? []}
      folderId={folderId}
      waiting={waiting.length}
      away={away}
      onPick={onPick}
      onWrite={() => {
        onPick();
        write();
      }}
      onAdd={() => {
        onPick();
        setAdding(true);
      }}
      onManage={(m) => {
        onPick();
        setManaging(m);
      }}
      onRemove={(a) => {
        onPick();
        void removeAccount(a, confirm).then((gone) => gone && go("/mail"));
      }}
    />
  );

  return (
    <div className="flex h-[calc(100dvh-7rem)] min-h-0 flex-col gap-2 md:h-[calc(100dvh-5rem)]">
      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[14rem_minmax(18rem,24rem)_1fr]">
        <nav
          aria-label={t("Accounts and folders")}
          className="hidden min-h-0 space-y-3 overflow-y-auto lg:block"
        >
          {sidebar(() => {})}
        </nav>
        <Sheet open={drawer} onOpenChange={setDrawer}>
          <SheetContent side="left" className="w-80 max-w-[85vw] gap-2 overflow-y-auto p-3 pt-10">
            <SheetHeader className="sr-only">
              <SheetTitle>{t("Accounts and folders")}</SheetTitle>
              <SheetDescription>{t("Pick a folder, or manage an account.")}</SheetDescription>
            </SheetHeader>
            <nav aria-label={t("Accounts and folders")} className="space-y-3">
              {sidebar(() => setDrawer(false))}
            </nav>
          </SheetContent>
        </Sheet>
        <section
          aria-label={t("Conversations")}
          className={cn("min-h-0 flex-col gap-2 lg:flex", pane === "list" ? "flex" : "hidden")}
        >
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 lg:hidden"
              data-help="mail.folders"
              aria-label={t("Folders and accounts")}
              onClick={() => setDrawer(true)}
            >
              <PanelLeft className="size-4" />
            </Button>
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute top-2 left-2 size-4 text-muted-foreground" />
              <Input
                ref={search}
                data-help="mail.search"
                className="h-8 pl-8"
                placeholder={t("Search this folder  /")}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key !== "Escape") return;
                  e.currentTarget.blur();
                  setQuery("");
                }}
              />
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-help="mail.check"
                  variant="ghost"
                  size="icon"
                  className="shrink-0"
                  aria-label={t("Check for mail")}
                  onClick={() => act(() => api.mail.sync({ id: current.id }))}
                >
                  <RefreshCw className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {current.protocol === "pop"
                  ? t("Oraknid checks every two minutes; this checks now.")
                  : t("New mail arrives on its own; this checks every folder now.")}
              </TooltipContent>
            </Tooltip>
            <Button
              size="icon"
              className="shrink-0 lg:hidden"
              aria-label={t("Write")}
              onClick={() => write()}
            >
              <PenSquare className="size-4" />
            </Button>
          </div>
          {/* Where I am, on a phone, where the folders are out of sight. */}
          <button
            type="button"
            className="flex items-center gap-1 truncate px-1 text-left text-xs text-muted-foreground lg:hidden"
            onClick={() => setDrawer(true)}
          >
            <span className="truncate">
              {current.name} · {folderName}
            </span>
            <ChevronDown className="size-3 shrink-0" />
          </button>
          <AccountState
            account={current}
            onReconnect={() => setManaging({ kind: "reconnect", account: current })}
          />
          {folderId === WAITING ? (
            <WaitingList
              drafts={waiting}
              accounts={list}
              onOpen={(d) =>
                d.threadId
                  ? go(`/mail/${d.accountId}/${WAITING}/${encodeURIComponent(d.threadId)}`)
                  : setComposing({ ...d, attachments: [], title: t("Draft") })
              }
            />
          ) : folderId ? (
            <ThreadList
              key={`${current.id}/${folderId}/${query}`}
              accountId={current.id}
              folderId={folderId}
              query={query}
              selected={threadId}
              onOpen={open}
              onThreads={(xs) => {
                threads.current = xs;
              }}
            />
          ) : (
            <Loading />
          )}
        </section>
        <section
          aria-label={t("Conversation")}
          className={cn("min-h-0 lg:block", pane === "thread" ? "block" : "hidden")}
        >
          {threadId ? (
            <ThreadView
              key={threadId}
              account={current}
              folders={folders.data ?? []}
              threadId={threadId}
              onBack={() => open(null)}
              onWrite={write}
              actions={actions}
            />
          ) : (
            <div className="hidden h-full items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground lg:flex">
              {t("Pick a conversation.")}
            </div>
          )}
        </section>
      </div>
      <Composer draft={composing} accounts={list} onClose={() => setComposing(null)} />
      <AddAccountDialog open={adding} onOpenChange={setAdding} />
      {managing?.kind === "reconnect" ? (
        <ReconnectDialog
          account={list.find((a) => a.id === managing.account.id) ?? managing.account}
          open
          onOpenChange={(o) => !o && setManaging(null)}
        />
      ) : null}
      {managing?.kind === "settings" ? (
        <AccountDialog
          account={list.find((a) => a.id === managing.account.id) ?? managing.account}
          away={away}
          onClose={() => setManaging(null)}
        />
      ) : null}
      {dialog}
    </div>
  );
}

const FOLDER_ICON: Record<string, typeof Inbox> = {
  "\\Inbox": Inbox,
  "\\Sent": Send,
  "\\Drafts": PenSquare,
  "\\Archive": Archive,
  "\\Trash": Trash2,
  "\\Junk": MailOpen,
};

/** Write, what waits for me, every account with its folders and its menu, and adding one. */
function MailSidebar({
  accounts,
  current,
  folders,
  folderId,
  waiting,
  away,
  onPick,
  onWrite,
  onAdd,
  onManage,
  onRemove,
}: {
  accounts: MailAccountView[];
  current: MailAccountView;
  folders: MailFolderView[];
  folderId: string | undefined;
  waiting: number;
  away: boolean;
  onPick: () => void;
  onWrite: () => void;
  onAdd: () => void;
  onManage: (m: NonNullable<Managing>) => void;
  onRemove: (a: MailAccountView) => void;
}) {
  return (
    <>
      <Button data-help="mail.write" className="w-full gap-1" onClick={onWrite}>
        <PenSquare className="size-4" />
        {t("Write")}
        <kbd className="ml-auto hidden rounded border border-primary-foreground/40 px-1 text-[10px] lg:inline">
          c
        </kbd>
      </Button>
      {waiting ? (
        <Link
          href={`/mail/${current.id}/${WAITING}`}
          onClick={onPick}
          className={cn(
            "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
            folderId === WAITING && "bg-accent font-medium",
          )}
        >
          <Hourglass className="size-4 text-warning" />
          <span className="flex-1">{t("Waiting for you")}</span>
          <Badge>{waiting}</Badge>
        </Link>
      ) : null}
      {accounts.map((a) => (
        <AccountFolders
          key={a.id}
          account={a}
          open={a.id === current.id}
          folders={a.id === current.id ? folders : []}
          folderId={folderId}
          away={away}
          onPick={onPick}
          onManage={onManage}
          onRemove={onRemove}
        />
      ))}
      {away ? null : (
        <Button
          data-help="mail.add-account"
          variant="ghost"
          size="sm"
          className="w-full justify-start gap-2"
          onClick={onAdd}
        >
          <Plus className="size-4" />
          {t("Add an account")}
        </Button>
      )}
    </>
  );
}

function AccountFolders({
  account,
  open,
  folders,
  folderId,
  away,
  onPick,
  onManage,
  onRemove,
}: {
  account: MailAccountView;
  open: boolean;
  folders: MailFolderView[];
  folderId: string | undefined;
  away: boolean;
  onPick: () => void;
  onManage: (m: NonNullable<Managing>) => void;
  onRemove: (a: MailAccountView) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1">
        <Link
          href={`/mail/${account.id}`}
          onClick={onPick}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground"
        >
          <span className="flex-1 truncate">{account.name}</span>
          {account.state === "reconnect" || account.state === "error" ? (
            <span className="size-2 rounded-full bg-destructive" title={t("needs attention")}>
              <span className="sr-only">{t("needs attention")}</span>
            </span>
          ) : account.unread ? (
            <span>{account.unread}</span>
          ) : null}
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              data-help="mail.account-menu"
              aria-label={t("{name}: account menu", { name: account.name })}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => act(() => api.mail.sync({ id: account.id }), t("Checking for mail."))}
            >
              <RefreshCw className="size-4" />
              {t("Check for mail")}
            </DropdownMenuItem>
            {away ? null : (
              <>
                <DropdownMenuItem
                  data-help="mail.reconnect"
                  onSelect={() => onManage({ kind: "reconnect", account })}
                >
                  <Plug className="size-4" />
                  {t("Reconnect…")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  data-help="mail.account-settings"
                  onSelect={() => onManage({ kind: "settings", account })}
                >
                  <Settings2 className="size-4" />
                  {t("Account settings…")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onRemove(account)}>
                  <LogOut className="size-4" />
                  {t("Remove from Oraknid…")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open ? (
        <ul className="mt-1 space-y-0.5">
          {folders.map((f) => {
            const Icon = (f.specialUse && FOLDER_ICON[f.specialUse]) || FolderInput;
            return (
              <li key={f.id}>
                <Link
                  href={`/mail/${account.id}/${f.id}`}
                  onClick={onPick}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                    f.id === folderId && "bg-accent font-medium",
                  )}
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{f.name}</span>
                  {f.unread && f.specialUse !== "\\Sent" && f.specialUse !== "\\Trash" ? (
                    <span className="text-xs text-muted-foreground">{f.unread}</span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

/** An account's state and switches, from its menu: no trip to Settings. */
function AccountDialog({
  account: a,
  away,
  onClose,
}: {
  account: MailAccountView;
  away: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="[overflow-wrap:anywhere]">{a.name}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span className="[overflow-wrap:anywhere]">{a.email}</span>
            <Badge
              variant={a.state === "reconnect" || a.state === "error" ? "destructive" : "outline"}
            >
              {t(ACCOUNT_STATE[a.state])}
            </Badge>
          </DialogDescription>
        </DialogHeader>
        {a.error ? <div className="text-xs text-destructive">{a.error}</div> : null}
        <AccountSettings account={a} away={away} />
      </DialogContent>
    </Dialog>
  );
}

/** "Reconnect" when the login stopped working; the error otherwise. Never a silent failure. */
function AccountState({
  account,
  onReconnect,
}: {
  account: MailAccountView;
  onReconnect: () => void;
}) {
  if (account.state === "syncing" && !account.lastSyncAt)
    return (
      <div className="text-xs text-muted-foreground">
        {t("Fetching your mail for the first time…")}
      </div>
    );
  if (account.state !== "reconnect" && account.state !== "error") return null;
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
    >
      <div className="text-destructive [overflow-wrap:anywhere]">
        {account.state === "reconnect"
          ? t("{email} needs signing in again: {error}", {
              email: account.email,
              error: account.error ?? "",
            })
          : t("Can't reach {email}'s server: {error}. Oraknid keeps trying.", {
              email: account.email,
              error: account.error ?? "",
            })}
      </div>
      {account.state === "reconnect" && !remote() ? (
        <Button size="sm" onClick={onReconnect}>
          {t("Reconnect")}
        </Button>
      ) : null}
    </div>
  );
}

/**

 * A folder's conversations, as many as it has: only the rows on screen
 * are drawn, and pages of a hundred are fetched as they come into view.
 */
function ThreadList({
  accountId,
  folderId,
  query,
  selected,
  onOpen,
  onThreads,
}: {
  accountId: string;
  folderId: string;
  query: string;
  selected: string | undefined;
  onOpen: (id: string) => void;
  onThreads: (xs: MailThreadSummary[]) => void;
}) {
  const [total, setTotal] = useState<number | null>(null);
  const [pages, setPages] = useState(() => new Map<number, MailThreadSummary[]>());
  const [error, setError] = useState<unknown>(null);
  const asked = useRef(new Set<number>());
  const box = useRef<HTMLDivElement>(null);
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(
    (page: number) => {
      asked.current.add(page);
      api.mail
        .threads({
          accountId,
          folderId,
          offset: page * PAGE,
          limit: PAGE,
          ...(debounced ? { query: debounced } : {}),
        })
        .then((r) => {
          setTotal(r.total);
          setPages((m) => new Map(m).set(page, r.threads));
          setError(null);
        })
        .catch((e) => {
          asked.current.delete(page);
          setError(e);
        });
    },
    [accountId, folderId, debounced],
  );

  // A new folder or search starts from the top.
  useEffect(() => {
    asked.current = new Set();
    setPages(new Map());
    load(0);
  }, [load]);

  // Live: what changed in this account reloads the pages on hand.
  useEffect(() => {
    const off = live.subscribe(["mail"]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offEvents = live.on((e) => {
      if (e.topic !== "mail" || !isMail(e)) return;
      if (accountOf(e) !== accountId && e.type !== "mail.draft") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        for (const p of asked.current) load(p);
      }, 150);
    });
    return () => {
      off();
      offEvents();
      clearTimeout(timer);
    };
  }, [accountId, load]);

  const rows = total ?? 0;
  const virtual = useVirtualizer({
    count: rows,
    getScrollElement: () => box.current,
    estimateSize: () => 76,
    overscan: 10,
  });
  const items = virtual.getVirtualItems();
  useEffect(() => {
    for (const it of items) {
      const p = Math.floor(it.index / PAGE);
      if (!asked.current.has(p)) load(p);
    }
  }, [items, load]);

  const flat = useMemo(() => {
    const out: MailThreadSummary[] = [];
    for (const k of [...pages.keys()].sort((a, b) => a - b)) out.push(...(pages.get(k) ?? []));
    return out;
  }, [pages]);
  useEffect(() => onThreads(flat), [flat, onThreads]);

  if (error && total === null) return <ErrorNote error={error} />;
  if (total === null) return <Loading />;
  if (total === 0)
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {debounced ? t("Nothing matches “{q}”.", { q: debounced }) : t("Nothing here.")}
      </div>
    );
  return (
    <div ref={box} className="min-h-0 flex-1 overflow-y-auto rounded-lg border">
      <ul style={{ height: virtual.getTotalSize(), position: "relative" }}>
        {items.map((it) => {
          const th = pages.get(Math.floor(it.index / PAGE))?.[it.index % PAGE];
          return (
            <li
              key={it.key}
              data-index={it.index}
              ref={virtual.measureElement}
              className="absolute inset-x-0 top-0"
              style={{ transform: `translateY(${it.start}px)` }}
            >
              {th ? (
                <ThreadRow thread={th} selected={th.threadId === selected} onOpen={onOpen} />
              ) : (
                <div className="h-[76px] animate-pulse border-b bg-muted/40" />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ThreadRow({
  thread: th,
  selected,
  onOpen,
}: {
  thread: MailThreadSummary;
  selected: boolean;
  onOpen: (id: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(th.threadId)}
      aria-current={selected || undefined}
      className={cn(
        "block w-full border-b px-3 py-2 text-left text-sm hover:bg-accent/60",
        selected && "bg-accent",
      )}
    >
      <div className="flex items-center gap-1.5">
        {th.unread ? (
          <span className="size-2 shrink-0 rounded-full bg-primary">
            <span className="sr-only">{t("unread")}</span>
          </span>
        ) : null}
        <span className={cn("flex-1 truncate", th.unread && "font-semibold")}>
          {th.from.slice(0, 3).join(", ")}
          {th.count > 1 ? (
            <span className="ml-1 text-xs text-muted-foreground">{th.count}</span>
          ) : null}
        </span>
        {th.drafts ? (
          <Bot className="size-3.5 text-warning" aria-label={t("a draft waits")} />
        ) : null}
        {th.hasAttachments ? <Paperclip className="size-3.5 text-muted-foreground" /> : null}
        {th.starred ? (
          <Star className="size-3.5 fill-warning text-warning" aria-label={t("starred")} />
        ) : null}
        <span className="shrink-0 text-xs text-muted-foreground">{ago(th.date)}</span>
      </div>
      <div className={cn("truncate", th.unread ? "font-medium" : "text-foreground/90")}>
        {th.subject || t("(no subject)")}
      </div>
      <div className="truncate text-xs text-muted-foreground">{th.snippet}</div>
    </button>
  );
}

function WaitingList({
  drafts,
  accounts,
  onOpen,
}: {
  drafts: MailDraftView[];
  accounts: MailAccountView[];
  onOpen: (d: MailDraftView) => void;
}) {
  if (!drafts.length)
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t("Nothing waits for you.")}
      </div>
    );
  return (
    <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {drafts.map((d) => (
        <li key={d.id}>
          <button
            type="button"
            className="w-full rounded-lg border p-3 text-left text-sm hover:bg-accent/60"
            onClick={() => onOpen(d)}
          >
            <div className="flex items-center gap-1.5">
              <Bot className="size-4 text-warning" />
              <span className="flex-1 truncate font-medium">{d.subject || t("(no subject)")}</span>
              <span className="text-xs text-muted-foreground">{ago(d.updatedAt)}</span>
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {t("To {to}, from {from}", {
                to: d.to.join(", "),
                from: accounts.find((a) => a.id === d.accountId)?.email ?? "",
              })}
            </div>
            <div className="line-clamp-2 text-xs">{d.text}</div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function ThreadView({
  account,
  folders,
  threadId,
  onBack,
  onWrite,
  actions,
}: {
  account: MailAccountView;
  folders: MailFolderView[];
  threadId: string;
  onBack: () => void;
  onWrite: (d: Partial<Draft>) => void;
  actions: React.MutableRefObject<ThreadActions | null>;
}) {
  const thread = useLive(() => api.mail.thread({ accountId: account.id, threadId }), {
    topics: ["mail"],
    refreshOn: (e) => isMail(e) && (accountOf(e) === account.id || e.type === "mail.draft"),
    deps: [account.id, threadId],
  });
  const messages = thread.data?.messages ?? [];
  const ids = messages.map((m) => m.id);
  const last = messages.at(-1);
  const starred = messages.some((m) => m.flags.includes("\\Flagged"));

  // Opening a conversation reads it, on the server too.
  const unread = messages.filter((m) => !m.flags.includes("\\Seen")).map((m) => m.id);
  const unreadKey = unread.join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per set of unread messages
  useEffect(() => {
    if (unread.length) void api.mail.flag({ ids: unread, seen: true }).catch(() => {});
  }, [unreadKey]);

  const reply = async (m: MailMessageView | undefined, all: boolean) => {
    if (!m) return;
    const tpl = await api.mail.replyTemplate({ id: m.id, all });
    onWrite({ ...tpl, title: all ? t("Reply to all") : t("Reply") });
  };
  const forward = (m: MailMessageView | undefined) => {
    if (!m) return;
    const head = `---------- Forwarded message ----------\nFrom: ${m.from?.name ?? ""} <${m.from?.address ?? ""}>\nDate: ${new Date(m.date).toUTCString()}\nSubject: ${m.subject}\n\n`;
    onWrite({
      accountId: account.id,
      subject: /^fwd?:/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
      text: `\n\n${head}${m.text ?? ""}`,
      forwardOfId: m.id,
      title: t("Forward"),
    });
  };
  const archive = () =>
    act(async () => {
      await api.mail.archive({ ids });
      onBack();
    }, t("Archived."));
  const remove = () =>
    act(async () => {
      await api.mail.delete({ ids });
      onBack();
    }, t("Deleted."));
  const star = () => act(() => api.mail.flag({ ids: last ? [last.id] : ids, flagged: !starred }));
  const markUnread = () =>
    act(async () => {
      if (last) await api.mail.flag({ ids: [last.id], seen: false });
      onBack();
    });

  actions.current = thread.data
    ? {
        archive,
        remove,
        reply: (all) => void reply(last, all),
        forward: () => forward(last),
        star,
        unread: markUnread,
      }
    : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: clears the keyboard's target when the view goes
  useEffect(
    () => () => {
      actions.current = null;
    },
    [],
  );

  if (thread.error) return <ErrorNote error={thread.error} />;
  if (!thread.data) return <Loading />;
  if (!messages.length)
    return (
      <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
        {t("This conversation is gone (moved or deleted).")}
      </div>
    );

  const icon = (
    label: string,
    key: string,
    Icon: typeof Archive,
    fn: () => void,
    extra?: string,
  ) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={label} onClick={fn}>
          <Icon className={cn("size-4", extra)} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} <kbd className="ml-1 rounded border px-1 text-[10px]">{key}</kbd>
      </TooltipContent>
    </Tooltip>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-0.5">
        <Button variant="ghost" size="sm" className="gap-1 px-2 lg:hidden" onClick={onBack}>
          <ArrowLeft className="size-4" />
          {t("Back to the list")}
        </Button>
        {icon(t("Archive"), "e", Archive, archive)}
        {icon(t("Delete"), "#", Trash2, remove)}
        {icon(t("Mark unread"), "u", Mail, markUnread)}
        {icon(
          starred ? t("Unstar") : t("Star"),
          "s",
          Star,
          star,
          starred ? "fill-warning text-warning" : undefined,
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="gap-1">
              <FolderInput className="size-4" />
              {t("Move")}
              <ChevronDown className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            {folders.map((f) => (
              <DropdownMenuItem
                key={f.id}
                onSelect={() =>
                  act(
                    async () => {
                      await api.mail.move({ ids, folderId: f.id });
                      onBack();
                    },
                    t("Moved to {f}.", { f: f.name }),
                  )
                }
              >
                {f.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <span className="flex-1" />
        {icon(t("Reply"), "r", Reply, () => void reply(last, false))}
        {icon(t("Reply to all"), "a", ReplyAll, () => void reply(last, true))}
        {icon(t("Forward"), "f", Forward, () => forward(last))}
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">
          {messages.find((m) => !/^re:/i.test(m.subject))?.subject ??
            messages[0]?.subject ??
            t("(no subject)")}
        </h2>
        {messages.map((m, i) => (
          <MessageCard
            key={m.id}
            m={m}
            initiallyOpen={i === messages.length - 1 || !m.flags.includes("\\Seen")}
          />
        ))}
        {thread.data.drafts.map((d) => (
          <DraftCard
            key={d.id}
            d={d}
            onEdit={() => onWrite({ ...d, attachments: [], id: d.id, title: t("Edit draft") })}
          />
        ))}
      </div>
    </div>
  );
}

const who = (a: { name: string; address: string } | null) => (a ? a.name || a.address : "");

function MessageCard({ m, initiallyOpen }: { m: MailMessageView; initiallyOpen: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <article className="rounded-lg border">
      <button
        type="button"
        className="flex w-full flex-wrap items-baseline gap-x-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="font-medium">{who(m.from)}</span>
        {m.from?.name ? (
          <span className="text-xs text-muted-foreground">{m.from.address}</span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {new Date(m.date).toLocaleString()}
        </span>
        {open ? (
          <div className="w-full text-xs text-muted-foreground">
            {t("to {to}", { to: [...m.to, ...m.cc].map(who).join(", ") })}
          </div>
        ) : (
          <div className="w-full truncate text-xs text-muted-foreground">
            {(m.text ?? "").slice(0, 160)}
          </div>
        )}
      </button>
      {open ? (
        <div className="space-y-2 border-t px-3 py-2">
          <MailBody m={m} />
          {m.attachments.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {m.attachments.map((a, i) => (
                // A message's attachments never change order: the position is their identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <li key={i}>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1 text-xs"
                    onClick={() => act(() => download(m.id, i))}
                  >
                    <Paperclip className="size-3" />
                    {a.filename} · {bytes(a.size)}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

async function download(id: string, index: number) {
  const a = await api.mail.attachment({ id, index });
  const bin = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bin], { type: a.contentType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = a.filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The message in a sandboxed frame: cleaned, nothing runs, remote images held back. */
function MailBody({ m }: { m: MailMessageView }) {
  const { resolved } = useTheme();
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(120);
  // Allowed images come from the daemon, inline: nothing here loads from outside.
  const [images, setImages] = useState<Record<string, string> | undefined>();
  useEffect(() => {
    if (!m.imagesAllowed || !m.html) return setImages(undefined);
    let live = true;
    api.mail
      .images({ id: m.id })
      .then((x) => live && setImages(x))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [m.id, m.imagesAllowed, m.html]);
  const clean = useMemo(
    () =>
      m.html
        ? cleanMailHtml(m.html, {
            allowImages: m.imagesAllowed,
            images,
            dark: resolved === "dark",
          })
        : m.text !== null
          ? cleanMailHtml(textMail(m.text), { allowImages: false, dark: resolved === "dark" })
          : null,
    [m.html, m.text, m.imagesAllowed, images, resolved],
  );
  if (!clean)
    return (
      <div className="text-sm text-muted-foreground">{t("The body couldn't be fetched yet.")}</div>
    );
  return (
    <div className="space-y-2">
      {clean.blocked ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-2 py-1 text-xs">
          <span className="flex-1">
            {t("Remote images are hidden, so the sender can't see you read this.")}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 text-xs"
            onClick={() => act(() => api.mail.allowImages({ id: m.id, sender: false }))}
          >
            {t("Show images")}
          </Button>
          {m.from?.address ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => act(() => api.mail.allowImages({ id: m.id, sender: true }))}
            >
              {t("Always from {s}", { s: m.from.address })}
            </Button>
          ) : null}
        </div>
      ) : null}
      <iframe
        ref={frame}
        title={t("Message from {from}", { from: who(m.from) })}
        // No scripts, ever. Same origin only so its height can be read; nothing runs in it to use that.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={clean.doc}
        className="w-full rounded border-0"
        style={{ height }}
        onLoad={() => {
          const doc = frame.current?.contentDocument;
          if (doc) setHeight(Math.min(20_000, doc.documentElement.scrollHeight + 8));
        }}
      />
    </div>
  );
}

/** A draft for this conversation; an agent's is marked and waits for my approval. */
function DraftCard({ d, onEdit }: { d: MailDraftView; onEdit: () => void }) {
  const agent = d.author === "agent";
  return (
    <article
      className={cn(
        "space-y-2 rounded-lg border p-3 text-sm",
        agent ? "border-warning/60 bg-warning/5" : "border-dashed",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {agent ? (
          <Badge variant="outline" className="gap-1 border-warning/60">
            <Bot className="size-3" />
            {t("Written by an agent")}
          </Badge>
        ) : (
          <Badge variant="outline">{t("Draft")}</Badge>
        )}
        {d.state === "waiting" ? <Badge>{t("waiting for your approval")}</Badge> : null}
        {d.state === "failed" ? <Badge variant="destructive">{t("not sent")}</Badge> : null}
        {d.state === "sending" ? <Badge variant="outline">{t("sending…")}</Badge> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {t("to {to}", { to: d.to.join(", ") })}
        </span>
      </div>
      {d.error ? <div className="text-xs text-destructive">{d.error}</div> : null}
      <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.text}</div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          className="gap-1"
          disabled={d.state === "sending"}
          onClick={() =>
            act(async () => {
              const r = await api.mail.approve({ id: d.id });
              if (r.state === "failed") throw new Error(r.error ?? t("It couldn't be sent."));
            }, t("Sent."))
          }
        >
          <Send className="size-3.5" />
          {agent ? t("Approve and send") : t("Send")}
        </Button>
        <Button size="sm" variant="secondary" disabled={d.state === "sending"} onClick={onEdit}>
          {t("Edit")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={d.state === "sending"}
          onClick={() => act(() => api.mail.discard({ id: d.id }), t("Discarded."))}
        >
          {t("Discard")}
        </Button>
      </div>
    </article>
  );
}
