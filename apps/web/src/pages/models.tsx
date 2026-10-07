import type {
  CatalogEntry,
  CatalogFile,
  LocalModelView,
  ModelKind,
  ModelRole,
  ModelsStatus,
} from "@oraknid/contracts";
import { Cpu, Download, Pause, Play, Power, PowerOff, Search, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading, PageHeader, Stat } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const ROLES: { role: ModelRole; label: string; does: string }[] = [
  { role: "translate", label: "Translate", does: "the translate tool" },
  { role: "ocr", label: "OCR / vision", does: "the ocr tool: text from images" },
  { role: "transcribe", label: "Speech to text", does: "the transcribe tool (whisper.cpp)" },
  { role: "embed", label: "Embeddings", does: "the embed tool" },
  { role: "mail", label: "Mail", does: "sorting and summarising mail" },
  { role: "code", label: "Simple code", does: "simple coding steps" },
  { role: "general", label: "General", does: "everything else" },
];

const ROLE_KIND: Record<ModelRole, ModelKind> = {
  translate: "text",
  ocr: "vision",
  transcribe: "speech",
  embed: "embedding",
  mail: "text",
  code: "text",
  general: "text",
};

const KIND_LABEL: Record<ModelKind, string> = {
  text: "text",
  vision: "vision",
  speech: "speech",
  embedding: "embedding",
};

const isModelEvent = (e: { type: string }) => e.type.startsWith("model.");

/**
 * Local models (ADR-054, Web-UI → Models): what is on this computer and
 * running, finding and downloading more, and the roles every agent's
 * tools use. Nothing leaves the machine.
 */
export function ModelsPage() {
  const status = useLive(() => api.models.status(), {
    topics: ["overview"],
    refreshOn: isModelEvent,
  });
  const list = useLive(() => api.models.list(), {
    topics: ["overview"],
    refreshOn: isModelEvent,
  });
  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title={t("Models")}
        sub={t(
          "Models on this computer: find, download and run them, and give them roles every agent can use. Nothing leaves the machine.",
        )}
      />
      {list.error ? <ErrorNote error={list.error} className="mb-4" /> : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          <InstalledCard models={list.data} status={status.data} />
          <FindCard />
        </div>
        <div className="space-y-4">
          <MachineCard status={status.data} />
          <RolesCard status={status.data} models={list.data ?? []} />
        </div>
      </div>
    </div>
  );
}

function InstalledCard({
  models,
  status,
}: {
  models: LocalModelView[] | undefined;
  status: ModelsStatus | undefined;
}) {
  return (
    <Card data-help="models.list">
      <CardHeader>
        <CardTitle>{t("On this computer")}</CardTitle>
        <CardDescription>
          {t(
            "Each loaded chat model is a model of the Local Leg, so The Eye can hand it work. Loading waits for room: the GPU stays under 90% and memory keeps its floor.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!models ? (
          <Loading rows={2} />
        ) : models.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t("No models yet: find one below and download it.")}
          </div>
        ) : (
          models.map((m) => <ModelRow key={m.id} m={m} status={status} />)
        )}
      </CardContent>
    </Card>
  );
}

function ModelRow({ m, status }: { m: LocalModelView; status: ModelsStatus | undefined }) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const run = async (what: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await what();
      if (done) toast.success(done);
    } catch (error) {
      toast.error(message(error));
    } finally {
      setBusy(false);
    }
  };
  const d = m.download;
  const pct = d?.totalBytes ? Math.round((d.doneBytes / d.totalBytes) * 100) : 0;
  const chat = m.kinds.includes("text") || m.kinds.includes("vision");
  const loadable = chat || m.kinds.includes("embedding");
  return (
    <div className="space-y-2 rounded-md border px-3 py-2.5 text-sm">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium break-all">{m.name}</span>
        <Badge
          variant={
            m.state === "loaded" ? "default" : m.state === "failed" ? "destructive" : "outline"
          }
        >
          {t(m.state)}
        </Badge>
        {m.kinds.map((k) => (
          <Badge key={k} variant="secondary">
            {t(KIND_LABEL[k])}
          </Badge>
        ))}
        <span className="text-xs text-muted-foreground">
          {[m.runner, m.quant, bytes(m.sizeBytes)].filter(Boolean).join(" · ")}
        </span>
        {m.roles.length ? (
          <span className="text-xs text-muted-foreground">
            {t("Roles: {r}", { r: m.roles.join(", ") })}
          </span>
        ) : null}
      </div>
      {m.error ? <div className="text-xs text-destructive">{m.error}</div> : null}
      {d ? (
        <div className="space-y-1" data-help="models.progress">
          <Progress value={pct} />
          <div className="text-xs text-muted-foreground">
            {t("{done} of {total} ({pct}%)", {
              done: bytes(d.doneBytes),
              total: bytes(d.totalBytes),
              pct,
            })}
            {d.bytesPerSec > 0 ? ` · ${bytes(d.bytesPerSec)}/s` : ""}
          </div>
        </div>
      ) : null}
      {m.loaded ? (
        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label={t("Speed")} value={m.tokensPerSec ? `${m.tokensPerSec} t/s` : "—"} />
          <Stat label={t("VRAM")} value={m.loaded.vramBytes ? bytes(m.loaded.vramBytes) : "—"} />
          <Stat label={t("Memory")} value={m.loaded.rssBytes ? bytes(m.loaded.rssBytes) : "—"} />
          <Stat
            label={t("Context")}
            value={m.loaded.contextSize ? m.loaded.contextSize.toLocaleString() : "—"}
            hint={
              m.loaded.gpuLayers === null
                ? undefined
                : m.loaded.gpuLayers >= 999
                  ? t("all layers on the GPU")
                  : t("{n} layers on the GPU", { n: m.loaded.gpuLayers })
            }
          />
        </div>
      ) : m.tokensPerSec ? (
        <div className="text-xs text-muted-foreground">
          {t("Measured at {n} tokens/s", { n: m.tokensPerSec })}
          {m.toolCalls === "none" ? ` · ${t("doesn't call tools: text work only")}` : ""}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {m.state === "downloading" ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            disabled={busy}
            onClick={() => run(() => api.models.pause({ id: m.id }))}
          >
            <Pause className="size-3.5" />
            {t("Pause")}
          </Button>
        ) : null}
        {m.state === "paused" || m.state === "failed" ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            disabled={busy}
            onClick={() => run(() => api.models.resume({ id: m.id }))}
          >
            <Play className="size-3.5" />
            {t("Resume download")}
          </Button>
        ) : null}
        {m.state === "ready" && loadable ? (
          <Button
            size="sm"
            className="gap-1"
            data-help="models.load"
            disabled={busy}
            onClick={() =>
              run(() => api.models.load({ id: m.id }), t("{name} is loaded.", { name: m.name }))
            }
          >
            <Power className="size-3.5" />
            {t("Load")}
          </Button>
        ) : null}
        {m.state === "loading" ? (
          <Button size="sm" disabled>
            {t("Loading…")}
          </Button>
        ) : null}
        {m.state === "loaded" ? (
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            disabled={busy}
            onClick={() => run(() => api.models.unload({ id: m.id }))}
          >
            <PowerOff className="size-3.5" />
            {t("Unload")}
          </Button>
        ) : null}
        {loadable && (m.state === "ready" || m.state === "loaded") ? <RunSettings m={m} /> : null}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1 text-muted-foreground"
          data-help="models.remove"
          disabled={busy}
          onClick={async () => {
            const inOllama = m.runner === "ollama";
            if (
              await confirm(
                t("Remove {name}?", { name: m.name }),
                inOllama
                  ? t("It leaves Oraknid's list; it stays in Ollama (ollama rm removes it there).")
                  : t("Its files ({size}) are deleted from {dir}.", {
                      size: bytes(m.sizeBytes),
                      dir: status?.dir ?? t("the models folder"),
                    }),
                t("Remove"),
              )
            )
              await run(() => api.models.remove({ id: m.id }));
          }}
        >
          <Trash2 className="size-3.5" />
          {t("Remove")}
        </Button>
      </div>
    </div>
  );
}

/** Keep loaded, idle minutes, context and GPU layers: automatic unless I set them. */
function RunSettings({ m }: { m: LocalModelView }) {
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState(
    m.settings.contextSize === "auto" ? "" : String(m.settings.contextSize),
  );
  const [layers, setLayers] = useState(
    m.settings.gpuLayers === "auto" ? "" : String(m.settings.gpuLayers),
  );
  const [idle, setIdle] = useState(String(m.settings.idleMinutes));
  const save = async (patch: Parameters<typeof api.models.settings>[0]) => {
    try {
      await api.models.settings(patch);
    } catch (error) {
      toast.error(message(error));
    }
  };
  if (!open)
    return (
      <Button size="sm" variant="ghost" data-help="models.settings" onClick={() => setOpen(true)}>
        {t("Settings")}
      </Button>
    );
  return (
    <div
      className="mt-1 grid w-full gap-3 rounded-md border bg-muted/30 p-3 sm:grid-cols-2"
      data-help="models.settings"
    >
      <div className="flex items-center gap-2">
        <Switch
          id={`keep-${m.id}`}
          checked={m.settings.keepLoaded}
          onCheckedChange={(v) => save({ id: m.id, keepLoaded: v })}
        />
        <Label htmlFor={`keep-${m.id}`}>{t("Keep loaded")}</Label>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`idle-${m.id}`}>{t("Unload after idle minutes (0: never)")}</Label>
        <Input
          id={`idle-${m.id}`}
          inputMode="numeric"
          value={idle}
          onChange={(e) => setIdle(e.target.value)}
          onBlur={() => save({ id: m.id, idleMinutes: Math.max(0, Number(idle) || 0) })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`ctx-${m.id}`}>{t("Context (empty: automatic)")}</Label>
        <Input
          id={`ctx-${m.id}`}
          inputMode="numeric"
          placeholder={t("automatic")}
          value={ctx}
          onChange={(e) => setCtx(e.target.value)}
          onBlur={() => save({ id: m.id, contextSize: ctx.trim() ? Number(ctx) : "auto" })}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`ngl-${m.id}`}>{t("GPU layers (empty: automatic)")}</Label>
        <Input
          id={`ngl-${m.id}`}
          inputMode="numeric"
          placeholder={t("automatic")}
          value={layers}
          onChange={(e) => setLayers(e.target.value)}
          onBlur={() => save({ id: m.id, gpuLayers: layers.trim() ? Number(layers) : "auto" })}
        />
      </div>
      <div className="text-xs text-muted-foreground sm:col-span-2">
        {t("Context and GPU layers apply the next time it loads.")}
      </div>
    </div>
  );
}

function FindCard() {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "huggingface" | "ollama">("all");
  const [kind, setKind] = useState<ModelKind | "any">("any");
  const [fitsOnly, setFitsOnly] = useState(true);
  const [found, setFound] = useState<{ entries: CatalogEntry[]; problems: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [searching, setSearching] = useState(false);
  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    setSearching(true);
    setError(null);
    try {
      setFound(
        await api.models.search({
          query,
          source,
          fitsOnly,
          limit: 20,
          ...(kind === "any" ? {} : { kind }),
        }),
      );
    } catch (err) {
      setError(err);
    } finally {
      setSearching(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Find a model")}</CardTitle>
        <CardDescription>
          {t(
            "Hugging Face's GGUF models and Ollama's library, each file with its size, quantisation and whether it fits this computer.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <form className="flex flex-wrap items-end gap-2" onSubmit={search}>
          <div className="min-w-48 flex-1">
            <Input
              data-help="models.search"
              aria-label={t("Search models")}
              placeholder={t("qwen coder, llama 3.2, whisper, embed…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Select value={source} onValueChange={(v) => setSource(v as typeof source)}>
            <SelectTrigger className="w-40" data-help="models.source" aria-label={t("Where")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("Everywhere")}</SelectItem>
              <SelectItem value="huggingface">{t("Hugging Face")}</SelectItem>
              <SelectItem value="ollama">{t("Ollama library")}</SelectItem>
            </SelectContent>
          </Select>
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger className="w-36" aria-label={t("Good at")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">{t("Any kind")}</SelectItem>
              <SelectItem value="text">{t("Text")}</SelectItem>
              <SelectItem value="vision">{t("Vision")}</SelectItem>
              <SelectItem value="speech">{t("Speech")}</SelectItem>
              <SelectItem value="embedding">{t("Embedding")}</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center gap-2 py-2">
            <Switch
              id="fits-only"
              data-help="models.fits"
              checked={fitsOnly}
              onCheckedChange={setFitsOnly}
            />
            <Label htmlFor="fits-only">{t("Fits this computer")}</Label>
          </div>
          <Button type="submit" className="gap-1" disabled={searching}>
            <Search className="size-3.5" />
            {searching ? t("Searching…") : t("Search")}
          </Button>
        </form>
        <ErrorNote error={error} />
        {found?.problems.map((p) => (
          <div key={p} className="text-xs text-muted-foreground">
            {p}
          </div>
        ))}
        {found && found.entries.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("Nothing found.")}</div>
        ) : null}
        <div className="space-y-3" data-help="models.results">
          {found?.entries.map((e) => (
            <EntryRow key={`${e.source}:${e.id}`} e={e} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function EntryRow({ e }: { e: CatalogEntry }) {
  const { confirm, dialog } = useConfirm();
  const take = async (f: CatalogFile) => {
    const license = e.license ?? t("not given: see the model's page");
    if (
      !(await confirm(
        t("Download {name}?", { name: `${e.name} ${f.quant ?? f.name}` }),
        <div className="space-y-2">
          <div>{t("Licence: {l}", { l: license })}</div>
          <div>{f.sizeBytes ? t("Size: {s}", { s: bytes(f.sizeBytes) }) : null}</div>
          <div className="text-muted-foreground">{f.fit.note}</div>
        </div>,
        t("Download"),
        { safe: true },
      ))
    )
      return;
    try {
      await api.models.download({ source: e.source, repo: e.id, file: f.name });
      toast.success(t("Downloading {name}.", { name: e.name }));
    } catch (error) {
      toast.error(message(error));
    }
  };
  return (
    <div className="space-y-2 rounded-md border px-3 py-2.5 text-sm">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <a
          className="font-medium break-all hover:underline"
          href={e.url}
          target="_blank"
          rel="noreferrer"
        >
          {e.id}
        </a>
        <Badge variant="outline">{e.source === "huggingface" ? "Hugging Face" : "Ollama"}</Badge>
        {e.kinds.map((k) => (
          <Badge key={k} variant="secondary">
            {t(KIND_LABEL[k])}
          </Badge>
        ))}
        {e.license ? <span className="text-xs text-muted-foreground">{e.license}</span> : null}
        {e.downloads ? (
          <span className="text-xs text-muted-foreground">
            {t("{n} downloads", { n: e.downloads.toLocaleString() })}
          </span>
        ) : null}
      </div>
      {e.description ? <div className="text-xs text-muted-foreground">{e.description}</div> : null}
      <div className="space-y-1">
        {e.files.map((f) => (
          <div key={f.name} className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono">{f.quant ?? f.name}</span>
            <span className="text-muted-foreground">{f.sizeBytes ? bytes(f.sizeBytes) : "?"}</span>
            <Badge
              variant={
                f.fit.fits === "yes" ? "default" : f.fit.fits === "no" ? "destructive" : "outline"
              }
              title={f.fit.note}
            >
              {f.fit.fits === "yes"
                ? f.fit.runsOn === "gpu"
                  ? t("fits the GPU")
                  : t("fits")
                : f.fit.fits === "tight"
                  ? f.fit.runsOn === "split"
                    ? t("GPU and memory")
                    : t("CPU, slow")
                  : f.fit.fits === "no"
                    ? t("too big")
                    : t("size unknown")}
            </Badge>
            <Button
              size="sm"
              variant="ghost"
              className="ml-auto h-7 gap-1"
              data-help="models.download"
              disabled={f.fit.fits === "no"}
              onClick={() => take(f)}
            >
              <Download className="size-3.5" />
              {t("Download")}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}

function MachineCard({ status }: { status: ModelsStatus | undefined }) {
  if (!status) return <Loading rows={2} />;
  const r = status.runtimes;
  return (
    <Card data-help="models.machine">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cpu className="size-4" />
          {t("This computer")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {status.machine.gpus.length ? (
          status.machine.gpus.map((g) => (
            <div key={g.name}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{g.name}</span>
                <span className="text-muted-foreground">
                  {bytes(g.usedBytes)} / {bytes(g.totalBytes)}
                </span>
              </div>
              <Progress value={g.totalBytes ? (g.usedBytes / g.totalBytes) * 100 : 0} />
            </div>
          ))
        ) : (
          <div className="text-muted-foreground">{t("No GPU seen: models run on the CPU.")}</div>
        )}
        <div className="flex justify-between gap-2">
          <span>{t("Memory free")}</span>
          <span className="text-muted-foreground">
            {bytes(status.machine.memoryAvailableBytes)} / {bytes(status.machine.memoryTotalBytes)}
          </span>
        </div>
        <div className="flex justify-between gap-2">
          <span>{t("Models take")}</span>
          <span className="text-muted-foreground">{bytes(status.usedBytes)}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span>{t("Disk free")}</span>
          <span className={status.diskLow ? "text-destructive" : "text-muted-foreground"}>
            {status.diskFreeBytes === null ? "—" : bytes(status.diskFreeBytes)}
          </span>
        </div>
        {status.diskLow ? (
          <div className="text-xs text-destructive">
            {t("The disk is under its floor: downloads wait until there is room.")}
          </div>
        ) : null}
        <div className="space-y-1 border-t pt-2 text-xs">
          <Runtime name="llama-server" at={r.llamaServer} />
          <Runtime name="Ollama" at={r.ollama} />
          <Runtime name="whisper.cpp" at={r.whisper} />
          {!r.llamaServer ? (
            <div className="text-muted-foreground">
              {t("Install llama.cpp with")}{" "}
              <code className="font-mono">install.sh --local-models</code>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function Runtime({ name, at }: { name: string; at: string | null }) {
  return (
    <div className="flex justify-between gap-2">
      <span>{name}</span>
      <span className="truncate text-muted-foreground" title={at ?? undefined}>
        {at ? t("found") : t("not installed")}
      </span>
    </div>
  );
}

function RolesCard({
  status,
  models,
}: {
  status: ModelsStatus | undefined;
  models: LocalModelView[];
}) {
  if (!status) return null;
  const set = async (role: ModelRole, id: string | null) => {
    try {
      await api.models.setRole({ role, id });
    } catch (error) {
      toast.error(message(error));
    }
  };
  return (
    <Card data-help="models.roles">
      <CardHeader>
        <CardTitle>{t("Roles")}</CardTitle>
        <CardDescription>
          {t(
            "Which model does what. Every agent may call these through the local-models tool, so Claude can hand OCR or a translation to a model here.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ROLES.map(({ role, label, does }) => {
          const kind = ROLE_KIND[role];
          const fit = models.filter(
            (m) =>
              (m.state === "ready" || m.state === "loaded") &&
              (m.kinds.includes(kind) || (kind === "text" && m.kinds.includes("vision"))),
          );
          const current = status.roles[role];
          return (
            <div key={role} className="space-y-1">
              <Label>{t(label)}</Label>
              <Select
                value={current ?? "none"}
                onValueChange={(v) => set(role, v === "none" ? null : v)}
                disabled={!fit.length}
              >
                <SelectTrigger className="w-full" aria-label={t(label)}>
                  <SelectValue placeholder={t("No model yet")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {fit.length ? t("Suggested") : t("No model yet")}
                  </SelectItem>
                  {fit.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="text-xs text-muted-foreground">{t(does)}</div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
