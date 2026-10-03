import type {
  BackupDestination,
  BackupKeyView,
  BackupPlanView,
  BackupRunView,
  BackupSchedule,
  BackupTarget,
  CloudProviderView,
  DbKind,
  NewBackupPlan,
  RestorePreview,
  ServerView,
} from "@oraknid/contracts";
import {
  CheckCircle2,
  Copy,
  Download,
  KeyRound,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ErrorNote, Loading } from "@/components/common";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago, bytes, until } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

// Backups (ADR-044, Web-UI → Settings → Backups and a server's Backups
// tab): plans, their backups, Verify, Restore in two steps, and age keys
// (the private one shown once).

const act = (p: Promise<unknown>, ok?: string) =>
  p.then(() => ok && toast.success(ok)).catch((e) => toast.error(message(e)));

export const KINDS: [DbKind, string][] = [
  ["postgres", "PostgreSQL"],
  ["mysql", "MySQL / MariaDB"],
  ["mongodb", "MongoDB"],
  ["redis", "Redis"],
  ["sqlite", "SQLite"],
];
const kindName = (k: DbKind) => KINDS.find((x) => x[0] === k)?.[1] ?? k;

const DEFAULT_PORT: Record<DbKind, number | null> = {
  postgres: 5432,
  mysql: 3306,
  mongodb: 27017,
  redis: 6379,
  sqlite: null,
};

/** A database found on a server (ADR-043's databases), offered to pick from. */
export interface DatabaseChoice {
  kind: DbKind;
  /** Its container, when it runs in Docker. */
  container?: string | null;
  host?: string | null;
  port?: number | null;
  /** A database inside it, when known. */
  database?: string | null;
  /** SQLite: the file. */
  path?: string | null;
  /** How it's shown: "postgres 16 in shop-db". */
  label?: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function scheduleText(s: BackupSchedule): string {
  switch (s.kind) {
    case "hourly":
      return t("Every hour at :{m}", { m: String(s.minute).padStart(2, "0") });
    case "daily":
      return t("Every day at {at}", { at: s.at });
    case "weekly":
      return t("Every {day} at {at}", { day: t(DAYS[s.day] ?? ""), at: s.at });
    case "cron":
      return t("cron {line}", { line: s.line });
  }
}

const what = (x: BackupTarget) =>
  x.kind === "sqlite"
    ? (x.path ?? "")
    : x.kind === "redis"
      ? t("all of it")
      : (x.database ?? t("all databases"));

function useServers() {
  return useLive(() => api.servers.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
  });
}

const serverName = (servers: ServerView[] | undefined, id: string) =>
  servers?.find((s) => s.id === id)?.name ?? t("a removed server");

/** My cloud storage providers (ADR-046), a backup's destination. */
function useCloudProviders() {
  return useLive(() => api.cloud.providers(), {
    topics: ["storage"],
    refreshOn: (e) => e.type.startsWith("cloud.provider"),
  });
}

function destText(
  d: BackupDestination,
  servers: ServerView[] | undefined,
  providers: CloudProviderView[] | undefined,
) {
  if (d.kind === "local") return t("this computer, {f}", { f: d.folder });
  if (d.kind === "cloud")
    return t("cloud storage ({p}), {f}", {
      p: d.providerId
        ? (providers?.find((p) => p.id === d.providerId)?.name ?? t("a removed provider"))
        : t("the pool"),
      f: d.folder,
    });
  return t("{s}, {f}", { s: serverName(servers, d.serverId), f: d.folder });
}

/** A file from Oraknid: a one-time link, opened as a download by this browser. */
export function fetchDownload(link: Promise<{ url: string }>) {
  return link
    .then(({ url }) => {
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      a.rel = "noopener";
      document.body.append(a);
      a.click();
      a.remove();
    })
    .catch((e) => toast.error(message(e)));
}

// ── Plans

const newPlan = { size: "sm", variant: "secondary", className: "gap-1" } as const;

/** Every plan, or a server's (its own, and those writing to it). */
export function BackupPlans({
  serverId,
  databases,
}: {
  serverId?: string;
  databases?: DatabaseChoice[];
}) {
  const plans = useLive(() => api.backups.plans(serverId ? { serverId } : undefined), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("backup."),
    deps: [serverId],
  });
  const servers = useServers();
  const keys = useLive(() => api.backups.keys(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("backup.key"),
  });
  const [editing, setEditing] = useState<BackupPlanView | "new" | null>(null);
  if (plans.error) return <ErrorNote error={plans.error} />;
  if (!plans.data || !servers.data || !keys.data) return <Loading rows={2} />;
  return (
    <div className="space-y-3">
      {plans.data.length === 0 && !editing ? (
        <div className="rounded-md border border-dashed px-3 py-4 text-sm text-muted-foreground">
          {t(
            "No backup plans yet. A plan dumps one database (or all of a server's) at its time, compressed and encrypted if you want, to this computer or another server.",
          )}
        </div>
      ) : null}
      {plans.data.map((p) => (
        <PlanRow
          key={p.id}
          plan={p}
          servers={servers.data}
          keys={keys.data ?? []}
          onEdit={() => setEditing(p)}
        />
      ))}
      {editing ? (
        <PlanForm
          plan={editing === "new" ? undefined : editing}
          serverId={serverId}
          servers={servers.data}
          keys={keys.data}
          databases={databases}
          onDone={() => setEditing(null)}
        />
      ) : serverId ? (
        <Button data-help="server.backups.new" {...newPlan} onClick={() => setEditing("new")}>
          <Plus className="size-3.5" />
          {t("New backup plan")}
        </Button>
      ) : (
        <Button data-help="backups.new-plan" {...newPlan} onClick={() => setEditing("new")}>
          <Plus className="size-3.5" />
          {t("New backup plan")}
        </Button>
      )}
    </div>
  );
}

function RunState({ run }: { run: BackupRunView }) {
  if (run.state === "running") return <Badge variant="outline">{t("running")}</Badge>;
  if (run.state === "failed") return <Badge variant="destructive">{t("failed")}</Badge>;
  return <Badge variant="secondary">{t("ok")}</Badge>;
}

function PlanRow({
  plan,
  servers,
  keys,
  onEdit,
}: {
  plan: BackupPlanView;
  servers: ServerView[] | undefined;
  keys: BackupKeyView[];
  onEdit: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [open, setOpen] = useState(false);
  const providers = useCloudProviders();
  const key = keys.find((k) => k.id === plan.keyId);
  const last = plan.lastRun;
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-medium">{plan.name}</span>
          <Badge variant="outline">{kindName(plan.target.kind)}</Badge>
          {key ? (
            <Badge variant="outline" className="gap-1">
              <KeyRound className="size-3" />
              {key.name}
            </Badge>
          ) : (
            <Badge variant="outline">{t("not encrypted")}</Badge>
          )}
          {!plan.hasPassword && plan.target.kind !== "sqlite" ? (
            <Badge variant="outline">{t("no password kept")}</Badge>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Switch
            checked={plan.enabled}
            aria-label={t("Scheduled")}
            onCheckedChange={(enabled) =>
              act(
                api.backups.updatePlan({ id: plan.id, enabled }),
                enabled ? t("On schedule again.") : t("Paused."),
              )
            }
          />
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            data-help="backups.run"
            disabled={plan.running}
            onClick={() => act(api.backups.run({ id: plan.id }), t("Started."))}
          >
            <Play className="size-3.5" />
            {plan.running ? t("Running…") : t("Run now")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Edit {name}", { name: plan.name })}
            onClick={onEdit}
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            aria-label={t("Remove {name}", { name: plan.name })}
            onClick={async () => {
              if (
                !(await confirm(
                  t("Remove the plan {name}?", { name: plan.name }),
                  t(
                    "It stops running and its password leaves the keychain. Its backups stay where they are.",
                  ),
                  t("Remove"),
                  { keep: t("Keep it") },
                ))
              )
                return;
              act(api.backups.removePlan({ id: plan.id, deleteBackups: false }), t("Removed."));
            }}
          >
            <Trash2 className="size-3.5" />
          </Button>
          {dialog}
        </div>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <div className="[overflow-wrap:anywhere]">
          {t("{what} on {server}{container}", {
            what: what(plan.target),
            server: serverName(servers, plan.target.serverId),
            container: plan.target.container
              ? t(", container {c}", { c: plan.target.container })
              : "",
          })}
        </div>
        <div>
          {scheduleText(plan.schedule)}
          {plan.enabled && plan.nextRunAt
            ? ` · ${t("next {when}", { when: until(plan.nextRunAt) })}`
            : ""}
          {plan.enabled ? "" : ` · ${t("paused")}`}
        </div>
        <div className="[overflow-wrap:anywhere]">
          {t("To {where}", { where: destText(plan.destination, servers, providers.data) })}
        </div>
        <div>
          {t("Keeps {count}{days}", {
            count:
              plan.retention.count === null
                ? t("any number")
                : t("the last {n}", { n: plan.retention.count }),
            days:
              plan.retention.days === null
                ? ""
                : t(", none older than {d} days", { d: plan.retention.days }),
          })}
        </div>
      </div>
      {last ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <RunState run={last} />
          <span className="text-muted-foreground">
            {ago(last.startedAt)}
            {last.size !== null ? ` · ${bytes(last.size)}` : ""}
            {last.trigger === "missed"
              ? ` · ${t("missed while Oraknid was off, run when it came back")}`
              : ""}
          </span>
          {last.error ? (
            <span className="text-destructive [overflow-wrap:anywhere]">{last.error}</span>
          ) : null}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">{t("Not run yet.")}</div>
      )}
      <Button
        size="sm"
        variant="link"
        className="h-auto p-0 text-xs"
        onClick={() => setOpen(!open)}
      >
        {open ? t("Hide its backups") : t("Its backups")}
      </Button>
      {open ? <BackupRuns planId={plan.id} plans={[plan]} /> : null}
    </div>
  );
}

// ── The plan's form

const emptyTarget = (serverId: string): BackupTarget => ({
  serverId,
  kind: "postgres",
  container: null,
  host: null,
  port: null,
  database: null,
  user: null,
  path: null,
});

const num = (s: string) => (s.trim() === "" ? null : Number(s));

export function PlanForm({
  plan,
  serverId,
  servers,
  keys,
  databases,
  onDone,
}: {
  plan?: BackupPlanView;
  serverId?: string;
  servers: ServerView[];
  keys: BackupKeyView[];
  databases?: DatabaseChoice[];
  onDone: () => void;
}) {
  const first = serverId ?? servers[0]?.id ?? "";
  const [name, setName] = useState(plan?.name ?? "");
  const [target, setTarget] = useState<BackupTarget>(plan?.target ?? emptyTarget(first));
  const [inDocker, setInDocker] = useState(plan ? plan.target.container !== null : true);
  const [password, setPassword] = useState("");
  const [schedule, setSchedule] = useState<BackupSchedule>(
    plan?.schedule ?? { kind: "daily", at: "03:30" },
  );
  const [dest, setDest] = useState<BackupDestination>(
    plan?.destination ?? { kind: "local", folder: "~/Backups/oraknid" },
  );
  const [count, setCount] = useState(plan ? String(plan.retention.count ?? "") : "14");
  const [days, setDays] = useState(plan ? String(plan.retention.days ?? "") : "");
  const [keyId, setKeyId] = useState<string | null>(plan ? plan.keyId : (keys[0]?.id ?? null));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<BackupTarget>) => setTarget((x) => ({ ...x, ...patch }));
  const others = servers.filter((s) => s.id !== target.serverId);
  const providers = useCloudProviders();

  const pick = (i: string) => {
    const d = databases?.[Number(i)];
    if (!d) return;
    setInDocker(!!d.container);
    setTarget((x) => ({
      ...x,
      kind: d.kind,
      container: d.container ?? null,
      host: d.host ?? null,
      port: d.port ?? null,
      database: d.database ?? null,
      path: d.path ?? null,
    }));
    if (!name) setName(d.label ?? `${kindName(d.kind)} ${d.database ?? d.container ?? ""}`.trim());
  };

  const submit = async () => {
    setError(null);
    const body: NewBackupPlan = {
      name: name.trim(),
      target: {
        ...target,
        container: inDocker ? target.container?.trim() || null : null,
        path: target.kind === "sqlite" ? target.path : null,
      },
      schedule,
      destination: dest,
      retention: { count: num(count), days: num(days) },
      keyId,
      enabled: plan?.enabled ?? true,
      ...(password ? { password } : {}),
    };
    if (!body.name) return setError(t("Give the plan a name."));
    if (inDocker && !body.target.container) return setError(t("Give the container's name."));
    setBusy(true);
    try {
      if (plan) await api.backups.updatePlan({ id: plan.id, ...body });
      else await api.backups.createPlan(body);
      toast.success(plan ? t("Plan saved.") : t("Plan made: it runs at its time."));
      onDone();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  const field = (id: string, label: string, node: React.ReactNode, hint?: string) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {node}
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );

  return (
    <form
      className="space-y-4 rounded-md border p-3"
      data-help="backups.plan-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="text-sm font-medium">
        {plan ? t("Change the plan") : t("A new backup plan")}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {field(
          "bk-name",
          t("Name"),
          <Input
            id="bk-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("Shop database")}
          />,
        )}
        {serverId
          ? null
          : field(
              "bk-server",
              t("Server"),
              <Select value={target.serverId} onValueChange={(v) => set({ serverId: v })}>
                <SelectTrigger id="bk-server" className="w-full">
                  <SelectValue placeholder={t("Pick a server")} />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )}
      </div>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("The database")}
        </legend>
        {databases?.length
          ? field(
              "bk-found",
              t("Found on the server"),
              <Select onValueChange={pick}>
                <SelectTrigger id="bk-found" className="w-full">
                  <SelectValue placeholder={t("Pick one, or describe it below")} />
                </SelectTrigger>
                <SelectContent>
                  {databases.map((d, i) => (
                    <SelectItem
                      key={`${d.kind}-${d.container}-${d.port}-${d.database}`}
                      value={String(i)}
                    >
                      {d.label ??
                        `${kindName(d.kind)}${d.container ? ` · ${d.container}` : ""}${d.database ? ` · ${d.database}` : ""}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>,
            )
          : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            "bk-kind",
            t("Kind"),
            <Select
              value={target.kind}
              onValueChange={(v) =>
                set({ kind: v as DbKind, ...(v === "redis" ? { database: null } : {}) })
              }
            >
              <SelectTrigger id="bk-kind" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map(([k, label]) => (
                  <SelectItem key={k} value={k}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
          )}
          <div className="flex items-end gap-2 pb-2">
            <Switch id="bk-docker" checked={inDocker} onCheckedChange={setInDocker} />
            <Label htmlFor="bk-docker">{t("It runs in a Docker container")}</Label>
          </div>
          {inDocker
            ? field(
                "bk-container",
                t("Container name"),
                <Input
                  id="bk-container"
                  value={target.container ?? ""}
                  onChange={(e) => set({ container: e.target.value })}
                  placeholder="shop-db"
                />,
                t("The dump runs inside it with docker exec; its own tools are always there."),
              )
            : null}
          {target.kind === "sqlite" ? (
            field(
              "bk-path",
              t("Database file"),
              <Input
                id="bk-path"
                value={target.path ?? ""}
                onChange={(e) => set({ path: e.target.value || null })}
                placeholder="/srv/app/data.db"
              />,
            )
          ) : (
            <>
              {field(
                "bk-host",
                t("Host"),
                <Input
                  id="bk-host"
                  value={target.host ?? ""}
                  onChange={(e) => set({ host: e.target.value || null })}
                  placeholder={inDocker ? t("its local socket") : "127.0.0.1"}
                />,
              )}
              {field(
                "bk-port",
                t("Port"),
                <Input
                  id="bk-port"
                  inputMode="numeric"
                  value={target.port ?? ""}
                  onChange={(e) => set({ port: num(e.target.value) })}
                  placeholder={String(DEFAULT_PORT[target.kind] ?? "")}
                />,
              )}
              {target.kind === "redis"
                ? null
                : field(
                    "bk-db",
                    t("Database"),
                    <Input
                      id="bk-db"
                      value={target.database ?? ""}
                      onChange={(e) => set({ database: e.target.value || null })}
                      placeholder={t("empty: all of them")}
                    />,
                  )}
              {field(
                "bk-user",
                t("User"),
                <Input
                  id="bk-user"
                  value={target.user ?? ""}
                  onChange={(e) => set({ user: e.target.value || null })}
                  placeholder={
                    target.kind === "mongodb"
                      ? "root"
                      : target.kind === "postgres"
                        ? "postgres"
                        : ""
                  }
                />,
              )}
              {field(
                "bk-password",
                t("Password"),
                <Input
                  id="bk-password"
                  type="password"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={plan?.hasPassword ? t("kept; type to change") : ""}
                />,
                t(
                  "Kept in the keychain, given to the dump through its environment, never on a command line.",
                ),
              )}
            </>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("When")}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            "bk-every",
            t("Every"),
            <Select
              value={schedule.kind}
              onValueChange={(k) =>
                setSchedule(
                  k === "hourly"
                    ? { kind: "hourly", minute: 0 }
                    : k === "weekly"
                      ? { kind: "weekly", day: 0, at: "03:30" }
                      : k === "cron"
                        ? { kind: "cron", line: "30 3 * * *" }
                        : { kind: "daily", at: "03:30" },
                )
              }
            >
              <SelectTrigger id="bk-every" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="hourly">{t("Hour")}</SelectItem>
                <SelectItem value="daily">{t("Day")}</SelectItem>
                <SelectItem value="weekly">{t("Week")}</SelectItem>
                <SelectItem value="cron">{t("A cron line")}</SelectItem>
              </SelectContent>
            </Select>,
          )}
          {schedule.kind === "hourly"
            ? field(
                "bk-minute",
                t("At minute"),
                <Input
                  id="bk-minute"
                  inputMode="numeric"
                  value={schedule.minute}
                  onChange={(e) =>
                    setSchedule({
                      kind: "hourly",
                      minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)),
                    })
                  }
                />,
              )
            : null}
          {schedule.kind === "weekly"
            ? field(
                "bk-day",
                t("On"),
                <Select
                  value={String(schedule.day)}
                  onValueChange={(d) => setSchedule({ ...schedule, day: Number(d) })}
                >
                  <SelectTrigger id="bk-day" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)}>
                        {t(d)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>,
              )
            : null}
          {schedule.kind === "daily" || schedule.kind === "weekly"
            ? field(
                "bk-at",
                t("At"),
                <Input
                  id="bk-at"
                  type="time"
                  value={schedule.at}
                  onChange={(e) => setSchedule({ ...schedule, at: e.target.value })}
                />,
                t("This computer's time."),
              )
            : null}
          {schedule.kind === "cron"
            ? field(
                "bk-cron",
                t("Cron line"),
                <Input
                  id="bk-cron"
                  className="font-mono"
                  value={schedule.line}
                  onChange={(e) => setSchedule({ kind: "cron", line: e.target.value })}
                />,
                t("minute hour day-of-month month day-of-week, in this computer's time."),
              )
            : null}
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {t("Where to, and how many")}
        </legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {field(
            "bk-dest",
            t("Kept on"),
            <Select
              value={
                dest.kind === "local"
                  ? "local"
                  : dest.kind === "cloud"
                    ? `cloud:${dest.providerId ?? "pool"}`
                    : dest.serverId
              }
              onValueChange={(v) =>
                setDest(
                  v === "local"
                    ? {
                        kind: "local",
                        folder: dest.kind === "local" ? dest.folder : "~/Backups/oraknid",
                      }
                    : v.startsWith("cloud:")
                      ? {
                          kind: "cloud",
                          providerId: v === "cloud:pool" ? null : v.slice(6),
                          folder: dest.kind === "cloud" ? dest.folder : "Oraknid backups",
                        }
                      : {
                          kind: "server",
                          serverId: v,
                          folder: dest.kind === "server" ? dest.folder : "backups",
                        },
                )
              }
            >
              <SelectTrigger id="bk-dest" className="w-full" data-help="backups.destination">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="local">{t("This computer")}</SelectItem>
                {others.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
                {providers.data?.length ? (
                  <SelectItem value="cloud:pool">{t("Cloud storage: the pool")}</SelectItem>
                ) : null}
                {providers.data?.map((p) => (
                  <SelectItem key={p.id} value={`cloud:${p.id}`}>
                    {t("Cloud storage: {name}", { name: p.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
            providers.data?.length
              ? undefined
              : t("Add cloud storage (Cloud storage in the sidebar) to keep backups there."),
          )}
          {field(
            "bk-folder",
            t("Folder"),
            <Input
              id="bk-folder"
              value={dest.folder}
              onChange={(e) => setDest({ ...dest, folder: e.target.value })}
            />,
            dest.kind === "local"
              ? t("On this computer; ~ is your home.")
              : dest.kind === "cloud"
                ? dest.providerId
                  ? t("A folder in that provider.")
                  : t("A folder in the pool; each backup goes where the upload rule puts it.")
                : t("On that server, from its login's home."),
          )}
          {field(
            "bk-count",
            t("Keep the last"),
            <Input
              id="bk-count"
              inputMode="numeric"
              value={count}
              onChange={(e) => setCount(e.target.value.replace(/\D/g, ""))}
              placeholder={t("any number")}
            />,
          )}
          {field(
            "bk-days",
            t("None older than (days)"),
            <Input
              id="bk-days"
              inputMode="numeric"
              value={days}
              onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))}
              placeholder={t("any age")}
            />,
            t("The newest good backup always stays."),
          )}
          {field(
            "bk-key",
            t("Encryption"),
            <Select
              value={keyId ?? "none"}
              onValueChange={(v) => setKeyId(v === "none" ? null : v)}
            >
              <SelectTrigger id="bk-key" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("None")}</SelectItem>
                {keys.map((k) => (
                  <SelectItem key={k.id} value={k.id}>
                    {t("age key {name}", { name: k.name })}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>,
            keys.length ? undefined : t("Make an age key under Keys to encrypt."),
          )}
        </div>
      </fieldset>
      {error ? <div className="text-sm text-destructive">{error}</div> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {plan ? t("Save") : t("Make the plan")}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {t("Cancel")}
        </Button>
      </div>
    </form>
  );
}

// ── Backups made

export function BackupRuns({ planId, plans }: { planId?: string; plans?: BackupPlanView[] }) {
  const runs = useLive(() => api.backups.runs(planId ? { planId, limit: 50 } : { limit: 30 }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("backup."),
    deps: [planId],
  });
  const [restoring, setRestoring] = useState<BackupRunView | null>(null);
  if (runs.error) return <ErrorNote error={runs.error} />;
  if (!runs.data) return <Loading rows={2} />;
  if (!runs.data.length)
    return <div className="text-xs text-muted-foreground">{t("No backups yet.")}</div>;
  const planOf = (id: string) => plans?.find((p) => p.id === id);
  return (
    <div className="space-y-2">
      {runs.data.map((r) => (
        <div key={r.id} className="space-y-1 rounded-md bg-muted/40 px-2 py-1.5 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <RunState run={r} />
            <span>{new Date(r.startedAt).toLocaleString()}</span>
            {!planId && planOf(r.planId) ? (
              <span className="font-medium">{planOf(r.planId)?.name}</span>
            ) : null}
            {r.trigger === "missed" ? <Badge variant="outline">{t("caught up")}</Badge> : null}
            {r.prunedAt ? <Badge variant="outline">{t("removed by retention")}</Badge> : null}
            <span className="flex-1" />
            {r.state === "ok" && !r.prunedAt ? (
              <>
                {r.keyId ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1"
                        data-help="backups.download"
                      >
                        <Download className="size-3.5" />
                        {t("Download")}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onSelect={() =>
                          void fetchDownload(api.backups.downloadLink({ runId: r.id }))
                        }
                      >
                        {t("As stored (encrypted)")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void fetchDownload(
                            api.backups.downloadLink({ runId: r.id, decrypt: true }),
                          )
                        }
                      >
                        {t("Decrypted with its key")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 gap-1"
                    data-help="backups.download"
                    onClick={() => void fetchDownload(api.backups.downloadLink({ runId: r.id }))}
                  >
                    <Download className="size-3.5" />
                    {t("Download")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1"
                  data-help="backups.verify"
                  onClick={() =>
                    api.backups
                      .verify({ runId: r.id })
                      .then((v) =>
                        v.verifyOk
                          ? toast.success(v.verifyNote ?? t("Verified."))
                          : toast.error(v.verifyNote ?? ""),
                      )
                      .catch((e) => toast.error(message(e)))
                  }
                >
                  <ShieldCheck className="size-3.5" />
                  {t("Verify")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 gap-1"
                  data-help="backups.restore"
                  onClick={() => setRestoring(r)}
                >
                  <RotateCcw className="size-3.5" />
                  {t("Restore")}
                </Button>
              </>
            ) : null}
          </div>
          <div className="text-muted-foreground [overflow-wrap:anywhere]">
            {r.state === "ok"
              ? t("{size} in {s} s, on {where}: {path}", {
                  size: bytes(r.size ?? 0),
                  s: Math.max(1, Math.round((r.durationMs ?? 0) / 1000)),
                  where: r.location,
                  path: r.path ?? "",
                })
              : (r.error ?? t("Running…"))}
          </div>
          {r.checksum ? (
            <div className="font-mono text-[10px] text-muted-foreground [overflow-wrap:anywhere]">
              sha256 {r.checksum}
            </div>
          ) : null}
          {r.verifiedAt ? (
            <div
              className={`flex items-center gap-1 ${r.verifyOk ? "text-success" : "text-destructive"}`}
            >
              {r.verifyOk ? <CheckCircle2 className="size-3" /> : <XCircle className="size-3" />}
              {r.verifyNote} ({ago(r.verifiedAt)})
            </div>
          ) : null}
        </div>
      ))}
      {restoring ? <RestoreDialog run={restoring} onClose={() => setRestoring(null)} /> : null}
    </div>
  );
}

/**
 * Restore, always in two steps (ADR-044): what it replaces and where, then
 * the database's name typed back. Only from here, never by an agent.
 */
export function RestoreDialog({ run, onClose }: { run: BackupRunView; onClose: () => void }) {
  const plan = useLive(() => api.backups.plans(), { topics: [] }).data?.find(
    (p) => p.id === run.planId,
  );
  const servers = useServers().data ?? [];
  const [other, setOther] = useState(false);
  const [target, setTarget] = useState<BackupTarget | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tgt = target ?? plan?.target ?? null;
  const set = (patch: Partial<BackupTarget>) => tgt && setTarget({ ...tgt, ...patch });

  const next = async () => {
    setError(null);
    setBusy(true);
    try {
      setPreview(
        await api.backups.prepareRestore({
          runId: run.id,
          ...(other && tgt ? { target: tgt } : {}),
          ...(other && password ? { password } : {}),
        }),
      );
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async () => {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const r = await api.backups.restore({ token: preview.token, confirm: typed });
      toast.success(r.note);
      onClose();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Restore a backup")}</DialogTitle>
          <DialogDescription>
            {t("The backup of {when}{plan}.", {
              when: new Date(run.startedAt).toLocaleString(),
              plan: plan ? ` (${plan.name})` : "",
            })}
          </DialogDescription>
        </DialogHeader>
        {!preview ? (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              <Switch id="rs-other" checked={other} onCheckedChange={setOther} />
              <Label htmlFor="rs-other">{t("Into another database")}</Label>
            </div>
            {other && tgt ? (
              <div className="grid gap-2 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="rs-server">{t("Server")}</Label>
                  <Select value={tgt.serverId} onValueChange={(v) => set({ serverId: v })}>
                    <SelectTrigger id="rs-server" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {servers.map((s) => (
                        <SelectItem key={s.id} value={s.id}>
                          {s.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="rs-container">{t("Container (empty: on the server)")}</Label>
                  <Input
                    id="rs-container"
                    value={tgt.container ?? ""}
                    onChange={(e) => set({ container: e.target.value || null })}
                  />
                </div>
                {tgt.kind === "sqlite" ? (
                  <div className="space-y-1 sm:col-span-2">
                    <Label htmlFor="rs-path">{t("Database file")}</Label>
                    <Input
                      id="rs-path"
                      value={tgt.path ?? ""}
                      onChange={(e) => set({ path: e.target.value || null })}
                    />
                  </div>
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="rs-host">{t("Host")}</Label>
                      <Input
                        id="rs-host"
                        value={tgt.host ?? ""}
                        onChange={(e) => set({ host: e.target.value || null })}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="rs-port">{t("Port")}</Label>
                      <Input
                        id="rs-port"
                        value={tgt.port ?? ""}
                        onChange={(e) => set({ port: num(e.target.value) })}
                      />
                    </div>
                    {tgt.kind === "redis" ? null : (
                      <div className="space-y-1">
                        <Label htmlFor="rs-db">{t("Database")}</Label>
                        <Input
                          id="rs-db"
                          value={tgt.database ?? ""}
                          onChange={(e) => set({ database: e.target.value || null })}
                        />
                      </div>
                    )}
                    <div className="space-y-1">
                      <Label htmlFor="rs-user">{t("User")}</Label>
                      <Input
                        id="rs-user"
                        value={tgt.user ?? ""}
                        onChange={(e) => set({ user: e.target.value || null })}
                      />
                    </div>
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="rs-password">
                        {t("Its password (used for this restore only)")}
                      </Label>
                      <Input
                        id="rs-password"
                        type="password"
                        autoComplete="off"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="text-muted-foreground">
                {t("Into the plan's own database, with its kept password.")}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
              {preview.summary}
            </div>
            <div className="space-y-1">
              <Label htmlFor="rs-confirm">
                {t("Type {word} to confirm", { word: `“${preview.confirmWord}”` })}
              </Label>
              <Input
                id="rs-confirm"
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            </div>
          </div>
        )}
        {error ? <div className="text-sm text-destructive">{error}</div> : null}
        <DialogFooter>
          <Button variant="secondary" autoFocus onClick={onClose}>
            {t("Cancel")}
          </Button>
          {preview ? (
            <Button
              variant="destructive"
              disabled={busy || typed.trim() !== preview.confirmWord}
              onClick={() => void restore()}
            >
              {t("Restore now")}
            </Button>
          ) : (
            <Button disabled={busy || !plan} onClick={() => void next()}>
              {t("Continue")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Keys

/** The private key as a file, the way age-keygen writes one. */
export function keyFile(k: { name: string; publicKey: string; privateKey: string }) {
  return `# Oraknid backup key "${k.name}"\n# created: ${new Date().toISOString()}\n# public key: ${k.publicKey}\n${k.privateKey}\n`;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function BackupKeys() {
  const keys = useLive(() => api.backups.keys(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("backup.key") || e.type.startsWith("backup.plan"),
  });
  const { confirm, dialog } = useConfirm();
  const [making, setMaking] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [shown, setShown] = useState<{
    name: string;
    publicKey: string;
    privateKey: string;
  } | null>(null);
  if (keys.error) return <ErrorNote error={keys.error} />;
  if (!keys.data) return <Loading rows={2} />;

  const takeOnce = (id: string) =>
    api.backups
      .exportKey({ id })
      .then(setShown)
      .catch((e) => toast.error(message(e)));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("Keys")}</CardTitle>
        <CardDescription>
          {t(
            "age keys: the public half encrypts backups; the private half stays in the keychain and is used only to verify and restore. Download it once and keep it somewhere safe: without it an encrypted backup can't be read.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {keys.data.length === 0 ? (
          <div className="text-sm text-muted-foreground">{t("No keys yet.")}</div>
        ) : null}
        {keys.data.map((k) => (
          <div key={k.id} className="space-y-1 rounded-md border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <KeyRound className="size-3.5 text-muted-foreground" />
              <span className="font-medium">{k.name}</span>
              {k.imported ? <Badge variant="outline">{t("imported")}</Badge> : null}
              <Badge variant="outline">
                {k.planCount === 1 ? t("1 plan") : t("{n} plans", { n: k.planCount })}
              </Badge>
              <span className="flex-1" />
              {k.exportedAt ? null : (
                <Button
                  size="sm"
                  variant="secondary"
                  className="gap-1"
                  onClick={() => void takeOnce(k.id)}
                >
                  <Download className="size-3.5" />
                  {t("Take the private key (once)")}
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={t("Remove {name}", { name: k.name })}
                onClick={async () => {
                  if (
                    !(await confirm(
                      t("Remove the key {name}?", { name: k.name }),
                      t(
                        "Its private half leaves the keychain: backups made with it can only be read with your own copy.",
                      ),
                      t("Remove"),
                      { keep: t("Keep it") },
                    ))
                  )
                    return;
                  act(api.backups.removeKey({ id: k.id }), t("Removed."));
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
            <div className="flex items-center gap-1">
              <code
                className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
                title={k.publicKey}
              >
                {k.publicKey}
              </code>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1"
                aria-label={t("Copy the public key")}
                onClick={() => act(navigator.clipboard.writeText(k.publicKey), t("Copied."))}
              >
                <Copy className="size-3" />
              </Button>
            </div>
            {k.exportedAt ? null : (
              <div className="text-xs text-warning">
                {t("Its private key isn't saved anywhere but this computer's keychain yet.")}
              </div>
            )}
          </div>
        ))}
        {dialog}
        {making || importing ? (
          <form
            className="space-y-2 rounded-md border p-3"
            onSubmit={(e) => {
              e.preventDefault();
              const p = making
                ? api.backups.createKey({ name: name.trim() }).then((k) => takeOnce(k.id))
                : api.backups
                    .importKey({ name: name.trim(), privateKey: privateKey.trim() })
                    .then(() => {
                      toast.success(t("Key imported."));
                    });
              p.then(() => {
                setMaking(false);
                setImporting(false);
                setName("");
                setPrivateKey("");
              }).catch((err) => toast.error(message(err)));
            }}
          >
            <div className="space-y-1">
              <Label htmlFor="key-name">{t("Name")}</Label>
              <Input
                id="key-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("Offsite")}
              />
            </div>
            {importing ? (
              <div className="space-y-1">
                <Label htmlFor="key-private">{t("Private key")}</Label>
                <Textarea
                  id="key-private"
                  className="font-mono text-xs"
                  value={privateKey}
                  onChange={(e) => setPrivateKey(e.target.value)}
                  placeholder="AGE-SECRET-KEY-1…"
                />
              </div>
            ) : null}
            <div className="flex gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={!name.trim() || (importing && !privateKey.trim())}
              >
                {making ? t("Make it") : t("Import it")}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => {
                  setMaking(false);
                  setImporting(false);
                }}
              >
                {t("Cancel")}
              </Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              className="gap-1"
              data-help="backups.new-key"
              onClick={() => setMaking(true)}
            >
              <Plus className="size-3.5" />
              {t("Make a key")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-help="backups.import-key"
              onClick={() => setImporting(true)}
            >
              {t("Import a key")}
            </Button>
          </div>
        )}
        <Dialog open={!!shown} onOpenChange={(o) => !o && setShown(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {t("The private key of {name}", { name: shown?.name ?? "" })}
              </DialogTitle>
              <DialogDescription>
                {t(
                  "Shown this once. Download it and keep it somewhere safe, away from this computer: it's what reads your encrypted backups if this computer is lost.",
                )}
              </DialogDescription>
            </DialogHeader>
            <code
              className="block rounded-md bg-muted p-2 font-mono text-xs break-all"
              data-testid="private-key"
            >
              {shown?.privateKey}
            </code>
            <DialogFooter>
              <Button
                variant="secondary"
                className="gap-1"
                onClick={() =>
                  shown && act(navigator.clipboard.writeText(shown.privateKey), t("Copied."))
                }
              >
                <Copy className="size-3.5" />
                {t("Copy")}
              </Button>
              <Button
                className="gap-1"
                onClick={() =>
                  shown &&
                  download(
                    `oraknid-backup-key-${shown.name.replace(/[^\w-]+/g, "-")}.txt`,
                    keyFile(shown),
                  )
                }
              >
                <Download className="size-3.5" />
                {t("Download")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  /** Its id in the help map (ADR-041). */
  help: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3" data-help={help}>
      <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

/** Settings → Backups: every plan, the latest backups, the keys. */
export function BackupsSettings() {
  const plans = useLive(() => api.backups.plans(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("backup."),
  });
  return (
    <>
      <Section help="settings.backups" title={t("Backup plans")}>
        <BackupPlans />
      </Section>
      <Section help="settings.backup-runs" title={t("Latest backups")}>
        <BackupRuns plans={plans.data} />
      </Section>
      <Section help="settings.backup-keys" title={t("Encryption keys")}>
        <BackupKeys />
      </Section>
    </>
  );
}
