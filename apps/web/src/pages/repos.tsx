import type {
  GitHubCommitSummary,
  GitHubFile,
  GitHubRepoDetail,
  GitHubRepoRef,
  GitHubRepoSummary,
} from "@oraknid/contracts";
import {
  ExternalLink,
  File,
  FileCode2,
  Folder,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  GitPullRequest,
  Lock,
  Plus,
  Search,
  Users,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { CiRuns } from "@/components/ci-panel";
import { BackButton, Empty, ErrorNote, Loading, Markdown } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { DiffList } from "@/components/diff-view";
import { GitHostsCard } from "@/components/git-hosts-card";
import { GitHubCard } from "@/components/github-card";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { remote } from "@/lib/remote";
import { cn } from "@/lib/utils";

// Repos (ADR-040): my GitHub repositories, read through the daemon with an
// account's token. The list, then a repository in tabs in the address:
// /repos/<owner>/<name>/<tab>/<what in the tab>. A repository on GitLab,
// Gitea or Forgejo (ADR-062) is read the same way; its owner part in the
// address carries its host: `<host>!<owner>` (neither a host nor an owner
// has a "!"), a GitLab group's subgroups encoded in it.

const seg = (s: string) => encodeURIComponent(s);
const unseg = (s: string | undefined) => {
  if (s === undefined) return undefined;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const pathSegs = (p: string) => p.split("/").filter(Boolean).map(seg).join("/");

/** Where a repository's pages are. */
export const repoHref = {
  base: (o: string, n: string) => `/repos/${seg(o)}/${seg(n)}`,
  code: (o: string, n: string, ref: string, kind?: "tree" | "blob", path?: string) =>
    `${repoHref.base(o, n)}/code/${seg(ref)}${kind && path ? `/${kind}/${pathSegs(path)}` : ""}`,
  commits: (o: string, n: string, branch: string, sha?: string) =>
    `${repoHref.base(o, n)}/commits/${seg(branch)}${sha ? `/${sha}` : ""}`,
  pulls: (o: string, n: string, state: "open" | "closed", num?: number) =>
    `${repoHref.base(o, n)}/pulls/${state}${num ? `/${num}` : ""}`,
};

/** Between a host and an owner in the address's owner part (ADR-062). */
const HOST_MARK = "!";

/** The address's owner part of a repository: its owner, after its host when not GitHub's. */
export const ownerKey = (host: string | undefined, owner: string) =>
  host && host !== "github" ? `${host}${HOST_MARK}${owner}` : owner;

/** The host and owner an address's owner part names. */
export function splitOwner(key: string): { host: string | undefined; owner: string } {
  const i = key.indexOf(HOST_MARK);
  return i < 0
    ? { host: undefined, owner: key }
    : { host: key.slice(0, i), owner: key.slice(i + 1) };
}

/** GitHub's reads, or another host's (ADR-062), by the owner part of the reference. */
type Ref = GitHubRepoRef;
const via =
  <I extends Ref, O>(gh: (i: I) => Promise<O>, other: (i: I & { host: string }) => Promise<O>) =>
  (i: I): Promise<O> => {
    const { host, owner } = splitOwner(i.owner);
    return host ? other({ ...i, owner, host }) : gh(i);
  };
type G = typeof api.github;
type H = typeof api.hosts;
export const rapi = {
  repoInfo: via<Parameters<G["repoInfo"]>[0], Awaited<ReturnType<G["repoInfo"]>>>(
    (i) => api.github.repoInfo(i),
    (i) => api.hosts.repoInfo(i),
  ),
  branches: via<Parameters<G["branches"]>[0], Awaited<ReturnType<G["branches"]>>>(
    (i) => api.github.branches(i),
    (i) => api.hosts.branches(i),
  ),
  tree: via<Parameters<G["tree"]>[0], Awaited<ReturnType<H["tree"]>>>(
    (i) => api.github.tree(i),
    (i) => api.hosts.tree(i),
  ),
  readme: via<Parameters<G["readme"]>[0], Awaited<ReturnType<G["readme"]>>>(
    (i) => api.github.readme(i),
    (i) => api.hosts.readme(i),
  ),
  file: via<Parameters<G["file"]>[0], Awaited<ReturnType<G["file"]>>>(
    (i) => api.github.file(i),
    (i) => api.hosts.file(i),
  ),
  commits: via<Parameters<G["commits"]>[0], Awaited<ReturnType<G["commits"]>>>(
    (i) => api.github.commits(i),
    (i) => api.hosts.commits(i),
  ),
  commit: via<Parameters<G["commit"]>[0], Awaited<ReturnType<G["commit"]>>>(
    (i) => api.github.commit(i),
    (i) => api.hosts.commit(i),
  ),
  pulls: via<Parameters<G["pulls"]>[0], Awaited<ReturnType<G["pulls"]>>>(
    (i) => api.github.pulls(i),
    (i) => api.hosts.pulls(i),
  ),
  pull: via<Parameters<G["pull"]>[0], Awaited<ReturnType<G["pull"]>>>(
    (i) => api.github.pull(i),
    (i) => api.hosts.pull(i),
  ),
};

/** What the rest of the address says inside a tab. */
export function parseRest(tab: string | undefined, rest: string | undefined) {
  const parts = (rest ?? "").split("/").filter(Boolean);
  if (tab === "code")
    return {
      ref: unseg(parts[0]),
      kind: parts[1] === "blob" ? ("blob" as const) : ("tree" as const),
      path: parts
        .slice(2)
        .map((p) => unseg(p) ?? p)
        .join("/"),
    };
  if (tab === "commits") return { branch: unseg(parts[0]), sha: parts[1] };
  if (tab === "pulls")
    return {
      state: parts[0] === "closed" ? ("closed" as const) : ("open" as const),
      number: parts[1] ? Number(parts[1]) : undefined,
    };
  if (tab === "ci") return { runId: /^\d+$/.test(parts[0] ?? "") ? Number(parts[0]) : undefined };
  return {};
}

const when = (iso: string | null) => (iso ? ago(Date.parse(iso)) : t("never"));

export function ReposPage({
  owner,
  name,
  tab,
  rest,
}: {
  owner?: string;
  name?: string;
  tab?: string;
  rest?: string;
}) {
  const open = owner && name ? { owner: unseg(owner) ?? owner, name: unseg(name) ?? name } : null;
  return (
    <div className="-mb-24 flex h-[calc(100dvh-7.5rem)] min-h-0 gap-4 md:-mb-8 md:h-[calc(100dvh-4.5rem)]">
      <aside
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col gap-2 md:w-80 xl:w-96",
          open && "hidden md:flex",
        )}
      >
        <RepoList selected={open} />
      </aside>
      <section className={cn("min-h-0 min-w-0 flex-1", !open && "hidden md:block")}>
        {open ? (
          <RepoDetail
            key={`${open.owner}/${open.name}`}
            owner={open.owner}
            name={open.name}
            tab={tab}
            rest={rest}
          />
        ) : (
          <div className="h-full space-y-4 overflow-y-auto pb-6">
            <AccountsPane />
          </div>
        )}
      </section>
    </div>
  );
}

/** The accounts, as in Settings, and what GitHub's allowance leaves. */
function AccountsPane() {
  const limits = useLive(() => api.github.limits(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  // Reads move the allowance without an event: asked again while it is shown.
  const reload = useRef(limits.reload);
  reload.current = limits.reload;
  useEffect(() => {
    const first = setTimeout(() => reload.current(), 3000);
    const every = setInterval(() => reload.current(), 30_000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  return (
    <>
      <GitHubCard />
      <GitHostsCard />
      {limits.data?.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("GitHub's hourly allowance")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            {limits.data.map((l) => (
              <div key={l.account} className="flex flex-wrap gap-x-2">
                <span className="font-medium">{l.account}</span>
                <span className={cn("text-muted-foreground", !l.remaining && "text-destructive")}>
                  {l.words}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </>
  );
}

const ALL = "all";

/** The repositories of an account or of all: searchable, with what matters on each row. */
function RepoList({ selected }: { selected: { owner: string; name: string } | null }) {
  const [, go] = useLocation();
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  // GitLab, Gitea and Forgejo beside GitHub (ADR-062).
  const hostAccounts = useLive(() => api.hosts.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("githost."),
  });
  const [account, setAccount] = useState(ALL);
  const [query, setQuery] = useState("");
  const [visibility, setVisibility] = useState<"any" | "public" | "private">("any");
  const [creating, setCreating] = useState(false);
  const [showAccounts, setShowAccounts] = useState(false);
  const list = useLive(
    () => {
      if (account === ALL) return api.hosts.repoList({});
      const { host, owner: login } = splitOwner(account);
      return host ? api.hosts.repoList({ host, account: login }) : api.github.repoList({ account });
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
  const githubLogins = (accounts.data ?? []).map((a) => a.login).filter(Boolean);
  /** Every account, GitHub's by login, another host's as `<host>!<login>`. */
  const logins = [
    ...githubLogins,
    ...(hostAccounts.data ?? []).map((a) => ownerKey(a.host, a.login)),
  ];
  const accountLabel = (key: string) => {
    const { host, owner: login } = splitOwner(key);
    return host ? `${login} · ${host}` : login;
  };
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (list.data?.repos ?? []).filter(
      (r) =>
        (visibility === "any" ||
          (visibility === "public" ? r.visibility === "public" : r.visibility !== "public")) &&
        (!q ||
          r.fullName.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q) ||
          (r.project?.name ?? "").toLowerCase().includes(q)),
    );
  }, [list.data, query, visibility]);
  const away = !!remote();

  return (
    <>
      <div className="flex items-center gap-2">
        <h1 className="flex-1 text-lg font-semibold">{t("Repos")}</h1>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 md:hidden"
          onClick={() => setShowAccounts(true)}
        >
          <Users className="size-4" />
          {t("Accounts")}
        </Button>
        {logins.length ? (
          <Button
            size="sm"
            className="gap-1"
            onClick={() => setCreating(true)}
            disabled={away}
            title={away ? t("A new repository is made at home.") : undefined}
          >
            <Plus className="size-4" />
            {t("New repository")}
          </Button>
        ) : null}
      </div>
      {accounts.data && hostAccounts.data && !logins.length ? (
        <Empty title={t("No GitHub account yet")}>
          {t(
            "Add a token in Accounts to see your repositories here: their code, commits, branches and pull requests.",
          )}
          <div className="mt-3 md:hidden">
            <Button size="sm" variant="secondary" onClick={() => setShowAccounts(true)}>
              {t("Accounts")}
            </Button>
          </div>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="relative min-w-0 flex-1 basis-40">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("Search repositories")}
                aria-label={t("Search repositories")}
                className="pl-8"
              />
            </div>
            <Select value={account} onValueChange={setAccount}>
              <SelectTrigger className="w-auto min-w-28" aria-label={t("Account")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{t("All accounts")}</SelectItem>
                {logins.map((l) => (
                  <SelectItem key={l} value={l}>
                    {accountLabel(l)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={visibility}
              onValueChange={(v) => setVisibility(v as "any" | "public" | "private")}
            >
              <SelectTrigger className="w-auto min-w-24" aria-label={t("Visibility")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">{t("Any")}</SelectItem>
                <SelectItem value="public">{t("Public")}</SelectItem>
                <SelectItem value="private">{t("Private")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {list.data?.errors.map((e) => (
            <ErrorNote key={e.account} error={`${e.account}: ${e.error}`} />
          ))}
          {list.error ? <ErrorNote error={list.error} /> : null}
          <section
            className="min-h-0 flex-1 space-y-1 overflow-y-auto"
            aria-label={t("Repositories")}
          >
            {list.loading && !list.data ? <Loading rows={6} /> : null}
            {list.data && !shown.length ? (
              <div className="p-3 text-sm text-muted-foreground">
                {list.data.repos.length
                  ? t("No repository matches.")
                  : t("No repository on this account yet.")}{" "}
                {query || visibility !== "any" ? (
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0"
                    onClick={() => {
                      setQuery("");
                      setVisibility("any");
                    }}
                  >
                    {t("Clear the filters")}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {shown.map((r) => (
              <RepoRow
                key={`${r.host ?? ""}:${r.fullName}`}
                repo={r}
                active={
                  selected?.owner.toLowerCase() === ownerKey(r.host, r.owner).toLowerCase() &&
                  selected?.name.toLowerCase() === r.name.toLowerCase()
                }
                onOpen={() => go(repoHref.base(ownerKey(r.host, r.owner), r.name))}
              />
            ))}
            {list.data?.truncated ? (
              <div className="p-2 text-xs text-muted-foreground">
                {t("Showing the 1,000 most recently pushed of an account; the rest are on GitHub.")}
              </div>
            ) : null}
          </section>
        </>
      )}
      <NewRepoDialog open={creating} onOpenChange={setCreating} logins={logins} />
      <Dialog open={showAccounts} onOpenChange={setShowAccounts}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("Accounts")}</DialogTitle>
            <DialogDescription>
              {t("GitHub's are the same as Settings → Connections → GitHub.")}
            </DialogDescription>
          </DialogHeader>
          <AccountsPane />
        </DialogContent>
      </Dialog>
    </>
  );
}

function RepoRow({
  repo: r,
  active,
  onOpen,
}: {
  repo: GitHubRepoSummary;
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      data-testid="repo-row"
      className={cn(
        "w-full min-w-0 rounded-lg border bg-card px-3 py-2 text-left hover:bg-accent",
        active && "border-primary bg-accent",
      )}
    >
      <div className="flex min-w-0 items-center gap-2 font-medium">
        <FolderGit2 className="size-4 shrink-0" />
        <span className="min-w-0 truncate" title={r.fullName}>
          {r.fullName}
        </span>
        <Visibility value={r.visibility} />
      </div>
      {r.description ? (
        <div className="truncate text-xs text-muted-foreground" title={r.description}>
          {r.description}
        </div>
      ) : null}
      <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <GitBranch className="size-3" />
          {r.defaultBranch}
        </span>
        <span>{r.pushedAt ? t("pushed {when}", { when: when(r.pushedAt) }) : t("empty")}</span>
        <span>{r.account}</span>
        {r.host ? (
          <Badge variant="outline" className="max-w-40 truncate font-normal" title={r.host}>
            {r.host}
          </Badge>
        ) : null}
        {r.project ? (
          <Badge variant="secondary" className="max-w-40 truncate" title={r.project.name}>
            {r.project.name}
          </Badge>
        ) : null}
      </div>
    </button>
  );
}

function Visibility({ value }: { value: GitHubRepoSummary["visibility"] }) {
  return (
    <Badge variant="outline" className="shrink-0 gap-1 font-normal">
      {value !== "public" ? <Lock className="size-3" /> : null}
      {value === "public" ? t("Public") : value === "internal" ? t("Internal") : t("Private")}
    </Badge>
  );
}

/** A new repository of mine, made from here (ADR-040), with a README so it can be cloned. */
function NewRepoDialog({
  open,
  onOpenChange,
  logins,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  logins: string[];
}) {
  const [, go] = useLocation();
  const [account, setAccount] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setPrivate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const chosen = account || logins[0] || "";
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { host, owner: login } = splitOwner(chosen);
      const input = {
        account: login,
        name: name.trim(),
        private: isPrivate,
        ...(description.trim() ? { description: description.trim() } : {}),
      };
      const r = host
        ? await api.hosts.createRepo({ ...input, host })
        : await api.github.createRepo(input);
      toast.success(t("Created {repo}.", { repo: `${r.owner}/${r.name}` }));
      onOpenChange(false);
      setName("");
      setDescription("");
      go(repoHref.base(ownerKey(host, r.owner), r.name));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("New repository")}</DialogTitle>
          <DialogDescription>
            {t("Made with a README, so it can be cloned at once.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          {logins.length > 1 ? (
            <div className="space-y-1">
              <Label>{t("Account")}</Label>
              <Select value={chosen} onValueChange={setAccount}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {logins.map((l) => (
                    <SelectItem key={l} value={l}>
                      {splitOwner(l).host ? `${splitOwner(l).owner} · ${splitOwner(l).host}` : l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="new-repo-name">{t("Name")}</Label>
            <Input
              id="new-repo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-repo-description">{t("Description (optional)")}</Label>
            <Input
              id="new-repo-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <label htmlFor="new-repo-private" className="flex min-h-11 items-center gap-3 text-sm">
            <Switch id="new-repo-private" checked={isPrivate} onCheckedChange={setPrivate} />
            {isPrivate ? t("Private: only you and who you invite") : t("Public: anyone can see it")}
          </label>
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !chosen}>
              {t("Create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** One repository, in tabs in the address (ADR-040). */
function RepoDetail({
  owner,
  name,
  tab,
  rest,
}: {
  owner: string;
  name: string;
  tab?: string;
  rest?: string;
}) {
  const info = useLive(() => rapi.repoInfo({ owner, name }), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "project.github" || e.type.startsWith("github."),
    deps: [owner, name],
  });
  // Another host than GitHub (ADR-062): its name, and what it calls its pull requests.
  const at = splitOwner(owner);
  const hosts = useLive(() => (at.host ? api.hosts.list() : Promise.resolve([])), {
    topics: [],
    deps: [at.host],
  });
  const hostView = hosts.data?.find((h) => h.host === at.host);
  const site = at.host ? (hostView?.label ?? at.host) : "GitHub";
  const header = (
    <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
      <BackButton fallback="/repos" label={t("All repositories")} className="md:hidden" />
      <h2 className="min-w-0 truncate text-lg font-semibold" title={`${at.owner}/${name}`}>
        <span className="text-muted-foreground">{at.owner}/</span>
        {name}
      </h2>
      {info.data ? <Visibility value={info.data.visibility} /> : null}
      {at.host ? (
        <Badge variant="outline" className="font-normal">
          {site}
        </Badge>
      ) : null}
      <span className="flex-1" />
      {info.data ? (
        <Button asChild size="sm" variant="ghost" className="gap-1">
          <a href={info.data.url} target="_blank" rel="noreferrer">
            <ExternalLink className="size-4" />
            {at.host ? t("Open on {site}", { site: at.host }) : t("Open on GitHub")}
          </a>
        </Button>
      ) : null}
      {info.data?.description ? (
        <p className="w-full truncate text-sm text-muted-foreground" title={info.data.description}>
          {info.data.description}
        </p>
      ) : null}
    </div>
  );
  if (info.error)
    return (
      <div className="space-y-3">
        {header}
        <ErrorNote error={info.error} />
      </div>
    );
  if (!info.data)
    return (
      <div className="space-y-3">
        {header}
        <Loading />
      </div>
    );
  // The tabs read and link through the address's owner part, the host in it (ADR-062).
  const linked = info.data;
  const repo = { ...linked, owner: ownerKey(linked.host, linked.owner) };
  const ref: GitHubRepoRef = { owner: repo.owner, name: repo.name, account: repo.account };
  const sub = parseRest(tab, rest);
  const tabs: PageTab[] = [
    {
      id: "code",
      label: t("Code"),
      content: () =>
        repo.empty ? (
          <Empty title={t("Nothing pushed yet")}>
            {t("This repository is empty: its code shows here after the first push.")}
          </Empty>
        ) : (
          <CodeTab
            repo={repo}
            r={ref}
            at={("ref" in sub && sub.ref) || repo.defaultBranch}
            kind={("kind" in sub && sub.kind) || "tree"}
            path={("path" in sub && sub.path) || ""}
          />
        ),
    },
    {
      id: "commits",
      label: t("Commits"),
      content: () => (
        <CommitsTab
          repo={repo}
          r={ref}
          branch={("branch" in sub && sub.branch) || repo.defaultBranch}
          sha={"sha" in sub ? sub.sha : undefined}
        />
      ),
    },
    { id: "branches", label: t("Branches"), content: () => <BranchesTab repo={repo} r={ref} /> },
    {
      id: "pulls",
      label: at.host && hostView ? t(hostView.pullsName) : t("Pull requests"),
      content: () => (
        <PullsTab
          repo={repo}
          r={ref}
          state={("state" in sub && sub.state) || "open"}
          number={"number" in sub ? sub.number : undefined}
        />
      ),
    },
    // GitHub Actions: GitHub's only (ADR-058); another host's repo has no CI tab here.
    ...(at.host
      ? []
      : [
          {
            id: "ci",
            label: t("CI"),
            content: () => (
              <CiRuns
                r={ref}
                defaultBranch={repo.defaultBranch}
                runId={"runId" in sub ? sub.runId : undefined}
                hrefFor={(id) => `${repoHref.base(owner, name)}/ci${id ? `/${id}` : ""}`}
              />
            ),
          },
        ]),
    { id: "project", label: t("Project"), content: () => <ProjectTab repo={linked} /> },
  ];
  return (
    <PageTabs
      base={repoHref.base(owner, name)}
      tab={tab}
      tabs={tabs}
      header={header}
      className="mb-0 h-full md:mb-0 md:h-full"
    />
  );
}

/** The branches, for a picker. */
function useBranches(r: GitHubRepoRef) {
  return useLive(() => rapi.branches({ ...r }), {
    topics: [],
    deps: [r.owner, r.name],
  });
}

function BranchPicker({
  r,
  value,
  onChange,
}: {
  r: GitHubRepoRef;
  value: string;
  onChange: (b: string) => void;
}) {
  const branches = useBranches(r);
  const names = (branches.data?.items ?? []).map((b) => b.name);
  if (!names.includes(value)) names.unshift(value);
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="w-auto max-w-56 min-w-28 gap-1" aria-label={t("Branch")}>
        <GitBranch className="size-4 shrink-0" />
        <span className="min-w-0 truncate">
          <SelectValue />
        </span>
      </SelectTrigger>
      <SelectContent>
        {names.map((n) => (
          <SelectItem key={n} value={n}>
            {n}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The tree at a branch, a file in it, and the README on the root. */
function CodeTab({
  repo,
  r,
  at,
  kind,
  path,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  at: string;
  kind: "tree" | "blob";
  path: string;
}) {
  const [, go] = useLocation();
  const o = repo.owner;
  const n = repo.name;
  const crumbs = path ? path.split("/") : [];
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <BranchPicker
          r={r}
          value={at}
          onChange={(b) => go(repoHref.code(o, n, b, kind, path), { replace: true })}
        />
        <nav
          aria-label={t("Path")}
          className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5 font-mono text-sm"
        >
          <Link href={repoHref.code(o, n, at)} className="text-primary hover:underline">
            {n}
          </Link>
          {crumbs.map((c, i) => {
            const p = crumbs.slice(0, i + 1).join("/");
            const last = i === crumbs.length - 1;
            return (
              <span key={p} className="flex min-w-0 items-center gap-0.5">
                <span className="text-muted-foreground">/</span>
                {last ? (
                  <span className="break-all">{c}</span>
                ) : (
                  <Link
                    href={repoHref.code(o, n, at, "tree", p)}
                    className="break-all text-primary hover:underline"
                  >
                    {c}
                  </Link>
                )}
              </span>
            );
          })}
        </nav>
      </div>
      {kind === "blob" && path ? (
        <FileTab r={r} at={at} path={path} />
      ) : (
        <TreeTab repo={repo} r={r} at={at} path={path} />
      )}
    </div>
  );
}

function TreeTab({
  repo,
  r,
  at,
  path,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  at: string;
  path: string;
}) {
  const tree = useLive(() => rapi.tree({ ...r, ref: at, path }), {
    topics: [],
    deps: [r.owner, r.name, at, path],
  });
  const readme = useLive(() => (path ? Promise.resolve(null) : rapi.readme({ ...r, ref: at })), {
    topics: [],
    deps: [r.owner, r.name, at, path],
  });
  if (tree.error) return <ErrorNote error={tree.error} />;
  if (!tree.data) return <Loading rows={5} />;
  return (
    <div className="space-y-4">
      <ul className="divide-y overflow-hidden rounded-lg border bg-card" aria-label={t("Files")}>
        {path ? (
          <li>
            <Link
              href={repoHref.code(
                repo.owner,
                repo.name,
                at,
                "tree",
                path.split("/").slice(0, -1).join("/"),
              )}
              className="flex min-h-10 items-center gap-2 px-3 text-sm text-muted-foreground hover:bg-accent"
            >
              <Folder className="size-4" />
              ..
            </Link>
          </li>
        ) : null}
        {tree.data.entries.map((e) => (
          <li key={e.path}>
            <Link
              href={
                e.type === "dir"
                  ? repoHref.code(repo.owner, repo.name, at, "tree", e.path)
                  : repoHref.code(repo.owner, repo.name, at, "blob", e.path)
              }
              className="flex min-h-10 min-w-0 items-center gap-2 px-3 text-sm hover:bg-accent"
            >
              {e.type === "dir" ? (
                <Folder className="size-4 shrink-0 text-primary" />
              ) : e.type === "submodule" ? (
                <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
              ) : (
                <File className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate" title={e.name}>
                {e.name}
              </span>
              {e.size !== null ? (
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {bytes(e.size)}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
        {!tree.data.entries.length ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">{t("An empty folder.")}</li>
        ) : null}
      </ul>
      {readme.data?.text ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-mono text-xs">
              <FileCode2 className="size-4" />
              {readme.data.path}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Markdown text={readme.data.text} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function FileTab({ r, at, path }: { r: GitHubRepoRef; at: string; path: string }) {
  const file = useLive(() => rapi.file({ ...r, ref: at, path }), {
    topics: [],
    deps: [r.owner, r.name, at, path],
  });
  if (file.error) return <ErrorNote error={file.error} />;
  if (!file.data) return <Loading rows={8} />;
  return <FileView file={file.data} />;
}

/**
 * A file with line numbers and syntax colouring, scrolling inside its own
 * block; a binary or too large file says so, with GitHub a click away.
 */
export function FileView({ file }: { file: GitHubFile }) {
  const text = file.text;
  const [lines, setLines] = useState<string[] | null>(null);
  useEffect(() => {
    setLines(null);
    if (text === null || text.length > 300_000) return;
    let gone = false;
    void import("@/lib/highlight").then((m) => {
      if (!gone) setLines(m.highlightLines(text, m.languageOf(file.path)));
    });
    return () => {
      gone = true;
    };
  }, [text, file.path]);
  const plain = useMemo(() => {
    if (text === null) return [];
    const l = text.split("\n");
    if (l.length > 1 && text.endsWith("\n")) l.pop();
    return l;
  }, [text]);
  const head = (
    <div className="flex min-h-10 flex-wrap items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
      <span className="font-mono">
        {text !== null ? t("{n} lines", { n: plain.length }) : null}
        {text !== null ? " · " : ""}
        {bytes(file.size)}
      </span>
      <span className="flex-1" />
      <a
        href={file.url}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-1 text-primary hover:underline"
      >
        <ExternalLink className="size-3.5" />
        {t("Open on GitHub")}
      </a>
    </div>
  );
  if (text === null)
    return (
      <div className="overflow-hidden rounded-lg border bg-card">
        {head}
        <div className="px-3 py-6 text-center text-sm text-muted-foreground">
          {file.binary
            ? t("A binary file: nothing to read here.")
            : t("Too large to show here (more than 512 KB).")}
        </div>
      </div>
    );
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border bg-card">
      {head}
      <div
        className="max-h-[70vh] overflow-auto bg-field font-mono text-[12.5px] leading-5"
        data-testid="file-view"
      >
        <table className="w-max min-w-full border-collapse">
          <tbody>
            {plain.map((line, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: a file's lines never move
              <tr key={i}>
                <td className="w-12 px-3 text-right align-top text-muted-foreground select-none">
                  {i + 1}
                </td>
                {lines?.[i] !== undefined ? (
                  <td
                    className="pr-4 whitespace-pre"
                    // highlight.js escapes the text; only its own spans are added.
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by highlight.js
                    dangerouslySetInnerHTML={{ __html: lines[i] || " " }}
                  />
                ) : (
                  <td className="pr-4 whitespace-pre">{line || " "}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Pages of something GitHub pages, appended as I ask for more. */
function usePages<T>(
  load: (page: number) => Promise<{ items: T[]; next: boolean }>,
  deps: unknown[],
) {
  const [items, setItems] = useState<T[]>([]);
  const [page, setPage] = useState(1);
  const [next, setNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const key = JSON.stringify(deps);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new key starts again
  useEffect(() => {
    setItems([]);
    setPage(1);
  }, [key]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads the page asked for
  useEffect(() => {
    let gone = false;
    setLoading(true);
    setError(undefined);
    load(page)
      .then((r) => {
        if (gone) return;
        setItems((xs) => (page === 1 ? r.items : [...xs, ...r.items]));
        setNext(r.next);
      })
      .catch((e) => !gone && setError(e))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
    };
  }, [key, page]);
  return { items, next, loading, error, more: () => setPage((p) => p + 1) };
}

function CommitRow({ c, href }: { c: GitHubCommitSummary; href: string }) {
  return (
    <li>
      <Link
        href={href}
        className="flex min-h-12 min-w-0 items-center gap-3 px-3 py-1.5 hover:bg-accent"
      >
        <GitCommitHorizontal className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm" title={c.title}>
            {c.title}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {c.author.login ?? c.author.name} · {when(c.date)}
          </span>
        </span>
        <code className="shrink-0 font-mono text-xs text-muted-foreground">
          {c.sha.slice(0, 7)}
        </code>
      </Link>
    </li>
  );
}

/** A branch's history, paged; a commit opened with its message and diff. */
function CommitsTab({
  repo,
  r,
  branch,
  sha,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  branch: string;
  sha?: string;
}) {
  const [, go] = useLocation();
  const list = usePages((page) => rapi.commits({ ...r, branch, page }), [r.owner, r.name, branch]);
  if (sha) return <CommitView repo={repo} r={r} branch={branch} sha={sha} />;
  return (
    <div className="min-w-0 space-y-3">
      <BranchPicker
        r={r}
        value={branch}
        onChange={(b) => go(repoHref.commits(repo.owner, repo.name, b), { replace: true })}
      />
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.items.length ? (
        <ul
          className="divide-y overflow-hidden rounded-lg border bg-card"
          aria-label={t("Commits")}
        >
          {list.items.map((c) => (
            <CommitRow
              key={c.sha}
              c={c}
              href={repoHref.commits(repo.owner, repo.name, branch, c.sha)}
            />
          ))}
        </ul>
      ) : list.loading ? (
        <Loading rows={6} />
      ) : !list.error ? (
        <div className="text-sm text-muted-foreground">{t("No commits on this branch yet.")}</div>
      ) : null}
      {list.next ? (
        <Button variant="secondary" size="sm" disabled={list.loading} onClick={list.more}>
          {t("Older commits")}
        </Button>
      ) : null}
    </div>
  );
}

function CommitView({
  repo,
  r,
  branch,
  sha,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  branch: string;
  sha: string;
}) {
  const c = useLive(() => rapi.commit({ ...r, sha }), {
    topics: [],
    deps: [r.owner, r.name, sha],
  });
  const body = c.data ? c.data.message.split("\n").slice(1).join("\n").trim() : "";
  return (
    <div className="min-w-0 space-y-3">
      <div className="flex min-w-0 items-start gap-1">
        <BackButton
          fallback={repoHref.commits(repo.owner, repo.name, branch)}
          label={t("All commits")}
        />
        <div className="min-w-0 flex-1">
          {c.data ? (
            <>
              <h3 className="text-base font-semibold [overflow-wrap:anywhere]">{c.data.title}</h3>
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                <span>{c.data.author.login ?? c.data.author.name}</span>
                <span title={c.data.date}>{new Date(c.data.date).toLocaleString()}</span>
                <code className="font-mono">{c.data.sha.slice(0, 12)}</code>
                <a
                  href={c.data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {t("Open on GitHub")}
                </a>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {c.error ? <ErrorNote error={c.error} /> : null}
      {!c.data && !c.error ? <Loading rows={4} /> : null}
      {body ? (
        <pre className="max-w-full rounded-md bg-muted p-3 font-sans text-sm whitespace-pre-wrap [overflow-wrap:anywhere]">
          {body}
        </pre>
      ) : null}
      {c.data ? <DiffList files={c.data.files} truncated={c.data.filesTruncated} /> : null}
    </div>
  );
}

function BranchesTab({ repo, r }: { repo: GitHubRepoDetail; r: GitHubRepoRef }) {
  const list = usePages((page) => rapi.branches({ ...r, page }), [r.owner, r.name]);
  return (
    <div className="min-w-0 space-y-3">
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.items.length ? (
        <ul
          className="divide-y overflow-hidden rounded-lg border bg-card"
          aria-label={t("Branches")}
        >
          {list.items.map((b) => (
            <li
              key={b.name}
              className="flex min-h-12 min-w-0 flex-wrap items-center gap-2 px-3 py-1.5"
            >
              <GitBranch className="size-4 shrink-0 text-muted-foreground" />
              <Link
                href={repoHref.code(repo.owner, repo.name, b.name)}
                className="min-w-0 flex-1 truncate font-mono text-sm text-primary hover:underline"
                title={b.name}
              >
                {b.name}
              </Link>
              {b.name === repo.defaultBranch ? (
                <Badge variant="secondary">{t("default")}</Badge>
              ) : null}
              {b.protected ? <Badge variant="outline">{t("protected")}</Badge> : null}
              <Link
                href={repoHref.commits(repo.owner, repo.name, b.name)}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {t("Commits")}
              </Link>
            </li>
          ))}
        </ul>
      ) : list.loading ? (
        <Loading rows={4} />
      ) : !list.error ? (
        <div className="text-sm text-muted-foreground">{t("No branches yet.")}</div>
      ) : null}
      {list.next ? (
        <Button variant="secondary" size="sm" disabled={list.loading} onClick={list.more}>
          {t("More branches")}
        </Button>
      ) : null}
    </div>
  );
}

const PR_TONE: Record<string, string> = {
  open: "bg-success/15 text-success",
  merged: "bg-primary/15 text-primary",
  closed: "bg-destructive/15 text-destructive",
};

/** Pull requests, open or closed; one with its description, commits and diff. */
function PullsTab({
  repo,
  r,
  state,
  number,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  state: "open" | "closed";
  number?: number;
}) {
  const [, go] = useLocation();
  const list = usePages((page) => rapi.pulls({ ...r, state, page }), [r.owner, r.name, state]);
  if (number) return <PullView repo={repo} r={r} state={state} number={number} />;
  return (
    <div className="min-w-0 space-y-3">
      <fieldset className="flex gap-1" aria-label={t("Which pull requests")}>
        {(["open", "closed"] as const).map((s) => (
          <Button
            key={s}
            size="sm"
            variant={s === state ? "secondary" : "ghost"}
            aria-pressed={s === state}
            onClick={() => go(repoHref.pulls(repo.owner, repo.name, s), { replace: true })}
          >
            {s === "open" ? t("Open") : t("Closed")}
          </Button>
        ))}
      </fieldset>
      {list.error ? <ErrorNote error={list.error} /> : null}
      {list.items.length ? (
        <ul
          className="divide-y overflow-hidden rounded-lg border bg-card"
          aria-label={t("Pull requests")}
        >
          {list.items.map((p) => (
            <li key={p.number}>
              <Link
                href={repoHref.pulls(repo.owner, repo.name, state, p.number)}
                className="flex min-h-12 min-w-0 items-center gap-3 px-3 py-1.5 hover:bg-accent"
              >
                <GitPullRequest className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm" title={p.title}>
                    {p.title}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    #{p.number} · {p.author ?? "—"} · {p.head} → {p.base} · {when(p.updatedAt)}
                  </span>
                </span>
                <Badge variant="outline" className={cn("border-transparent", PR_TONE[p.state])}>
                  {p.draft ? t("draft") : t(p.state)}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : list.loading ? (
        <Loading rows={4} />
      ) : !list.error ? (
        <div className="text-sm text-muted-foreground">
          {state === "open" ? t("No open pull request.") : t("No closed pull request.")}
        </div>
      ) : null}
      {list.next ? (
        <Button variant="secondary" size="sm" disabled={list.loading} onClick={list.more}>
          {t("More pull requests")}
        </Button>
      ) : null}
    </div>
  );
}

function PullView({
  repo,
  r,
  state,
  number,
}: {
  repo: GitHubRepoDetail;
  r: GitHubRepoRef;
  state: "open" | "closed";
  number: number;
}) {
  const p = useLive(() => rapi.pull({ ...r, number }), {
    topics: [],
    deps: [r.owner, r.name, number],
  });
  return (
    <div className="min-w-0 space-y-4">
      <div className="flex min-w-0 items-start gap-1">
        <BackButton
          fallback={repoHref.pulls(repo.owner, repo.name, state)}
          label={t("All pull requests")}
        />
        <div className="min-w-0 flex-1">
          {p.data ? (
            <>
              <h3 className="text-base font-semibold [overflow-wrap:anywhere]">
                {p.data.title} <span className="text-muted-foreground">#{p.data.number}</span>
              </h3>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <Badge
                  variant="outline"
                  className={cn("border-transparent", PR_TONE[p.data.state])}
                >
                  {p.data.draft ? t("draft") : t(p.data.state)}
                </Badge>
                <span>{p.data.author ?? "—"}</span>
                <span className="font-mono">
                  {p.data.head} → {p.data.base}
                </span>
                <span>{when(p.data.updatedAt)}</span>
                <a
                  href={p.data.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  {t("Open on GitHub")}
                </a>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {p.error ? <ErrorNote error={p.error} /> : null}
      {!p.data && !p.error ? <Loading rows={4} /> : null}
      {p.data ? (
        <>
          <Card>
            <CardContent className="pt-4">
              {p.data.body.trim() ? (
                <Markdown text={p.data.body} />
              ) : (
                <span className="text-sm text-muted-foreground">{t("No description.")}</span>
              )}
            </CardContent>
          </Card>
          <section className="space-y-2">
            <h4 className="eyebrow">{t("Commits ({n})", { n: p.data.commits.length })}</h4>
            <ul className="divide-y overflow-hidden rounded-lg border bg-card">
              {p.data.commits.map((c) => (
                <CommitRow
                  key={c.sha}
                  c={c}
                  href={repoHref.commits(repo.owner, repo.name, p.data?.head ?? "", c.sha)}
                />
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <h4 className="eyebrow">{t("Changes")}</h4>
            <DiffList files={p.data.files} truncated={p.data.truncated} />
          </section>
        </>
      ) : null}
    </div>
  );
}

/** The project that links it (open it, new work on it), or link it to one. */
function ProjectTab({ repo }: { repo: GitHubRepoDetail }) {
  const [, go] = useLocation();
  const projects = useLive(() => api.projects.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("project."),
  });
  const [chosen, setChosen] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  const away = !!remote();
  const linked = repo.project;
  const candidates = (projects.data ?? []).filter((p) => !p.archivedAt && p.id !== linked?.id);
  const link = async () => {
    const p = candidates.find((x) => x.id === chosen);
    if (!p) return;
    if (
      p.github &&
      !(await confirm(
        t("Link {project} to {repo} instead?", { project: p.name, repo: repo.fullName }),
        t("It is linked to {other} now. Nothing changes on the host.", {
          other: `${p.github.owner}/${p.github.name}`,
        }),
        t("Link"),
        { keep: t("Keep it") },
      ))
    )
      return;
    setBusy(true);
    try {
      await api.projects.setGitHub({
        id: p.id,
        link: {
          ...(repo.host ? { host: repo.host } : {}),
          account: repo.account,
          owner: repo.owner,
          name: repo.name,
          visibility: repo.visibility === "public" ? "public" : "private",
          origin: "existing",
        },
      });
      toast.success(t("{project} is linked to {repo}.", { project: p.name, repo: repo.fullName }));
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  const newWork = () =>
    linked
      ? go(`/projects/${linked.id}/eye`)
      : go("/new", {
          state: {
            source: "github-clone",
            repo: repo.fullName,
            account: repo.account,
            ...(repo.host ? { host: repo.host } : {}),
          },
        });
  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t("Its project")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {linked ? (
            <div className="flex min-h-11 flex-wrap items-center gap-2">
              <FolderGit2 className="size-4 shrink-0" />
              <span className="min-w-0 truncate font-medium" title={linked.name}>
                {linked.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("pushes here through {account}", { account: repo.account })}
              </span>
              <span className="flex-1" />
              <Button size="sm" variant="secondary" onClick={() => go(`/projects/${linked.id}`)}>
                {t("Open the project")}
              </Button>
              <Button size="sm" className="gap-1" onClick={newWork}>
                <Plus className="size-4" />
                {t("New work on it")}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-muted-foreground">
                {t(
                  "No project links it. Link one: Oraknid then pushes its branches here and opens pull requests, without asking. Or start new work on it: it is cloned into a new project.",
                )}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={chosen} onValueChange={setChosen}>
                  <SelectTrigger className="w-auto min-w-48" aria-label={t("Project")}>
                    <SelectValue placeholder={t("Choose a project")} />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                        {p.github ? ` · ${p.github.owner}/${p.github.name}` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="secondary" disabled={!chosen || busy} onClick={link}>
                  {t("Link")}
                </Button>
                <span className="flex-1" />
                <Button size="sm" className="gap-1" onClick={newWork}>
                  <Plus className="size-4" />
                  {t("New work on it")}
                </Button>
              </div>
              {away ? (
                <p className="text-xs text-muted-foreground">
                  {t("Away from home, linking needs a device with full rights.")}
                </p>
              ) : null}
            </>
          )}
        </CardContent>
      </Card>
      {linked ? (
        <p className="text-xs text-muted-foreground">
          {t("Change or unlink it in the project's Settings.")}{" "}
          <Link href={`/projects/${linked.id}/settings`} className="text-primary underline">
            {t("Open its Settings")}
          </Link>
        </p>
      ) : null}
      {dialog}
    </div>
  );
}
