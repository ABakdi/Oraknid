import {
  LogSource,
  type ProxySite,
  type ServerDatabases,
  ServerDatabases as ServerDatabasesSchema,
  type ServerDocker,
  ServerDocker as ServerDockerSchema,
  type ServerLogSource,
  type ServerLogs,
  type ServerProxies,
  ServerProxies as ServerProxiesSchema,
  type ServerRestart,
  type ServerTraffic,
  ServerTraffic as ServerTrafficSchema,
} from "@oraknid/contracts";
import type { Client, ClientChannel } from "ssh2";
import type { z } from "zod";
import type { EventBus } from "../events/bus.ts";
import { MONITOR_PATH } from "./monitor.ts";
import type { Servers } from "./service.ts";
import { exec, q } from "./ssh.ts";

// What runs on a server (ADR-043): oraknid-monitor's parts, read over the
// server's SSH connection only while a screen (or the helper) asks, kept a
// few seconds so that tabs and the helper share a reading, never stored.
// Restarting a container or a service is the one change, asked first and
// audited.

export type InsightPart = "docker" | "databases" | "proxy" | "traffic";
interface Parts {
  docker: ServerDocker;
  databases: ServerDatabases;
  proxy: ServerProxies;
  traffic: ServerTraffic;
}
const SCHEMAS: { [K in InsightPart]: z.ZodType<Parts[K]> } = {
  docker: ServerDockerSchema,
  databases: ServerDatabasesSchema,
  proxy: ServerProxiesSchema,
  traffic: ServerTrafficSchema,
};

/** How long a reading is shared: while a screen is open, never longer. */
export const INSIGHT_TTL_MS = 20_000;
/** At most this many followed logs per live socket. */
export const MAX_FOLLOWED = 4;

/** A log line as the screen shows it: no colours, no control characters. */
export const cleanLine = (s: string) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is what it removes
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

/** nginx often has the same names in two blocks (port 80 redirecting, 443 serving): one site. */
export function mergeSites(sites: ProxySite[]): ProxySite[] {
  const byNames = new Map<string, ProxySite>();
  const out: ProxySite[] = [];
  for (const s of sites) {
    const key = [...s.names].sort().join(" ");
    const seen = key ? byNames.get(key) : undefined;
    if (!seen) {
      const copy = { ...s, listen: [...s.listen], upstreams: [...s.upstreams] };
      if (key) byNames.set(key, copy);
      out.push(copy);
      continue;
    }
    for (const l of s.listen) if (!seen.listen.includes(l)) seen.listen.push(l);
    for (const u of s.upstreams) if (!seen.upstreams.includes(u)) seen.upstreams.push(u);
    seen.root ??= s.root;
    seen.certificate ??= s.certificate;
    seen.accessLog ??= s.accessLog;
    // A redirect to https next to the site itself is part of it, not what it does.
    if (seen.upstreams.length || seen.root) seen.redirect = null;
    else seen.redirect ??= s.redirect;
  }
  return out;
}

/** Runs oraknid-monitor with arguments; its JSON answer, read with the part's schema. */
async function runPart<K extends InsightPart>(
  client: Client,
  part: K,
  args: string[] = [],
): Promise<Parts[K]> {
  const r = await exec(
    client,
    `~/${MONITOR_PATH} sample ${part}${args.map((a) => ` ${q(a)}`).join("")}`,
    { timeoutMs: 60_000, cap: 2 * 1024 * 1024 },
  );
  let raw: unknown;
  try {
    raw = JSON.parse(r.stdout.trim());
  } catch {
    throw new Error(
      `oraknid-monitor's ${part} answer couldn't be read${r.stderr.trim() ? `: ${r.stderr.trim().slice(0, 300)}` : "."}`,
    );
  }
  const data = SCHEMAS[part].parse(raw);
  if (part === "proxy") {
    const p = data as ServerProxies;
    for (const x of p.proxies) {
      x.sites = mergeSites(x.sites);
      for (const c of x.certificates) {
        const at = c.notAfter ? Date.parse(c.notAfter) : Number.NaN;
        c.expiresAt = Number.isNaN(at) ? null : at;
      }
    }
  }
  return data;
}

export class ServerInsight {
  readonly #cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(private readonly o: { servers: Servers; bus: EventBus; now?: () => number }) {}

  #now() {
    return this.o.now?.() ?? Date.now();
  }

  /** One part of a server, from the last few seconds' reading or the server itself. */
  async part<K extends InsightPart>(
    id: string,
    part: K,
    fresh = false,
  ): Promise<{ at: number; data: Parts[K] }> {
    const now = this.#now();
    for (const [k, v] of this.#cache) if (now - v.at > INSIGHT_TTL_MS) this.#cache.delete(k);
    const key = `${id}:${part}`;
    const cached = this.#cache.get(key);
    if (cached && !fresh) return { at: cached.at, data: (await cached.value) as Parts[K] };
    const value = (async () => {
      const client = await this.o.servers.monitor(id);
      // Traffic reads the access logs the proxy names, or the usual places.
      const args =
        part === "traffic"
          ? [...new Set((await this.part(id, "proxy")).data.proxies.flatMap((p) => p.accessLogs))]
          : [];
      return runPart(client, part, args);
    })();
    this.#cache.set(key, { at: now, value });
    try {
      return { at: now, data: await value };
    } catch (error) {
      this.#cache.delete(key);
      throw error;
    }
  }

  /** Forgets what was read of a server: after a restart, or when it is removed. */
  forget(id: string) {
    for (const k of [...this.#cache.keys()]) if (k.startsWith(`${id}:`)) this.#cache.delete(k);
  }

  /** The logs I can open on a server: its services, its containers, its proxy's files. */
  async logSources(id: string): Promise<ServerLogSource[]> {
    const out: ServerLogSource[] = [];
    const [docker, proxy] = await Promise.allSettled([
      this.part(id, "docker"),
      this.part(id, "proxy"),
    ]);
    if (proxy.status === "fulfilled")
      for (const p of proxy.value.data.proxies)
        for (const f of [...p.accessLogs, ...p.errorLogs])
          out.push({ id: `file:${f}`, label: `${p.kind}: ${f}`, kind: "proxy" });
    for (const s of this.o.servers.latest(id)?.services ?? [])
      if (LogSource.safeParse(`unit:${s}`).success)
        out.push({ id: `unit:${s}`, label: s, kind: "service" });
    if (docker.status === "fulfilled")
      for (const c of docker.value.data.containers)
        if (LogSource.safeParse(`container:${c.name}`).success)
          out.push({
            id: `container:${c.name}`,
            label: c.project ? `${c.name} (${c.project})` : c.name,
            kind: "container",
          });
    return out;
  }

  /** A log's last lines, or those matching a search (in the last 20 000). */
  async logs(
    id: string,
    source: string,
    o: { lines?: number; search?: string } = {},
  ): Promise<ServerLogs> {
    const src = LogSource.parse(source);
    const client = await this.o.servers.monitor(id);
    const n = Math.max(1, Math.min(2000, o.lines ?? 200));
    const r = await exec(
      client,
      `~/${MONITOR_PATH} logs ${q(src)} -n ${n}${o.search ? ` -g ${q(o.search)}` : ""}`,
      { timeoutMs: 30_000, cap: 2 * 1024 * 1024 },
    );
    const notes = noteLines(r.stderr);
    if (r.code === 3 || r.code === 2) throw new Error(notes.join(" ") || "That log can't be read.");
    return { lines: splitLog(r.stdout).slice(-n), notes };
  }

  /**
   * Follows a log (ADR-043): its last lines, then each new one, until stop()
   * ends the channel's input, which ends the follower on the server.
   */
  async follow(
    id: string,
    source: string,
    push: (lines: string[]) => void,
    end: (error: string | null) => void,
    o: { lines?: number; flushMs?: number } = {},
  ): Promise<() => void> {
    const src = LogSource.parse(source);
    const client = await this.o.servers.monitor(id);
    const n = Math.max(1, Math.min(1000, o.lines ?? 100));
    const ch = await new Promise<ClientChannel>((resolve, reject) =>
      client.exec(`~/${MONITOR_PATH} logs ${q(src)} -n ${n} -f`, (err, c) =>
        err ? reject(err) : resolve(c),
      ),
    );
    let partial = "";
    let pending: string[] = [];
    let skipped = 0;
    let errText = "";
    let done = false;
    const flush = () => {
      if (skipped) pending.push(`… ${skipped} more lines not shown (too many at once).`);
      skipped = 0;
      if (pending.length) push(pending);
      pending = [];
    };
    const timer = setInterval(flush, o.flushMs ?? 250);
    ch.on("data", (d: Buffer) => {
      const text = partial + d.toString();
      const lines = text.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) {
        const c = cleanLine(l);
        if (/^-- (Journal begins|Logs begin|No entries)/.test(c)) continue;
        // A torrent is cut, not queued: the screen shows what keeps up.
        if (pending.length < 500) pending.push(c);
        else skipped++;
      }
    });
    ch.stderr.on("data", (d: Buffer) => {
      errText += d.toString();
    });
    ch.on("close", (code: number | null) => {
      clearInterval(timer);
      if (partial) pending.push(cleanLine(partial));
      flush();
      if (done) return;
      done = true;
      const notes = noteLines(errText);
      end(code === 3 || code === 2 ? notes.join(" ") || "That log can't be read." : null);
    });
    // What the server said about access (the journal's group…) comes first.
    setTimeout(() => {
      const notes = noteLines(errText);
      if (notes.length && !done) push(notes.map((x) => `[oraknid] ${x}`));
    }, 1000).unref();
    return () => {
      if (done) return;
      done = true;
      clearInterval(timer);
      ch.end();
      // A follower that doesn't notice its input ending is closed after a moment.
      setTimeout(() => ch.close(), 3000).unref();
    };
  }

  /** Restarts a container or a service, after I said yes (ADR-043); audited. */
  async restart(input: ServerRestart): Promise<{ ok: true }> {
    const { id, kind, name } = input;
    const r = this.o.servers.row(id);
    let command: string;
    if (kind === "container") {
      const docker = (await this.part(id, "docker", true)).data;
      if (!docker.engine || docker.error)
        throw new Error(docker.error ?? "Neither Docker nor Podman is on this server.");
      if (!docker.containers.some((c) => c.name === name))
        throw new Error(`No container ${name} on ${r.name}.`);
      command = `${docker.engine === "podman" ? "podman" : "docker"} restart ${q(name)}`;
    } else {
      const unit = name.endsWith(".service") ? name : `${name}.service`;
      const known = new Set(this.o.servers.latest(id)?.services ?? []);
      try {
        for (const d of (await this.part(id, "databases")).data.databases)
          if (d.source === "service") known.add(d.name);
      } catch {}
      if (!known.has(unit)) throw new Error(`No service ${unit} running on ${r.name}.`);
      command = `if [ "$(id -u)" = 0 ]; then systemctl restart ${q(unit)}; else sudo -n systemctl restart ${q(unit)}; fi`;
    }
    const client = await this.o.servers.monitor(id);
    const res = await exec(client, command, { timeoutMs: 120_000 });
    const said = `${res.stderr}\n${res.stdout}`.trim();
    const error =
      res.code === 0
        ? null
        : /password is required|sudo: /i.test(said)
          ? `Restarting a service needs root: ${r.user} isn't root and has no sudo without a password.`
          : /permission denied/i.test(said)
            ? `${r.user} can't reach the Docker socket: add ${r.user} to the docker group.`
            : said.split("\n").pop() || `It ended with code ${res.code}.`;
    this.forget(id);
    // Every restart is in the audit log, done or not (ADR-026).
    this.o.bus.publish({
      type: "server.restarted",
      topic: "overview",
      jobId: null,
      payload: { id, server: r.name, kind, name, ok: error === null, error },
      actor: "owner",
    });
    if (error) throw new Error(error);
    return { ok: true };
  }
}

const splitLog = (s: string) =>
  s
    .split("\n")
    .map(cleanLine)
    .filter((l, i, all) => !(i === all.length - 1 && l === ""))
    .filter((l) => !/^-- (Journal begins|Logs begin|No entries)/.test(l));

const noteLines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^oraknid-monitor: /, ""))
    .slice(0, 5);

/**
 * What runs on the server, in a few lines for the state document (ADR-026):
 * containers, databases, the proxy's sites. Each part that can't be read says why.
 */
export async function insightSummary(client: Client): Promise<string> {
  const out: string[] = [];
  const read = async <K extends InsightPart>(part: K) => {
    try {
      return await runPart(client, part);
    } catch (error) {
      out.push(`- ${part}: not read (${error instanceof Error ? error.message : String(error)})`);
      return null;
    }
  };
  const docker = await read("docker");
  if (docker?.error) out.push(`- Containers: not read: ${docker.error}`);
  else if (docker?.engine) {
    const running = docker.containers.filter((c) => c.state === "running").length;
    out.push(
      `### Containers (${docker.engine} ${docker.version ?? ""}, ${running} running of ${docker.containers.length}; ${docker.images.length} images, ${docker.volumes.length} volumes)`,
    );
    for (const c of docker.containers.slice(0, 60))
      out.push(
        `- ${c.name}: ${c.image}, ${c.state}${c.health ? ` (${c.health})` : ""}${c.ports ? `, ports ${c.ports}` : ""}${c.project ? `, compose ${c.project}` : ""}`,
      );
  }
  const dbs = await read("databases");
  if (dbs?.databases.length) {
    out.push("### Databases");
    for (const d of dbs.databases)
      out.push(
        `- ${d.kind} ${d.version ?? ""} (${d.source} ${d.name}), ${d.state}${d.port ? `, port ${d.port}` : ""}`,
      );
  }
  const proxy = await read("proxy");
  for (const p of proxy?.proxies ?? []) {
    out.push(`### ${p.kind} (${p.source} ${p.name}, ${p.state})`);
    for (const s of p.sites.slice(0, 60))
      out.push(
        `- ${s.names.join(" ") || "(default)"} → ${s.upstreams.join(", ") || s.root || s.redirect || "?"}${s.certificate ? " (TLS)" : ""}`,
      );
    for (const c of p.certificates)
      if (c.expiresAt)
        out.push(
          `- certificate ${c.path} ends ${new Date(c.expiresAt).toISOString().slice(0, 10)}`,
        );
  }
  return out.length ? `## What runs (oraknid-monitor)\n${out.join("\n").slice(0, 12_000)}` : "";
}
