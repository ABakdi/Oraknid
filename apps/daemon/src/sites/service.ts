import { isIP } from "node:net";
import type { ServerProxies, SiteCheck, SitePatch, SitesFound, SiteView } from "@oraknid/contracts";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { siteChecks, sites } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Servers } from "../servers/service.ts";
import { q } from "../servers/ssh.ts";
import { checkUrl, type Resolver, readCert, readDns, systemResolver, transient } from "./probes.ts";

// Sites, domains, certificates and uptime (ADR-060): the domains my
// servers' proxies serve (and ones I add), their DNS and certificates read
// from this computer, and an uptime check every few minutes. A site is down
// only when it is down (ADR-071): a check that got no answer is tried again
// before it counts; two failed checks in a row are asked of the site's
// server; what only fails from here is one `site.path` per server, not a
// `site.down` per site. A said down is `site.down` once; the first check up
// after is `site.up`. Checks are kept 7 days.

type SiteRow = typeof sites.$inferSelect;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** How long checks are kept. */
export const KEEP_MS = 7 * DAY;
/** How often DNS and the certificate are read again. */
export const CERT_EVERY_MS = 6 * HOUR;
/** Checks running at once. */
const AT_ONCE = 4;
/** The pauses before trying again a check the path may explain (ADR-071 §1). */
const RETRY_DELAYS_MS = [2_000, 5_000];
/** A site back less than this ago that fails again is held longer before it is said (ADR-071 §4). */
const FLAP_MS = 30 * MIN;
/** Held: failing this long, and this many checks, before it is said again. */
const FLAP_HOLD_MS = 15 * MIN;
const FLAP_FAILS = 3;
/** One server's incident is said at most this often (ADR-071 §3). */
const PATH_SAID_EVERY_MS = DAY;
/** How long the server has to answer the second opinion. */
const ASK_TIMEOUT_MS = 30_000;

export interface SitesDeps {
  db: Db;
  bus: EventBus;
  servers: Pick<Servers, "list" | "insight" | "run">;
  now?: () => number;
  resolver?: Resolver;
  /** Where the certificate is read: tests point it at a stand-in. */
  tls?: (host: string) => { host: string; port: number };
  /** How often the schedule looks for checks due (ms). */
  tickMs?: number;
  timeoutMs?: number;
  /** The check from this computer: tests give a stand-in. */
  probe?: (url: string, o: { timeoutMs?: number }) => Promise<Omit<SiteCheck, "at">>;
  /** The pauses before each retry of a check the path may explain (ms). */
  retryDelaysMs?: number[];
}

/** A domain a proxy names that can be a site: no wildcard, no IP, no `_` or localhost. */
export function siteName(name: string): string | null {
  const n = name.trim().toLowerCase().replace(/\.$/, "");
  if (!n || n.length > 253) return null;
  if (isIP(n)) return null;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(n)) return null;
  if (n === "localhost" || n.endsWith(".localhost") || n.endsWith(".local")) return null;
  return n;
}

/** What I typed (a domain or a URL): the host, and the URL to check. */
export function readAddress(text: string): { host: string; url: string } {
  const t = text.trim();
  if (/^https?:\/\//i.test(t)) {
    let u: URL;
    try {
      u = new URL(t);
    } catch {
      throw new Error("That isn't an address: a domain (example.com) or a URL (https://…).");
    }
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!host) throw new Error("That address has no host.");
    return { host: u.port ? `${host}:${u.port}` : host, url: u.toString() };
  }
  const host = siteName(t);
  if (!host) throw new Error("That isn't a domain: a name like example.com, or a URL.");
  return { host, url: `https://${host}/` };
}

/**
 * The second opinion's script (ADR-071 §2), run on the site's server: each
 * site fetched by the server itself with curl, the domain resolved to
 * 127.0.0.1, then to the site's own addresses when they are the server's.
 * One line per site, `<id> <status>`, 000 for no answer; `no-curl` when it
 * has no curl. A GET, nothing changed.
 */
export function askScript(rows: Pick<SiteRow, "id" | "url" | "dns">[]): string {
  const lines = [
    "command -v curl >/dev/null 2>&1 || { echo no-curl; exit 0; }",
    "ask() {",
    "  id=$1; url=$2; host=$3; port=$4; shift 4",
    '  for ip in "$@"; do',
    '    code=$(curl -sk -o /dev/null -w \'%{http_code}\' --connect-timeout 3 --max-time 8 --resolve "$host:$port:$ip" "$url" 2>/dev/null)',
    '    case "$code" in 000|"") ;; *) echo "$id $code"; return ;; esac',
    "  done",
    '  echo "$id 000"',
    "}",
  ];
  for (const r of rows) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const own = r.dns?.pointsHere ? [...r.dns.a, ...r.dns.aaaa.map((a) => `[${a}]`)] : [];
    const ips = ["127.0.0.1", ...own.filter((a) => a !== "127.0.0.1")];
    lines.push(`ask ${[r.id, u.toString(), host, port, ...ips].map(q).join(" ")} &`);
  }
  lines.push("wait");
  return lines.join("\n");
}

export class Sites {
  #timer: NodeJS.Timeout | undefined;
  readonly #running = new Set<string>();
  #ticking = false;

  constructor(private readonly d: SitesDeps) {}

  #now() {
    return this.d.now?.() ?? Date.now();
  }

  #publish(type: string, payload: Record<string, unknown>, actor = "oraknid") {
    this.d.bus.publish({ type, topic: "overview", jobId: null, payload, actor });
  }

  #row(id: string): SiteRow {
    const r = this.d.db.select().from(sites).where(eq(sites.id, id)).get();
    if (!r || r.hidden) throw new Error(`No site ${id}.`);
    return r;
  }

  list(): SiteView[] {
    const rows = this.d.db
      .select()
      .from(sites)
      .where(eq(sites.hidden, false))
      .orderBy(asc(sites.host))
      .all();
    const names = new Map(this.d.servers.list().map((s) => [s.id, s.name]));
    const since = this.#now() - KEEP_MS;
    const checks = this.d.db
      .select()
      .from(siteChecks)
      .where(gte(siteChecks.at, since))
      .orderBy(asc(siteChecks.at))
      .all();
    const bySite = new Map<string, (typeof checks)[number][]>();
    for (const c of checks) {
      const l = bySite.get(c.siteId) ?? [];
      l.push(c);
      bySite.set(c.siteId, l);
    }
    return rows.map((r) => this.#view(r, bySite.get(r.id) ?? [], names));
  }

  view(id: string): SiteView {
    const r = this.#row(id);
    return this.list().find((s) => s.id === r.id) ?? this.#view(r, [], new Map<string, string>());
  }

  #view(
    r: SiteRow,
    checks: (typeof siteChecks.$inferSelect)[],
    names: Map<string, string>,
  ): SiteView {
    const now = this.#now();
    const share = (from: number) => {
      const xs = checks.filter((c) => c.at >= from);
      return xs.length ? xs.filter((c) => c.up).length / xs.length : null;
    };
    const day = checks.filter((c) => c.at >= now - DAY);
    const step = Math.max(1, Math.ceil(day.length / 96));
    const recent: SiteCheck[] = day
      .filter((_, i) => (day.length - 1 - i) % step === 0)
      .map((c) => ({
        at: c.at,
        up: c.up,
        status: c.status,
        latencyMs: c.latencyMs,
        error: c.error,
      }));
    const last = checks.at(-1);
    return {
      id: r.id,
      host: r.host,
      url: r.url,
      serverId: r.serverId,
      serverName: r.serverId ? (names.get(r.serverId) ?? null) : null,
      source: r.source,
      upstream: r.upstream,
      checkEnabled: r.checkEnabled,
      intervalMin: r.intervalMin,
      lastCheckAt: r.lastCheckAt,
      up: r.up,
      downSince: r.downSince,
      downReason: r.downSince !== null ? (r.downReason ?? "site") : null,
      lastStatus: last?.status ?? null,
      lastLatencyMs: last?.latencyMs ?? null,
      lastError: last?.error ?? null,
      uptime24h: share(now - DAY),
      uptime7d: share(now - KEEP_MS),
      recent,
      dns: r.dns ?? null,
      dnsAt: r.dnsAt,
      cert: {
        expiresAt: r.certExpiresAt,
        issuer: r.certIssuer,
        names: r.certNames ?? [],
        valid: r.certValid,
        error: r.certError,
        at: r.certAt,
      },
      createdAt: r.createdAt,
    };
  }

  /** The checks of a site since a time (at most the 7 days kept). */
  history(id: string, since = 0): SiteCheck[] {
    this.#row(id);
    return this.d.db
      .select()
      .from(siteChecks)
      .where(and(eq(siteChecks.siteId, id), gte(siteChecks.at, since)))
      .orderBy(asc(siteChecks.at))
      .all()
      .map((c) => ({
        at: c.at,
        up: c.up,
        status: c.status,
        latencyMs: c.latencyMs,
        error: c.error,
      }));
  }

  /** A site I add by hand: a domain or a URL. Checked at once. */
  async add(address: string): Promise<SiteView> {
    const { host, url } = readAddress(address);
    const had = this.d.db.select().from(sites).where(eq(sites.host, host)).get();
    let id: string;
    if (had && !had.hidden) throw new Error(`${host} is already a site.`);
    if (had) {
      // One I removed comes back, mine now.
      this.d.db
        .update(sites)
        .set({ hidden: false, url, source: had.serverId ? had.source : "owner" })
        .where(eq(sites.id, had.id))
        .run();
      id = had.id;
    } else {
      const now = this.#now();
      id = newId(now);
      this.d.db
        .insert(sites)
        .values({ id, host, url, serverId: null, source: "owner", createdAt: now })
        .run();
    }
    this.#publish("site.added", { id, host }, "owner");
    await this.refresh(id).catch(() => {});
    return this.view(id);
  }

  update(patch: SitePatch): SiteView {
    const r = this.#row(patch.id);
    this.d.db
      .update(sites)
      .set({
        ...(patch.checkEnabled !== undefined ? { checkEnabled: patch.checkEnabled } : {}),
        ...(patch.intervalMin !== undefined ? { intervalMin: patch.intervalMin } : {}),
        ...(patch.url !== undefined ? { url: patch.url } : {}),
        // Turned off: no longer down either.
        ...(patch.checkEnabled === false
          ? { downSince: null, downReason: null, fails: 0, failingSince: null }
          : {}),
      })
      .where(eq(sites.id, r.id))
      .run();
    this.#publish(
      "site.updated",
      {
        id: r.id,
        host: r.host,
        fields: Object.keys(patch).filter((k) => k !== "id"),
      },
      "owner",
    );
    return this.view(r.id);
  }

  /** Removed: its checks go; found again by a proxy, it stays hidden. */
  remove(id: string) {
    const r = this.#row(id);
    this.d.db.delete(siteChecks).where(eq(siteChecks.siteId, id)).run();
    if (r.serverId)
      this.d.db
        .update(sites)
        .set({
          hidden: true,
          up: null,
          fails: 0,
          failingSince: null,
          downSince: null,
          downReason: null,
          lastCheckAt: null,
        })
        .where(eq(sites.id, id))
        .run();
    else this.d.db.delete(sites).where(eq(sites.id, id)).run();
    this.#publish("site.removed", { id, host: r.host }, "owner");
  }

  /**
   * Find sites: the proxies' sites of my ready servers (ADR-043's proxy
   * part), one per domain. A server whose proxy can't be read is said.
   */
  async find(serverId?: string): Promise<SitesFound> {
    const ready = this.d.servers
      .list()
      .filter((s) => s.setup === "ready" && (!serverId || s.id === serverId));
    const added: string[] = [];
    const skipped: SitesFound["skipped"] = [];
    for (const s of ready) {
      let proxies: ServerProxies;
      try {
        proxies = (await this.d.servers.insight.part(s.id, "proxy")).data;
      } catch (error) {
        skipped.push({ serverId: s.id, name: s.name, why: (error as Error).message });
        continue;
      }
      for (const p of proxies.proxies)
        for (const site of p.sites)
          for (const name of site.names) {
            const host = siteName(name);
            if (!host) continue;
            const tlsOn =
              !!site.certificate || site.listen.some((l) => /\b443\b|ssl|https/.test(l));
            const upstream = site.upstreams[0] ?? site.root ?? site.redirect ?? null;
            if (this.#found(host, s.id, p.kind, upstream, tlsOn)) added.push(host);
          }
    }
    if (added.length) this.#publish("site.found", { added });
    const total = this.d.db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.hidden, false))
      .all().length;
    return { added, total, skipped };
  }

  /** One domain a proxy serves: new, or its server and upstream brought up to date. True when new. */
  #found(
    host: string,
    serverId: string,
    kind: string,
    upstream: string | null,
    tlsOn: boolean,
  ): boolean {
    const had = this.d.db.select().from(sites).where(eq(sites.host, host)).get();
    if (had) {
      // A site of mine added by hand stays mine; one a proxy found follows the proxy.
      if (had.source !== "owner")
        this.d.db
          .update(sites)
          .set({ serverId, source: kind, upstream })
          .where(eq(sites.id, had.id))
          .run();
      else if (!had.serverId)
        this.d.db.update(sites).set({ serverId, upstream }).where(eq(sites.id, had.id)).run();
      return false;
    }
    const now = this.#now();
    this.d.db
      .insert(sites)
      .values({
        id: newId(now),
        host,
        url: `${tlsOn ? "https" : "http"}://${host}/`,
        serverId,
        source: kind,
        upstream,
        createdAt: now,
      })
      .run();
    return true;
  }

  /** DNS and the certificate, read now; then a check. */
  async refresh(id: string): Promise<SiteView> {
    await this.#readDnsAndCert(this.#row(id));
    await this.check(id);
    return this.view(id);
  }

  async #readDnsAndCert(r: SiteRow) {
    const host = r.host.replace(/:\d+$/, "");
    const serverHost = r.serverId
      ? (this.d.servers.list().find((s) => s.id === r.serverId)?.host ?? null)
      : null;
    const resolver = this.d.resolver ?? systemResolver;
    const dns = isIP(host)
      ? { a: [host], aaaa: [], cname: [], pointsHere: null, error: null }
      : await readDns(resolver, host, serverHost);
    const now = this.#now();
    const update: Partial<SiteRow> = { dns, dnsAt: now };
    if (r.url.startsWith("https:")) {
      const where = this.d.tls?.(host) ?? { host, port: Number(new URL(r.url).port) || 443 };
      const cert = await readCert(host, {
        connectHost: where.host,
        port: where.port,
        now,
        ...(this.d.timeoutMs ? { timeoutMs: this.d.timeoutMs } : {}),
      });
      Object.assign(update, {
        certExpiresAt: cert.expiresAt,
        certIssuer: cert.issuer,
        certNames: cert.names,
        certValid: cert.valid,
        certError: cert.error,
        certAt: now,
      });
    } else
      Object.assign(update, {
        certExpiresAt: null,
        certIssuer: null,
        certNames: [],
        certValid: null,
        certError: "Checked over http: no certificate.",
        certAt: now,
      });
    this.d.db.update(sites).set(update).where(eq(sites.id, r.id)).run();
  }

  /** One uptime check now; the down and up notifications from it. */
  async check(id: string): Promise<SiteCheck> {
    const r = this.#row(id);
    if (this.#running.has(id)) throw new Error(`${r.host} is being checked.`);
    this.#running.add(id);
    try {
      const c = await this.#probe(r);
      const at = this.#now();
      await this.#settle([{ id, at, c }]);
      return { at, ...c };
    } finally {
      this.#running.delete(id);
    }
  }

  /**
   * One check from this computer (ADR-071 §1): a failure the path may
   * explain (no answer, the connection cut) is tried again after a short
   * pause, twice, before it counts.
   */
  async #probe(r: SiteRow): Promise<Omit<SiteCheck, "at">> {
    const probe = this.d.probe ?? checkUrl;
    const o = this.d.timeoutMs ? { timeoutMs: this.d.timeoutMs } : {};
    let c = await probe(r.url, o);
    for (const ms of this.d.retryDelaysMs ?? RETRY_DELAYS_MS) {
      if (!transient(c)) break;
      if (ms > 0) await new Promise((done) => setTimeout(done, ms).unref());
      c = await probe(r.url, o);
    }
    return c;
  }

  /** Two failures in a row; after a recent comeback, failing for 15 minutes (ADR-071 §4). */
  #dueDown(r: Pick<SiteRow, "backAt">, fails: number, failingSince: number, at: number) {
    if (r.backAt !== null && at - r.backAt < FLAP_MS)
      return fails >= FLAP_FAILS && at - failingSince >= FLAP_HOLD_MS;
    return fails >= 2;
  }

  /**
   * A round of checks, kept and judged together (ADR-071): a site that
   * would be down and failed in a way the path may explain is asked of its
   * server first; what only fails from here is one incident per server.
   */
  async #settle(results: { id: string; at: number; c: Omit<SiteCheck, "at"> }[]) {
    const ask = new Map<string, { r: SiteRow; c: Omit<SiteCheck, "at"> }[]>();
    const touched = new Set<string>();
    const servers = new Map(this.d.servers.list().map((s) => [s.id, s]));
    for (const { id, at, c } of results) {
      this.d.db
        .insert(siteChecks)
        .values({ siteId: id, at, ...c })
        .run();
      const r = this.d.db.select().from(sites).where(eq(sites.id, id)).get();
      if (!r) continue;
      if (r.serverId) touched.add(r.serverId);
      if (c.up) {
        // Back: said only when its down was said (a quiet down comes back quietly).
        const said = r.downSince !== null && r.downReason === "site";
        if (said)
          this.#publish("site.up", {
            id,
            host: r.host,
            serverId: r.serverId,
            downForMs: at - (r.downSince as number),
          });
        this.d.db
          .update(sites)
          .set({
            up: true,
            fails: 0,
            failingSince: null,
            downSince: null,
            downReason: null,
            lastCheckAt: at,
            ...(said ? { backAt: at } : {}),
          })
          .where(eq(sites.id, id))
          .run();
        continue;
      }
      const fails = r.fails + 1;
      const failingSince = r.failingSince ?? (r.fails > 0 ? r.lastCheckAt : null) ?? at;
      this.d.db
        .update(sites)
        .set({ up: false, fails, failingSince, lastCheckAt: at })
        .where(eq(sites.id, id))
        .run();
      // Said once: nothing more until it is back.
      if (r.downReason === "site" && r.downSince !== null) continue;
      if (!this.#dueDown(r, fails, failingSince, at)) continue;
      const server = r.serverId ? servers.get(r.serverId) : undefined;
      if (transient(c) && server && server.setup === "ready" && !server.hostKeyOffered) {
        const l = ask.get(server.id) ?? [];
        l.push({ r: { ...r, fails, failingSince }, c });
        ask.set(server.id, l);
      } else this.#down({ ...r, failingSince }, c, null);
    }
    for (const [serverId, list] of ask) {
      const name = servers.get(serverId)?.name ?? "its server";
      let answers: Map<string, number> | null;
      try {
        answers = await this.#ask(
          serverId,
          list.map((x) => x.r),
        );
      } catch {
        // The server can't be reached either: Oraknid can't tell (ADR-071 §2).
        for (const x of list) this.#quietDown(x.r, "server");
        continue;
      }
      for (const x of list) {
        const status = answers?.get(x.r.id);
        if (status === undefined) this.#down(x.r, x.c, null);
        else if (status > 0 && status < 500) this.#quietDown(x.r, "path");
        else
          this.#down(
            x.r,
            x.c,
            status === 0
              ? `${name} gets no answer from it either.`
              : `On ${name} itself it answers ${status}.`,
          );
      }
    }
    const at = results.at(-1)?.at ?? this.#now();
    for (const serverId of touched) this.#incident(serverId, at);
  }

  /** Down, said: it doesn't answer (ADR-060), and its server agrees or wasn't asked. */
  #down(
    r: Pick<SiteRow, "id" | "host" | "serverId" | "downSince" | "failingSince">,
    c: Omit<SiteCheck, "at">,
    confirmed: string | null,
  ) {
    const downSince = r.downSince ?? r.failingSince ?? this.#now();
    this.d.db.update(sites).set({ downSince, downReason: "site" }).where(eq(sites.id, r.id)).run();
    this.#publish("site.down", {
      id: r.id,
      host: r.host,
      serverId: r.serverId,
      error: c.error ?? (c.status ? `It answered ${c.status}.` : "No answer."),
      why: confirmed ?? "Two checks in a row from this computer failed.",
    });
  }

  /** Down from here only, or its server out of reach too: not said per site (ADR-071 §3). */
  #quietDown(r: Pick<SiteRow, "id" | "downSince" | "failingSince">, reason: "path" | "server") {
    this.d.db
      .update(sites)
      .set({ downSince: r.downSince ?? r.failingSince ?? this.#now(), downReason: reason })
      .where(eq(sites.id, r.id))
      .run();
  }

  /**
   * The second opinion (ADR-071 §2): the server itself GETs each site
   * (askScript). Each site's status, 0 for no answer; null when the server
   * has no curl to ask with. Throws when the server can't be reached.
   */
  async #ask(serverId: string, rows: SiteRow[]): Promise<Map<string, number> | null> {
    const script = askScript(rows);
    let res: { code: number | null; stdout: string } | undefined;
    for (let i = 0; i < 2 && !res; i++)
      try {
        res = await this.d.servers.run(serverId, script, ASK_TIMEOUT_MS);
      } catch (error) {
        if (i === 1) throw error;
      }
    if (!res || /^no-curl$/m.test(res.stdout)) return null;
    const out = new Map<string, number>();
    for (const line of res.stdout.split("\n")) {
      const m = /^(\S+) (\d{3})$/.exec(line.trim());
      if (m) out.set(m[1] as string, Number(m[2]));
    }
    return out;
  }

  /**
   * One incident per server (ADR-071 §3): its sites down from here only (or
   * with the server out of reach) are one `site.path`, said at most once a
   * day per server; its end is `site.path-ok`, which notifies nobody.
   */
  #incident(serverId: string, at: number) {
    const rows = this.d.db
      .select()
      .from(sites)
      .where(
        and(eq(sites.serverId, serverId), eq(sites.hidden, false), eq(sites.checkEnabled, true)),
      )
      .all();
    const out = rows.filter(
      (r) => r.downSince !== null && (r.downReason === "path" || r.downReason === "server"),
    );
    const open = this.#incidents.get(serverId);
    const name = this.d.servers.list().find((s) => s.id === serverId)?.name ?? "a server";
    if (out.length && !open) {
      const last = this.d.db.$client
        .prepare(
          "select max(at) as at from events where type = 'site.path' and json_extract(payload, '$.serverId') = ?",
        )
        .get(serverId) as { at: number | null } | undefined;
      const said = !last?.at || at - last.at >= PATH_SAID_EVERY_MS;
      this.#incidents.set(serverId, { since: at, said });
      if (said)
        this.#publish("site.path", {
          serverId,
          server: name,
          cause: out.every((r) => r.downReason === "server") ? "server" : "path",
          failing: out.length,
          total: rows.length,
          hosts: out.map((r) => r.host),
        });
    } else if (!out.length && open) {
      this.#incidents.delete(serverId);
      if (open.said)
        this.#publish("site.path-ok", { serverId, server: name, forMs: at - open.since });
    }
  }

  readonly #incidents = new Map<string, { since: number; said: boolean }>();

  /** Checks due, a few at a time, judged together; DNS and certificates every 6 hours; old checks dropped. */
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
    const mine: string[] = [];
    try {
      const now = this.#now();
      const rows = this.d.db
        .select()
        .from(sites)
        .where(and(eq(sites.hidden, false), eq(sites.checkEnabled, true)))
        .all();
      const due = rows.filter(
        (r) => !this.#running.has(r.id) && (r.lastCheckAt ?? 0) + r.intervalMin * MIN <= now,
      );
      for (const r of due) {
        this.#running.add(r.id);
        mine.push(r.id);
      }
      const certs = rows.filter((r) => (r.certAt ?? 0) + CERT_EVERY_MS <= now);
      const results: { id: string; at: number; c: Omit<SiteCheck, "at"> }[] = [];
      const queue = [
        ...certs.map((r) => () => this.#readDnsAndCert(r)),
        ...due.map((r) => async () => {
          const c = await this.#probe(r);
          results.push({ id: r.id, at: this.#now(), c });
        }),
      ];
      const workers = Array.from({ length: AT_ONCE }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await job().catch(() => {});
      });
      await Promise.all(workers);
      await this.#settle(results);
      this.d.db
        .delete(siteChecks)
        .where(lt(siteChecks.at, now - KEEP_MS))
        .run();
    } finally {
      for (const id of mine) this.#running.delete(id);
      this.#ticking = false;
    }
  }

  start() {
    const tick = () => void this.tick().catch((e) => console.error("site checks failed", e));
    this.#timer = setInterval(tick, this.d.tickMs ?? 30_000);
    this.#timer.unref();
    // Each discovery reads the proxy again: its sites follow (ADR-060).
    this.#unsubscribe = this.d.bus.subscribe((e) => {
      const p = (e.payload ?? {}) as { id?: string; source?: string };
      if (e.type === "server.state" && p.source === "eye" && p.id)
        void this.find(p.id).catch(() => {});
    });
  }

  #unsubscribe: (() => void) | undefined;

  stop() {
    clearInterval(this.#timer);
    this.#unsubscribe?.();
  }
}
