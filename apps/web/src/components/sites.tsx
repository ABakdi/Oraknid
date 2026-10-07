import type { SiteView } from "@oraknid/contracts";
import { Globe, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sparkline } from "@/components/charts";
import { BackButton, Empty, ErrorNote, Loading } from "@/components/common";
import { useConfirm } from "@/components/confirm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { api, message } from "@/lib/api";
import { ago } from "@/lib/format";
import { t } from "@/lib/i18n";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";

// Sites across my servers (ADR-060): each domain, where it is served, up or
// down from this computer, its certificate's end and its DNS.

const DAY = 86_400_000;
const pct = (x: number | null) => (x === null ? "—" : `${(x * 100).toFixed(x === 1 ? 0 : 1)}%`);

/** When the certificate ends, in words and a colour: red under two weeks, or ended. */
export function certWords(
  s: Pick<SiteView, "cert">,
  now = Date.now(),
): { text: string; bad: boolean } {
  const c = s.cert;
  if (c.expiresAt === null)
    return { text: c.error ?? t("not read yet"), bad: !!c.error && !/http/.test(c.error) };
  const days = Math.floor((c.expiresAt - now) / DAY);
  if (days < 0) return { text: t("ended {n} days ago", { n: -days }), bad: true };
  return {
    text: t("ends in {n} days", { n: days }),
    bad: days < 14 || c.valid === false,
  };
}

/** Up, down, or not checked: a word and a colour. */
export function stateOf(s: SiteView): { text: string; tone: "ok" | "bad" | "warn" | "off" } {
  if (!s.checkEnabled) return { text: t("not checked"), tone: "off" };
  if (s.downSince) return { text: t("down"), tone: "bad" };
  if (s.up === null) return { text: t("not checked yet"), tone: "off" };
  return s.up ? { text: t("up"), tone: "ok" } : { text: t("failing"), tone: "warn" };
}

const act = (p: Promise<unknown>, ok?: string) =>
  p.then(() => ok && toast.success(ok)).catch((e) => toast.error(message(e)));

export function SitesPanel() {
  const sites = useLive(() => api.sites.list(), {
    topics: ["overview"],
    refreshOn: (e) => e.type.startsWith("site."),
  });
  const { reload } = sites;
  // Checks don't make events: read again every minute while in sight.
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") reload();
    }, 60_000);
    return () => clearInterval(timer);
  }, [reload]);
  const [address, setAddress] = useState("");
  const [finding, setFinding] = useState(false);
  const { confirm, dialog } = useConfirm();
  const find = () => {
    setFinding(true);
    api.sites
      .find()
      .then((r) => {
        toast.success(
          r.added.length
            ? t("Found {n} new: {names}.", { n: r.added.length, names: r.added.join(", ") })
            : t("No new sites."),
        );
        for (const s of r.skipped) toast.error(`${s.name}: ${s.why}`);
        reload();
      })
      .catch((e) => toast.error(message(e)))
      .finally(() => setFinding(false));
  };
  const add = () => {
    const a = address.trim();
    if (!a) return;
    void act(
      api.sites.add({ address: a }).then(() => {
        setAddress("");
        reload();
      }),
      t("Added and checked."),
    );
  };
  const header = (
    <div className="flex flex-wrap items-center gap-2">
      <BackButton fallback="/servers" label={t("All servers")} className="md:hidden" />
      <h2 className="flex-1 text-lg font-semibold">{t("Sites")}</h2>
      <Button
        size="sm"
        variant="secondary"
        className="gap-1"
        disabled={finding}
        onClick={find}
        data-help="sites.find"
      >
        <Search className="size-3.5" />
        {t("Find sites")}
      </Button>
      <form
        className="flex gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder={t("example.com or https://…")}
          aria-label={t("A domain or a URL")}
          className="h-8 w-48"
        />
        <Button size="sm" type="submit" className="gap-1" disabled={!address.trim()}>
          <Plus className="size-3.5" />
          {t("Add")}
        </Button>
      </form>
    </div>
  );
  if (sites.error) return <ErrorNote error={sites.error} />;
  if (sites.loading) return <Loading />;
  const list = sites.data ?? [];
  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {header}
      <p className="text-xs text-muted-foreground">
        {t(
          "Checked from this computer every few minutes while Oraknid runs: down twice in a row is a notification, and so is back up. Certificates and DNS are read every 6 hours.",
        )}
      </p>
      {list.length === 0 ? (
        <Empty title={t("No sites yet")}>
          {t(
            "Find sites reads the sites your servers' proxies serve (nginx, Caddy, Traefik, HAProxy). You can also add a domain by hand.",
          )}
        </Empty>
      ) : (
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
          {list.map((s) => (
            <SiteRow
              key={s.id}
              s={s}
              onRemove={async () => {
                if (
                  await confirm(
                    t("Remove {host}?", { host: s.host }),
                    t(
                      "Its checks go. A site found on a proxy stays out when sites are found again; add it by hand to bring it back.",
                    ),
                    t("Remove"),
                  )
                )
                  void act(api.sites.remove({ id: s.id }).then(reload), t("Removed."));
              }}
              reload={reload}
            />
          ))}
        </div>
      )}
      {dialog}
    </div>
  );
}

function SiteRow({
  s,
  onRemove,
  reload,
}: {
  s: SiteView;
  onRemove: () => void;
  reload: () => void;
}) {
  const state = stateOf(s);
  const cert = certWords(s);
  const [busy, setBusy] = useState(false);
  const latencies = s.recent.map((c) => (c.up ? (c.latencyMs ?? 0) : 0));
  return (
    <div className="space-y-2 rounded-md border px-3 py-2 text-sm" data-site={s.host}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            state.tone === "ok"
              ? "bg-success"
              : state.tone === "bad"
                ? "bg-destructive"
                : state.tone === "warn"
                  ? "bg-warning"
                  : "bg-muted-foreground/40",
          )}
        />
        <Globe className="size-4 shrink-0 text-muted-foreground" />
        <a
          href={s.url}
          target="_blank"
          rel="noreferrer noopener"
          className="min-w-0 truncate font-medium hover:underline"
          title={s.url}
        >
          {s.host}
        </a>
        <Badge variant={state.tone === "bad" ? "destructive" : "outline"}>{state.text}</Badge>
        {s.downSince ? (
          <span className="text-xs text-destructive">
            {t("since {when}", { when: ago(s.downSince) })}
          </span>
        ) : null}
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {s.serverName
            ? t("on {server} · {source}", { server: s.serverName, source: s.source })
            : t("added by hand")}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={busy}
          aria-label={t("Check now")}
          title={t("Check now")}
          onClick={() => {
            setBusy(true);
            void act(api.sites.refresh({ id: s.id }).then(reload)).finally(() => setBusy(false));
          }}
        >
          <RefreshCw className={cn("size-3.5", busy && "animate-spin")} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7"
          aria-label={t("Remove")}
          title={t("Remove")}
          onClick={onRemove}
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-[1fr_auto]">
        <div className="space-y-0.5">
          <div>
            {s.lastCheckAt
              ? t("Last check {when}: {what}", {
                  when: ago(s.lastCheckAt),
                  what: s.lastError
                    ? s.lastError
                    : `${s.lastStatus ?? ""}${s.lastLatencyMs !== null ? ` · ${s.lastLatencyMs} ms` : ""}`,
                })
              : t("Not checked yet.")}{" "}
            · {t("uptime 24 h {a}, 7 days {b}", { a: pct(s.uptime24h), b: pct(s.uptime7d) })}
          </div>
          <div className={cn(cert.bad && "text-destructive")}>
            {t("Certificate")}: {cert.text}
            {s.cert.issuer ? ` · ${s.cert.issuer}` : ""}
            {s.cert.valid === false && s.cert.error && s.cert.expiresAt !== null
              ? ` · ${s.cert.error}`
              : ""}
          </div>
          <div className={cn(s.dns?.pointsHere === false && "text-warning")}>
            DNS:{" "}
            {!s.dns
              ? t("not read yet")
              : s.dns.error
                ? s.dns.error
                : [...s.dns.a, ...s.dns.aaaa].join(", ") || s.dns.cname.join(", ")}
            {s.dns?.cname.length && !s.dns.error ? ` (CNAME ${s.dns.cname.join(", ")})` : ""}
            {s.dns?.pointsHere === true
              ? ` · ${t("points at its server")}`
              : s.dns?.pointsHere === false
                ? ` · ${t("doesn't point at {server}", { server: s.serverName ?? "" })}`
                : ""}
            {s.upstream ? ` · → ${s.upstream}` : ""}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {latencies.length > 1 ? (
            <div className="w-32" title={t("Latency, the last day")}>
              <Sparkline values={latencies} height={28} />
            </div>
          ) : null}
          <label className="flex items-center gap-1.5">
            <Switch
              checked={s.checkEnabled}
              onCheckedChange={(v) =>
                act(api.sites.update({ id: s.id, checkEnabled: v }).then(reload))
              }
              aria-label={t("Check it")}
            />
            {t("every")}
            <select
              className="rounded border bg-background px-1 py-0.5"
              value={s.intervalMin}
              aria-label={t("Minutes between checks")}
              onChange={(e) =>
                act(
                  api.sites.update({ id: s.id, intervalMin: Number(e.target.value) }).then(reload),
                )
              }
            >
              {[1, 2, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
