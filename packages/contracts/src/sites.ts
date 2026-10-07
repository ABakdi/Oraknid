import { z } from "zod";
import { Id, Timestamp } from "./common.ts";

// Sites, domains, certificates and uptime across my servers (ADR-060).

/** A domain as I type it, or a URL (http or https). */
export const SiteAddress = z
  .string()
  .trim()
  .min(3)
  .max(2048)
  .refine((s) => !/\s/.test(s), "no spaces");

export const SiteDns = z.object({
  a: z.array(z.string()),
  aaaa: z.array(z.string()),
  cname: z.array(z.string()),
  /** One of its addresses is its server's; null when it has no server or no address. */
  pointsHere: z.boolean().nullable(),
  error: z.string().nullable(),
});
export type SiteDns = z.infer<typeof SiteDns>;

export const SiteCert = z.object({
  expiresAt: Timestamp.nullable(),
  issuer: z.string().nullable(),
  names: z.array(z.string()),
  /** Trusted, for this domain, and not ended. */
  valid: z.boolean().nullable(),
  error: z.string().nullable(),
  at: Timestamp.nullable(),
});
export type SiteCert = z.infer<typeof SiteCert>;

export const SiteCheck = z.object({
  at: Timestamp,
  up: z.boolean(),
  status: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});
export type SiteCheck = z.infer<typeof SiteCheck>;

export const SiteView = z.object({
  id: Id,
  host: z.string(),
  url: z.string(),
  serverId: Id.nullable(),
  serverName: z.string().nullable(),
  /** nginx, caddy, traefik, haproxy, or owner (added by hand). */
  source: z.string(),
  upstream: z.string().nullable(),
  checkEnabled: z.boolean(),
  intervalMin: z.number().int(),
  lastCheckAt: Timestamp.nullable(),
  /** The last check: up, down, or null before any. */
  up: z.boolean().nullable(),
  /** Down twice in a row (notified) since; null when up. */
  downSince: Timestamp.nullable(),
  lastStatus: z.number().int().nullable(),
  lastLatencyMs: z.number().int().nullable(),
  lastError: z.string().nullable(),
  /** Share of checks up (0–1); null without checks. */
  uptime24h: z.number().nullable(),
  uptime7d: z.number().nullable(),
  /** The last day's checks, at most 96 (a sparkline). */
  recent: z.array(SiteCheck),
  dns: SiteDns.nullable(),
  dnsAt: Timestamp.nullable(),
  cert: SiteCert,
  createdAt: Timestamp,
});
export type SiteView = z.infer<typeof SiteView>;

export const SitePatch = z.object({
  id: Id,
  checkEnabled: z.boolean().optional(),
  intervalMin: z.number().int().min(1).max(60).optional(),
  url: z
    .url({ protocol: /^https?$/ })
    .max(2048)
    .optional(),
});
export type SitePatch = z.infer<typeof SitePatch>;

export const SitesFound = z.object({
  added: z.array(z.string()),
  total: z.number().int(),
  /** Servers whose proxy couldn't be read, with why. */
  skipped: z.array(z.object({ serverId: Id, name: z.string(), why: z.string() })),
});
export type SitesFound = z.infer<typeof SitesFound>;
