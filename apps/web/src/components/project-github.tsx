import type { GitHubLinkInput, ProjectRepo, ProjectView } from "@oraknid/contracts";
import { GitBranch } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { GitHubSetupButton } from "@/components/setup";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";

/**
 * A project's GitHub link (ADR-038): the account and repository Oraknid's
 * github tool uses for it. Pushing a branch there, creating it when it is
 * new and opening a pull request there run without asking.
 */
export function ProjectGitHubCard({
  project,
  repo,
}: {
  project: ProjectView;
  /** In a project of several repos, the repo whose link this is (ADR-042). */
  repo?: ProjectRepo;
}) {
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  // GitLab, Gitea and Forgejo accounts too (ADR-062), as `host!login`.
  const hostAccounts = useLive(() => api.hosts.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("githost."),
  });
  const [editing, setEditing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const link = repo ? repo.github : project.github;
  if (!accounts.data) return <Loading rows={1} />;
  const logins = [
    ...accounts.data.map((a) => a.login).filter(Boolean),
    ...(hostAccounts.data ?? []).map((a) => accountKey(a.host, a.login)),
  ];
  const unlink = async () => {
    if (
      !(await confirm(
        t("Unlink {repo}?", { repo: `${link?.owner}/${link?.name}` }),
        t(
          "Nothing changes on GitHub. The Eye asks again which repo to use the next time a task needs GitHub.",
        ),
        t("Unlink"),
        { keep: t("Keep it") },
      ))
    )
      return;
    api.projects
      .setGitHub({ id: project.id, link: null, ...(repo ? { repo: repo.name } : {}) })
      .then(() => toast.success(t("Unlinked.")))
      .catch((e) => toast.error(message(e)));
  };
  return (
    <Card data-help="project.github">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitBranch className="size-4" />
          {repo ? t("GitHub repo of {name}", { name: repo.name }) : t("GitHub repo")}
        </CardTitle>
        <CardDescription>
          {t(
            "Oraknid creates it when it is new, pushes this project's branches there and opens pull requests, with this account's token: no question for that. Pushing anywhere else, a force-push or deleting still asks.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {editing ? null : link ? (
          <div className="flex min-h-11 flex-wrap items-center gap-2">
            <span
              className="min-w-0 truncate font-mono font-medium"
              title={`${link.owner}/${link.name}`}
            >
              {link.owner}/{link.name}
            </span>
            <Badge variant="outline">
              {link.visibility === "public" ? t("Public") : t("Private")}
            </Badge>
            {!link.ready ? <Badge variant="secondary">{t("to be created")}</Badge> : null}
            {link.host ? <Badge variant="outline">{link.host}</Badge> : null}
            <span className="text-xs text-muted-foreground">
              {t("through {account}", { account: link.account })}
              {logins.includes(accountKey(link.host, link.account))
                ? ""
                : ` — ${t("an account Oraknid no longer has")}`}
            </span>
            <span className="flex-1" />
            <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
              {t("Change")}
            </Button>
            <Button size="sm" variant="ghost" onClick={unlink}>
              {t("Unlink")}
            </Button>
          </div>
        ) : (
          <div className="flex min-h-11 flex-wrap items-center gap-2 text-muted-foreground">
            <span className="flex-1">
              {logins.length
                ? t(
                    "None yet. The Eye asks which one the first time a task needs GitHub, or link one now.",
                  )
                : t("No GitHub account in Oraknid yet.")}
            </span>
            {logins.length ? (
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                {t("Link a repo")}
              </Button>
            ) : (
              <GitHubSetupButton />
            )}
          </div>
        )}
        {editing ? (
          <LinkForm
            project={project}
            {...(repo ? { repo } : {})}
            logins={logins}
            onDone={() => setEditing(false)}
          />
        ) : null}
        {dialog}
      </CardContent>
    </Card>
  );
}

function LinkForm({
  project,
  repo,
  logins,
  onDone,
}: {
  project: ProjectView;
  repo?: ProjectRepo;
  logins: string[];
  onDone: () => void;
}) {
  const link = repo ? repo.github : project.github;
  const [account, setAccount] = useState(
    link ? accountKey(link.host, link.account) : (logins[0] ?? ""),
  );
  const [origin, setOrigin] = useState<"new" | "existing">(link?.origin ?? "new");
  const [owner, setOwner] = useState(link?.owner ?? splitAccount(logins[0] ?? "").login);
  // A repo of several is named after the project and itself: site-api.
  const [name, setName] = useState(
    link?.name ??
      (repo && slug(repo.name) !== slug(project.name)
        ? `${slug(project.name)}-${slug(repo.name)}`
        : slug(project.name)),
  );
  const [visibility, setVisibility] = useState<"public" | "private">(link?.visibility ?? "private");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const { host, login } = splitAccount(account);
      const input: GitHubLinkInput = {
        ...(host ? { host } : {}),
        account: login,
        owner: owner.trim(),
        name: name.trim(),
        visibility,
        origin,
      };
      await api.projects.setGitHub({
        id: project.id,
        link: input,
        ...(repo ? { repo: repo.name } : {}),
      });
      toast.success(t("Linked {repo}.", { repo: `${input.owner}/${input.name}` }));
      onDone();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="space-y-1">
        <Label>{t("Account")}</Label>
        <Select
          value={account}
          onValueChange={(v) => {
            if (owner === splitAccount(account).login) setOwner(splitAccount(v).login);
            setAccount(v);
          }}
        >
          <SelectTrigger className="w-full" aria-label={t("Account")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {logins.map((l) => (
              <SelectItem key={l} value={l}>
                {splitAccount(l).host ? `${splitAccount(l).login} · ${splitAccount(l).host}` : l}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label>{t("Repository")}</Label>
        <Select value={origin} onValueChange={(v) => setOrigin(v as "new" | "existing")}>
          <SelectTrigger className="w-full" aria-label={t("Repository")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="new">{t("A new one, created by Oraknid")}</SelectItem>
            <SelectItem value="existing">{t("One that exists")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`gh-owner${repo ? `-${repo.name}` : ""}`}>{t("Owner")}</Label>
        <Input
          id={`gh-owner${repo ? `-${repo.name}` : ""}`}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`gh-name${repo ? `-${repo.name}` : ""}`}>{t("Name")}</Label>
        <Input
          id={`gh-name${repo ? `-${repo.name}` : ""}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label>{t("Who can see it")}</Label>
        <Select value={visibility} onValueChange={(v) => setVisibility(v as "public" | "private")}>
          <SelectTrigger className="w-full" aria-label={t("Who can see it")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="private">{t("Private")}</SelectItem>
            <SelectItem value="public">{t("Public")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-end justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
        <Button type="submit" disabled={busy || !account || !owner.trim() || !name.trim()}>
          {t("Save")}
        </Button>
      </div>
    </form>
  );
}

/** An account as the picker holds it: GitHub's by login, another host's as `host!login` (ADR-062). */
const accountKey = (host: string | undefined, login: string) => (host ? `${host}!${login}` : login);
const splitAccount = (key: string) => {
  const i = key.indexOf("!");
  return i < 0
    ? { host: undefined, login: key }
    : { host: key.slice(0, i), login: key.slice(i + 1) };
};
