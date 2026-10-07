import { isIP } from "node:net";
import type { ServerProxies, SiteCheck, SitePatch, SitesFound, SiteView } from "@oraknid/contracts";
import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { siteChecks, sites } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Servers } from "../servers/service.ts";
import { checkUrl, type Resolver, readCert, readDns, systemResolver } from "./probes.ts";

// Sites, domains, certificates and uptime (ADR-060): the domains my
// servers' proxies serve (and ones I add), their DNS and certificates read
// from this computer, and an uptime check every few minutes. Two failed
// checks in a row are `site.down`, once; the first check up after is
// `site.up`. Checks are kept 7 days.

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

export interface SitesDeps {
  db: Db;
  bus: EventBus;
  servers: Pick<Servers, "list" | "insight">;
  now?: () => number;
  resolver?: Resolver;
  /** Where the certificate is read: tests point it at a stand-in. */
  tls?: (host: string) => { host: string; port: number };
  /** How often the schedule looks for checks due (ms). */
  tickMs?: number;
  timeoutMs?: number;
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
        ...(patch.checkEnabled === false ? { downSince: null, fails: 0 } : {}),
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
        .set({ hidden: true, up: null, fails: 0, downSince: null, lastCheckAt: null })
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
      const c = await checkUrl(r.url, {
        ...(this.d.timeoutMs ? { timeoutMs: this.d.timeoutMs } : {}),
      });
      const at = this.#now();
      this.d.db
        .insert(siteChecks)
        .values({ siteId: id, at, ...c })
        .run();
      const fails = c.up ? 0 : r.fails + 1;
      let downSince = r.downSince;
      // Twice in a row: down, said once.
      if (!c.up && fails >= 2 && downSince === null) {
        downSince = r.lastCheckAt ?? at;
        this.#publish("site.down", {
          id,
          host: r.host,
          serverId: r.serverId,
          error: c.error ?? (c.status ? `It answered ${c.status}.` : "No answer."),
        });
      }
      if (c.up && downSince !== null) {
        this.#publish("site.up", {
          id,
          host: r.host,
          serverId: r.serverId,
          downForMs: at - downSince,
        });
        downSince = null;
      }
      this.d.db
        .update(sites)
        .set({ up: c.up, fails, downSince, lastCheckAt: at })
        .where(eq(sites.id, id))
        .run();
      return { at, ...c };
    } finally {
      this.#running.delete(id);
    }
  }

  /** Checks due, a few at a time; DNS and certificates every 6 hours; old checks dropped. */
  async tick() {
    if (this.#ticking) return;
    this.#ticking = true;
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
      const certs = rows.filter((r) => (r.certAt ?? 0) + CERT_EVERY_MS <= now);
      const queue = [
        ...certs.map((r) => () => this.#readDnsAndCert(r)),
        ...due.map((r) => () => this.check(r.id).then(() => {})),
      ];
      const workers = Array.from({ length: AT_ONCE }, async () => {
        for (let job = queue.shift(); job; job = queue.shift()) await job().catch(() => {});
      });
      await Promise.all(workers);
      this.d.db
        .delete(siteChecks)
        .where(lt(siteChecks.at, now - KEEP_MS))
        .run();
    } finally {
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
