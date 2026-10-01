import {
  Bot,
  Coffee,
  Cog,
  FolderGit2,
  Inbox,
  LayoutDashboard,
  ListTodo,
  Moon,
  Plus,
  ScrollText,
  Search,
  Sparkles,
  Sun,
  Wand2,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive, useLiveStatus } from "@/lib/live";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: ListTodo },
  { href: "/projects", label: "Projects", icon: FolderGit2 },
  { href: "/inbox", label: "Inbox", icon: Inbox },
  { href: "/legs", label: "Legs", icon: Bot },
  { href: "/skills", label: "Skills", icon: Sparkles },
  { href: "/logs", label: "Logs", icon: ScrollText },
  { href: "/settings", label: "Settings", icon: Cog },
];
/** On a phone: four tabs and "More" (Web-UI → Layout). */
const TABS = ["/", "/jobs", "/inbox", "/legs"];

export function Shell({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const [palette, setPalette] = useState(false);
  const [more, setMore] = useState(false);
  const status = useLiveStatus();
  const { resolved, set } = useTheme();
  const inbox = useLive(() => api.inbox.list({ state: "open" }), { topics: ["inbox"] });
  const system = useLive(() => api.system.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "system.inhibitor",
  });
  const open = inbox.data?.length ?? 0;

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

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
        <Link href="/inbox">
          <Button variant="ghost" size="sm" className="gap-1.5" aria-label={t("Inbox")}>
            <Inbox className="size-4" />
            {open ? <Badge className="h-5 min-w-5 justify-center px-1">{open}</Badge> : null}
          </Button>
        </Link>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("Switch theme")}
          onClick={() => set(resolved === "dark" ? "light" : "dark")}
        >
          {resolved === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
        <Link href="/jobs/new">
          <Button size="sm" className="hidden gap-1 sm:flex">
            <Plus className="size-4" />
            {t("New job")}
          </Button>
        </Link>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          className="hidden w-48 shrink-0 flex-col gap-0.5 border-r bg-sidebar p-2 md:flex"
          aria-label={t("Main")}
        >
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-sidebar-foreground/80 hover:bg-accent hover:text-accent-foreground",
                active(href) && "bg-accent font-medium text-accent-foreground",
              )}
            >
              <Icon className="size-4" />
              <span className="flex-1">{t(label)}</span>
              {href === "/inbox" && open ? (
                <Badge className="h-5 min-w-5 justify-center px-1">{open}</Badge>
              ) : null}
            </Link>
          ))}
        </nav>
        <main className="min-w-0 flex-1 overflow-y-auto px-3 pb-24 pt-4 md:px-6 md:pb-8">
          {children}
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
          onClick={() => setMore((m) => !m)}
          className="flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground"
        >
          <Wand2 className="size-5" />
          {t("More")}
        </button>
      </nav>
      {more ? (
        <div className="fixed inset-x-0 bottom-14 z-30 grid grid-cols-2 gap-1 border-t bg-background p-2 md:hidden">
          {[
            { href: "/jobs/new", label: "New job", icon: Plus },
            ...NAV.filter((n) => !TABS.includes(n.href)),
          ].map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMore(false)}
              className="flex min-h-11 items-center gap-2 rounded-md px-3 text-sm hover:bg-accent"
            >
              <Icon className="size-4" />
              {t(label)}
            </Link>
          ))}
        </div>
      ) : null}

      <Palette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

/** ⌘K: jump to anything, run any control (Web-UI → Layout). */
function Palette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [, go] = useLocation();
  const jobs = useLive(() => api.jobs.list(), { topics: ["overview"], deps: [open] });
  const run = (fn: () => unknown) => {
    onOpenChange(false);
    fn();
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
          <CommandItem onSelect={() => run(() => go("/jobs/new"))}>
            <Plus className="size-4" />
            {t("New job")}
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading={t("Jobs")}>
          {(jobs.data ?? []).map((j) => (
            <CommandItem
              key={j.id}
              value={`job ${j.title} ${j.state}`}
              onSelect={() => run(() => go(`/jobs/${j.id}`))}
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
                onSelect={() => run(() => api.jobs.pause({ id: j.id }))}
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
                onSelect={() => run(() => api.jobs.resume({ id: j.id }))}
              >
                {t("Resume “{title}”", { title: j.title })}
              </CommandItem>
            ))}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
