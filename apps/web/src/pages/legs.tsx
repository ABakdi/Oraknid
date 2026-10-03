import type { LegView } from "@oraknid/contracts";
import { Bot, ChevronRight, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AddLeg } from "@/components/add-leg";
import { Empty, ErrorNote, Loading, PageHeader, StateBadge } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { FindAgents } from "@/components/find-agents";
import { LegLogin } from "@/components/leg-login";
import { LegPlanUsageDetail } from "@/components/plan-usage";
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

export function LegsPage({ focus }: { focus?: string } = {}) {
  const legs = useLive(() => api.legs.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("leg."),
  });
  const [adding, setAdding] = useState(false);
  // Collapsed to one line by default; the Leg I came for is open (Web-UI → Legs).
  const [open, setOpen] = useState<Set<string>>(() => new Set(focus ? [focus] : []));
  const toggle = (id: string) =>
    setOpen((o) => {
      const n = new Set(o);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  useEffect(() => {
    if (!focus || legs.loading) return;
    document.getElementById(`leg-${focus}`)?.scrollIntoView({ block: "start" });
  }, [focus, legs.loading]);
  const [profile, setProfile] = useState<{ leg: LegView; modelId: string } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const { confirm, dialog } = useConfirm();
  if (legs.error) return <ErrorNote error={legs.error} />;
  if (legs.loading) return <Loading />;
  const add = (
    <Button data-help="legs.add" className="gap-1" onClick={() => setAdding(true)}>
      <Plus className="size-4" />
      {t("Add a Leg")}
    </Button>
  );
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("Legs")}
        back={focus ? { fallback: "/legs" } : undefined}
        sub={t("Agent accounts and local models Oraknid can hand work to.")}
        actions={
          <>
            <FindAgents />
            {add}
          </>
        }
      />
      {(legs.data ?? []).length === 0 ? (
        <Empty
          title={t("No Legs yet")}
          action={
            <>
              <FindAgents />
              {add}
            </>
          }
        >
          {t(
            "Let Oraknid find the agents on this machine, or add one by hand: a Claude Code or Antigravity account, OpenCode, or an OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM). Any number of each; none is required.",
          )}
        </Empty>
      ) : null}
      {(legs.data ?? []).map((leg) => (
        <Card key={leg.id} id={`leg-${leg.id}`} className="scroll-mt-4 gap-0 py-0">
          <CardHeader className="py-3">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              <button
                data-help="legs.card"
                type="button"
                className="flex min-w-0 flex-1 items-center gap-2 text-left"
                aria-expanded={open.has(leg.id)}
                onClick={() => toggle(leg.id)}
              >
                <ChevronRight
                  className={`size-4 shrink-0 transition-transform ${open.has(leg.id) ? "rotate-90" : ""}`}
                />
                <Bot className="size-4 shrink-0" />
                <span className="truncate" title={leg.name}>
                  {leg.name}
                </span>
                <StateBadge state={leg.paused ? "paused" : leg.health} />
                <Badge variant="outline" className="hidden sm:inline-flex">
                  {leg.kind}
                </Badge>
                {open.has(leg.id) ? null : (
                  <span className="hidden min-w-0 truncate text-xs font-normal text-muted-foreground md:inline">
                    {leg.healthDetail}
                  </span>
                )}
              </button>
              {(leg.kind === "claude-code" || leg.kind === "antigravity") &&
              leg.health !== "healthy" ? (
                <LegLogin legId={leg.id} legName={leg.name} kind={leg.kind} />
              ) : null}
            </CardTitle>
          </CardHeader>
          {open.has(leg.id) ? (
            <CardContent className="space-y-3 border-t pt-3 pb-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{leg.remote ? t("remote") : t("local")}</Badge>
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
                <Select
                  value={String((leg.config as { maxSessions?: number }).maxSessions ?? 1)}
                  onValueChange={(v) =>
                    act(() => api.legs.update({ id: leg.id, maxSessions: Number(v) }))
                  }
                >
                  <SelectTrigger className="h-8 w-36 text-xs" aria-label={t("Sessions at once")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4].map((n) => (
                      <SelectItem key={n} value={String(n)}>
                        {t("{n} at once", { n })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                {(leg.kind === "claude-code" || leg.kind === "antigravity") &&
                leg.health === "healthy" ? (
                  <LegLogin legId={leg.id} legName={leg.name} kind={leg.kind} />
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    act(
                      () =>
                        leg.paused
                          ? api.legs.resume({ id: leg.id })
                          : api.legs.pause({ id: leg.id }),
                      leg.paused
                        ? t("Resumed.")
                        : t(
                            "Paused: its running sessions stopped at a safe point; their tasks wait for it.",
                          ),
                    )
                  }
                >
                  {leg.paused ? t("Resume") : t("Pause")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming({ id: leg.id, name: leg.name })}
                >
                  {t("Rename")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-destructive"
                  onClick={async () => {
                    if (
                      await confirm(
                        t("Remove “{name}”?", { name: leg.name }),
                        t(
                          "Oraknid stops handing it work and forgets it, with its models and its secret. A folder it logs in from stays on disk.",
                        ),
                        t("Remove"),
                        { keep: t("Keep it") },
                      )
                    )
                      void act(() => api.legs.remove({ id: leg.id }), t("Removed."));
                  }}
                >
                  {t("Remove")}
                </Button>
              </div>
              {renaming?.id === leg.id ? (
                <form
                  className="flex min-w-0 flex-wrap gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!renaming.name.trim()) return;
                    void act(
                      () => api.legs.update({ id: leg.id, name: renaming.name.trim() }),
                      t("Renamed."),
                    ).then(() => setRenaming(null));
                  }}
                >
                  <Input
                    className="h-8 min-w-40 flex-1"
                    aria-label={t("Name")}
                    autoFocus
                    value={renaming.name}
                    onChange={(e) => setRenaming({ id: leg.id, name: e.target.value })}
                    onKeyDown={(e) => e.key === "Escape" && setRenaming(null)}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    type="button"
                    onClick={() => setRenaming(null)}
                  >
                    {t("Cancel")}
                  </Button>
                  <Button size="sm" type="submit" disabled={!renaming.name.trim()}>
                    {t("Save")}
                  </Button>
                </form>
              ) : null}
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
              <LegPlanUsageDetail legId={leg.id} />
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
                          <TableCell className="text-xs">
                            {t("{n} attempts", { n: seen })}
                          </TableCell>
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
          ) : null}
        </Card>
      ))}
      <AddLeg open={adding} onOpenChange={setAdding} />
      {dialog}
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
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={save}>{t("Save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
