import type { LegView } from "@oraknid/contracts";
import { useState } from "react";
import { ErrorNote, StateBadge } from "@/components/common";
import { LegLogin } from "@/components/leg-login";
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
import { api } from "@/lib/api";
import { t } from "@/lib/i18n";

/** Adding a Leg by hand, tested straight away (Legs → Adding a Leg); from Legs, and wherever one is missing. */
export function AddLeg({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [kind, setKind] = useState<
    "claude-code" | "openai-compatible" | "opencode" | "antigravity" | "oraknid-agent"
  >("claude-code");
  const [agentUrl, setAgentUrl] = useState("https://openrouter.ai/api/v1");
  const [agyBinary, setAgyBinary] = useState("agy");
  const [providerID, setProviderID] = useState("openrouter");
  const [ocBaseURL, setOcBaseURL] = useState("https://openrouter.ai/api/v1");
  const [models, setModels] = useState("");
  const [ownProvider, setOwnProvider] = useState(false);
  const [name, setName] = useState("");
  const [binary, setBinary] = useState("claude");
  const [configDir, setConfigDir] = useState("");
  const [baseUrl, setBaseUrl] = useState("http://localhost:11434/v1");
  const [secret, setSecret] = useState("");
  const [result, setResult] = useState<LegView | null>(null);
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const leg =
        kind === "claude-code"
          ? await api.legs.create({
              kind,
              name,
              config: { binary, ...(configDir ? { configDir } : {}) },
            })
          : kind === "antigravity"
            ? await api.legs.create({ kind, name, config: { binary: agyBinary, models: [] } })
            : kind === "opencode"
              ? await api.legs.create({
                  kind,
                  name,
                  config: ownProvider
                    ? {
                        binary: "opencode",
                        providerID,
                        package: "@opencode/ai/providers/openai-compatible",
                        ...(ocBaseURL ? { baseURL: ocBaseURL } : {}),
                        models: models
                          .split(/[\s,]+/)
                          .map((m) => m.trim())
                          .filter(Boolean),
                      }
                    : {
                        binary: "opencode",
                        package: "@opencode/ai/providers/openai-compatible",
                        models: [],
                      },
                  ...(ownProvider && secret ? { secret } : {}),
                })
              : kind === "oraknid-agent"
                ? await api.legs.create({
                    kind,
                    name,
                    config: {
                      baseUrl: agentUrl,
                      models: models
                        .split(/[\s,]+/)
                        .map((m) => m.trim())
                        .filter(Boolean),
                      endpoints: [],
                    },
                    ...(secret ? { secret } : {}),
                  })
                : await api.legs.create({
                    kind,
                    name,
                    config: { baseUrl },
                    ...(secret ? { secret } : {}),
                  });
      setResult(leg);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) setResult(null);
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Add a Leg")}</DialogTitle>
          <DialogDescription>
            {t("It is tested straight away. Secrets go to the keychain, never the database.")}
          </DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              {result.name} <StateBadge state={result.health} />
            </div>
            <div className="text-muted-foreground">{result.healthDetail}</div>
            {(result.kind === "claude-code" || result.kind === "antigravity") &&
            result.health !== "healthy" &&
            !/not installed/.test(result.healthDetail ?? "") ? (
              <div className="flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                <span className="flex-1">{t("Log this account in to use it.")}</span>
                <LegLogin legId={result.id} legName={result.name} kind={result.kind} />
              </div>
            ) : result.setupHint ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
                {result.setupHint}
              </div>
            ) : null}
            {result.models.length ? (
              <div>{t("Models: {m}", { m: result.models.map((m) => m.model).join(", ") })}</div>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label>{t("Kind")}</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="claude-code">{t("Claude Code account")}</SelectItem>
                  <SelectItem value="openai-compatible">
                    {t("OpenAI-compatible server (Ollama, LM Studio…)")}
                  </SelectItem>
                  <SelectItem value="opencode">
                    {t("OpenCode, with a provider's API key")}
                  </SelectItem>
                  <SelectItem value="antigravity">{t("Antigravity account (Google)")}</SelectItem>
                  <SelectItem value="oraknid-agent">
                    {t("Oraknid's own agent, on any OpenAI-compatible model")}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ln">{t("Name")}</Label>
              <Input
                id="ln"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  kind === "claude-code"
                    ? t("Claude — personal")
                    : kind === "antigravity"
                      ? t("Antigravity — personal")
                      : kind === "opencode"
                        ? t("OpenCode — free models")
                        : kind === "oraknid-agent"
                          ? t("Oraknid agent — OpenRouter")
                          : t("Ollama on this machine")
                }
              />
            </div>
            {kind === "claude-code" ? (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="lb">{t("Binary")}</Label>
                  <Input
                    id="lb"
                    className="font-mono"
                    value={binary}
                    onChange={(e) => setBinary(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lc">
                    {t("Config directory (empty: a new one you log into)")}
                  </Label>
                  <Input
                    id="lc"
                    className="font-mono"
                    value={configDir}
                    onChange={(e) => setConfigDir(e.target.value)}
                    placeholder={t("empty: a folder of its own")}
                  />
                </div>
              </>
            ) : kind === "antigravity" ? (
              <>
                <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  {t(
                    "Antigravity's official CLI, agy, signed in to your Google account from this Leg's card. It must be installed on this machine first (antigravity.google/docs/cli). Commands it runs still go through your approvals.",
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ab">{t("Binary")}</Label>
                  <Input
                    id="ab"
                    className="font-mono"
                    value={agyBinary}
                    onChange={(e) => setAgyBinary(e.target.value)}
                  />
                </div>
              </>
            ) : kind === "oraknid-agent" ? (
              <>
                <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  {t(
                    "Oraknid's own tool loop (read, edit, write, glob, grep, bash in the sandbox, a todo list, a web fetch) over any model behind an OpenAI-compatible API. The test checks each model's tool calling; one that can't call tools does text work only. Your local models get a Leg like this by themselves, from the Models page.",
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="au">{t("Endpoint (OpenAI-compatible)")}</Label>
                  <Input
                    id="au"
                    className="font-mono"
                    value={agentUrl}
                    onChange={(e) => setAgentUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="am">{t("Models (empty: every model it lists)")}</Label>
                  <Input
                    id="am"
                    className="font-mono"
                    value={models}
                    onChange={(e) => setModels(e.target.value)}
                    placeholder="qwen/qwen3-coder:free"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ak">{t("API key, if the endpoint needs one")}</Label>
                  <Input
                    id="ak"
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </div>
              </>
            ) : kind === "opencode" ? (
              <>
                <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                  {ownProvider
                    ? t(
                        "OpenCode with another provider's API key. Never a Claude subscription (Anthropic's terms).",
                      )
                    : t(
                        "OpenCode's own free models, as your installed OpenCode uses them: no account, no key. The test lists them. Free models may use what they are sent to improve; see OpenCode Zen's terms.",
                      )}
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Switch id="own" checked={ownProvider} onCheckedChange={setOwnProvider} />
                  <Label htmlFor="own" className="font-normal">
                    {t("Use another provider, with its API key")}
                  </Label>
                </div>
                {ownProvider ? (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1.5">
                        <Label htmlFor="op">{t("Provider id")}</Label>
                        <Input
                          id="op"
                          className="font-mono"
                          value={providerID}
                          onChange={(e) => setProviderID(e.target.value.toLowerCase())}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="ou">{t("Endpoint (OpenAI-compatible)")}</Label>
                        <Input
                          id="ou"
                          className="font-mono"
                          value={ocBaseURL}
                          onChange={(e) => setOcBaseURL(e.target.value)}
                        />
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="om">{t("Models, by their id at the provider")}</Label>
                      <Input
                        id="om"
                        className="font-mono"
                        value={models}
                        onChange={(e) => setModels(e.target.value)}
                        placeholder="qwen/qwen3-coder, deepseek/deepseek-chat"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="ok">{t("API key")}</Label>
                      <Input
                        id="ok"
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                      />
                    </div>
                  </>
                ) : null}
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="lu">{t("Server URL")}</Label>
                  <Input
                    id="lu"
                    className="font-mono"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="lk">{t("API key, if the server needs one")}</Label>
                  <Input
                    id="lk"
                    type="password"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                  />
                </div>
              </>
            )}
            <ErrorNote error={error} />
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button
              onClick={() => {
                onOpenChange(false);
                setResult(null);
              }}
            >
              {t("Done")}
            </Button>
          ) : (
            <>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                {t("Cancel")}
              </Button>
              <Button disabled={!name || busy} onClick={create}>
                {busy ? t("Testing…") : name ? t("Add and test") : t("Give it a name")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
