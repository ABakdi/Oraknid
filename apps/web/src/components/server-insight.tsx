import type {
  ProxyCertificate,
  ServerContainer,
  ServerDatabase,
  ServerLogSource,
  ServerView,
} from "@oraknid/contracts";
import { Pause, Play, RefreshCw, RotateCw, ScrollText, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { useLocation } from "wouter";
import { Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, message } from "@/lib/api";
import { ago, bytes } from "@/lib/format";
import { t } from "@/lib/i18n";
import { live } from "@/lib/live";
import { cn } from "@/lib/utils";

// What runs on a server (ADR-043): Docker, databases, the proxy and its
// traffic, logs. Each part is read while its tab is open, again every so
// often while the page is in sight; nothing is kept.

/**
 * A part of the server, read now and again every `everyMs` while the page
 * is visible; Refresh asks the server rather than the daemon's short cache.
 */
function usePart<T>(load: (fresh: boolean) => Promise<{ at: number; data: T }>, everyMs: number) {
  const [state, setState] = useState<{ at: number; data: T } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const run = (fresh: boolean) => {
    setBusy(true);
    return loadRef
      .current(fresh)
      .then((r) => {
        setState(r);
        setError(null);
      })
      .catch(setError)
      .finally(() => setBusy(false));
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once, then on its timer
  useEffect(() => {
    void run(false);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void run(false);
    }, everyMs);
    return () => clearInterval(timer);
  }, []);
  return { data: state?.data, at: state?.at, error, busy, refresh: () => run(true) };
}

function ReadAt({ at, busy, onRefresh }: { at?: number; busy: boolean; onRefresh: () => void }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="flex-1">{at ? t("Read {when}.", { when: ago(at) }) : t("Reading…")}</span>
      <Button
        data-help="server.refresh"
        size="sm"
        variant="ghost"
        className="gap-1"
        disabled={busy}
        onClick={onRefresh}
      >
        <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        {t("Refresh")}
      </Button>
    </div>
  );
}

/** What a part couldn't read, and why, in a box that says so. */
function Unread({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm [overflow-wrap:anywhere]">
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

const stateVariant = (s: string) =>
  ["running", "active"].includes(s)
    ? "outline"
    : ["exited", "dead", "failed", "inactive"].includes(s)
      ? "destructive"
      : "secondary";

// ── The log the Logs tab shows: another tab's Logs button picks it.

let pickedLog: string | null = null;
const pickListeners = new Set<() => void>();
const pickLog = (source: string) => {
  pickedLog = source;
  for (const l of pickListeners) l();
};
const usePickedLog = () =>
  useSyncExternalStore(
    (cb) => {
      pickListeners.add(cb);
      return () => pickListeners.delete(cb);
    },
    () => pickedLog,
  );

/** Opens a log on the Logs tab. */
function LogsButton({ id, source }: { id: string; source: string }) {
  const [, go] = useLocation();
  return (
    <Button
      size="sm"
      variant="ghost"
      className="h-7 gap-1 px-2"
      onClick={() => {
        pickLog(source);
        go(`/servers/${id}/logs`);
      }}
    >
      <ScrollText className="size-3.5" />
      {t("Logs")}
    </Button>
  );
}

/** Restart, asked first (ADR-043, like any change on a server). */
function RestartButton({
  server,
  kind,
  name,
  onDone,
}: {
  server: ServerView;
  kind: "container" | "service";
  name: string;
  onDone?: () => void;
}) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    if (
      !(await confirm(
        t("Restart {name}?", { name }),
        kind === "container"
          ? t(
              "Oraknid runs docker restart {name} on {server}. What it serves stops for a moment. It is in the audit log.",
              { name, server: server.name },
            )
          : t(
              "Oraknid runs systemctl restart {name} on {server} (as root, or with sudo when it asks no password). What it serves stops for a moment. It is in the audit log.",
              { name, server: server.name },
            ),
        t("Restart"),
        { keep: t("Leave it running") },
      ))
    )
      return;
    setBusy(true);
    api.servers
      .restart({ id: server.id, kind, name, confirm: true })
      .then(() => {
        toast.success(t("{name} restarted.", { name }));
        onDone?.();
      })
      .catch((e) => toast.error(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Button
        data-help="server.restart"
        size="sm"
        variant="ghost"
        className="h-7 gap-1 px-2"
        disabled={busy}
        onClick={ask}
      >
        <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
        {t("Restart")}
      </Button>
      {dialog}
    </>
  );
}

// ── Docker

function ContainerRow({
  server,
  c,
  onChange,
}: {
  server: ServerView;
  c: ServerContainer;
  onChange: () => void;
}) {
  return (
    <li className="space-y-1 rounded-md border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium [overflow-wrap:anywhere]">{c.name}</span>
        <Badge variant={stateVariant(c.state)}>{c.state}</Badge>
        {c.health ? (
          <Badge variant={c.health === "unhealthy" ? "destructive" : "outline"}>{c.health}</Badge>
        ) : null}
        <span className="flex-1" />
        <LogsButton id={server.id} source={`container:${c.name}`} />
        <RestartButton server={server} kind="container" name={c.name} onDone={onChange} />
      </div>
      <div className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {c.image}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
        {c.uptime ? <span>{t("up {time}", { time: c.uptime })}</span> : <span>{c.status}</span>}
        {c.cpuPercent !== null ? <span>CPU {c.cpuPercent}%</span> : null}
        {c.memBytes !== null ? (
          <span>
            {t("memory")} {bytes(c.memBytes)}
            {c.memLimit ? ` / ${bytes(c.memLimit)}` : ""}
          </span>
        ) : null}
        {c.ports ? <span className="font-mono [overflow-wrap:anywhere]">{c.ports}</span> : null}
      </div>
    </li>
  );
}

export function ServerDockerTab({ server }: { server: ServerView }) {
  const part = usePart((fresh) => api.servers.docker({ id: server.id, fresh }), 30_000);
  if (part.error && !part.data) return <ErrorNote error={part.error} />;
  if (!part.data) return <Loading />;
  const d = part.data;
  const head = <ReadAt at={part.at} busy={part.busy} onRefresh={part.refresh} />;
  if (d.error)
    return (
      <div className="space-y-3">
        {head}
        <Unread>{d.error}</Unread>
      </div>
    );
  if (!d.engine)
    return (
      <div className="space-y-3">
        {head}
        <Empty title={t("No Docker here")}>
          {t("Neither Docker nor Podman is installed on this server.")}
        </Empty>
      </div>
    );
  // Compose projects together, then the containers on their own.
  const groups = new Map<string, ServerContainer[]>();
  for (const c of d.containers) {
    const k = c.project ?? "";
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  const order = [...groups.keys()].sort((a, b) =>
    a === "" ? 1 : b === "" ? -1 : a.localeCompare(b),
  );
  const running = d.containers.filter((c) => c.state === "running").length;
  return (
    <div className="space-y-4">
      {head}
      <div className="text-sm text-muted-foreground">
        {t("{engine} {version}: {running} of {n} containers running.", {
          engine: d.engine === "podman" ? "Podman" : "Docker",
          version: d.version ?? "",
          running,
          n: d.containers.length,
        })}
      </div>
      {order.map((k) => (
        <Section
          key={k || "-"}
          title={k ? t("Compose project {name}", { name: k }) : t("Other containers")}
        >
          <ul className="space-y-2">
            {(groups.get(k) ?? []).map((c) => (
              <ContainerRow key={c.id} server={server} c={c} onChange={part.refresh} />
            ))}
          </ul>
        </Section>
      ))}
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">
          {t("Images ({n})", { n: d.images.length })}
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {d.images.map((m) => (
            <li
              key={`${m.id}${m.repository}${m.tag}`}
              className="flex flex-wrap items-center gap-2"
            >
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">
                {m.repository}:{m.tag}
              </span>
              <span className="text-muted-foreground">
                {bytes(m.sizeBytes)} · {m.created}
              </span>
              {m.inUse ? null : <Badge variant="secondary">{t("unused")}</Badge>}
            </li>
          ))}
        </ul>
      </details>
      <details className="rounded-md border p-2">
        <summary className="cursor-pointer text-sm font-medium">
          {t("Volumes ({n}) and networks ({m})", { n: d.volumes.length, m: d.networks.length })}
        </summary>
        <ul className="mt-2 space-y-1 text-xs">
          {d.volumes.map((v) => (
            <li key={v.name} className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 font-mono [overflow-wrap:anywhere]">{v.name}</span>
              {v.project ? <span className="text-muted-foreground">{v.project}</span> : null}
              {v.inUse ? null : <Badge variant="secondary">{t("unused")}</Badge>}
            </li>
          ))}
          {d.networks.map((n) => (
            <li key={`net-${n.name}`} className="flex flex-wrap gap-2">
              <span className="font-mono [overflow-wrap:anywhere]">{n.name}</span>
              <span className="text-muted-foreground">
                {t("network")} · {n.driver}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

// ── Databases

const KIND: Record<ServerDatabase["kind"], string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL / MariaDB",
  mongodb: "MongoDB",
  redis: "Redis",
  sqlite: "SQLite",
};

export function ServerDatabasesTab({ server }: { server: ServerView }) {
  const part = usePart((fresh) => api.servers.databases({ id: server.id, fresh }), 60_000);
  if (part.error && !part.data) return <ErrorNote error={part.error} />;
  if (!part.data) return <Loading />;
  const d = part.data;
  return (
    <div className="space-y-3">
      <ReadAt at={part.at} busy={part.busy} onRefresh={part.refresh} />
      {d.notes.map((n) => (
        <Unread key={n}>{n}</Unread>
      ))}
      {d.databases.length === 0 ? (
        <Empty title={t("No database found")}>
          {t(
            "Oraknid looks for PostgreSQL, MySQL or MariaDB, MongoDB and Redis, as services, processes or containers, and the SQLite files the state document or a backup plan names.",
          )}
        </Empty>
      ) : (
        <ul className="space-y-2">
          {d.databases.map((b) => (
            <li
              key={`${b.source}:${b.name}`}
              className="space-y-1 rounded-md border px-3 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{KIND[b.kind]}</span>
                {b.version ? <span className="text-muted-foreground">{b.version}</span> : null}
                <Badge variant={stateVariant(b.state)}>{b.state}</Badge>
                <span className="flex-1" />
                {b.source !== "process" && b.source !== "file" ? (
                  <>
                    <LogsButton
                      id={server.id}
                      source={b.source === "container" ? `container:${b.name}` : `unit:${b.name}`}
                    />
                    <RestartButton
                      server={server}
                      kind={b.source === "container" ? "container" : "service"}
                      name={b.name}
                      onDone={part.refresh}
                    />
                  </>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="[overflow-wrap:anywhere]">
                  {b.source === "container"
                    ? t("container {name}", { name: b.name })
                    : b.source === "service"
                      ? t("service {name}", { name: b.name })
                      : b.source === "file"
                        ? t("file {name}", { name: b.name })
                        : t("process {name}", { name: b.name })}
                </span>
                {b.port ? <span>{t("port {port}", { port: b.port })}</span> : null}
                {b.sizeBytes !== null ? <span>{bytes(b.sizeBytes)}</span> : null}
              </div>
              {b.note ? <div className="text-xs text-muted-foreground">{b.note}</div> : null}
              {b.sizes ? (
                <div className="text-xs text-muted-foreground">
                  {t("With the backup plan “{plan}”'s login:", { plan: b.sizes.plan })}{" "}
                  {b.sizes.error
                    ? b.sizes.error
                    : b.sizes.databases.map((x) => `${x.name} ${bytes(x.bytes)}`).join(" · ") ||
                      t("no databases it may see")}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ── The proxy and its traffic

/** When a certificate ends, and in what colour: red when gone or under two weeks. */
function CertEnd({ c }: { c: ProxyCertificate | undefined }) {
  if (!c) return null;
  if (!c.expiresAt) return <span className="text-muted-foreground">{c.error ?? ""}</span>;
  const days = Math.floor((c.expiresAt - Date.now()) / 86_400_000);
  return (
    <span className={cn(days < 14 ? "text-destructive" : "text-muted-foreground")}>
      {days < 0
        ? t("certificate ended {n} days ago", { n: -days })
        : t("certificate ends in {n} days", { n: days })}
    </span>
  );
}

function Traffic({ server }: { server: ServerView }) {
  const part = usePart((fresh) => api.servers.traffic({ id: server.id, fresh }), 30_000);
  if (part.error && !part.data) return <ErrorNote error={part.error} />;
  if (!part.data) return <Loading rows={2} />;
  const x = part.data;
  const max = Math.max(1, ...x.perMinute);
  const list = (items: { label: string; count: number }[]) => (
    <ul className="space-y-0.5 text-xs">
      {items.map((i) => (
        <li key={i.label} className="flex gap-2">
          <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">{i.label}</span>
          <span className="text-muted-foreground">{i.count}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="space-y-3">
      <ReadAt at={part.at} busy={part.busy} onRefresh={part.refresh} />
      {x.logs.length === 0 ? (
        <Unread>{t("No access log found: the proxy's traffic isn't counted.")}</Unread>
      ) : null}
      {x.logs
        .filter((l) => l.error)
        .map((l) => (
          <Unread key={l.path}>
            {l.path}: {l.error}
          </Unread>
        ))}
      <div className="text-sm">
        {t("{n} requests in the last {m} minutes, {bytes} sent.", {
          n: x.requests,
          m: x.windowMinutes,
          bytes: bytes(x.bytes),
        })}
      </div>
      <div
        className="flex h-16 items-end gap-0.5"
        role="img"
        aria-label={t("Requests per minute")}
        title={x.perMinute.join(" · ")}
      >
        {x.perMinute.map((n, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: a minute is its position
            key={i}
            className="min-w-0 flex-1 rounded-sm bg-primary/70"
            style={{ height: `${Math.max(2, (n / max) * 100)}%` }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["2xx", "3xx", "4xx", "5xx"] as const).map((k) => (
          <div key={k} className="rounded-md border px-2 py-1 text-xs">
            <div className="text-muted-foreground">{k}</div>
            <div
              className={cn(
                "text-base font-medium",
                k === "5xx" && x.statuses[k] > 0 && "text-destructive",
              )}
            >
              {x.statuses[k]}
            </div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Section title={t("Top paths")}>
          {list(x.paths.map((p) => ({ label: p.path, count: p.count })))}
        </Section>
        <Section title={t("Top clients")}>
          {list(x.clients.map((c) => ({ label: c.client, count: c.count })))}
        </Section>
        <Section title={t("Status codes")}>
          {list(x.codes.map((c) => ({ label: c.code, count: c.count })))}
        </Section>
        <Section title={t("Connections per port")}>
          {list(x.connections.map((c) => ({ label: c.port, count: c.count })))}
        </Section>
      </div>
      {x.unparsed ? (
        <div className="text-xs text-muted-foreground">
          {t("{n} lines in a format Oraknid doesn't read.", { n: x.unparsed })}
        </div>
      ) : null}
    </div>
  );
}

export function ServerProxyTab({ server }: { server: ServerView }) {
  const part = usePart((fresh) => api.servers.proxy({ id: server.id, fresh }), 120_000);
  if (part.error && !part.data) return <ErrorNote error={part.error} />;
  if (!part.data) return <Loading />;
  const d = part.data;
  return (
    <div className="space-y-4">
      <ReadAt at={part.at} busy={part.busy} onRefresh={part.refresh} />
      {d.notes.map((n) => (
        <Unread key={n}>{n}</Unread>
      ))}
      {d.proxies.length === 0 ? (
        <Empty title={t("No reverse proxy found")}>
          {t("Oraknid looks for nginx, Caddy, Traefik and HAProxy, as services or containers.")}
        </Empty>
      ) : null}
      {d.proxies.map((p) => {
        const certs = new Map(p.certificates.map((c) => [c.path, c]));
        return (
          <Section
            key={`${p.kind}:${p.name}`}
            title={`${p.kind}${p.version ? ` ${p.version}` : ""}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge variant={stateVariant(p.state)}>{p.state}</Badge>
              <span className="text-xs text-muted-foreground">
                {p.source === "container" ? t("container {name}", { name: p.name }) : t("service")}
              </span>
              {p.check ? (
                <Badge
                  variant={
                    p.check.ok === false ? "destructive" : p.check.ok ? "outline" : "secondary"
                  }
                  title={p.check.output}
                >
                  {p.check.ok === null
                    ? t("config not checked")
                    : p.check.ok
                      ? t("config ok")
                      : t("config has errors")}
                </Badge>
              ) : null}
              <span className="flex-1" />
              {p.source === "service" ? (
                <>
                  <LogsButton id={server.id} source={`unit:${p.kind}.service`} />
                  <RestartButton
                    server={server}
                    kind="service"
                    name={p.kind}
                    onDone={part.refresh}
                  />
                </>
              ) : (
                <LogsButton id={server.id} source={`container:${p.name}`} />
              )}
            </div>
            {p.check && p.check.ok !== true ? (
              <pre className="whitespace-pre-wrap rounded-md bg-muted px-2 py-1 text-xs [overflow-wrap:anywhere]">
                {p.check.output}
              </pre>
            ) : null}
            {p.note ? <div className="text-xs text-muted-foreground">{p.note}</div> : null}
            <ul className="space-y-1">
              {p.sites.map((s, i) => (
                <li
                  // biome-ignore lint/suspicious/noArrayIndexKey: sites have no id; the order is the config's
                  key={i}
                  className="rounded-md border px-3 py-1.5 text-xs"
                >
                  <div className="font-medium [overflow-wrap:anywhere]">
                    {s.names.join(" ") || t("(the default site)")}
                  </div>
                  <div className="flex flex-wrap gap-x-3 text-muted-foreground [overflow-wrap:anywhere]">
                    <span>
                      →{" "}
                      {s.upstreams.join(", ") ||
                        s.root ||
                        (s.redirect ? t("redirect {to}", { to: s.redirect }) : "?")}
                    </span>
                    {s.listen.length ? (
                      <span>{t("on {ports}", { ports: s.listen.join(", ") })}</span>
                    ) : null}
                    {s.certificate ? <CertEnd c={certs.get(s.certificate)} /> : null}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        );
      })}
      <Section title={t("Traffic")}>
        <Traffic server={server} />
      </Section>
    </div>
  );
}

// ── Logs

const KIND_LABEL: Record<ServerLogSource["kind"], string> = {
  service: "Services",
  container: "Containers",
  proxy: "The proxy's files",
};

export function ServerLogsTab({ server }: { server: ServerView }) {
  const picked = usePickedLog();
  const sources = usePart(
    async () => ({ at: Date.now(), data: await api.servers.logSources({ id: server.id }) }),
    300_000,
  );
  const [source, setSource] = useState<string | null>(picked);
  const [search, setSearch] = useState("");
  const [follow, setFollow] = useState(true);
  const [lines, setLines] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  // Another tab's Logs button picks the source.
  useEffect(() => {
    if (picked) setSource(picked);
  }, [picked]);
  // The first one by default: the proxy's access log, else the first.
  useEffect(() => {
    if (!source && sources.data?.length) setSource(sources.data[0]?.id ?? null);
  }, [source, sources.data]);

  // Followed: the last lines then each new one, until this closes (ADR-043).
  useEffect(() => {
    if (!source || !follow) return;
    setLines([]);
    setNotes([]);
    setError(null);
    return live.followLog(
      server.id,
      source,
      (l) => setLines((xs) => [...xs, ...l].slice(-2000)),
      (e) => {
        setError(e);
        setFollow(false);
      },
    );
  }, [server.id, source, follow]);

  // Not followed: the last lines, or a search through the last 20 000 on the server.
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!source || follow) return;
    let gone = false;
    setError(null);
    api.servers
      .logs({ id: server.id, source, lines: 500, ...(query ? { search: query } : {}) })
      .then((r) => {
        if (gone) return;
        setLines(r.lines);
        setNotes(r.notes);
      })
      .catch((e) => !gone && setError(message(e)));
    return () => {
      gone = true;
    };
  }, [server.id, source, follow, query]);

  // Kept at the bottom while I'm there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on new lines
  useEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const shown =
    follow && search ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase())) : lines;
  const groups = (["proxy", "service", "container"] as const).map((k) => ({
    k,
    items: (sources.data ?? []).filter((s) => s.kind === k),
  }));
  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <select
          data-help="server.logs.source"
          aria-label={t("Which log")}
          className="h-8 w-full min-w-0 rounded-md border bg-background px-2 text-sm sm:w-auto sm:flex-1"
          value={source ?? ""}
          onChange={(e) => setSource(e.target.value || null)}
        >
          {!source ? <option value="">{t("Pick a log")}</option> : null}
          {source && !sources.data?.some((s) => s.id === source) ? (
            <option value={source}>{source}</option>
          ) : null}
          {groups.map((g) =>
            g.items.length ? (
              <optgroup key={g.k} label={t(KIND_LABEL[g.k])}>
                {g.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        <form
          className="flex min-w-0 flex-1 items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (!follow) setQuery(search.trim());
          }}
        >
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            data-help="server.logs.search"
            className="h-8 min-w-0"
            placeholder={follow ? t("Filter what comes") : t("Search, then Enter")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <Button
          data-help="server.logs.follow"
          size="sm"
          variant={follow ? "secondary" : "ghost"}
          className="gap-1"
          disabled={!source}
          onClick={() => {
            if (follow) setQuery(search.trim());
            setFollow(!follow);
          }}
        >
          {follow ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
          {follow ? t("Following") : t("Follow")}
        </Button>
      </div>
      {sources.error ? <ErrorNote error={sources.error} /> : null}
      {error ? <Unread>{error}</Unread> : null}
      {notes.map((n) => (
        <Unread key={n}>{n}</Unread>
      ))}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-48 flex-1 overflow-y-auto rounded-md border bg-muted/40 p-2 font-mono text-xs"
      >
        {shown.length === 0 ? (
          <div className="text-muted-foreground">
            {!source
              ? t("Pick a log.")
              : follow
                ? t("Waiting for lines…")
                : query
                  ? t("Nothing matches “{q}”.", { q: query })
                  : t("Nothing in this log.")}
          </div>
        ) : (
          shown.map((l, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: lines repeat; their place is who they are
              key={i}
              className="whitespace-pre-wrap [overflow-wrap:anywhere]"
            >
              {l}
            </div>
          ))
        )}
      </div>
      <div className="text-xs text-muted-foreground">
        {follow
          ? t("Live while this is open; nothing is kept.")
          : t("{n} lines; Follow shows new ones as they come.", { n: lines.length })}
      </div>
    </div>
  );
}
