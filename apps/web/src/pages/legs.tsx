import type { LegView } from "@oraknid/contracts";
import { Bot, Plus, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Empty, ErrorNote, Loading, PageHeader, StateBadge } from "@/components/common";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api, message } from "@/lib/api";
import { bytes, tokens, until } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const CAPS = [
  "planning",
  "architecture",
  "implementation",
  "debugging",
  "refactor",
  "tests",
  "review",
  "docs",
  "mechanical",
  "summarize",
  "classify",
  "ui",
] as const;

async function act(fn: () => Promise<unknown>, ok?: string) {
  try {
    await fn();
    if (ok) toast.success(ok);
  } catch (e) {
    toast.error(message(e));
  }
}

export function LegsPage() {
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const [adding, setAdding] = useState(false);
  const [profile, setProfile] = useState<{ leg: LegView; modelId: string } | null>(null);
  if (legs.error) return <ErrorNote error={legs.error} />;
  if (legs.loading) return <Loading />;
  const add = (
    <Button className="gap-1" onClick={() => setAdding(true)}>
      <Plus className="size-4" />
      {t("Add a Leg")}
    </Button>
  );
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("Legs")}
        sub={t("Agent accounts and local models Oraknid can hand work to.")}
        actions={add}
      />
      {(legs.data ?? []).length === 0 ? (
        <Empty title={t("No Legs yet")} action={add}>
          {t(
            "Add a Claude Code account or an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). Any number of each; none is required.",
          )}
        </Empty>
      ) : null}
      {(legs.data ?? []).map((leg) => (
        <Card key={leg.id}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <Bot className="size-4" />
              {leg.name}
              <StateBadge state={leg.paused ? "paused" : leg.health} />
              <Badge variant="outline">{leg.kind}</Badge>
              <Badge variant="outline">{leg.remote ? t("remote") : t("local")}</Badge>
              <span className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                className="gap-1"
                onClick={() => act(() => api.legs.test({ id: leg.id }), t("Tested."))}
              >
                <RefreshCw className="size-3.5" />
                {t("Test")}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  act(() =>
                    leg.paused ? api.legs.resume({ id: leg.id }) : api.legs.pause({ id: leg.id }),
                  )
                }
              >
                {leg.paused ? t("Resume") : t("Pause")}
              </Button>
              <label
                htmlFor={`enabled-${leg.id}`}
                className="flex items-center gap-1.5 text-xs font-normal"
              >
                <Switch
                  id={`enabled-${leg.id}`}
                  checked={leg.enabled}
                  onCheckedChange={(v) => act(() => api.legs.update({ id: leg.id, enabled: v }))}
                />
                {t("enabled")}
              </label>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="text-muted-foreground">
              {leg.healthDetail}
              {leg.limitedUntil
                ? ` ${t("Usable again {when}.", { when: until(leg.limitedUntil) })}`
                : ""}
            </div>
            {leg.setupHint ? (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 font-mono text-xs [overflow-wrap:anywhere]">
                {leg.setupHint}
              </div>
            ) : null}
            {leg.quota.length ? (
              <div className="flex flex-wrap gap-2 text-xs">
                {leg.quota.map((w) => (
                  <Badge key={w.name} variant="secondary">
                    {w.name}:{" "}
                    {w.utilization === null
                      ? t("no figure")
                      : `${Math.round(w.utilization * 100)}%`}
                    {w.estimated ? ` ${t("(estimated)")}` : ""}
                    {w.resetsAt ? ` · ${until(w.resetsAt)}` : ""}
                  </Badge>
                ))}
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("Model")}</TableHead>
                    <TableHead>{t("Best at")}</TableHead>
                    <TableHead>{t("Takes")}</TableHead>
                    <TableHead>{t("Quota cost")}</TableHead>
                    <TableHead>{t("Seen")}</TableHead>
                    <TableHead>{t("Shown")}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leg.models.map((m) => {
                    const best = Object.entries(m.profile.strengths)
                      .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
                      .slice(0, 3)
                      .map(([k]) => k);
                    const seen = Object.values(m.profile.observed).reduce(
                      (n, o) => n + (o?.attempts ?? 0),
                      0,
                    );
                    return (
                      <TableRow key={m.id} className={m.hidden ? "opacity-50" : ""}>
                        <TableCell className="font-medium">
                          {m.displayName}
                          {m.effortLevels.length ? (
                            <div className="text-xs text-muted-foreground">
                              {m.effortLevels.join(" · ")}
                            </div>
                          ) : null}
                          {m.vramBytes ? (
                            <div className="text-xs text-muted-foreground">
                              VRAM {bytes(m.vramBytes)}
                            </div>
                          ) : null}
                        </TableCell>
                        <TableCell className="text-xs">{best.join(", ")}</TableCell>
                        <TableCell className="text-xs">
                          {t("up to {d}", { d: m.profile.maxDifficulty })}
                        </TableCell>
                        <TableCell className="text-xs">×{m.profile.quotaWeight}</TableCell>
                        <TableCell className="text-xs">{t("{n} attempts", { n: seen })}</TableCell>
                        <TableCell>
                          <Switch
                            checked={!m.hidden}
                            onCheckedChange={(v) =>
                              act(() => api.legs.setModelHidden({ modelId: m.id, hidden: !v }))
                            }
                            aria-label={t("Shown to routing")}
                          />
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setProfile({ leg, modelId: m.id })}
                          >
                            {t("Profile")}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ))}
      <AddLeg open={adding} onOpenChange={setAdding} />
      {profile ? (
        <ProfileEditor
          leg={profile.leg}
          modelId={profile.modelId}
          onClose={() => setProfile(null)}
        />
      ) : null}
    </div>
  );
}

function AddLeg({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [kind, setKind] = useState<"claude-code" | "openai-compatible">("claude-code");
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
      <DialogContent>
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
            {result.setupHint ? (
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
                  kind === "claude-code" ? t("Claude — personal") : t("Ollama on this machine")
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
            <Button disabled={!name || busy} onClick={create}>
              {busy ? t("Testing…") : name ? t("Add and test") : t("Give it a name")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Learned values next to my overrides, which always win (Legs → Capability profile). */
function ProfileEditor({
  leg,
  modelId,
  onClose,
}: {
  leg: LegView;
  modelId: string;
  onClose: () => void;
}) {
  const model = leg.models.find((m) => m.id === modelId);
  const [over, setOver] = useState<Record<string, string>>({});
  const [weight, setWeight] = useState("");
  const [window5h, setWindow5h] = useState("");
  if (!model) return null;
  const p = model.profile;
  const save = () => {
    const strengths = Object.fromEntries(
      Object.entries(over)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => [k, Number(v)]),
    );
    return act(
      () =>
        api.legs.setProfile({
          modelId,
          overrides: {
            ...(Object.keys(strengths).length ? { strengths } : {}),
            ...(weight ? { quotaWeight: Number(weight) } : {}),
            ...(window5h
              ? { windowLimits: { ...p.windowLimits, five_hour: Number(window5h) } }
              : {}),
          },
        }),
      t("Saved; routing uses it from the next task."),
    ).then(onClose);
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {leg.name} · {model.displayName}
          </DialogTitle>
          <DialogDescription>
            {t(
              "Strengths 0–5. Learned moves at most half a point per 20 attempts. Your value wins.",
            )}
          </DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("Capability")}</TableHead>
              <TableHead>{t("Learned")}</TableHead>
              <TableHead>{t("Now")}</TableHead>
              <TableHead>{t("Mine")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {CAPS.map((c) => (
              <TableRow key={c}>
                <TableCell>{t(c)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {p.learned[c] ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums">{p.strengths[c] ?? "—"}</TableCell>
                <TableCell>
                  <Input
                    className="h-7 w-16"
                    inputMode="decimal"
                    value={over[c] ?? ""}
                    placeholder="—"
                    onChange={(e) => setOver({ ...over, [c]: e.target.value })}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="qw">{t("Quota cost (now ×{w})", { w: p.quotaWeight })}</Label>
            <Input
              id="qw"
              inputMode="decimal"
              value={weight}
              onChange={(e) => setWeight(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="w5">{t("5-hour window, in tokens (for estimates)")}</Label>
            <Input
              id="w5"
              inputMode="numeric"
              placeholder={
                p.windowLimits.five_hour ? tokens(p.windowLimits.five_hour) : t("unknown")
              }
              value={window5h}
              onChange={(e) => setWindow5h(e.target.value.replace(/\D/g, ""))}
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={save}>{t("Save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
