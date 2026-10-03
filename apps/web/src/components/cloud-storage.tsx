import type {
  CloudAuthorization,
  CloudEntry,
  CloudPlacement,
  CloudProviderView,
  CloudTransfer,
  NewCloudProvider,
  S3Preset,
} from "@oraknid/contracts";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  Cloud,
  Download,
  ExternalLink,
  File as FileIcon,
  Folder,
  FolderPlus,
  HardDrive,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { fetchDownload } from "@/components/backups";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { live, useLive } from "@/lib/live";
import { remote } from "@/lib/remote";
import { UploadError, uploadFile } from "@/lib/upload";

// Cloud storage (ADR-046, Web-UI → Cloud storage): my providers, the pool
// as one listing, uploads with their progress, where uploads go.

const act = (p: Promise<unknown>, ok?: string) =>
  p.then(() => ok && toast.success(ok)).catch((e) => toast.error(message(e)));

const KIND_NAMES: Record<CloudProviderView["kind"], string> = {
  s3: "Object storage (S3)",
  drive: "Google Drive",
  dropbox: "Dropbox",
  mega: "MEGA",
};

const GiB = 1 << 30;

export function useProviders() {
  return useLive(() => api.cloud.providers(), {
    topics: ["storage"],
    refreshOn: (e) => e.type.startsWith("cloud.provider") || e.type.startsWith("cloud.file"),
  });
}

/** The pool's path in the address: /storage/a/b → "a/b". */
export const poolHref = (path: string) =>
  path ? `/storage/${path.split("/").map(encodeURIComponent).join("/")}` : "/storage";

// ── Providers

function SpaceBar({ p }: { p: CloudProviderView }) {
  const total = p.totalBytes;
  const used = p.usedBytes ?? 0;
  return (
    <div className="space-y-1">
      {total ? (
        <Progress value={Math.min(100, (used / total) * 100)} aria-label={t("Used space")} />
      ) : null}
      <div className="text-xs text-muted-foreground">
        {p.unlimited
          ? t("{used} used · pay as you go, no limit", { used: bytes(used) })
          : p.freeBytes !== null
            ? t("{used} used · {free} free{of}", {
                used: bytes(used),
                free: bytes(p.freeBytes),
                of: total ? ` ${t("of {total}", { total: bytes(total) })}` : "",
              })
            : p.usedBytes !== null
              ? t("{used} used · free space unknown: used only when picked", { used: bytes(used) })
              : t("Not checked yet")}
      </div>
    </div>
  );
}

export function ProvidersCard({ providers }: { providers: CloudProviderView[] }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CloudProviderView | null>(null);
  const { confirm, dialog } = useConfirm();
  return (
    <Card data-help="storage.providers">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle>{t("Providers")}</CardTitle>
          <CardDescription>
            {t("Your storage accounts. Their keys stay in Oraknid's encrypted rclone config.")}
          </CardDescription>
        </div>
        <Button
          size="sm"
          className="gap-1"
          data-help="storage.add-provider"
          onClick={() => setAdding(true)}
        >
          <Plus className="size-3.5" />
          {t("Add a provider")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {providers.length === 0 ? (
          <div className="text-sm text-muted-foreground">
            {t(
              "None yet. Add Google Drive, Dropbox, MEGA or any S3-compatible storage (MinIO, AWS, R2, B2, Wasabi).",
            )}
          </div>
        ) : null}
        {providers.map((p) => (
          <div key={p.id} className="space-y-2 rounded-md border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{p.name}</span>
              <Badge variant="outline">{KIND_NAMES[p.kind]}</Badge>
              {p.error ? <Badge variant="destructive">{t("not answering")}</Badge> : null}
              <span className="ml-auto flex items-center gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Check {name}", { name: p.name })}
                  title={t("Check used and free space")}
                  onClick={() => act(api.cloud.checkProvider({ id: p.id }), t("Checked."))}
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Edit {name}", { name: p.name })}
                  onClick={() => setEditing(p)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={t("Remove {name}", { name: p.name })}
                  onClick={async () => {
                    if (
                      !(await confirm(
                        t("Remove {name}?", { name: p.name }),
                        t(
                          "Oraknid forgets it and its keys. The files stay in the account; they leave the pool.",
                        ),
                        t("Remove"),
                        { keep: t("Keep it") },
                      ))
                    )
                      return;
                    act(api.cloud.removeProvider({ id: p.id }), t("Removed."));
                  }}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </span>
            </div>
            <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{p.detail}</div>
            <SpaceBar p={p} />
            {p.error ? <ErrorNote error={p.error} className="text-xs" /> : null}
            {p.checkedAt ? (
              <div className="text-[11px] text-muted-foreground">
                {t("Checked {when}", { when: ago(p.checkedAt) })}
              </div>
            ) : null}
          </div>
        ))}
        {dialog}
      </CardContent>
      {adding ? <AddProviderDialog onClose={() => setAdding(false)} /> : null}
      {editing ? <EditProviderDialog provider={editing} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}

function field(id: string, label: string, node: ReactNode, hint?: ReactNode) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {node}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

const PRESETS: [S3Preset, string, string | null][] = [
  ["Minio", "MinIO", "http://127.0.0.1:9000"],
  ["AWS", "AWS S3", null],
  ["R2", "Cloudflare R2", "https://<account id>.r2.cloudflarestorage.com"],
  ["B2", "Backblaze B2", "https://s3.<region>.backblazeb2.com"],
  ["Wasabi", "Wasabi", "https://s3.<region>.wasabisys.com"],
  ["Other", "Other S3-compatible", "https://"],
];

function EditProviderDialog({
  provider,
  onClose,
}: {
  provider: CloudProviderView;
  onClose: () => void;
}) {
  const [name, setName] = useState(provider.name);
  const [limit, setLimit] = useState(
    provider.limitBytes ? String(Math.round((provider.limitBytes / GiB) * 100) / 100) : "",
  );
  const [unlimited, setUnlimited] = useState(provider.unlimited);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api.cloud.updateProvider({
        id: provider.id,
        name: name.trim() || provider.name,
        ...(provider.kind === "s3"
          ? { unlimited, limitBytes: limit ? Math.round(Number(limit) * GiB) : null }
          : {}),
      });
      toast.success(t("Saved."));
      onClose();
    } catch (e) {
      setError(message(e));
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Edit {name}", { name: provider.name })}</DialogTitle>
          <DialogDescription>{provider.detail}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {field(
            "cp-rename",
            t("Name"),
            <Input id="cp-rename" value={name} onChange={(e) => setName(e.target.value)} />,
          )}
          {provider.kind === "s3" ? (
            <SpaceFields {...{ limit, setLimit, unlimited, setUnlimited }} />
          ) : null}
          <ErrorNote error={error} />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("Cancel")}
          </Button>
          <Button onClick={() => void save()}>{t("Save")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SpaceFields({
  limit,
  setLimit,
  unlimited,
  setUnlimited,
}: {
  limit: string;
  setLimit: (s: string) => void;
  unlimited: boolean;
  setUnlimited: (b: boolean) => void;
}) {
  return (
    <div className="space-y-2 rounded-md bg-muted/40 p-2">
      <div className="flex items-center gap-2">
        <Switch id="cp-unlimited" checked={unlimited} onCheckedChange={setUnlimited} />
        <Label htmlFor="cp-unlimited">{t("Pay as you go: never full")}</Label>
      </div>
      {unlimited
        ? null
        : field(
            "cp-limit",
            t("Space limit (GiB)"),
            <Input
              id="cp-limit"
              inputMode="decimal"
              value={limit}
              placeholder={t("none")}
              onChange={(e) => setLimit(e.target.value.replace(/[^\d.]/g, ""))}
            />,
            t(
              "Object storage can't say its free space: with a limit (or pay as you go) uploads may go there automatically; without, only when you pick it.",
            ),
          )}
    </div>
  );
}

type Kind = NewCloudProvider["kind"];

export function AddProviderDialog({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<Kind>("s3");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [preset, setPreset] = useState<S3Preset>("Minio");
  const [endpoint, setEndpoint] = useState("");
  const [region, setRegion] = useState("");
  const [bucket, setBucket] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecret] = useState("");
  const [limit, setLimit] = useState("");
  const [unlimited, setUnlimited] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [auth, setAuth] = useState<CloudAuthorization | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const away = !!remote();

  // A sign-in in progress: asked until it is ready or failed.
  useEffect(() => {
    if (auth?.state !== "waiting") return;
    const timer = setInterval(() => {
      api.cloud
        .authorizeStatus({ session: auth.session })
        .then(setAuth)
        .catch(() => {});
    }, 1000);
    return () => clearInterval(timer);
  }, [auth]);
  // Closing the dialog stops a sign-in still waiting.
  const authRef = useRef(auth);
  authRef.current = auth;
  useEffect(
    () => () => {
      const a = authRef.current;
      if (a?.state === "waiting")
        void api.cloud.authorizeCancel({ session: a.session }).catch(() => {});
    },
    [],
  );

  const choose = (k: Kind) => {
    setKind(k);
    setError(null);
    if (auth?.state === "waiting") void api.cloud.authorizeCancel({ session: auth.session });
    setAuth(null);
  };

  const signIn = async () => {
    setError(null);
    try {
      setAuth(await api.cloud.authorizeStart({ kind: kind as "drive" | "dropbox" }));
    } catch (e) {
      setError(message(e));
    }
  };

  const submit = async () => {
    setError(null);
    const base = { name: name.trim() || KIND_NAMES[kind], folder: folder.trim() };
    let body: NewCloudProvider;
    if (kind === "s3")
      body = {
        ...base,
        kind,
        preset,
        endpoint: preset === "AWS" ? null : endpoint.trim() || null,
        region: region.trim() || null,
        bucket: bucket.trim(),
        accessKeyId: accessKeyId.trim(),
        secretAccessKey,
        limitBytes: !unlimited && limit ? Math.round(Number(limit) * GiB) : null,
        unlimited,
      };
    else if (kind === "mega") body = { ...base, kind, email: email.trim(), password };
    else {
      if (auth?.state !== "ready") return setError(t("Sign in first."));
      body = { ...base, kind, authSession: auth.session };
    }
    setBusy(true);
    try {
      await api.cloud.addProvider(body);
      toast.success(t("Added: it's in the pool."));
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const presetHint = PRESETS.find((p) => p[0] === preset)?.[2];
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto" data-help="storage.add-dialog">
        <DialogHeader>
          <DialogTitle>{t("Add a provider")}</DialogTitle>
          <DialogDescription>
            {t(
              "Oraknid reaches it through rclone; its keys go into an encrypted config only Oraknid opens.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
          {(["s3", "drive", "dropbox", "mega"] as Kind[]).map((k) => (
            // biome-ignore lint/a11y/useSemanticElements: a tile, not a native radio
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={kind === k}
              onClick={() => choose(k)}
              className={`rounded-md border px-2 py-2 text-left text-xs ${kind === k ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
            >
              {KIND_NAMES[k]}
            </button>
          ))}
        </div>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {field(
            "cp-name",
            t("Name"),
            <Input
              id="cp-name"
              value={name}
              placeholder={KIND_NAMES[kind]}
              onChange={(e) => setName(e.target.value)}
            />,
          )}
          {kind === "s3" ? (
            <>
              {field(
                "cp-preset",
                t("Service"),
                <Select value={preset} onValueChange={(v) => setPreset(v as S3Preset)}>
                  <SelectTrigger id="cp-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESETS.map(([v, label]) => (
                      <SelectItem key={v} value={v}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>,
              )}
              {preset === "AWS"
                ? null
                : field(
                    "cp-endpoint",
                    t("Endpoint"),
                    <Input
                      id="cp-endpoint"
                      value={endpoint}
                      placeholder={presetHint ?? ""}
                      onChange={(e) => setEndpoint(e.target.value)}
                    />,
                  )}
              <div className="grid gap-3 sm:grid-cols-2">
                {field(
                  "cp-region",
                  t("Region"),
                  <Input
                    id="cp-region"
                    value={region}
                    placeholder={preset === "R2" ? "auto" : "us-east-1"}
                    onChange={(e) => setRegion(e.target.value)}
                  />,
                )}
                {field(
                  "cp-bucket",
                  t("Bucket"),
                  <Input
                    id="cp-bucket"
                    value={bucket}
                    onChange={(e) => setBucket(e.target.value)}
                  />,
                  t("Made when it isn't there."),
                )}
                {field(
                  "cp-access",
                  t("Access key"),
                  <Input
                    id="cp-access"
                    autoComplete="off"
                    value={accessKeyId}
                    onChange={(e) => setAccessKeyId(e.target.value)}
                  />,
                )}
                {field(
                  "cp-secret",
                  t("Secret key"),
                  <Input
                    id="cp-secret"
                    type="password"
                    autoComplete="new-password"
                    value={secretAccessKey}
                    onChange={(e) => setSecret(e.target.value)}
                  />,
                )}
              </div>
              <SpaceFields {...{ limit, setLimit, unlimited, setUnlimited }} />
            </>
          ) : null}
          {kind === "mega" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              {field(
                "cp-email",
                t("E-mail"),
                <Input
                  id="cp-email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />,
              )}
              {field(
                "cp-password",
                t("Password"),
                <Input
                  id="cp-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />,
              )}
            </div>
          ) : null}
          {kind === "drive" || kind === "dropbox" ? (
            <div
              className="space-y-2 rounded-md bg-muted/40 p-3 text-sm"
              data-help="storage.sign-in"
            >
              {away ? (
                <div className="text-muted-foreground">
                  {t(
                    "Signing in to {kind} needs a browser on the computer running Oraknid: rclone waits for it there. Do it at home.",
                    { kind: KIND_NAMES[kind] },
                  )}
                </div>
              ) : !auth || auth.state === "failed" ? (
                <>
                  <div className="text-muted-foreground">
                    {t(
                      "Sign in with rclone's own authorization, in a browser on this computer. Nothing to register.",
                    )}
                  </div>
                  {auth?.error ? <ErrorNote error={auth.error} /> : null}
                  <Button type="button" size="sm" onClick={() => void signIn()}>
                    {t("Sign in to {kind}", { kind: KIND_NAMES[kind] })}
                  </Button>
                </>
              ) : auth.state === "waiting" ? (
                <>
                  <div>{t("Open the sign-in page, allow rclone, then come back here.")}</div>
                  {auth.url ? (
                    <a
                      href={auth.url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-primary underline"
                    >
                      {t("Open the sign-in page")}
                      <ExternalLink className="size-3.5" />
                    </a>
                  ) : null}
                  <div className="text-xs text-muted-foreground">
                    {t("Waiting for the sign-in…")}
                  </div>
                </>
              ) : (
                <div className="text-success">{t("Signed in. Add it to finish.")}</div>
              )}
            </div>
          ) : null}
          {field(
            "cp-folder",
            kind === "s3" ? t("Folder in the bucket") : t("Folder in the account"),
            <Input
              id="cp-folder"
              value={folder}
              placeholder={t("none: all of it")}
              onChange={(e) => setFolder(e.target.value)}
            />,
            t("What the pool shows of this provider."),
          )}
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                busy || ((kind === "drive" || kind === "dropbox") && auth?.state !== "ready")
              }
            >
              {busy ? t("Checking…") : t("Add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Where uploads go

export function PlacementCard({ providers }: { providers: CloudProviderView[] }) {
  const placement = useLive(() => api.cloud.placement(), {
    topics: ["storage"],
    refreshOn: (e) => e.type === "cloud.placement" || e.type === "cloud.provider.removed",
  });
  if (!placement.data) return null;
  const p = placement.data;
  const save = (next: Partial<CloudPlacement>) =>
    act(api.cloud.setPlacement({ ...p, ...next }), t("Saved."));
  const move = (i: number, by: number) => {
    const ids = providers.map((x) => x.id);
    const [x] = ids.splice(i, 1);
    if (!x) return;
    ids.splice(i + by, 0, x);
    act(api.cloud.reorder({ ids }));
  };
  return (
    <Card data-help="storage.placement">
      <CardHeader>
        <CardTitle>{t("Where uploads go")}</CardTitle>
        <CardDescription>
          {t("A file goes to one provider, never split; one too big for any of them is refused.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid gap-3">
          {field(
            "pl-mode",
            t("Uploads go"),
            <Select
              value={p.mode === "provider" ? (p.providerId ?? "") : "auto"}
              onValueChange={(v) =>
                save(
                  v === "auto"
                    ? { mode: "auto", providerId: null }
                    : { mode: "provider", providerId: v },
                )
              }
            >
              <SelectTrigger id="pl-mode" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("Automatic, by a rule")}</SelectItem>
                {providers.map((x) => (
                  <SelectItem key={x.id} value={x.id}>
                    {t("Always to {name}", { name: x.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
          )}
          {p.mode === "auto"
            ? field(
                "pl-rule",
                t("Rule"),
                <Select
                  value={p.rule}
                  onValueChange={(v) => save({ rule: v as CloudPlacement["rule"] })}
                >
                  <SelectTrigger id="pl-rule" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="free">{t("Most free space first")}</SelectItem>
                    <SelectItem value="priority">{t("My priority order")}</SelectItem>
                    <SelectItem value="size">
                      {t("By size: large files to object storage")}
                    </SelectItem>
                  </SelectContent>
                </Select>,
              )
            : null}
          {p.mode === "auto" && p.rule === "size"
            ? field(
                "pl-large",
                t("Large from (MiB)"),
                <Input
                  id="pl-large"
                  inputMode="numeric"
                  defaultValue={String(Math.round(p.largeFromBytes / (1 << 20)))}
                  onBlur={(e) => {
                    const n = Number(e.target.value);
                    if (n > 0) save({ largeFromBytes: Math.round(n * (1 << 20)) });
                  }}
                />,
              )
            : null}
        </div>
        {p.mode === "auto" && p.rule === "priority" ? (
          <ol className="space-y-1">
            {providers.map((x, i) => (
              <li key={x.id} className="flex items-center gap-2 rounded-md bg-muted/40 px-2 py-1">
                <span className="w-5 text-xs text-muted-foreground">{i + 1}</span>
                <span className="flex-1">{x.name}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === 0}
                  aria-label={t("Move {name} up", { name: x.name })}
                  onClick={() => move(i, -1)}
                >
                  <ArrowUp className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={i === providers.length - 1}
                  aria-label={t("Move {name} down", { name: x.name })}
                  onClick={() => move(i, 1)}
                >
                  <ArrowDown className="size-3.5" />
                </Button>
              </li>
            ))}
          </ol>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── The pool

interface Sending {
  id: string;
  name: string;
  size: number;
  phase: "receive" | "send" | "done" | "failed";
  bytes: number;
  error: string | null;
  providerName: string | null;
}

let nextUpload = 1;

export function PoolBrowser({ path, providers }: { path: string; providers: CloudProviderView[] }) {
  const [, go] = useLocation();
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState("");
  const [target, setTarget] = useState("auto");
  const [over, setOver] = useState(false);
  const [sending, setSending] = useState<Sending[]>([]);
  const [renaming, setRenaming] = useState<CloudEntry | null>(null);
  const [making, setMaking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const { confirm, dialog } = useConfirm();
  const away = !!remote();
  const listing = useLive(
    () => (searching ? api.cloud.search({ q: searching, path }) : api.cloud.list({ path })),
    {
      topics: ["storage"],
      refreshOn: (e) =>
        e.type.startsWith("cloud.file") ||
        e.type.startsWith("cloud.folder") ||
        e.type.startsWith("cloud.provider"),
      deps: [path, searching],
    },
  );
  const name = (id: string | null) => providers.find((p) => p.id === id)?.name ?? "?";

  // The provider's half of each upload, from the live socket.
  useEffect(() => {
    const off = live.subscribe(["storage"]);
    const offT = live.onTransfer((x: CloudTransfer) =>
      setSending((all) =>
        all.map((s) =>
          s.id === x.id && s.phase !== "done" && s.phase !== "failed" && x.phase !== "receive"
            ? { ...s, phase: x.phase, bytes: x.bytes, error: x.error }
            : s,
        ),
      ),
    );
    return () => {
      off();
      offT();
    };
  }, []);

  const set = (id: string, patch: Partial<Sending>) =>
    setSending((all) => all.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  const send = async (file: File, replace = false): Promise<void> => {
    const id = `up${Date.now().toString(36)}${nextUpload++}`;
    setSending((all) => [
      ...all,
      {
        id,
        name: file.name,
        size: file.size,
        phase: "receive",
        bytes: 0,
        error: null,
        providerName: null,
      },
    ]);
    try {
      const r = await uploadFile(file, {
        folder: path,
        provider: target,
        replace,
        transfer: id,
        onProgress: (b) => set(id, { bytes: b }),
      });
      set(id, { phase: "done", bytes: file.size, providerName: r.providerName });
    } catch (e) {
      if (e instanceof UploadError && e.status === 409 && !replace) {
        setSending((all) => all.filter((s) => s.id !== id));
        if (await confirm(t("Replace {name}?", { name: file.name }), e.message, t("Replace")))
          return send(file, true);
        return;
      }
      set(id, { phase: "failed", error: message(e) });
    }
  };
  const sendAll = (files: FileList | File[]) => {
    for (const f of Array.from(files)) void send(f);
  };

  const crumbs = path ? path.split("/") : [];
  const entries = listing.data?.entries ?? [];

  const fileMenu = (e: CloudEntry) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("Actions for {name}", { name: e.name })}
          data-help="storage.file-actions"
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {e.isDir ? null : (
          <DropdownMenuItem
            disabled={away}
            onSelect={() =>
              void fetchDownload(
                api.cloud.downloadLink({ providerId: e.providerId as string, path: e.path }),
              )
            }
          >
            <Download className="size-3.5" />
            {t("Download")}
          </DropdownMenuItem>
        )}
        <DropdownMenuItem onSelect={() => setRenaming(e)}>
          <Pencil className="size-3.5" />
          {e.isDir ? t("Rename or move") : t("Rename or move…")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive"
          onSelect={async () => {
            const ok = await confirm(
              e.isDir
                ? t("Delete the folder {name}?", { name: e.name })
                : t("Delete {name}?", { name: e.name }),
              e.isDir
                ? t("Everything in it goes, in {list}. It can't be undone.", {
                    list: e.providers.map(name).join(", "),
                  })
                : t("It goes from {p}. It can't be undone.", { p: name(e.providerId) }),
              t("Delete"),
              { keep: t("Keep it") },
            );
            if (!ok) return;
            act(
              e.isDir
                ? api.cloud.deleteFolder({ path: e.path })
                : api.cloud.deleteFile({ providerId: e.providerId as string, path: e.path }),
              t("Deleted."),
            );
          }}
        >
          <Trash2 className="size-3.5" />
          {t("Delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <Card data-help="storage.pool">
      <CardHeader className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="mr-auto">{t("The pool")}</CardTitle>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger
              className="h-8 w-auto min-w-36 text-xs"
              aria-label={t("Upload to")}
              data-help="storage.upload-to"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">{t("Upload: where the rule puts it")}</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {t("Upload to {name}", { name: p.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="secondary" className="gap-1" onClick={() => setMaking(true)}>
            <FolderPlus className="size-3.5" />
            {t("New folder")}
          </Button>
          <Button
            size="sm"
            className="gap-1"
            data-help="storage.upload"
            disabled={away || providers.length === 0}
            onClick={() => fileInput.current?.click()}
          >
            <Upload className="size-3.5" />
            {t("Upload")}
          </Button>
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            data-testid="upload-input"
            onChange={(e) => {
              if (e.target.files) sendAll(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label={t("Folder")}>
          <Link href={poolHref("")} className="inline-flex items-center gap-1 hover:underline">
            <Cloud className="size-3.5" />
            {t("Pool")}
          </Link>
          {crumbs.map((c, i) => (
            <span key={crumbs.slice(0, i + 1).join("/")} className="inline-flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <Link href={poolHref(crumbs.slice(0, i + 1).join("/"))} className="hover:underline">
                {c}
              </Link>
            </span>
          ))}
        </nav>
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setSearching(q.trim());
          }}
        >
          <Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            value={q}
            data-help="storage.search"
            placeholder={path ? t("Search in this folder") : t("Search the pool")}
            onChange={(e) => {
              setQ(e.target.value);
              if (!e.target.value) setSearching("");
            }}
          />
        </form>
      </CardHeader>
      <CardContent
        className={`space-y-2 ${over ? "rounded-md outline-2 outline-primary outline-dashed" : ""}`}
        onDragOver={(e) => {
          if (away || !providers.length) return;
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!away && providers.length) sendAll(e.dataTransfer.files);
        }}
      >
        {away ? (
          <div className="text-xs text-muted-foreground">
            {t(
              "Uploads and downloads work in a browser on the computer running Oraknid; away from home you can look, move and delete.",
            )}
          </div>
        ) : null}
        {sending.length ? (
          <div className="space-y-1.5" data-help="storage.uploads">
            {sending.map((s) => (
              <div key={s.id} className="space-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <span className="text-muted-foreground">
                    {s.phase === "receive"
                      ? t("sending to Oraknid")
                      : s.phase === "send"
                        ? t("to the provider")
                        : s.phase === "done"
                          ? s.providerName
                            ? t("in {p}", { p: s.providerName })
                            : t("done")
                          : t("failed")}
                  </span>
                </div>
                {s.phase === "failed" ? (
                  <div className="text-destructive">{s.error}</div>
                ) : (
                  <Progress
                    value={s.size ? (Math.min(s.bytes, s.size) / s.size) * 100 : 100}
                    aria-label={t("Progress of {name}", { name: s.name })}
                  />
                )}
              </div>
            ))}
            {sending.every((s) => s.phase === "done" || s.phase === "failed") ? (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 text-xs"
                onClick={() => setSending([])}
              >
                {t("Clear")}
              </Button>
            ) : null}
          </div>
        ) : null}
        {listing.error ? <ErrorNote error={listing.error} /> : null}
        {listing.data?.errors.map((e) => (
          <ErrorNote key={e.providerId} error={t("{name} couldn't be read: {error}", e)} />
        ))}
        {!listing.data && !listing.error ? <Loading rows={3} /> : null}
        {listing.data && entries.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {searching
              ? t("Nothing found.")
              : providers.length
                ? t("Empty. Drop files here, or Upload.")
                : t("Add a provider first.")}
          </div>
        ) : null}
        <ul className="divide-y rounded-md border">
          {entries.map((e) => (
            <li
              key={`${e.providerId ?? "dir"}:${e.path}`}
              className="flex items-center gap-2 px-2 py-1.5 text-sm"
            >
              {e.isDir ? (
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
                  onClick={() => {
                    setQ("");
                    setSearching("");
                    go(poolHref(e.path));
                  }}
                >
                  <Folder className="size-4 shrink-0 text-primary" />
                  <span className="truncate">{searching ? e.path : e.name}</span>
                </button>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <FileIcon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block truncate">{searching ? e.path : e.name}</span>
                    <span className="block text-[11px] text-muted-foreground sm:hidden">
                      {bytes(e.size ?? 0)} · {name(e.providerId)}
                    </span>
                  </span>
                </span>
              )}
              <span className="hidden items-center gap-1 sm:flex">
                {(e.isDir ? e.providers : [e.providerId]).map((id) => (
                  <Badge key={id} variant="outline" className="gap-1 text-[10px]">
                    <HardDrive className="size-3" />
                    {name(id)}
                  </Badge>
                ))}
              </span>
              <span className="hidden w-20 text-right text-xs text-muted-foreground sm:block">
                {e.isDir ? "" : bytes(e.size ?? 0)}
              </span>
              <span className="hidden w-24 text-right text-xs text-muted-foreground md:block">
                {!e.isDir && e.modTime ? new Date(e.modTime).toLocaleDateString() : ""}
              </span>
              {fileMenu(e)}
            </li>
          ))}
        </ul>
        {listing.data?.truncated ? (
          <div className="text-xs text-muted-foreground">{t("The first 500 found.")}</div>
        ) : null}
        {dialog}
      </CardContent>
      {renaming ? (
        <MoveDialog entry={renaming} providers={providers} onClose={() => setRenaming(null)} />
      ) : null}
      {making ? (
        <NewFolderDialog
          onDone={(n) => {
            setMaking(false);
            if (n) go(poolHref([path, n].filter(Boolean).join("/")));
          }}
        />
      ) : null}
    </Card>
  );
}

function NewFolderDialog({ onDone }: { onDone: (name: string | null) => void }) {
  const [name, setName] = useState("");
  const clean = name.trim().replace(/\//g, "-");
  return (
    <Dialog open onOpenChange={(o) => !o && onDone(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("New folder")}</DialogTitle>
          <DialogDescription>
            {t("It opens empty; it is kept once a file is uploaded into it.")}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (clean && clean !== "." && clean !== "..") onDone(clean);
          }}
          className="space-y-3"
        >
          {field(
            "nf-name",
            t("Name"),
            <Input id="nf-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />,
          )}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onDone(null)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={!clean}>
              {t("Open it")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function MoveDialog({
  entry,
  providers,
  onClose,
}: {
  entry: CloudEntry;
  providers: CloudProviderView[];
  onClose: () => void;
}) {
  const [to, setTo] = useState(entry.path);
  const [provider, setProvider] = useState(entry.providerId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    setBusy(true);
    try {
      const toPath = to.trim().replace(/^\/+|\/+$/g, "");
      if (entry.isDir) await api.cloud.moveFolder({ path: entry.path, toPath });
      else
        await api.cloud.move({
          providerId: entry.providerId as string,
          path: entry.path,
          toPath,
          toProviderId: provider === entry.providerId ? null : provider,
        });
      toast.success(t("Moved."));
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Rename or move {name}", { name: entry.name })}</DialogTitle>
          <DialogDescription>
            {entry.isDir
              ? t("In every provider holding it.")
              : t(
                  "Within its provider, or to another one (it is copied there, then removed here).",
                )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {field(
            "mv-path",
            t("Path in the pool"),
            <Input id="mv-path" value={to} onChange={(e) => setTo(e.target.value)} />,
          )}
          {entry.isDir
            ? null
            : field(
                "mv-provider",
                t("Provider"),
                <Select value={provider} onValueChange={setProvider}>
                  <SelectTrigger id="mv-provider" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>,
              )}
          <ErrorNote error={error} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("Cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("Moving…") : t("Move")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** rclone isn't on this computer: what to do. */
export function NoRclone({ fix }: { fix: string | null }) {
  return (
    <Empty title={t("rclone isn't installed")}>
      {t("Cloud storage runs through rclone.")} {fix}
    </Empty>
  );
}
