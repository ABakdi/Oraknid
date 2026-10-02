import type { ServerSample, ServerView } from "@oraknid/contracts";
import {
  ChevronRight,
  Plus,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Empty, ErrorNote, Loading, Markdown, PageHeader } from "@/components/common";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { api, message } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";

const act = (p: Promise<unknown>, ok?: string) =>
  p.then(() => ok && toast.success(ok)).catch((e) => toast.error(message(e)));

/** My servers (Servers spec): state documents, oraknid-monitor, a terminal. */
export function ServersPage() {
  const servers = useLive(() => api.servers.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("server."),
  });
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (servers.error) return <ErrorNote error={servers.error} />;
  if (servers.loading) return <Loading />;
  const add = (
    <Button className="gap-1" onClick={() => setAdding(true)}>
      <Plus className="size-4" />
      {t("Add a server")}
    </Button>
  );
  return (
    <div className="space-y-4">
      <PageHeader
        title={t("Servers")}
        sub={t("What runs where: each with its state document, its readings, and a terminal.")}
        actions={add}
      />
      {(servers.data ?? []).length === 0 ? (
        <Empty title={t("No servers yet")} action={add}>
          {t(
            "Add one over SSH: Oraknid reads what's on it (only reads), writes its state document, and shows how it's doing.",
          )}
        </Empty>
      ) : null}
      {(servers.data ?? []).map((s) => (
        <ServerCard
          key={s.id}
          s={s}
          open={open.has(s.id)}
          onToggle={() =>
            setOpen((o) => {
              const n = new Set(o);
              if (n.has(s.id)) n.delete(s.id);
              else n.add(s.id);
              return n;
            })
          }
        />
      ))}
      <AddServer open={adding} onOpenChange={setAdding} />
    </div>
  );
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

function ServerCard({ s, open, onToggle }: { s: ServerView; open: boolean; onToggle: () => void }) {
  const [, go] = useLocation();
  const l = s.latest;
  return (
    <Card className="gap-0 py-0">
      <CardHeader className="py-3">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            aria-expanded={open}
            onClick={onToggle}
          >
            <ChevronRight
              className={`size-4 shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
            />
            <Server className="size-4 shrink-0" />
            <span className="truncate">{s.name}</span>
            <Badge
              variant={s.error ? "destructive" : s.setup === "ready" ? "outline" : "secondary"}
            >
              {s.busy ??
                (s.error ? t("unreachable") : s.setup === "ready" ? t("ready") : t("not set up"))}
            </Badge>
            <span className="hidden truncate font-mono text-xs font-normal text-muted-foreground sm:inline">
              {s.user}@{s.host}
              {s.port !== 22 ? `:${s.port}` : ""}
            </span>
            {l ? (
              <span className="hidden text-xs font-normal text-muted-foreground md:inline">
                · CPU {Math.round(l.cpuPercent)}% · {t("memory")} {pct(l.memUsed, l.memTotal)}% ·{" "}
                {t("disk")} {pct(l.diskUsed, l.diskTotal)}%
              </span>
            ) : null}
          </button>
          {s.setup === "new" ? (
            <Button
              size="sm"
              disabled={!!s.busy}
              onClick={() => act(api.servers.setup({ id: s.id }), t("Set up."))}
            >
              {t("Set up")}
            </Button>
          ) : null}
        </CardTitle>
      </CardHeader>
      {s.hostKeyOffered ? (
        <div className="mx-4 mb-3 space-y-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm">
          <div>
            {t(
              "The server's host key changed. Nothing connects until you accept it, and only if you know why it changed.",
            )}
          </div>
          <div className="font-mono text-xs [overflow-wrap:anywhere]">
            {t("was")} {s.hostKey} → {t("now")} {s.hostKeyOffered}
          </div>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => act(api.servers.acceptHostKey({ id: s.id }), t("Accepted."))}
          >
            {t("Accept the new key")}
          </Button>
        </div>
      ) : null}
      {open ? (
        <CardContent className="space-y-4 border-t pt-3 pb-4 text-sm">
          {s.error ? (
            <div className="text-destructive [overflow-wrap:anywhere]">{s.error}</div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {s.setup === "new"
                ? s.auth === "password"
                  ? t(
                      "Set up installs a key of Oraknid's own on it, deletes the password, reads what's there and installs oraknid-monitor.",
                    )
                  : t("Set up reads what's there (only reads) and installs oraknid-monitor.")
                : s.lastSeenAt
                  ? t("Seen {when}.", { when: ago(s.lastSeenAt) })
                  : ""}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="secondary"
              className="gap-1"
              disabled={s.setup !== "ready" || !!s.busy}
              onClick={() =>
                act(api.servers.discover({ id: s.id }), t("Its document is up to date."))
              }
            >
              <RefreshCw className="size-3.5" />
              {t("Discover again")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              className="gap-1"
              onClick={() => go(`/terminal/${s.id}`)}
            >
              <SquareTerminal className="size-3.5" />
              {t("Terminal")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="gap-1"
              onClick={() =>
                api.servers
                  .remove({ id: s.id })
                  .then((r) =>
                    toast.success(
                      r.cleaned
                        ? t("Removed, and Oraknid's things taken off it.")
                        : t("Removed here; Oraknid couldn't reach it to take its things off."),
                    ),
                  )
                  .catch((e) => toast.error(message(e)))
              }
            >
              <Trash2 className="size-3.5" />
              {t("Remove")}
            </Button>
          </div>
          {s.description ? (
            <div className="text-muted-foreground [overflow-wrap:anywhere]">{s.description}</div>
          ) : null}
          {s.setup === "ready" ? <Readings id={s.id} latest={l} /> : null}
          {s.stateVersion > 0 ? <StateDocument id={s.id} /> : null}
        </CardContent>
      ) : null}
    </Card>
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

function AddServer({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [f, setF] = useState({
    name: "",
    host: "",
    port: "22",
    user: "root",
    description: "",
    password: "",
    privateKey: "",
    passphrase: "",
  });
  const [withKey, setWithKey] = useState(true);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true);
    try {
      await api.servers.add({
        name: f.name,
        host: f.host.trim(),
        port: Number(f.port) || 22,
        user: f.user.trim(),
        description: f.description,
        ...(withKey
          ? { privateKey: f.privateKey, ...(f.passphrase ? { passphrase: f.passphrase } : {}) }
          : { password: f.password }),
      });
      toast.success(t("Added. Set it up from its card."));
      onOpenChange(false);
      setF({ ...f, password: "", privateKey: "", passphrase: "" });
    } catch (e) {
      toast.error(message(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Add a server")}</DialogTitle>
          <DialogDescription>
            {t(
              "Over SSH. Credentials go to the keychain; a password is used once, to install a key of Oraknid's own.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="sv-name">{t("Name")}</Label>
              <Input id="sv-name" value={f.name} onChange={set("name")} placeholder="staging" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sv-host">{t("Host")}</Label>
              <Input
                id="sv-host"
                className="font-mono"
                value={f.host}
                onChange={set("host")}
                placeholder="203.0.113.7"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="sv-port">{t("Port")}</Label>
                <Input id="sv-port" inputMode="numeric" value={f.port} onChange={set("port")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sv-user">{t("User")}</Label>
                <Input id="sv-user" value={f.user} onChange={set("user")} />
              </div>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sv-desc">{t("What it is and what it has")}</Label>
            <Textarea
              id="sv-desc"
              rows={3}
              value={f.description}
              onChange={set("description")}
              placeholder={t("The VPS for my sites: nginx, two Node apps under pm2, Postgres.")}
            />
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={withKey ? "default" : "secondary"}
              onClick={() => setWithKey(true)}
            >
              {t("A private key")}
            </Button>
            <Button
              size="sm"
              variant={withKey ? "secondary" : "default"}
              onClick={() => setWithKey(false)}
            >
              {t("A password")}
            </Button>
          </div>
          {withKey ? (
            <>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor="sv-key" className="flex-1">
                    {t("Private key")}
                  </Label>
                  <Button asChild size="sm" variant="ghost" className="h-7 gap-1">
                    <label className="cursor-pointer">
                      <Upload className="size-3.5" />
                      {t("From a file")}
                      <input
                        type="file"
                        className="sr-only"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (file) setF({ ...f, privateKey: await file.text() });
                        }}
                      />
                    </label>
                  </Button>
                </div>
                <Textarea
                  id="sv-key"
                  rows={4}
                  className="font-mono text-xs"
                  value={f.privateKey}
                  onChange={set("privateKey")}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sv-pass">{t("Its passphrase, if it has one")}</Label>
                <Input
                  id="sv-pass"
                  type="password"
                  autoComplete="off"
                  value={f.passphrase}
                  onChange={set("passphrase")}
                />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="sv-pw">{t("Password")}</Label>
              <Input
                id="sv-pw"
                type="password"
                autoComplete="off"
                value={f.password}
                onChange={set("password")}
              />
            </div>
          )}
          <Button
            className="w-full"
            disabled={
              busy || !f.name || !f.host || !f.user || (withKey ? !f.privateKey : !f.password)
            }
            onClick={save}
          >
            {t("Add")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
