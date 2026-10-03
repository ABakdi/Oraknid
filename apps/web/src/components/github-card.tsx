import { GitBranch } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

/** GitHub through a token I paste (ADR-023): new projects from new or existing repos. */
export function GitHubCard() {
  const status = useLive(() => api.github.status(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("github."),
  });
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, dialog } = useConfirm();
  if (!status.data) return <Loading rows={2} />;
  const s = status.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <GitBranch className="size-4" />
          {t("GitHub")}
          {s.connected && s.login ? <Badge variant="outline">{s.login}</Badge> : null}
        </CardTitle>
        <CardDescription>
          {t(
            "Create a new repo or clone one of yours when you start a project. The token stays in the keychain and is never given to a Leg; a push still asks you.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {s.error ? <div className="text-destructive">{s.error}</div> : null}
        {s.connected ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              if (
                !(await confirm(
                  t("Disconnect GitHub?"),
                  t(
                    "The token is deleted from the keychain. New projects can't use GitHub repos until you connect again.",
                  ),
                  t("Disconnect"),
                  { keep: t("Stay connected") },
                ))
              )
                return;
              api.github
                .removeToken()
                .then(() => toast.success(t("Disconnected; the token is deleted.")))
                .catch((e) => toast.error(message(e)));
            }}
          >
            {t("Disconnect")}
          </Button>
        ) : (
          <>
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-muted-foreground">
              <li>
                {t(
                  "On github.com: Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.",
                )}
              </li>
              <li>
                {t(
                  "Repository access: All repositories. Permissions: Administration (read and write) to create repos, Contents (read and write) to clone and push.",
                )}
              </li>
              <li>{t("Copy the token and paste it here.")}</li>
            </ol>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  const r = await api.github.setToken({ token });
                  setToken("");
                  toast.success(t("Connected as {login}.", { login: r.login }));
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
              <Button type="submit" disabled={busy || token.length < 10}>
                {t("Connect")}
              </Button>
            </form>
          </>
        )}
        {dialog}
      </CardContent>
    </Card>
  );
}
