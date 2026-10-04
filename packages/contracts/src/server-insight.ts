import { z } from "zod";
import { Timestamp } from "./common.ts";

// What runs on a server (ADR-043): oraknid-monitor's parts, each read only
// while its screen is open, never stored. Each says what it couldn't read.

export const ServerContainer = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  /** running, exited, created, paused, restarting… */
  state: z.string(),
  status: z.string(),
  health: z.enum(["healthy", "unhealthy", "starting"]).nullable(),
  uptime: z.string().nullable(),
  ports: z.string(),
  /** Its compose project and service, when it has them. */
  project: z.string().nullable(),
  service: z.string().nullable(),
  cpuPercent: z.number().nullable(),
  memBytes: z.number().nullable(),
  memLimit: z.number().nullable(),
});
export type ServerContainer = z.infer<typeof ServerContainer>;

export const ServerDocker = z.object({
  /** docker or podman; null: neither is installed. */
  engine: z.string().nullable(),
  version: z.string().nullable(),
  /** Why it couldn't be read, in words (no access to the socket…). */
  error: z.string().nullable(),
  containers: z.array(ServerContainer),
  images: z.array(
    z.object({
      repository: z.string(),
      tag: z.string(),
      id: z.string(),
      sizeBytes: z.number(),
      created: z.string(),
      inUse: z.boolean(),
    }),
  ),
  volumes: z.array(
    z.object({
      name: z.string(),
      driver: z.string(),
      project: z.string().nullable(),
      inUse: z.boolean(),
    }),
  ),
  networks: z.array(
    z.object({ name: z.string(), driver: z.string(), scope: z.string().nullable() }),
  ),
});
export type ServerDocker = z.infer<typeof ServerDocker>;

export const ServerDatabase = z.object({
  kind: z.enum(["postgres", "mysql", "mongodb", "redis"]),
  /** The service unit, the process or the container. */
  name: z.string(),
  source: z.enum(["service", "process", "container"]),
  version: z.string().nullable(),
  state: z.string(),
  port: z.number().nullable(),
  /** Only when it can be read without credentials. */
  sizeBytes: z.number().nullable(),
  note: z.string().nullable(),
  /**
   * A container's login, read from its environment (POSTGRES_USER,
   * MYSQL_DATABASE, MONGO_INITDB_ROOT_USERNAME…) for a backup plan
   * (ADR-044): never a password's value, only whether one is set there.
   */
  login: z
    .object({
      user: z.string().nullable(),
      database: z.string().nullable(),
      passwordSet: z.boolean(),
    })
    .nullable()
    .default(null),
});
export type ServerDatabase = z.infer<typeof ServerDatabase>;

export const ServerDatabases = z.object({
  databases: z.array(ServerDatabase),
  notes: z.array(z.string()),
});
export type ServerDatabases = z.infer<typeof ServerDatabases>;

export const ProxySite = z.object({
  names: z.array(z.string()),
  listen: z.array(z.string()),
  upstreams: z.array(z.string()),
  root: z.string().nullable(),
  redirect: z.string().nullable(),
  certificate: z.string().nullable(),
  accessLog: z.string().nullable(),
});
export type ProxySite = z.infer<typeof ProxySite>;

export const ProxyCertificate = z.object({
  path: z.string(),
  /** As openssl prints it. */
  notAfter: z.string().nullable(),
  /** When it ends, read from notAfter by the daemon. */
  expiresAt: Timestamp.nullable().default(null),
  error: z.string().nullable(),
});
export type ProxyCertificate = z.infer<typeof ProxyCertificate>;

export const ServerProxy = z.object({
  kind: z.string(),
  source: z.enum(["service", "container"]),
  name: z.string(),
  state: z.string(),
  version: z.string().nullable(),
  /** nginx -t: ok true or false; null when it couldn't be run (no root). */
  check: z.object({ ok: z.boolean().nullable(), output: z.string() }).nullable(),
  sites: z.array(ProxySite),
  certificates: z.array(ProxyCertificate),
  accessLogs: z.array(z.string()),
  errorLogs: z.array(z.string()),
  note: z.string().nullable(),
});
export type ServerProxy = z.infer<typeof ServerProxy>;

export const ServerProxies = z.object({
  proxies: z.array(ServerProxy),
  notes: z.array(z.string()),
});
export type ServerProxies = z.infer<typeof ServerProxies>;

export const ServerTraffic = z.object({
  windowMinutes: z.number(),
  logs: z.array(z.object({ path: z.string(), error: z.string().nullable() })),
  linesRead: z.number(),
  unparsed: z.number(),
  requests: z.number(),
  bytes: z.number(),
  /** Requests in each of the last minutes, oldest first. */
  perMinute: z.array(z.number()),
  statuses: z.object({
    "2xx": z.number(),
    "3xx": z.number(),
    "4xx": z.number(),
    "5xx": z.number(),
  }),
  codes: z.array(z.object({ code: z.string(), count: z.number() })),
  paths: z.array(z.object({ path: z.string(), count: z.number() })),
  clients: z.array(z.object({ client: z.string(), count: z.number() })),
  /** Established connections per listening port. */
  connections: z.array(z.object({ port: z.string(), count: z.number() })),
});
export type ServerTraffic = z.infer<typeof ServerTraffic>;

/** A part read at a time, from the daemon's short cache or the server. */
export const Insight = <T extends z.ZodType>(data: T) => z.object({ at: Timestamp, data });

/** A log Oraknid can show: `unit:<name>`, `container:<name>` or `file:<path>`. */
export const LogSource = z
  .string()
  .regex(/^(unit:[A-Za-z0-9@_.:-]+|container:[A-Za-z0-9][A-Za-z0-9_.-]*|file:\/[^\s]+)$/)
  .refine((s) => !s.includes(".."), "Not a log.");
export type LogSource = z.infer<typeof LogSource>;

export const ServerLogSource = z.object({
  id: LogSource,
  label: z.string(),
  kind: z.enum(["service", "container", "proxy"]),
});
export type ServerLogSource = z.infer<typeof ServerLogSource>;

export const ServerLogs = z.object({
  lines: z.array(z.string()),
  /** What the server said it couldn't do (no journal access…). */
  notes: z.array(z.string()),
});
export type ServerLogs = z.infer<typeof ServerLogs>;

/** Restarting is the one change these screens make, always asked first (ADR-043). */
export const ServerRestart = z.object({
  id: z.string(),
  kind: z.enum(["container", "service"]),
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9@_.:-]*$/),
  /** I said yes to it. */
  confirm: z.literal(true),
});
export type ServerRestart = z.infer<typeof ServerRestart>;
