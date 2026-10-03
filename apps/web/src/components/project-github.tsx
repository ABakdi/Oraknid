import type { GitHubLinkInput, ProjectView } from "@oraknid/contracts";
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
export function ProjectGitHubCard({ project }: { project: ProjectView }) {
  const accounts = useLive(() => api.github.accounts({}), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const [editing, setEditing] = useState(false);
  const { confirm, dialog } = useConfirm();
  const link = project.github;
  if (!accounts.data) return <Loading rows={1} />;
  const logins = accounts.data.map((a) => a.login).filter(Boolean);
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
      .setGitHub({ id: project.id, link: null })
      .then(() => toast.success(t("Unlinked.")))
      .catch((e) => toast.error(message(e)));
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <GitBranch className="size-4" />
          {t("GitHub repo")}
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
            <span className="text-xs text-muted-foreground">
              {t("through {account}", { account: link.account })}
              {logins.includes(link.account) ? "" : ` — ${t("an account Oraknid no longer has")}`}
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
          <LinkForm project={project} logins={logins} onDone={() => setEditing(false)} />
        ) : null}
        {dialog}
      </CardContent>
    </Card>
  );
}

function LinkForm({
  project,
  logins,
  onDone,
}: {
  project: ProjectView;
  logins: string[];
  onDone: () => void;
}) {
  const link = project.github;
  const [account, setAccount] = useState(link?.account ?? logins[0] ?? "");
  const [origin, setOrigin] = useState<"new" | "existing">(link?.origin ?? "new");
  const [owner, setOwner] = useState(link?.owner ?? logins[0] ?? "");
  const [name, setName] = useState(link?.name ?? slug(project.name));
  const [visibility, setVisibility] = useState<"public" | "private">(link?.visibility ?? "private");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const input: GitHubLinkInput = {
        account,
        owner: owner.trim(),
        name: name.trim(),
        visibility,
        origin,
      };
      await api.projects.setGitHub({ id: project.id, link: input });
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
            if (owner === account) setOwner(v);
            setAccount(v);
          }}
        >
          <SelectTrigger className="w-full" aria-label={t("Account")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {logins.map((l) => (
              <SelectItem key={l} value={l}>
                {l}
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
        <Label htmlFor="gh-owner">{t("Owner")}</Label>
        <Input id="gh-owner" value={owner} onChange={(e) => setOwner(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="gh-name">{t("Name")}</Label>
        <Input id="gh-name" value={name} onChange={(e) => setName(e.target.value)} />
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
