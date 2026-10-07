import type {
  ChatView,
  GitHubRepoSummary,
  InboxItem,
  JobView,
  LegView,
  LocalModelView,
  ServerView,
} from "@oraknid/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { api, message } from "@/lib/api";
import { GUIDE } from "@/lib/guide";
import { t } from "@/lib/i18n";
import { jobHref } from "@/lib/links";
import {
  type PaletteEntry,
  type RecentItem,
  recentItems,
  remember,
  searchPalette,
} from "@/lib/palette";
import { repoHref } from "@/pages/repos";

/** What the palette jumps to, loaded when it opens (Audit 1 → Q1-06: not on every event). */
export interface PaletteData {
  jobs: JobView[];
  projects: { id: string; name: string; workspacePath?: string; archivedAt?: number | null }[];
  servers: Pick<ServerView, "id" | "name" | "host">[];
  legs: Pick<LegView, "id" | "name" | "kind">[];
  chats: Pick<ChatView, "id" | "title" | "modelLabel">[];
  skills: { id: string; name: string; description: string }[];
  inbox: InboxItem[];
  models: Pick<LocalModelView, "id" | "name" | "repo">[];
  repos: Pick<GitHubRepoSummary, "owner" | "name" | "fullName" | "description">[];
}

export const NO_DATA: PaletteData = {
  jobs: [],
  projects: [],
  servers: [],
  legs: [],
  chats: [],
  skills: [],
  inbox: [],
  models: [],
  repos: [],
};

const GOING = ["running", "planning", "verifying", "interviewing", "waiting"];
const ENDED = ["completed", "cancelled", "failed", "draft"];

/** The groups, in the order they show. */
export const GROUPS = [
  "Recent",
  "Go to",
  "Controls",
  "Jobs",
  "Inbox",
  "Projects",
  "Chats",
  "Servers",
  "Legs",
  "Models",
  "Skills",
  "Repos",
  "Guide",
];

/**
 * Every place and control the palette offers (Web-UI → Layout): the pages,
 * my projects, jobs, servers, Legs, chats, skills, inbox items, local
 * models, GitHub repos and the guide's pages, and the controls: new work, a
 * new chat, the terminal, an update check, pausing, resuming or cancelling a
 * job, and answering an approval.
 */
export function paletteEntries(
  d: PaletteData,
  pages: { href: string; label: string }[],
): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (const p of pages)
    out.push({ key: `page:${p.href}`, group: "Go to", label: p.label, href: p.href });
  const control = (e: Omit<PaletteEntry, "group">) => out.push({ ...e, group: "Controls" });
  control({ key: "do:new-work", label: "New work", keywords: "new job draft start", href: "/new" });
  control({ key: "do:new-chat", label: "New chat", keywords: "talk model", href: "/chats?new" });
  control({
    key: "do:terminal",
    label: "Open the terminal",
    keywords: "shell console",
    href: "/terminal",
  });
  control({
    key: "do:updates",
    label: "Check for updates",
    keywords: "update version release",
    run: () =>
      api.updates
        .check()
        .then((v) =>
          toast.message(
            v.error
              ? t("Couldn't check: {why}", { why: v.error })
              : v.available
                ? t("An update waits: {target}", { target: v.target ?? "" })
                : t("Oraknid {version} is the newest.", { version: v.version }),
          ),
        ),
  });
  for (const j of d.jobs) {
    if (GOING.includes(j.state))
      control({
        key: `pause:${j.id}`,
        label: t("Pause “{title}”", { title: j.title }),
        keywords: "pause job",
        run: () => api.jobs.pause({ id: j.id }),
        done: t("Pausing at the next safe point…"),
      });
    if (["paused", "blocked"].includes(j.state))
      control({
        key: `resume:${j.id}`,
        label: t("Resume “{title}”", { title: j.title }),
        keywords: "resume job",
        run: () => api.jobs.resume({ id: j.id }),
        done: t("Resumed."),
      });
    if (!ENDED.includes(j.state))
      control({
        key: `cancel:${j.id}`,
        label: t("Cancel “{title}”", { title: j.title }),
        keywords: "cancel stop job",
        run: () => api.jobs.cancel({ id: j.id }),
        done: t("Cancelled."),
        confirm: t("Cancel “{title}”? Its running tasks stop and it can't be started again.", {
          title: j.title,
        }),
      });
  }
  for (const i of d.inbox.filter((x) => x.state === "open" && x.kind === "approval"))
    for (const o of i.options)
      control({
        key: `answer:${i.id}:${o}`,
        label: `${o}: ${i.title}`,
        sub: [i.projectName, i.jobTitle].filter(Boolean).join(" · "),
        keywords: "approve deny approval inbox answer",
        run: () => api.inbox.answer({ id: i.id, answer: o }),
        done: t("Answered."),
      });
  for (const j of d.jobs)
    out.push({
      key: `job:${j.id}`,
      group: "Jobs",
      label: j.title,
      sub: [j.description, j.state].filter(Boolean).join(" · "),
      keywords: `job ${j.state}`,
      href: jobHref(j),
    });
  for (const i of d.inbox.filter((x) => x.state === "open"))
    out.push({
      key: `inbox:${i.id}`,
      group: "Inbox",
      label: i.title,
      sub: [i.projectName, i.jobTitle].filter(Boolean).join(" · "),
      keywords: `inbox ${i.kind}`,
      href: `/inbox/${i.id}`,
    });
  for (const p of d.projects.filter((x) => !x.archivedAt))
    out.push({
      key: `project:${p.id}`,
      group: "Projects",
      label: p.name,
      ...(p.workspacePath ? { sub: p.workspacePath } : {}),
      keywords: "project",
      href: `/projects/${p.id}`,
    });
  for (const c of d.chats)
    out.push({
      key: `chat:${c.id}`,
      group: "Chats",
      label: c.title || t("A chat"),
      sub: c.modelLabel,
      keywords: "chat",
      href: `/chats/${c.id}`,
    });
  for (const s of d.servers)
    out.push({
      key: `server:${s.id}`,
      group: "Servers",
      label: s.name,
      sub: s.host,
      keywords: "server ssh",
      href: `/servers/${s.id}`,
    });
  for (const l of d.legs)
    out.push({
      key: `leg:${l.id}`,
      group: "Legs",
      label: l.name,
      sub: l.kind,
      keywords: "leg agent",
      href: `/legs/${l.id}`,
    });
  for (const m of d.models)
    out.push({
      key: `model:${m.id}`,
      group: "Models",
      label: m.name,
      sub: m.repo,
      keywords: "local model",
      href: "/models",
    });
  for (const s of d.skills)
    out.push({
      key: `skill:${s.id}`,
      group: "Skills",
      label: s.name,
      sub: s.description,
      keywords: "skill",
      href: `/skills/${s.id}`,
    });
  for (const r of d.repos)
    out.push({
      key: `repo:${r.fullName}`,
      group: "Repos",
      label: r.fullName,
      ...(r.description ? { sub: r.description } : {}),
      keywords: "repo github",
      href: repoHref.base(r.owner, r.name),
    });
  for (const g of GUIDE)
    out.push({
      key: `guide:${g.slug}`,
      group: "Guide",
      label: g.title,
      sub: g.line,
      keywords: `docs guide help ${g.headings.map((h) => h.text).join(" ")}`,
      href: `/docs/${g.slug}`,
    });
  return out;
}

/** Everything at once, each list on its own: one that fails (no GitHub) leaves the rest. */
async function loadAll(): Promise<PaletteData> {
  const get = async <T,>(f: () => Promise<T>, empty: T) => {
    try {
      return await f();
    } catch {
      return empty;
    }
  };
  const [jobs, projects, servers, legs, chats, skills, inbox, models, repos] = await Promise.all([
    get(() => api.jobs.list(), []),
    get(() => api.projects.list(), []),
    get(() => api.servers.list(), []),
    get(() => api.legs.list(), []),
    get(() => api.chats.list(), []),
    get(() => api.skills.list(), []),
    get(() => api.inbox.list({ state: "open" }), []),
    get(() => api.models.list(), []),
    get(() => api.github.repoList({}).then((r) => r.repos), []),
  ]);
  return { jobs, projects, servers, legs, chats, skills, inbox, models, repos } as PaletteData;
}

/** ⌘K: jump to anything, run any control (Web-UI → Layout). */
export function CommandPalette({
  open,
  onOpenChange,
  pages,
  load = loadAll,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  pages: { href: string; label: string }[];
  load?: () => Promise<PaletteData>;
}) {
  const [, go] = useLocation();
  const [data, setData] = useState<PaletteData>(NO_DATA);
  const [query, setQuery] = useState("");
  const [asking, setAsking] = useState<PaletteEntry | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setAsking(null);
    setRecent(recentItems());
    let gone = false;
    load().then((d) => !gone && setData(d));
    return () => {
      gone = true;
    };
  }, [open, load]);

  const entries = paletteEntries(data, pages);
  const shown = searchPalette(
    entries,
    query,
    recent.map((r) => r.key),
  );
  const choose = (e: PaletteEntry) => {
    if (e.confirm && asking?.key !== e.key) {
      setAsking(e);
      return;
    }
    onOpenChange(false);
    if (e.href) {
      remember(e);
      go(e.href);
      return;
    }
    Promise.resolve()
      .then(e.run)
      .then(() => e.done && toast.success(e.done))
      .catch((err) => toast.error(message(err)));
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      shouldFilter={false}
      title={t("Search or run")}
      description={t("Jump to a place, or run a control.")}
    >
      <CommandInput
        placeholder={
          asking ? t("Enter to confirm, Esc to close") : t("Jump to anything, or run a control…")
        }
        value={query}
        onValueChange={(v) => {
          setQuery(v);
          setAsking(null);
        }}
      />
      <CommandList>
        {asking ? (
          // A second step, naming what happens (Web-UI → A second step).
          <CommandGroup heading={asking.confirm}>
            <CommandItem value="yes" onSelect={() => choose(asking)}>
              {t("Yes, {what}", { what: asking.label })}
            </CommandItem>
            <CommandItem value="no" onSelect={() => setAsking(null)}>
              {t("No, go back")}
            </CommandItem>
          </CommandGroup>
        ) : (
          <>
            <CommandEmpty>{t("Nothing matches.")}</CommandEmpty>
            {!query.trim() && recent.length ? (
              <CommandGroup heading={t("Recent")}>
                {recent.map((r) => (
                  <CommandItem
                    key={`recent:${r.key}`}
                    value={`recent:${r.key}`}
                    onSelect={() => choose({ ...r, group: "Recent" })}
                  >
                    <Line label={r.label} sub={r.sub} />
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
            {GROUPS.map((g) => {
              const items = shown.filter((e) => e.group === g);
              // Without a query: the pages and controls, and not every item of every list.
              const listed = query.trim() || g === "Go to" || g === "Controls" ? items : [];
              return listed.length ? (
                <CommandGroup key={g} heading={t(g)}>
                  {listed.map((e) => (
                    <CommandItem key={e.key} value={e.key} onSelect={() => choose(e)}>
                      <Line label={e.group === "Go to" ? t(e.label) : e.label} sub={e.sub} />
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null;
            })}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

function Line({ label, sub }: { label: string; sub?: string | undefined }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate">{label}</span>
      {sub ? <span className="block truncate text-xs text-muted-foreground">{sub}</span> : null}
    </span>
  );
}
