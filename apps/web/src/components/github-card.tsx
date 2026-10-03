import { GitBranch, Plus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/**
 * My GitHub accounts (ADR-023, ADR-038): a token each, named by its
 * account, in the keychain. New projects from new or existing repos, and
 * a project's GitHub link, use them; no token ever reaches a Leg.
 */
export function GitHubCard() {
  const accounts = useLive(() => api.github.accounts({ check: true }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const { confirm, dialog } = useConfirm();
  if (!accounts.data) return <Loading rows={2} />;
  const list = accounts.data;
  const showForm = adding || list.length === 0;
  const remove = async (login: string) => {
    if (
      !(await confirm(
        t("Remove {login}?", { login: login || t("this account") }),
        t(
          "Its token is deleted from the keychain. Projects linked to it can't use GitHub until you link them to another account or add it again.",
        ),
        t("Remove"),
        { keep: t("Keep it") },
      ))
    )
      return;
    try {
      await api.github.removeAccount({ login });
      toast.success(t("Removed; its token is deleted."));
    } catch (e) {
      toast.error(message(e));
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4" />
          {t("GitHub")}
        </CardTitle>
        <CardDescription>
          {t(
            "Your GitHub accounts, a token each. Projects use one for their repo: Oraknid creates it, pushes and opens pull requests itself. Tokens stay in the keychain and never reach a Leg.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {list.length ? (
          <ul className="divide-y rounded-md border">
            {list.map((a, i) => (
              <li
                key={a.login || i}
                className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-1.5"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{a.login || t("Unnamed account")}</span>
                  {i === 0 ? (
                    <span className="ml-2 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                      {t("Default")}
                    </span>
                  ) : null}
                  {a.error ? (
                    <span className="block text-xs text-destructive">{a.error}</span>
                  ) : null}
                </span>
                <Button variant="ghost" size="sm" onClick={() => remove(a.login)}>
                  {t("Remove")}
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {showForm ? (
          <>
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
              <li>
                {t(
                  "On github.com: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
                )}
              </li>
              <li>
                {t(
                  "Repository access: All repositories. Permissions: Administration (read and write) to create repos, Contents (read and write) to clone and push, Pull requests (read and write) to open them.",
                )}
              </li>
              <li>
                {t("Copy the token and paste it here. A token of an account you have replaces it.")}
              </li>
            </ol>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api.github.addAccount({ token });
                  setToken("");
                  setAdding(false);
                  toast.success(t("Added {login}.", { login: r.login }));
                } catch (x) {
                  toast.error(message(x));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <div className="min-w-0 flex-1 basis-60 space-y-1">
                <Label htmlFor="gh-token">{t("Token")}</Label>
                <Input
                  id="gh-token"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="github_pat_…"
                />
              </div>
              {list.length ? (
                <Button type="button" variant="ghost" onClick={() => setAdding(false)}>
                  {t("Cancel")}
                </Button>
              ) : null}
              <Button type="submit" disabled={busy || token.length < 10}>
                {t("Add")}
              </Button>
            </form>
          </>
        ) : (
          <Button variant="secondary" size="sm" className="gap-1" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            {t("Add an account")}
          </Button>
        )}
        {dialog}
      </CardContent>
    </Card>
  );
}
