import type { ProjectSource } from "@oraknid/contracts";
import { FolderOpen, FolderPlus, GitBranch, Info, Lock, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading } from "@/components/common";
import { FolderField } from "@/components/folder-picker";
import { isSeveral } from "@/components/project-repo";
import { GitHubSetupButton } from "@/components/setup";
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
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// A new project that says what it does (Jobs-and-Projects → Projects, M13.19):
// its name, then where it comes from (a new folder, a folder I have, or
// GitHub), and a sentence saying what will happen. The New project dialog
// and New work's "A new project…" are this one form.

/** Where a new project's folder went last time (New project and New work share it). */
export const PARENT_KEY = "oraknid.newwork.parent";
export const rememberedParent = () => {
  try {
    return localStorage.getItem(PARENT_KEY) ?? "";
  } catch {
    return "";
  }
};
export const rememberParent = (parent: string) => {
  try {
    if (parent.trim()) localStorage.setItem(PARENT_KEY, parent.trim());
  } catch {}
};

/** New (a folder Oraknid makes), a folder I have, or from GitHub. */
export type Origin = "new" | "folder" | "github";

export interface ProjectDraft {
  name: string;
  origin: Origin;
  /** New: the folder's name; "" for the name, slugified. */
  folder: string;
  /** New and GitHub: the folder it goes in. */
  parent: string;
  /** New: also a new GitHub repo. */
  onGitHub: boolean;
  isPrivate: boolean;
  /** The account a new GitHub repo is made on; "" for the default. */
  account: string;
  /** A folder I have. */
  path: string;
  /** From GitHub: one of my repos, or a link. */
  via: "mine" | "link";
  /** One of my repos, `owner/name`. */
  repo: string;
  /** The account that reads it; "" for the default. */
  repoAccount: string;
  /** Its git host when not GitHub (ADR-062): GitLab, Gitea or Forgejo, by its id. */
  repoHost: string;
  url: string;
}

export const newDraft = (o: Partial<ProjectDraft> = {}): ProjectDraft => ({
  name: "",
  origin: "new",
  folder: "",
  parent: rememberedParent(),
  onGitHub: false,
  isPrivate: true,
  account: "",
  path: "",
  via: "mine",
  repo: "",
  repoAccount: "",
  repoHost: "",
  url: "",
  ...o,
});

/** A project's name as a folder's: lower case, dashes, nothing a folder can't be called. */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 100);
}

const FOLDER_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const lastPart = (p: string) => p.replace(/\/+$/, "").split("/").filter(Boolean).at(-1) ?? "";
const inside = (parent: string, name: string) => {
  const p = parent.trim().replace(/\/+$/, "");
  return `${p}/${name}`;
};

/** The new folder's name: the one typed, else the project's name slugified. */
export const folderOf = (d: ProjectDraft) => d.folder.trim() || slugify(d.name);
/** The folder a clone lands in, named by the daemon after the repo. */
const cloneFolder = (d: ProjectDraft) =>
  d.via === "mine"
    ? (d.repo.split("/").at(-1) ?? "")
    : lastPart(d.url.trim()).replace(/\.git$/, "") || "project";

/**
 * Where a new project comes from, as the API takes it, or null while
 * something is missing. `initGit` answers, for a folder I have that isn't a
 * repo, how its checkpoints are kept.
 */
export function projectSource(
  d: ProjectDraft,
  o: { initGit?: boolean } = {},
): ProjectSource | null {
  const parent = d.parent.trim();
  if (d.origin === "folder") {
    const path = d.path.trim();
    if (!path) return null;
    return { kind: "folder", path, ...(o.initGit === undefined ? {} : { initGit: o.initGit }) };
  }
  if (!parent) return null;
  if (d.origin === "new") {
    const name = folderOf(d);
    if (!FOLDER_NAME.test(name) || name === "." || name === "..") return null;
    return d.onGitHub
      ? {
          kind: "github-new",
          ...(d.account ? { account: d.account } : {}),
          parent,
          name,
          private: d.isPrivate,
          description: "",
        }
      : { kind: "new-folder", parent, name };
  }
  if (d.via === "mine")
    return d.repo
      ? {
          kind: "github-clone",
          parent,
          fullName: d.repo,
          ...(d.repoAccount ? { account: d.repoAccount } : {}),
          ...(d.repoHost ? { host: d.repoHost } : {}),
        }
      : null;
  const url = d.url.trim();
  return url ? { kind: "git-url", parent, url } : null;
}

/** What is still missing, in words, or null when it can be made. */
export function missing(d: ProjectDraft): string | null {
  if (d.origin === "folder") return d.path.trim() ? null : t("Choose the project's folder.");
  if (d.origin === "new" && !d.name.trim() && !d.folder.trim()) return t("Give it a name.");
  if (d.origin === "new" && !projectSource({ ...d, parent: d.parent || "/" }))
    return t("Its folder's name: letters, digits, dots, dashes and underscores.");
  if (d.origin === "github" && d.via === "mine" && !d.repo) return t("Choose one of your repos.");
  if (d.origin === "github" && d.via === "link" && !d.url.trim())
    return t("Paste the repo's link.");
  if (!d.parent.trim()) return t("Choose where it goes.");
  return projectSource(d) ? null : t("Say where the new project comes from.");
}

/**
 * The sentence that says what will happen, or null while something is
 * missing: what is made, where, and what is left alone.
 */
export function whatHappens(
  d: ProjectDraft,
  o: { github: boolean; defaultAccount?: string },
): string | null {
  const s = projectSource(d);
  if (!s) return null;
  switch (s.kind) {
    case "folder":
      return t(
        "Uses {path} as the project. Nothing in it changes until a job runs, and then only in a worktree.",
        { path: s.path },
      );
    case "new-folder":
      return t("Creates {path} and makes it a git repo.", { path: inside(s.parent, s.name) });
    case "github-new": {
      const owner = s.account || o.defaultAccount;
      return t(
        "Creates a new {visibility} GitHub repo, {repo}, clones it into {path} and links the project to it.",
        {
          visibility: s.private ? t("private") : t("public"),
          repo: owner ? `${owner}/${s.name}` : s.name,
          path: inside(s.parent, s.name),
        },
      );
    }
    case "github-clone":
      return t("Clones {repo} into {path} and links the project to it.", {
        repo: s.host ? `${s.fullName} (${s.host})` : s.fullName,
        path: inside(s.parent, cloneFolder(d)),
      });
    default:
      return (
        t("Clones {url} into {path}.", { url: s.url, path: inside(s.parent, cloneFolder(d)) }) +
        (o.github ? "" : ` ${t("Without a GitHub account, only a public repo can be cloned.")}`)
      );
  }
}

const ORIGINS: { id: Origin; icon: typeof FolderPlus; label: string; hint: string }[] = [
  {
    id: "new",
    icon: FolderPlus,
    label: "New",
    hint: "A new folder, made a git repo",
  },
  {
    id: "folder",
    icon: FolderOpen,
    label: "A folder on this computer",
    hint: "One you have: a repo, or a folder of several",
  },
  {
    id: "github",
    icon: GitBranch,
    label: "From GitHub",
    hint: "One of your repos, or a link",
  },
];

/**
 * The form: the name first, then where it comes from (New by default),
 * each choice's own fields, and the sentence saying what will happen.
 * `plainFolder` says what becomes of a folder I have that isn't a repo:
 * asked after (New project), or made one (New work).
 */
export function NewProjectFields({
  draft,
  onChange,
  plainFolder = "ask",
  autoFocus = false,
}: {
  draft: ProjectDraft;
  onChange: (d: ProjectDraft) => void;
  plainFolder?: "ask" | "init";
  autoFocus?: boolean;
}) {
  const github = useLive(() => api.github.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  // Accounts on GitLab, Gitea or Forgejo count too (ADR-062).
  const hostAccounts = useLive(() => api.hosts.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("githost."),
  });
  const connected = !!github.data?.connected || !!hostAccounts.data?.length;
  const set = (p: Partial<ProjectDraft>) => onChange({ ...draft, ...p });
  // Without a GitHub account, a link is the only way from GitHub.
  const linkOnly = !!github.data && !!hostAccounts.data && !connected && draft.via === "mine";
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when GitHub's state says so
  useEffect(() => {
    if (linkOnly) onChange({ ...draft, via: "link" });
  }, [linkOnly]);
  const said = whatHappens(draft, {
    github: connected,
    defaultAccount: accounts.data?.[0]?.login ?? "",
  });
  const away = missing(draft);
  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="np-name">{t("Name")}</Label>
        <Input
          id="np-name"
          autoFocus={autoFocus}
          value={draft.name}
          onChange={(e) => set({ name: e.target.value })}
          placeholder={
            draft.origin === "folder"
              ? lastPart(draft.path) || t("My project")
              : draft.origin === "github"
                ? cloneFolder(draft) || t("My project")
                : t("My project")
          }
        />
      </div>

      <div className="space-y-1.5">
        <div id="np-origin" className="text-sm font-medium">
          {t("Where it comes from")}
        </div>
        <div role="radiogroup" aria-labelledby="np-origin" className="grid gap-2 sm:grid-cols-3">
          {ORIGINS.map((o) => (
            // biome-ignore lint/a11y/useSemanticElements: a choice of three cards, each with its line
            <button
              key={o.id}
              type="button"
              role="radio"
              aria-checked={draft.origin === o.id}
              onClick={() => set({ origin: o.id })}
              className={cn(
                "flex items-start gap-2 rounded-lg border p-2.5 text-left hover:bg-accent sm:flex-col sm:gap-1",
                draft.origin === o.id && "border-primary bg-accent ring-1 ring-primary",
              )}
            >
              <o.icon className="mt-0.5 size-4 shrink-0" />
              <span className="min-w-0">
                <span className="block text-sm font-medium">{t(o.label)}</span>
                <span className="block text-xs text-muted-foreground">{t(o.hint)}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {draft.origin === "new" ? (
        <div className="space-y-3">
          <FolderField
            id="np-parent"
            label={t("Where it goes")}
            title={t("Where the project's folder goes")}
            description={t("Its folder is made inside the folder you choose.")}
            value={draft.parent}
            onChange={(parent) => set({ parent })}
          />
          <div className="space-y-1.5">
            <Label htmlFor="np-folder">{t("Folder name")}</Label>
            <Input
              id="np-folder"
              className="font-mono text-xs"
              value={draft.folder}
              onChange={(e) => set({ folder: e.target.value.replace(/[^A-Za-z0-9._-]/g, "-") })}
              placeholder={slugify(draft.name) || "my-project"}
            />
          </div>
          {connected ? (
            <div className="space-y-3 rounded-md border p-3">
              <label htmlFor="np-github" className="flex items-center gap-2 text-sm">
                <Switch
                  id="np-github"
                  checked={draft.onGitHub}
                  onCheckedChange={(onGitHub) => set({ onGitHub })}
                />
                {t("Also a new GitHub repo")}
              </label>
              {draft.onGitHub ? (
                <>
                  <GitHubAccountPicker
                    value={draft.account}
                    onChange={(account) => set({ account })}
                  />
                  <label htmlFor="np-private" className="flex items-center gap-2 text-sm">
                    <Switch
                      id="np-private"
                      checked={draft.isPrivate}
                      onCheckedChange={(isPrivate) => set({ isPrivate })}
                    />
                    {t("Private")}
                  </label>
                </>
              ) : null}
            </div>
          ) : github.data ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span>{t("Connect GitHub to also make a GitHub repo for it.")}</span>
              <GitHubSetupButton />
            </div>
          ) : null}
        </div>
      ) : null}

      {draft.origin === "folder" ? (
        <FolderField
          id="np-path"
          label={t("The project's folder")}
          title={t("The project's folder")}
          description={t("The folder is the project: a repo, or a folder holding several repos.")}
          value={draft.path}
          onChange={(path) => set({ path })}
          help={
            <div className="text-xs text-muted-foreground">
              {plainFolder === "init"
                ? t(
                    "A git repo, or a folder holding several (each found). A folder that isn't one becomes a git repo.",
                  )
                : t(
                    "A git repo, or a folder holding several (each found). A folder that isn't one: you're asked how to keep its checkpoints.",
                  )}
            </div>
          }
        />
      ) : null}

      {draft.origin === "github" ? (
        <div className="space-y-3">
          {connected ? (
            <div role="radiogroup" aria-label={t("Which repo")} className="flex gap-1">
              {(
                [
                  ["mine", t("One of my repos")],
                  ["link", t("A link")],
                ] as const
              ).map(([v, label]) => (
                <Button
                  key={v}
                  type="button"
                  size="sm"
                  role="radio"
                  aria-checked={draft.via === v}
                  variant={draft.via === v ? "default" : "outline"}
                  onClick={() => set({ via: v })}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : null}
          {connected && draft.via === "mine" ? (
            <GitHubRepoChooser
              value={draft.repo}
              host={draft.repoHost}
              onChange={(repo, account, host) =>
                set({
                  repo,
                  repoAccount: account,
                  repoHost: host,
                  name: draft.name || (repo.split("/").at(-1) ?? ""),
                })
              }
            />
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="np-url">{t("The repo's link")}</Label>
              <Input
                id="np-url"
                className="font-mono text-xs"
                value={draft.url}
                onChange={(e) => set({ url: e.target.value })}
                placeholder="https://github.com/owner/repo"
              />
              <div className="text-xs text-muted-foreground">
                {connected
                  ? t(
                      "Any git link: GitHub, GitLab or another. A private one of yours: pick it from your repos.",
                    )
                  : t(
                      "Without a GitHub account, only a public repo can be cloned. Connect GitHub to pick one of your repos, private ones too.",
                    )}
              </div>
              {!connected && github.data ? <GitHubSetupButton /> : null}
            </div>
          )}
          <FolderField
            id="np-clone-parent"
            label={t("Clone it into")}
            title={t("Where the clone goes")}
            description={t(
              "Its folder, named after the repo, is made inside the folder you choose.",
            )}
            value={draft.parent}
            onChange={(parent) => set({ parent })}
          />
        </div>
      ) : null}

      <div
        role="status"
        className={cn(
          "flex gap-2 rounded-md border px-3 py-2 text-sm",
          said ? "border-primary/40 bg-primary/5" : "text-muted-foreground",
        )}
      >
        <Info className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">{said ?? away}</span>
      </div>
    </div>
  );
}

/**
 * New project (Projects → New project): the form above, made with
 * `projects.createFrom`. A folder I have that isn't a git repo is asked
 * about: made one, or left alone with checkpoints in a shadow repo.
 */
export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated?: (id: string) => void;
}) {
  const [draft, setDraft] = useState(newDraft);
  const [askGit, setAskGit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useEffect(() => {
    if (!open) return;
    setDraft(newDraft());
    setAskGit(false);
    setError(undefined);
  }, [open]);
  const change = (d: ProjectDraft) => {
    setDraft(d);
    setAskGit(false);
  };
  const create = async (initGit?: boolean) => {
    const source = projectSource(draft, initGit === undefined ? {} : { initGit });
    if (!source) return;
    setBusy(true);
    setError(undefined);
    try {
      if (draft.origin !== "folder") rememberParent(draft.parent);
      const p = await api.projects.createFrom({
        ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        source,
      });
      // A folder holding several repos is a project of several (ADR-042): said, with their names.
      toast.success(
        isSeveral(p.repos)
          ? t("Project created, with {n} repos: {names}.", {
              n: p.repos.length,
              names: p.repos.map((r) => r.name).join(", "),
            })
          : t("Project created."),
      );
      onOpenChange(false);
      onCreated?.(p.id);
    } catch (e) {
      if (message(e).includes("is not a git repo")) setAskGit(true);
      else setError(e);
    } finally {
      setBusy(false);
    }
  };
  const why = missing(draft);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("New project")}</DialogTitle>
          <DialogDescription>
            {t(
              "A project is the folder its jobs work in. Each job works on its own branch, never on yours.",
            )}
          </DialogDescription>
        </DialogHeader>
        <NewProjectFields draft={draft} onChange={change} autoFocus />
        <ErrorNote error={error} />
        {askGit ? (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <div>
              {t("This folder is not a git repo. How should Oraknid keep its checkpoints?")}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => create(true)}>
                {t("Make it a git repo")}
              </Button>
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => create(false)}>
                {t("Use a shadow repo, leave the folder alone")}
              </Button>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button
            disabled={!!why || busy || askGit}
            title={why ?? undefined}
            onClick={() => create()}
          >
            {busy ? t("Creating…") : t("Create project")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The account a new GitHub repo is made on (ADR-038): shown when I have
 * more than one, the first (the default) chosen until I pick another.
 */
export function GitHubAccountPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const logins = (accounts.data ?? []).map((a) => a.login);
  if (logins.length < 2) return null;
  const chosen = logins.includes(value) ? value : (logins[0] as string);
  return (
    <div data-help="work.github-account" className="space-y-1.5">
      <Label>{t("GitHub account")}</Label>
      <Select value={chosen} onValueChange={onChange}>
        <SelectTrigger className="w-full" aria-label={t("GitHub account")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(accounts.data ?? []).map((a, i) => (
            <SelectItem key={a.login} value={a.login}>
              {a.login}
              {i === 0 ? ` · ${t("default")}` : ""}
              {a.error ? ` · ${t("can't be used now")}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const ALL = "__all__";

/**
 * One of my GitHub repos (ADR-040's list): searchable, of one account or
 * all, each with who can see it and the project it already is.
 */
export function GitHubRepoChooser({
  value,
  host = "",
  onChange,
}: {
  value: string;
  /** The chosen one's host when not GitHub (ADR-062). */
  host?: string;
  onChange: (fullName: string, account: string, host: string) => void;
}) {
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const hostAccounts = useLive(() => api.hosts.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("githost."),
  });
  const [account, setAccount] = useState(ALL);
  const [query, setQuery] = useState("");
  // Every host's when all are shown; one account's, GitHub's or another host's (`host!login`).
  const list = useLive(
    () => {
      if (account === ALL) return api.hosts.repoList({});
      const cut = account.indexOf("!");
      return cut < 0
        ? api.github.repoList({ account })
        : api.hosts.repoList({ host: account.slice(0, cut), account: account.slice(cut + 1) });
    },
    {
      topics: ["overview"],
      refreshOn: (e) =>
        e.type.startsWith("github.") ||
        e.type.startsWith("githost.") ||
        e.type === "project.github",
      deps: [account],
    },
  );
  const logins = [
    ...(accounts.data ?? []).map((a) => a.login),
    ...(hostAccounts.data ?? []).map((a) => `${a.host}!${a.login}`),
  ];
  const chosen = (r: { fullName: string; host?: string | undefined }) =>
    value === r.fullName && (r.host ?? "") === host;
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data?.repos ?? []).filter(
      (r) =>
        !q ||
        r.fullName.toLowerCase().includes(q) ||
        (r.description ?? "").toLowerCase().includes(q),
    );
  }, [list.data, query]);
  return (
    <div className="space-y-1.5">
      <Label htmlFor="np-repo-search">{t("Your repos")}</Label>
      <div className="flex gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="np-repo-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search your repos")}
            className="pl-8"
          />
        </div>
        {logins.length > 1 ? (
          <Select value={account} onValueChange={setAccount}>
            <SelectTrigger className="w-auto min-w-28" aria-label={t("Account")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t("All accounts")}</SelectItem>
              {logins.map((l) => (
                <SelectItem key={l} value={l}>
                  {l.includes("!") ? `${l.split("!")[1]} · ${l.split("!")[0]}` : l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.data?.errors.map((e) => (
        <div key={e.account} className="text-xs text-destructive">
          {e.account}: {e.error}
        </div>
      ))}
      <div
        role="listbox"
        aria-label={t("Your repos")}
        className="max-h-56 overflow-y-auto rounded-md border"
      >
        {/* One chosen in Repos may not be listed here. */}
        {value && !list.data?.repos.some(chosen) ? (
          <button
            type="button"
            role="option"
            aria-selected
            className="w-full border-b bg-accent px-3 py-2 text-left text-sm font-medium last:border-b-0"
          >
            {value}
          </button>
        ) : null}
        {!list.data && list.loading ? (
          <div className="p-3">
            <Loading rows={2} />
          </div>
        ) : shown.length === 0 ? (
          <div className="p-3 text-sm text-muted-foreground">{t("No repo matches.")}</div>
        ) : (
          shown.map((r) => (
            <button
              key={`${r.host ?? ""}:${r.account}:${r.fullName}`}
              type="button"
              role="option"
              aria-selected={chosen(r)}
              onClick={() => onChange(r.fullName, r.account, r.host ?? "")}
              className={cn(
                "flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent",
                chosen(r) && "bg-accent font-medium",
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  {r.fullName}
                  {r.host ? (
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      · {r.host}
                    </span>
                  ) : null}
                </span>
                {r.project ? (
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {t("Already the project {name}", { name: r.project.name })}
                  </span>
                ) : r.description ? (
                  <span className="block truncate text-xs font-normal text-muted-foreground">
                    {r.description}
                  </span>
                ) : null}
              </span>
              {r.visibility !== "public" ? (
                <Lock
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-label={t("private")}
                />
              ) : null}
            </button>
          ))
        )}
      </div>
      {list.data?.truncated ? (
        <div className="text-xs text-muted-foreground">
          {t("Only the first 1,000 of an account's repos are listed: paste a link for another.")}
        </div>
      ) : null}
    </div>
  );
}
