import { GitMerge, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
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
import { remote } from "@/lib/remote";

type Kind = "gitlab" | "gitea";

/** What each kind's token needs, where it is made, said step by step. */
const STEPS: Record<Kind, string[]> = {
  gitlab: [
    "On your GitLab (gitlab.com or your own): your avatar → Edit profile → Access tokens → Add new token.",
    "Scopes: api (to create projects and open merge requests), read_repository and write_repository (to clone and push). Give it an expiry you will remember.",
    "Copy the token and paste it here with GitLab's address.",
  ],
  gitea: [
    "On your Gitea or Forgejo: Settings → Applications → Generate new token.",
    "Permissions: repository Read and write, user Read, organisation Read (Read and write to create repos in an organisation).",
    "Copy the token and paste it here with the server's address.",
  ],
};

/**
 * My accounts on git hosts besides GitHub (ADR-062): GitLab (gitlab.com or
 * my own) and Gitea or Forgejo, a personal access token each, checked
 * against the host and kept in the keychain; never shown again, never
 * reaching a Leg.
 */
export function GitHostsCard() {
  const accounts = useLive(() => api.hosts.accounts({ check: true }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("githost."),
  });
  const [kind, setKind] = useState<Kind>("gitlab");
  const [url, setUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const { confirm, dialog } = useConfirm();
  const away = !!remote();
  if (!accounts.data) return <Loading rows={2} />;
  const list = accounts.data;
  const remove = async (host: string, login: string) => {
    if (
      !(await confirm(
        t("Remove {login} on {host}?", { login, host }),
        t(
          "Its token is deleted from the keychain. Projects linked through it can't push there until you link them to another account or add it again.",
        ),
        t("Remove"),
        { keep: t("Keep it") },
      ))
    )
      return;
    try {
      await api.hosts.removeAccount({ host, login });
      toast.success(t("Removed; its token is deleted."));
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitMerge className="size-4" />
          {t("GitLab, Gitea and Forgejo")}
        </CardTitle>
        <CardDescription>
          {t(
            "Accounts on other git hosts, a token each: their repositories here beside GitHub's, new projects from them, and a project's link there. Oraknid clones and pushes itself; tokens stay in the keychain.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {list.length ? (
          <ul className="divide-y rounded-md border">
            {list.map((a) => (
              <li
                key={`${a.host}/${a.login}`}
                className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.login}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {a.kind === "gitlab" ? "GitLab" : "Gitea/Forgejo"} · {a.host}
                  </span>
                  {a.error ? (
                    <span className="block text-xs text-destructive">{a.error}</span>
                  ) : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={away}
                  onClick={() => remove(a.host, a.login)}
                >
                  {t("Remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {adding ? (
          <>
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
              {STEPS[kind].map((s) => (
                <li key={s}>{t(s)}</li>
              ))}
            </ol>
            <form
              className="grid gap-2 sm:grid-cols-[auto_1fr]"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api.hosts.addAccount({ kind, url: url.trim(), token });
                  setToken("");
                  setAdding(false);
                  toast.success(t("Added {login} on {host}.", { login: r.login, host: r.host }));
                } catch (x) {
                  toast.error(message(x));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="space-y-1">
                <Label>{t("Host")}</Label>
                <Select
                  value={kind}
                  onValueChange={(v) => {
                    setKind(v as Kind);
                    if (v === "gitlab" && !url) setUrl("https://gitlab.com");
                    if (v === "gitea" && url === "https://gitlab.com") setUrl("");
                  }}
                >
                  <SelectTrigger className="w-full min-w-36" aria-label={t("Host")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gitlab">GitLab</SelectItem>
                    <SelectItem value="gitea">Gitea / Forgejo</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="min-w-0 space-y-1">
                <Label htmlFor="gh-host-url">{t("Address")}</Label>
                <Input
                  id="gh-host-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder={kind === "gitlab" ? "https://gitlab.com" : "https://git.example.org"}
                />
              </div>
              <div className="min-w-0 space-y-1 sm:col-span-2">
                <Label htmlFor="gh-host-token">{t("Token")}</Label>
                <Input
                  id="gh-host-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder={kind === "gitlab" ? "glpat-…" : ""}
                />
              </div>
              <div className="flex justify-end gap-2 sm:col-span-2">
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  {t("Cancel")}
                </Button>
                <Button type="submit" disabled={busy || token.length < 8 || !url.trim()}>
                  {t("Add")}
                </Button>
              </div>
            </form>
          </>
        ) : (
          <Button
            variant="secondary"
            size="sm"
            className="gap-1"
            disabled={away}
            title={away ? t("Accounts are added at home.") : undefined}
            onClick={() => setAdding(true)}
          >
            <Plus className="size-4" />
            {t("Add a GitLab, Gitea or Forgejo account")}
          </Button>
        )}
        {dialog}
      </CardContent>
    </Card>
  );
}
