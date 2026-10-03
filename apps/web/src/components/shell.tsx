import {
  Bot,
  Coffee,
  Cog,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Mail,
  MessagesSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  ScrollText,
  Search,
  Server,
  Sparkles,
  SquareTerminal,
  Sun,
  Wand2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { HelperButton } from "@/components/helper";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive, useLiveStatus } from "@/lib/live";
import { store } from "@/lib/store";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: ListTodo },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/mail", label: "Mail", icon: Mail },
  { href: "/legs", label: "Legs", icon: Bot },
  { href: "/chats", label: "Chats", icon: MessagesSquare },
  { href: "/servers", label: "Servers", icon: Server },
  { href: "/terminal", label: "Terminal", icon: SquareTerminal },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Cog },
];
/** On a phone: four tabs and "More" (Web-UI → Layout). */
const TABS = ["/", "/jobs", "/inbox", "/legs"];

/** Pages with a side panel of their own fold the sidebar while open (Web-UI → Layout). */
const FOLDS = [/^\/chats/, /^\/terminal/, /^\/mail/, /^\/jobs\/(?!new)[^/]+/];

/** `g` then a key: where it goes (Web-UI → Keyboard). */
const GO: Record<string, string> = {
  o: "/",
  j: "/jobs",
  p: "/projects",
  i: "/inbox",
  l: "/legs",
  c: "/chats",
  s: "/servers",
  t: "/terminal",
  m: "/mail",
  k: "/skills",
  ",": "/settings",
};

/** What shortcuts there are, for `?`. */
export const SHORTCUTS: { keys: string; does: string; where?: string }[] = [
  { keys: "Ctrl K", does: "Search, jump or run a control" },
  { keys: "?", does: "This list" },
  { keys: "[", does: "Fold or unfold the sidebar" },
  { keys: "n", does: "New work" },
  { keys: "g o", does: "Overview" },
  { keys: "g j", does: "Jobs" },
  { keys: "g p", does: "Projects" },
  { keys: "g i", does: "Inbox" },
  { keys: "g l", does: "Legs" },
  { keys: "g c", does: "Chats" },
  { keys: "g s", does: "Servers" },
  { keys: "g t", does: "Terminal" },
  { keys: "g m", does: "Mail" },
  { keys: "g k", does: "Skills" },
  { keys: "g ,", does: "Settings" },
  { keys: "1 … 9", does: "Go to that tab", where: "Pages with tabs" },
  { keys: "Ctrl Shift Enter", does: "New terminal", where: "Terminal" },
  { keys: "Ctrl Shift X", does: "Close this terminal", where: "Terminal" },
  { keys: "Ctrl Shift ← / →", does: "Previous / next terminal", where: "Terminal" },
  { keys: "Ctrl Shift 1 … 9", does: "Go to that terminal", where: "Terminal" },
  { keys: "Ctrl Shift D", does: "Side by side", where: "Terminal" },
  { keys: "Ctrl Shift G", does: "Grid", where: "Terminal" },
  { keys: "Ctrl Shift F", does: "One at a time", where: "Terminal" },
  { keys: "Select / Ctrl Shift V", does: "Copy / paste", where: "Terminal" },
];

/** Typing somewhere: single-key shortcuts stay out of the way. */
export const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
};

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [, go] = useLocation();
  const [palette, setPalette] = useState(false);
  const [help, setHelp] = useState(false);
  const [more, setMore] = useState(false);
  // Folded: my choice, unless this page folds it; unfolding there lasts until I leave the page.
  const [pref, setPref] = useState(() => store.get("sidebar") === "folded");
  const [override, setOverride] = useState<boolean | null>(null);
  const auto = FOLDS.some((r) => r.test(location));
  const folded = override ?? (auto || pref);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new page drops the page's own choice, and closes More
  useEffect(() => {
    setOverride(null);
    setMore(false);
  }, [location]);
  const toggle = () => {
    if (auto) setOverride(!folded);
    else {
      store.set("sidebar", folded ? "open" : "folded");
      setPref(!folded);
      setOverride(null);
    }
  };
  const status = useLiveStatus();
  const { resolved, set } = useTheme();
  const inbox = useLive(() => api.inbox.list({ state: "open" }), { topics: ["inbox"] });
  const system = useLive(() => api.system.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "system.inhibitor",
  });
  const open = inbox.data?.length ?? 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: toggle reads the current fold
  useEffect(() => {
    let g = 0;
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      if (e.key === "Escape") setMore(false);
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return;
      if (g && Date.now() - g < 1500 && GO[e.key]) {
        g = 0;
        e.preventDefault();
        go(GO[e.key] as string);
        return;
      }
      g = e.key === "g" ? Date.now() : 0;
      if (e.key === "?") setHelp((h) => !h);
      else if (e.key === "[") toggle();
      else if (e.key === "n") go("/new");
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, [folded, auto]);

  const active = (href: string) => (href === "/" ? location === "/" : location.startsWith(href));
  const awake = system.data?.inhibitor.held;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b bg-background/85 px-3 backdrop-blur md:px-4">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <img src="/icon.svg" alt="" className="size-6" />
          <span>Oraknid</span>
        </Link>
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="ml-1 flex items-center gap-1.5 text-xs text-muted-foreground"
              aria-live="polite"
            >
              <span
                className={cn(
                  "size-2 rounded-full",
                  status === "live"
                    ? "bg-success"
                    : status === "reconnecting"
                      ? "animate-pulse bg-warning"
                      : "bg-destructive",
                )}
              />
              <span className="hidden sm:inline">{t(status)}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {status === "live"
              ? t("Updates arrive as they happen.")
              : t("Showing the last known state; reconnecting.")}
          </TooltipContent>
        </Tooltip>
        {awake ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Coffee className="size-3.5" />
                <span className="hidden sm:inline">{t("awake")}</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {t("Keeping the machine awake: {why}", { why: system.data?.inhibitor.why ?? "" })}
            </TooltipContent>
          </Tooltip>
        ) : null}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="hidden gap-2 text-muted-foreground sm:flex"
          onClick={() => setPalette(true)}
        >
          <Search className="size-4" />
          <span>{t("Search or run…")}</span>
          <kbd className="rounded border px-1 text-[10px]">⌘K</kbd>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="sm:hidden"
          aria-label={t("Search or run")}
          onClick={() => setPalette(true)}
        >
          <Search className="size-4" />
        </Button>
        <Button asChild variant="ghost" size="sm" className="gap-1.5" aria-label={t("Inbox")}>
          <Link href="/inbox">
            <Inbox className="size-4" />
            {open ? <Badge className="h-5 min-w-5 justify-center px-1">{open}</Badge> : null}
          </Link>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Switch theme")}
          onClick={() => set(resolved === "dark" ? "light" : "dark")}
        >
          {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Button asChild size="sm" className="hidden gap-1 sm:flex">
          <Link href="/new">
            <Plus className="size-4" />
            {t("New work")}
          </Link>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className={cn(
            "hidden shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2 pb-16 transition-[width] md:flex",
            folded ? "w-14" : "w-48",
          )}
          aria-label={t("Main")}
        >
          {NAV.map(({ href, label, icon: Icon }) => {
            const link = (
              <Link
                key={href}
                href={href}
                aria-label={folded ? t(label) : undefined}
                className={cn(
                  "relative flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/80 hover:bg-accent hover:text-accent-foreground",
                  folded && "justify-center px-0",
                  active(href) && "bg-accent font-medium text-accent-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" />
                {folded ? null : <span className="flex-1">{t(label)}</span>}
                {href === "/inbox" && open ? (
                  <Badge
                    className={cn(
                      "h-5 min-w-5 justify-center px-1",
                      folded && "absolute -right-1 -top-1 h-4 min-w-4 text-[10px]",
                    )}
                  >
                    {open}
                  </Badge>
                ) : null}
              </Link>
            );
            return folded ? (
              <Tooltip key={href}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">{t(label)}</TooltipContent>
              </Tooltip>
            ) : (
              link
            );
          })}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="sm"
            className={cn("justify-start gap-2 text-muted-foreground", folded && "justify-center")}
            onClick={toggle}
            aria-label={folded ? t("Unfold the sidebar") : t("Fold the sidebar")}
            title={folded ? t("Unfold the sidebar ( [ )") : t("Fold the sidebar ( [ )")}
          >
            {folded ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
            {folded ? null : t("Fold")}
          </Button>
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-3 pb-24 pt-4 md:px-6 md:pb-8">
          {children}
          <HelperButton />
        </main>
      </div>

      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        aria-label={t("Main")}
      >
        {NAV.filter((n) => TABS.includes(n.href)).map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={cn(
              "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground",
              active(href) && "text-primary",
            )}
          >
            <span className="relative">
              <Icon className="size-5" />
              {href === "/inbox" && open ? (
                <span className="absolute -right-2 -top-1 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
                  {open}
                </span>
              ) : null}
            </span>
            {t(label)}
          </Link>
        ))}
        <button
          type="button"
          aria-expanded={more}
          onClick={() => setMore((m) => !m)}
          className={cn(
            "flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground",
            (more || NAV.some((n) => !TABS.includes(n.href) && active(n.href))) && "text-primary",
          )}
        >
          <Wand2 className="size-5" />
          {t("More")}
        </button>
      </nav>
      {more ? (
        // A tap outside closes it: nothing on a phone traps me.
        <button
          type="button"
          aria-label={t("Close")}
          className="fixed inset-0 z-[41] bg-black/40 md:hidden"
          onClick={() => setMore(false)}
        />
      ) : null}
      {more ? (
        <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-[45] grid grid-cols-2 gap-1 border-t bg-background p-2 md:hidden">
          {[
            { href: "/new", label: "New work", icon: Plus },
            ...NAV.filter((n) => !TABS.includes(n.href)),
          ].map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMore(false)}
              className={cn(
                "flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent",
                active(href) && "bg-accent font-medium",
              )}
            >
              <Icon className="size-4" />
              {t(label)}
            </Link>
          ))}
        </div>
      ) : null}

      <Palette open={palette} onOpenChange={setPalette} />
      <ShortcutsDialog open={help} onOpenChange={setHelp} />
    </div>
  );
}

/** `?`: every shortcut (Web-UI → Keyboard). */
function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Keyboard shortcuts")}</DialogTitle>
          <DialogDescription>
            {t("Single keys work when you aren't typing in a field.")}
          </DialogDescription>
        </DialogHeader>
        <table className="w-full text-sm">
          <tbody>
            {SHORTCUTS.map((s) => (
              <tr key={s.keys + s.does} className="border-b last:border-0">
                <td className="py-1.5 pr-3 whitespace-nowrap">
                  {s.keys.split(" ").map((k) => (
                    <kbd
                      key={k}
                      className="mr-1 rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      {k}
                    </kbd>
                  ))}
                </td>
                <td className="py-1.5">
                  {t(s.does)}
                  {s.where ? <span className="text-muted-foreground"> · {t(s.where)}</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}

/** ⌘K: jump to anything, run any control (Web-UI → Layout). */
function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [, go] = useLocation();
  // Loaded when the palette opens, not on every overview event (Audit 1 → Q1-06).
  const jobs = useLive(() => (open ? api.jobs.list() : Promise.resolve([])), {
    topics: [],
    deps: [open],
  });
  const run = (fn: () => unknown, done?: string) => {
    onOpenChange(false);
    Promise.resolve()
      .then(fn)
      .then(() => done && toast.success(done))
      .catch((e) => toast.error(message(e)));
  };
  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder={t("Jump to a page or a job, or run a control…")} />
      <CommandList>
        <CommandEmpty>{t("Nothing matches.")}</CommandEmpty>
        <CommandGroup heading={t("Go to")}>
          {NAV.map((n) => (
            <CommandItem key={n.href} onSelect={() => run(() => go(n.href))}>
              <n.icon className="size-4" />
              {t(n.label)}
            </CommandItem>
          ))}
          <CommandItem onSelect={() => run(() => go("/new"))}>
            <Plus className="size-4" />
            {t("New work")}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t("Jobs")}>
          {(jobs.data ?? []).map((j) => (
            <CommandItem
              key={j.id}
              value={`job ${j.title} ${j.state}`}
              onSelect={() => run(() => go(j.state === "draft" ? `/new/${j.id}` : `/jobs/${j.id}`))}
            >
              <ListTodo className="size-4" />
              <span className="flex-1 truncate">{j.title}</span>
              <span className="text-xs text-muted-foreground">{j.state}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading={t("Controls")}>
          {(jobs.data ?? [])
            .filter((j) =>
              ["running", "planning", "verifying", "interviewing", "waiting"].includes(j.state),
            )
            .map((j) => (
              <CommandItem
                key={`p${j.id}`}
                value={`pause ${j.title}`}
                onSelect={() =>
                  run(() => api.jobs.pause({ id: j.id }), t("Pausing at the next safe point…"))
                }
              >
                {t("Pause “{title}”", { title: j.title })}
              </CommandItem>
            ))}
          {(jobs.data ?? [])
            .filter((j) => ["paused", "blocked"].includes(j.state))
            .map((j) => (
              <CommandItem
                key={`r${j.id}`}
                value={`resume ${j.title}`}
                onSelect={() => run(() => api.jobs.resume({ id: j.id }), t("Resumed."))}
              >
                {t("Resume “{title}”", { title: j.title })}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
