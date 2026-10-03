import type { ServerSample, ServerView } from "@oraknid/contracts";
import { Pencil, Plus, RefreshCw, Server, SquareTerminal, Trash2 } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { AddServer } from "@/components/add-server";
import { BackButton, Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { type PageTab, PageTabs } from "@/components/page-tabs";
import { ServerBackupsTab } from "@/components/server-backups";
import {
  ServerDatabasesTab,
  ServerDockerTab,
  ServerLogsTab,
  ServerProxyTab,
} from "@/components/server-insight";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// xterm.js only when a server's Terminal tab opens.
const ServerTerminal = lazy(() =>
  import("@/pages/terminal").then((m) => ({ default: m.ServerTerminal })),
);

const act = (p: Promise<unknown>, ok?: string) =>
  p.then(() => ok && toast.success(ok)).catch((e) => toast.error(message(e)));

/** My servers (Servers spec): state documents, oraknid-monitor, a terminal. */
export function ServersPage({ id, tab }: { id?: string; tab?: string }) {
  const [, go] = useLocation();
  const servers = useLive(() => api.servers.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
  });
  const [adding, setAdding] = useState(false);
  if (servers.error) return <ErrorNote error={servers.error} />;
  if (servers.loading) return <Loading />;
  const list = servers.data ?? [];
  const add = (
    <Button data-help="servers.add" className="gap-1" size="sm" onClick={() => setAdding(true)}>
      <Plus className="size-4" />
      {t("Add a server")}
    </Button>
  );
  if (list.length === 0)
    return (
      <div className="space-y-4">
        <PageHeader
          title={t("Servers")}
          sub={t("What runs where: each with its state document, its readings, and a terminal.")}
        />
        <Empty title={t("No servers yet")} action={add}>
          {t(
            "Add one over SSH: Oraknid reads what's on it (only reads), writes its state document, and shows how it's doing.",
          )}
        </Empty>
        <AddServer open={adding} onOpenChange={setAdding} onAdded={(x) => go(`/servers/${x.id}`)} />
      </div>
    );
  // A server open: its id in the address; on a computer the first one by default.
  const selected = list.find((x) => x.id === id);
  const shown =
    selected ?? (typeof window !== "undefined" && window.innerWidth >= 768 ? list[0] : undefined);
  return (
    <div className="-mb-24 flex h-[calc(100dvh-7.5rem)] min-h-0 gap-4 md:-mb-8 md:h-[calc(100dvh-4.5rem)]">
      <aside
        className={cn(
          "flex min-h-0 w-full shrink-0 flex-col gap-2 md:w-64",
          selected && "hidden md:flex",
        )}
      >
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-lg font-semibold">{t("Servers")}</h1>
          {add}
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {list.map((x) => {
            const l = x.latest;
            return (
              <button
                key={x.id}
                type="button"
                onClick={() => go(`/servers/${x.id}`)}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md border px-3 py-2 text-left text-sm hover:bg-accent",
                  shown?.id === x.id && "border-primary bg-accent",
                )}
              >
                <span className="flex items-center gap-2">
                  <Server className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium" title={x.name}>
                    {x.name}
                  </span>
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full",
                      x.error
                        ? "bg-destructive"
                        : x.setup === "ready"
                          ? "bg-success"
                          : "bg-warning",
                    )}
                  />
                </span>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {x.user}@{x.host}
                </span>
                {l ? (
                  <span className="text-xs text-muted-foreground">
                    CPU {Math.round(l.cpuPercent)}% · {t("memory")} {pct(l.memUsed, l.memTotal)}% ·{" "}
                    {t("disk")} {pct(l.diskUsed, l.diskTotal)}%
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </aside>
      <section className={cn("min-h-0 min-w-0 flex-1", !selected && "hidden md:block")}>
        {shown ? <ServerDetail key={shown.id} s={shown} tab={tab} /> : null}
      </section>
      <AddServer open={adding} onOpenChange={setAdding} onAdded={(x) => go(`/servers/${x.id}`)} />
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/** One server: its header and actions, then Readings · State document · About in tabs. */
function ServerDetail({ s, tab }: { s: ServerView; tab?: string }) {
  const [, go] = useLocation();
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = useState<{ name: string; description: string } | null>(null);
  const remove = async () => {
    if (
      !(await confirm(
        t("Remove “{name}”?", { name: s.name }),
        t(
          "Oraknid takes its key and oraknid-monitor off the server if it can reach it, and forgets the server, its readings and its state document. Projects stop using it.",
        ),
        t("Remove"),
        { keep: t("Keep it") },
      ))
    )
      return;
    api.servers
      .remove({ id: s.id })
      .then((r) => {
        toast.success(
          r.cleaned
            ? t("Removed, and Oraknid's things taken off it.")
            : t("Removed here; Oraknid couldn't reach it to take its things off."),
        );
        go("/servers", { replace: true });
      })
      .catch((e) => toast.error(message(e)));
  };
  const acceptKey = async () => {
    if (
      await confirm(
        t("Trust the new host key?"),
        t(
          "Only if you know why it changed (a reinstall, a new server at the same address). Otherwise someone may be in the middle.",
        ),
        t("Accept the new key"),
      )
    )
      void act(api.servers.acceptHostKey({ id: s.id }), t("Accepted."));
  };
  const header = (
    <div className="shrink-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <BackButton fallback="/servers" label={t("All servers")} className="md:hidden" />
        <h2 className="min-w-0 truncate text-lg font-semibold" title={s.name}>
          {s.name}
        </h2>
        <Badge variant={s.error ? "destructive" : s.setup === "ready" ? "outline" : "secondary"}>
          {s.busy ??
            (s.error ? t("unreachable") : s.setup === "ready" ? t("ready") : t("not set up"))}
        </Badge>
        <span className="truncate font-mono text-xs text-muted-foreground">
          {s.user}@{s.host}
          {s.port !== 22 ? `:${s.port}` : ""}
        </span>
        <span className="flex-1" />
        {s.setup === "new" ? (
          <Button
            size="sm"
            disabled={!!s.busy}
            onClick={() => act(api.servers.setup({ id: s.id }), t("Set up."))}
          >
            {t("Set up")}
          </Button>
        ) : null}
        <Button
          data-help="server.discover"
          size="sm"
          variant="secondary"
          className="gap-1"
          disabled={s.setup !== "ready" || !!s.busy}
          onClick={() => act(api.servers.discover({ id: s.id }), t("Its document is up to date."))}
        >
          <RefreshCw className="size-3.5" />
          {t("Discover again")}
        </Button>
        <Button
          data-help="server.terminal"
          size="sm"
          variant="secondary"
          className="gap-1"
          onClick={() => go(`/terminal/${s.id}`)}
        >
          <SquareTerminal className="size-3.5" />
          {t("Terminal")}
        </Button>
      </div>
      {s.error ? (
        <div className="text-sm text-destructive [overflow-wrap:anywhere]">{s.error}</div>
      ) : null}
      {s.hostKeyOffered ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <div>
            {t(
              "The server's host key changed. Nothing connects until you accept it, and only if you know why it changed.",
            )}
          </div>
          <div className="font-mono text-xs [overflow-wrap:anywhere]">
            {t("was")} {s.hostKey} → {t("now")} {s.hostKeyOffered}
          </div>
          <Button size="sm" variant="destructive" onClick={acceptKey}>
            {t("Accept the new key")}
          </Button>
        </div>
      ) : null}
    </div>
  );
  const about = (
    <div className="space-y-3 text-sm">
      {s.description ? (
        <div className="text-muted-foreground [overflow-wrap:anywhere]">{s.description}</div>
      ) : null}
      <div className="text-xs text-muted-foreground">
        {s.setup === "new"
          ? s.auth === "password"
            ? t(
                "Set up installs a key of Oraknid's own on it, deletes the password, reads what's there and installs oraknid-monitor.",
              )
            : t("Set up reads what's there (only reads) and installs oraknid-monitor.")
          : s.lastSeenAt
            ? t("Seen {when}.", { when: ago(s.lastSeenAt) })
            : ""}
      </div>
      {editing ? (
        <form
          className="space-y-3 rounded-md border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            void act(
              api.servers
                .update({
                  id: s.id,
                  name: editing.name.trim(),
                  description: editing.description,
                })
                .then(() => setEditing(null)),
              t("Saved."),
            );
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="se-name">{t("Name")}</Label>
            <Input
              id="se-name"
              value={editing.name}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="se-desc">{t("What it is and what it has")}</Label>
            <Textarea
              id="se-desc"
              rows={3}
              value={editing.description}
              onChange={(e) => setEditing({ ...editing, description: e.target.value })}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(null)}>
              {t("Cancel")}
            </Button>
            <Button type="submit" size="sm" disabled={!editing.name.trim()}>
              {t("Save")}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="gap-1"
            onClick={() => setEditing({ name: s.name, description: s.description })}
          >
            <Pencil className="size-3.5" />
            {t("Edit")}
          </Button>
          <Button size="sm" variant="ghost" className="gap-1 text-destructive" onClick={remove}>
            <Trash2 className="size-3.5" />
            {t("Remove this server")}
          </Button>
        </div>
      )}
    </div>
  );
  // A server's tabs (ADR-043): what runs there is read only once it is set up.
  const ready = s.setup === "ready";
  const tabs: PageTab[] = [
    {
      id: "overview",
      label: t("Overview"),
      content: () => (
        <div className="space-y-6">
          {ready ? <Readings id={s.id} latest={s.latest} /> : null}
          {about}
        </div>
      ),
    },
    ...(ready
      ? [
          { id: "docker", label: t("Docker"), content: () => <ServerDockerTab server={s} /> },
          {
            id: "databases",
            label: t("Databases"),
            content: () => <ServerDatabasesTab server={s} />,
          },
          {
            id: "proxy",
            label: t("Proxy & traffic"),
            content: () => <ServerProxyTab server={s} />,
          },
          { id: "logs", label: t("Logs"), fill: true, content: () => <ServerLogsTab server={s} /> },
        ]
      : []),
    { id: "backups", label: t("Backups"), content: () => <ServerBackupsTab server={s} /> },
    {
      id: "terminal",
      label: t("Terminal"),
      fill: true,
      content: () => (
        <Suspense fallback={<Loading />}>
          <ServerTerminal id={s.id} name={s.name} />
        </Suspense>
      ),
    },
    ...(s.stateVersion > 0
      ? [{ id: "state", label: t("State document"), content: () => <StateDocument id={s.id} /> }]
      : []),
  ];
  return (
    <PageTabs
      base={`/servers/${s.id}`}
      tab={tab}
      tabs={tabs}
      header={
        <>
          {header}
          {dialog}
        </>
      }
      className="mb-0 h-full md:mb-0 md:h-full"
    />
  );
}

/** A tiny line of the last 24 hours. */
function Spark({ values, max }: { values: number[]; max: number }) {
  if (values.length < 2) return null;
  const w = 160;
  const h = 32;
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (Math.min(v, max) / (max || 1)) * h}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className="h-8 w-full text-primary"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function Readings({ id, latest }: { id: string; latest: ServerSample | null }) {
  const samples = useLive(() => api.servers.samples({ id, since: Date.now() - 24 * 3600_000 }), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
    deps: [id],
  });
  const all = samples.data ?? [];
  const l = latest ?? all.at(-1) ?? null;
  if (!l)
    return (
      <div className="text-xs text-muted-foreground">
        {t("No reading yet: oraknid-monitor answers every 15 seconds.")}
      </div>
    );
  const tile = (label: string, value: string, series: number[], max: number) => (
    <div className="min-w-0 space-y-1 rounded-md border p-2">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="font-medium text-foreground">{value}</span>
      </div>
      <Spark values={series} max={max} />
    </div>
  );
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {tile(
          "CPU",
          `${Math.round(l.cpuPercent)}%`,
          all.map((x) => x.cpuPercent),
          100,
        )}
        {tile(
          t("Memory"),
          `${bytes(l.memUsed)} / ${bytes(l.memTotal)}`,
          all.map((x) => pct(x.memUsed, x.memTotal)),
          100,
        )}
        {tile(
          t("Disk"),
          `${bytes(l.diskUsed)} / ${bytes(l.diskTotal)}`,
          all.map((x) => pct(x.diskUsed, x.diskTotal)),
          100,
        )}
        {tile(
          t("Load · connections"),
          `${l.load1} · ${l.connections}`,
          all.map((x) => x.load1),
          Math.max(1, ...all.map((x) => x.load1)),
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer text-xs font-medium">
            {t("Running services ({n})", { n: l.services.length })}
          </summary>
          <ul className="mt-1 max-h-48 overflow-y-auto font-mono text-xs">
            {l.services.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
        <details className="rounded-md border p-2">
          <summary className="cursor-pointer text-xs font-medium">
            {t("Listening ports ({n})", { n: l.ports.length })}
          </summary>
          <ul className="mt-1 max-h-48 overflow-y-auto font-mono text-xs">
            {l.ports.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

function StateDocument({ id }: { id: string }) {
  const doc = useLive(() => api.servers.state({ id }), {
    topics: ["overview"],
    refreshOn: (e) => e.type === "server.state",
    deps: [id],
  });
  const [editing, setEditing] = useState<string | null>(null);
  if (!doc.data) return null;
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-medium">{t("State document")}</div>
        <Badge variant="outline">
          v{doc.data.version} · {doc.data.source === "eye" ? t("by The Eye") : t("by you")} ·{" "}
          {ago(doc.data.createdAt)}
        </Badge>
        <span className="flex-1" />
        {editing === null ? (
          <Button size="sm" variant="ghost" onClick={() => setEditing(doc.data?.body ?? "")}>
            {t("Edit")}
          </Button>
        ) : (
          <>
            <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t("Cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() =>
                api.servers
                  .editState({ id, body: editing })
                  .then(() => {
                    setEditing(null);
                    toast.success(t("Saved as a new version."));
                  })
                  .catch((e) => toast.error(message(e)))
              }
            >
              {t("Save")}
            </Button>
          </>
        )}
      </div>
      {editing === null ? (
        <Markdown text={doc.data.body} />
      ) : (
        <Textarea
          rows={18}
          className="font-mono text-xs"
          value={editing}
          onChange={(e) => setEditing(e.target.value)}
        />
      )}
    </div>
  );
}
