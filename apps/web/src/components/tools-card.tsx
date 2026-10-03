import type { ToolView } from "@oraknid/contracts";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Loading } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const words = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Tools for skills (ADR-021): MCP servers the daemon runs for a job's
 * sessions, never the Legs. Their secrets go to the keychain.
 */
export function ToolsCard() {
  const tools = useLive(() => api.tools.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("tool."),
  });
  const [adding, setAdding] = useState(false);
  if (!tools.data) return <Loading rows={2} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Tools")}</CardTitle>
        <CardDescription>
          {t(
            "What skills can use, such as email. Oraknid runs each one in its own sandbox with its secrets; the Legs only reach it through Oraknid, which lets reads through and asks you before anything is sent.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {tools.data.length === 0 && !adding ? (
          <div className="text-sm text-muted-foreground">{t("No tools yet.")}</div>
        ) : null}
        {tools.data.map((tool) => (
          <ToolRow key={tool.id} tool={tool} />
        ))}
        {adding ? (
          <ToolForm onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="secondary" className="gap-1" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" />
            {t("Add a tool")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ToolRow({ tool }: { tool: ToolView }) {
  if (tool.builtIn) return <BuiltInRow tool={tool} />;
  return <ServerRow tool={tool} />;
}

/** One of Oraknid's own tools (the email tool): nothing to set up, nothing to remove. */
function BuiltInRow({ tool }: { tool: ToolView }) {
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{tool.name}</span>
        <Badge variant="outline">{t("part of Oraknid")}</Badge>
        {tool.untrusted ? <Badge variant="outline">{t("untrusted output")}</Badge> : null}
      </div>
      {tool.description ? <div className="text-muted-foreground">{tool.description}</div> : null}
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>{t("Reads (allowed): {r}", { r: tool.reads.join(", ") || t("none") })}</div>
        <div>{t("Waits for my approval: {h}", { h: tool.held.join(", ") || t("none") })}</div>
        <div>{t("Used by: {u}", { u: tool.usedBy.join(", ") || t("no skill yet") })}</div>
      </div>
    </div>
  );
}

function ServerRow({ tool }: { tool: ToolView }) {
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{tool.name}</span>
        {tool.untrusted ? <Badge variant="outline">{t("untrusted output")}</Badge> : null}
        {tool.missingSecrets.length ? (
          <Badge variant="destructive">
            {t("missing {s}", { s: tool.missingSecrets.join(", ") })}
          </Badge>
        ) : null}
        <span className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("Remove {name}", { name: tool.name })}
          onClick={() =>
            api.tools
              .remove({ id: tool.id })
              .then(() => toast.success(t("Removed.")))
              .catch((e) => toast.error(message(e)))
          }
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {tool.description ? <div className="text-muted-foreground">{tool.description}</div> : null}
      <div className="font-mono text-xs [overflow-wrap:anywhere]">
        {[tool.command, ...tool.args].join(" ")}
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div>{t("Reads (allowed): {r}", { r: tool.reads.join(", ") || t("none") })}</div>
        <div>{t("Sends (always asked): {s}", { s: tool.sends.join(", ") || t("none") })}</div>
        <div>{t("Secrets: {s}", { s: tool.secretNames.join(", ") || t("none") })}</div>
        <div>{t("Used by: {u}", { u: tool.usedBy.join(", ") || t("no skill yet") })}</div>
      </div>
      {secret ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor={`sn-${tool.id}`}>{t("Name")}</Label>
            <Input
              id={`sn-${tool.id}`}
              className="w-44 font-mono"
              value={secret.name}
              onChange={(e) => setSecret({ ...secret, name: e.target.value.toUpperCase() })}
            />
          </div>
          <div className="min-w-40 flex-1 space-y-1">
            <Label htmlFor={`sv-${tool.id}`}>{t("Value")}</Label>
            <Input
              id={`sv-${tool.id}`}
              type="password"
              value={secret.value}
              onChange={(e) => setSecret({ ...secret, value: e.target.value })}
            />
          </div>
          <Button
            size="sm"
            disabled={!secret.name || !secret.value}
            onClick={() =>
              api.tools
                .update({ id: tool.id, secrets: { [secret.name]: secret.value } })
                .then(() => {
                  toast.success(t("Saved to the keychain."));
                  setSecret(null);
                })
                .catch((e) => toast.error(message(e)))
            }
          >
            {t("Save")}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setSecret({ name: tool.missingSecrets[0] ?? "", value: "" })}
        >
          {t("Set a secret")}
        </Button>
      )}
    </div>
  );
}

function ToolForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [command, setCommand] = useState("");
  const [reads, setReads] = useState("");
  const [sends, setSends] = useState("");
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [untrusted, setUntrusted] = useState(true);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    const [cmd, ...args] = words(command);
    if (!cmd) return;
    setBusy(true);
    try {
      await api.tools.create({
        name,
        description,
        command: cmd,
        args,
        reads: words(reads),
        sends: words(sends),
        untrusted,
        ...(secretName && secretValue ? { secrets: { [secretName]: secretValue } } : {}),
      });
      toast.success(t("Added."));
      onDone();
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3 rounded-md border px-3 py-3 text-sm">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tn">{t("Name skills use")}</Label>
          <Input
            id="tn"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="email"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="td">{t("Description")}</Label>
          <Input
            id="td"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("My mail, over IMAP and SMTP")}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="tc">{t("MCP server command (stdio)")}</Label>
        <Input
          id="tc"
          className="font-mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="/usr/bin/node /home/me/mcp/mail/server.js"
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tr">{t("Tools that only read")}</Label>
          <Input
            id="tr"
            className="font-mono"
            value={reads}
            onChange={(e) => setReads(e.target.value)}
            placeholder="list_messages, get_message"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="ts">{t("Tools that send")}</Label>
          <Input
            id="ts"
            className="font-mono"
            value={sends}
            onChange={(e) => setSends(e.target.value)}
            placeholder="send_email"
          />
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        {t(
          "Anything not listed as a read counts as a write and asks you, unless you waive it for a job. A send always asks.",
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="tk">{t("Secret's variable (optional)")}</Label>
          <Input
            id="tk"
            className="font-mono"
            value={secretName}
            onChange={(e) => setSecretName(e.target.value.toUpperCase())}
            placeholder="MAIL_PASSWORD"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="tv">{t("Its value")}</Label>
          <Input
            id="tv"
            type="password"
            value={secretValue}
            onChange={(e) => setSecretValue(e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch id="tu" checked={untrusted} onCheckedChange={setUntrusted} />
        <Label htmlFor="tu" className="font-normal">
          {t("What it returns comes from outside (mail, web pages): treat it as data")}
        </Label>
      </div>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !name || !command} onClick={create}>
          {t("Add")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
      </div>
    </div>
  );
}
