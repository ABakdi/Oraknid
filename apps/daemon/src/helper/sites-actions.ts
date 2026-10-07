import type { SiteView } from "@oraknid/contracts";
import { wrapUntrusted } from "@oraknid/core";
import { z } from "zod";
import type { ActionDef } from "./service.ts";

// The helper reads my sites (ADR-060): domains across my servers, up or
// down, their certificates and DNS. Names come from servers' proxies, so
// what it reads is data, never instructions.

const day = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : "unknown");
const pct = (x: number | null) => (x === null ? "no checks" : `${(x * 100).toFixed(1)}%`);

/** One line per site, as the Sites tab shows it. */
export function siteLine(s: SiteView, now = Date.now()): string {
  const state = !s.checkEnabled
    ? "not checked"
    : s.downSince
      ? `DOWN since ${new Date(s.downSince).toISOString().slice(0, 16)}${s.lastError ? ` (${s.lastError})` : ""}`
      : s.up === null
        ? "not checked yet"
        : s.up
          ? `up${s.lastLatencyMs !== null ? `, ${s.lastLatencyMs} ms` : ""}`
          : `failed its last check${s.lastError ? ` (${s.lastError})` : ""}`;
  const cert =
    s.cert.expiresAt === null
      ? s.cert.error
        ? `certificate: ${s.cert.error}`
        : "certificate not read"
      : `certificate ends ${day(s.cert.expiresAt)}${s.cert.expiresAt < now ? " (ENDED)" : s.cert.expiresAt - now < 14 * 86_400_000 ? " (in under two weeks)" : ""}${s.cert.valid === false && s.cert.error ? `; ${s.cert.error}` : ""}`;
  const dns = !s.dns
    ? "DNS not read"
    : s.dns.error
      ? `DNS: ${s.dns.error}`
      : `DNS ${[...s.dns.a, ...s.dns.aaaa].join(", ") || s.dns.cname.join(", ")}${s.dns.pointsHere === false ? " (not its server)" : s.dns.pointsHere ? " (its server)" : ""}`;
  return `- ${s.host} (id ${s.id}${s.serverName ? `, on ${s.serverName} via ${s.source}` : ", added by hand"}): ${state}; uptime 24 h ${pct(s.uptime24h)}, 7 days ${pct(s.uptime7d)}; ${cert}; ${dns}`;
}

export const SITE_ACTIONS: Record<string, ActionDef> = {
  sites: {
    kind: "read",
    description:
      "Read my sites across my servers (ADR-060): each domain, its server and proxy, up or down with latency and uptime (24 h, 7 days), its certificate's end and DNS (where it points). No input.",
    input: z.object({}),
    confirm: () => false,
    run: async (d) => {
      if (!d.sites) throw new Error("Sites aren't available here.");
      const list = d.sites.list();
      const down = list.filter((s) => s.downSince).length;
      return {
        result: `${list.length} site${list.length === 1 ? "" : "s"}${down ? `, ${down} down` : ""}.`,
        link: "/servers/sites",
        data: wrapUntrusted(
          "the owner's sites (names from their servers)",
          list.map((s) => siteLine(s)).join("\n") || "No sites yet.",
        ),
      };
    },
  },
};
