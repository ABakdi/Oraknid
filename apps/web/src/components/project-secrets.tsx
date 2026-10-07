import type { ProjectSecretView, SecretEnvironment } from "@oraknid/contracts";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const ENVIRONMENTS: { id: SecretEnvironment; label: string }[] = [
  { id: "dev", label: "dev" },
  { id: "testing", label: "testing" },
  { id: "production", label: "production" },
];

const NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * A project's secrets per environment (ADR-059): names and when each was
 * set; a value is masked once saved and can only be replaced or removed.
 * A job's sessions get its environment's as variables in the sandbox.
 */
export function ProjectSecretsCard({ projectId }: { projectId: string }) {
  const s = useLive(() => api.projectSecrets.list({ projectId }), {
    topics: ["overview"],
    deps: [projectId],
    refreshOn: (e) => e.type.startsWith("project.secret") || e.type === "project.environment.set",
  });
  const [environment, setEnvironment] = useState<SecretEnvironment>("dev");
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [dotenv, setDotenv] = useState("");
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState("");
  const { confirm, dialog } = useConfirm();
  if (!s.data) return <Loading rows={2} />;
  const rows = s.data.secrets.filter((x) => x.environment === environment);

  const add = () =>
    api.projectSecrets
      .set({ projectId, environment, name: name.trim(), value })
      .then(() => {
        toast.success(t("{name} saved: it won't be shown again.", { name: name.trim() }));
        setName("");
        setValue("");
        s.reload();
      })
      .catch((e) => toast.error(message(e)));
  const replace = (row: ProjectSecretView) =>
    api.projectSecrets
      .set({ projectId, environment: row.environment, name: row.name, value: replacement })
      .then(() => {
        toast.success(t("{name} replaced.", { name: row.name }));
        setReplacing(null);
        setReplacement("");
        s.reload();
      })
      .catch((e) => toast.error(message(e)));
  const remove = async (row: ProjectSecretView) => {
    const ok = await confirm(
      t("Remove {name}?", { name: row.name }),
      t(
        "Its value is deleted from the keychain. Jobs of this project's {env} environment won't get it any more.",
        { env: row.environment },
      ),
      t("Remove"),
    );
    if (!ok) return;
    api.projectSecrets
      .remove({ id: row.id })
      .then(s.reload)
      .catch((e) => toast.error(message(e)));
  };
  const importText = () =>
    api.projectSecrets
      .importDotEnv({ projectId, environment, text: dotenv })
      .then((r) => {
        setDotenv("");
        s.reload();
        toast.success(
          t("{n} set from the .env.", { n: r.set.length }) +
            (r.skipped.length
              ? ` ${t("Skipped: {lines}.", {
                  lines: r.skipped
                    .map((x) => `${t("line {n}", { n: x.line })} (${x.reason})`)
                    .join(", "),
                })}`
              : ""),
        );
      })
      .catch((e) => toast.error(message(e)));

  return (
    <Card data-help="project.secrets">
      {dialog}
      <CardHeader>
        <CardTitle>{t("Secrets")}</CardTitle>
        <CardDescription>
          {t(
            "API keys and .env values for this project, per environment. They are kept in the keychain and never shown again after you save them. A job's sessions get its environment's as environment variables inside the sandbox; a deploy writes them on a server as a file only its login can read.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("Environment")}</span>
          <Select value={environment} onValueChange={(v) => setEnvironment(v as SecretEnvironment)}>
            <SelectTrigger className="w-36" aria-label={t("Environment")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENVIRONMENTS.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="ml-auto text-muted-foreground">{t("New jobs run in")}</span>
          <Select
            value={s.data.defaultEnvironment}
            onValueChange={(v) =>
              api.projectSecrets
                .setDefaultEnvironment({ projectId, environment: v as SecretEnvironment })
                .then(s.reload)
                .catch((e) => toast.error(message(e)))
            }
          >
            <SelectTrigger className="w-36" aria-label={t("New jobs run in")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ENVIRONMENTS.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {rows.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <span className="font-mono">{row.name}</span>
                <span className="font-mono text-muted-foreground">{row.masked}</span>
                <span className="text-xs text-muted-foreground">
                  {t("set {when}", { when: ago(row.updatedAt) })}
                </span>
                <span className="ml-auto flex gap-2">
                  {replacing === row.id ? (
                    <>
                      <Input
                        type="password"
                        autoComplete="off"
                        className="w-56"
                        placeholder={t("New value")}
                        value={replacement}
                        onChange={(e) => setReplacement(e.target.value)}
                        aria-label={t("New value for {name}", { name: row.name })}
                      />
                      <Button size="sm" disabled={!replacement} onClick={() => replace(row)}>
                        {t("Replace")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setReplacing(null)}>
                        {t("Cancel")}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setReplacing(row.id);
                          setReplacement("");
                        }}
                      >
                        {t("Replace")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => remove(row)}>
                        {t("Remove")}
                      </Button>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("No {env} secrets yet.", { env: environment })}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="w-56 font-mono"
            placeholder="API_KEY"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            aria-label={t("Name")}
          />
          <Input
            type="password"
            autoComplete="off"
            className="w-64"
            placeholder={t("Value")}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={t("Value")}
          />
          <Button onClick={add} disabled={!NAME.test(name.trim()) || !value}>
            {t("Add")}
          </Button>
        </div>

        <div className="space-y-2">
          <Textarea
            className="font-mono text-xs"
            rows={4}
            placeholder={"API_KEY=…\nDATABASE_URL=…"}
            value={dotenv}
            onChange={(e) => setDotenv(e.target.value)}
            aria-label={t("Paste a .env")}
          />
          <Button variant="secondary" disabled={!dotenv.trim()} onClick={importText}>
            {t("Set from this .env ({env})", { env: environment })}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
