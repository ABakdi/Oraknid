import { mkdirSync } from "node:fs";
import {
  isProduction,
  type NewServer,
  type ServerPatch,
  type ServerSample,
  type ServerState,
  type ServerStateVersion,
  type ServerTest,
  type ServerTestResult,
  type ServerView,
} from "@oraknid/contracts";
import { and, asc, desc, eq } from "drizzle-orm";
import ssh2, { type Client } from "ssh2";
import type { Db } from "../db/open.ts";
import { jobs, projects, serverSamples, serverStates, servers } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { discover } from "./discovery.ts";
import { insightSummary, ServerInsight } from "./insight.ts";
import { MONITOR_HASH, MONITOR_PATH, MONITOR_SCRIPT } from "./monitor.ts";
import { connect, exec, isHostKeyChanged, newKeyPair, q, sshWords } from "./ssh.ts";

// My servers (Servers, ADR-026/027): reached over SSH with Oraknid's own
// key, discovered read-only, documented by The Eye, sampled by
// oraknid-monitor. Credentials live in the keychain.

export type ServerRow = typeof servers.$inferSelect;

const KEY = (id: string) => `server.${id}.key`;
const PASSWORD = (id: string) => `server.${id}.password`;
const PASSPHRASE = (id: string) => `server.${id}.passphrase`;
const DAY = 24 * 3600_000;

/** A job that had the server, at its end (ADR-049): what it changed goes into the state document. */
export interface AfterJob {
  id: string;
  title: string;
  /** What it did there, a line each; null when it isn't the server's own job (its tasks may be code). */
  changes: string[] | null;
}
/** How long Test connection waits for the server, and for its answer. */
const TEST_TIMEOUT_MS = 10_000;

export class Servers {
  readonly #busy = new Map<string, string>();
  readonly #clients = new Map<string, Client>();
  readonly #latest = new Map<string, ServerSample>();
  /** Servers said stale, until a reading comes again. */
  readonly #staleSaid = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  /** What runs on each server, read while a screen asks (ADR-043). */
  readonly insight: ServerInsight;

  constructor(
    private readonly o: {
      db: Db;
      bus: EventBus;
      secrets: Secrets;
      brain: EyeBrain;
      /** An empty folder for The Eye's reasoning about servers. */
      workDir: string;
      now?: () => number;
      /** Seconds between oraknid-monitor readings. */
      sampleEverySec?: number;
    },
  ) {
    this.insight = new ServerInsight({
      servers: this,
      bus: o.bus,
      ...(o.now ? { now: o.now } : {}),
    });
  }

  #now() {
    return this.o.now?.() ?? Date.now();
  }

  row(id: string): ServerRow {
    const r = this.o.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!r) throw new Error(`No server ${id}.`);
    return r;
  }

  #publish(type: string, payload: Record<string, unknown>) {
    this.o.bus.publish({ type, topic: "overview", jobId: null, payload });
  }

  view(r: ServerRow): ServerView {
    const version =
      this.o.db
        .select({ v: serverStates.version })
        .from(serverStates)
        .where(eq(serverStates.serverId, r.id))
        .orderBy(desc(serverStates.version))
        .get()?.v ?? 0;
    const all = this.o.db
      .select({
        id: projects.id,
        serverIds: projects.serverIds,
        serverRoles: projects.serverRoles,
        serverId: projects.serverId,
      })
      .from(projects)
      .all();
    // Its own project (ADR-049) is not one of mine that uses it.
    const mine = all.filter((p) => !p.serverId && p.serverIds.includes(r.id));
    return {
      id: r.id,
      name: r.name,
      host: r.host,
      port: r.port,
      user: r.user,
      description: r.description,
      auth: r.auth,
      setup: r.setup,
      hostKey: r.hostKey,
      hostKeyOffered: r.hostKeyOffered,
      lastSeenAt: r.lastSeenAt,
      error: r.error,
      stale: this.isStale(r),
      busy: this.#busy.get(r.id) ?? null,
      stateVersion: version,
      latest: this.latest(r.id),
      projectIds: mine.map((p) => p.id),
      projectId: all.find((p) => p.serverId === r.id)?.id ?? null,
      production: r.production,
      productionIn: mine.filter((p) => isProduction(p.serverRoles[r.id])).map((p) => p.id),
      createdAt: r.createdAt,
    };
  }

  /**
   * Production (ADR-049): marked on the server itself, or its role in a
   * project of mine. Every job that reaches it asks before a change.
   */
  isProduction(id: string, role?: { role: string; production: boolean | null }): boolean {
    const r = this.o.db
      .select({ production: servers.production })
      .from(servers)
      .where(eq(servers.id, id))
      .get();
    return !!r?.production || isProduction(role);
  }

  /** My Production mark on the server itself (ADR-049). */
  setProduction(id: string, production: boolean): ServerView {
    this.row(id);
    this.o.db.update(servers).set({ production }).where(eq(servers.id, id)).run();
    this.o.bus.publish({
      type: "server.updated",
      topic: "overview",
      jobId: null,
      payload: { id, fields: ["production"], production },
      actor: "owner",
    });
    return this.view(this.row(id));
  }

  list(): ServerView[] {
    return this.o.db
      .select()
      .from(servers)
      .orderBy(asc(servers.name))
      .all()
      .map((r) => this.view(r));
  }

  /** A private key (and its passphrase) or a password into the keychain, in place of what was there. */
  async #keep(id: string, c: { privateKey?: string; password?: string; passphrase?: string }) {
    if (c.privateKey) {
      await this.o.secrets.set(KEY(id), `${c.privateKey.trim()}\n`);
      await this.o.secrets.delete(PASSWORD(id));
      if (c.passphrase) await this.o.secrets.set(PASSPHRASE(id), c.passphrase);
      else await this.o.secrets.delete(PASSPHRASE(id));
    } else if (c.password) {
      await this.o.secrets.set(PASSWORD(id), c.password);
      await this.o.secrets.delete(KEY(id));
      await this.o.secrets.delete(PASSPHRASE(id));
    }
  }

  async add(input: NewServer): Promise<ServerView> {
    if (!input.password && !input.privateKey)
      throw new Error("Give a password (used once) or a private key.");
    const id = newId(this.#now());
    await this.#keep(id, input);
    this.o.db
      .insert(servers)
      .values({
        id,
        name: input.name,
        host: input.host,
        port: input.port,
        user: input.user,
        description: input.description,
        auth: input.privateKey ? "my-key" : "password",
        createdAt: this.#now(),
      })
      .run();
    this.#publish("server.added", { id, name: input.name });
    return this.view(this.row(id));
  }

  /**
   * Anything about a server, changed after it was added (Servers → Editing
   * a server). A new address forgets the pinned host key (the next
   * connection pins the new one) and oraknid-monitor's install; a new
   * password makes it a server to set up again, which installs Oraknid's key
   * with it. Its connection is dropped: the next use connects with the new.
   */
  async update(id: string, patch: Omit<ServerPatch, "id">): Promise<ServerView> {
    const r = this.row(id);
    const { privateKey, password, passphrase, ...fields } = patch;
    if (privateKey && password) throw new Error("Give a private key or a password, not both.");
    if (passphrase && !privateKey && r.auth !== "my-key")
      throw new Error("A passphrase goes with a private key of yours: give the key too.");
    const set: Partial<ServerRow> = {};
    for (const [k, v] of Object.entries(fields))
      if (v !== undefined && v !== r[k as keyof ServerRow]) Object.assign(set, { [k]: v });
    const moved = set.host !== undefined || set.port !== undefined;
    if (moved)
      Object.assign(set, {
        hostKey: null,
        hostKeyLine: null,
        hostKeyOffered: null,
        monitorHash: null,
      });
    if (privateKey) set.auth = "my-key";
    if (password) Object.assign(set, { auth: "password", setup: "new" });
    const reach = moved || set.user !== undefined || !!privateKey || !!password || !!passphrase;
    if (reach) set.error = null;
    if (privateKey || password) await this.#keep(id, { privateKey, password, passphrase });
    else if (passphrase) await this.o.secrets.set(PASSPHRASE(id), passphrase);
    if (Object.keys(set).length) this.o.db.update(servers).set(set).where(eq(servers.id, id)).run();
    if (reach) this.#drop(id);
    this.o.bus.publish({
      type: "server.updated",
      topic: "overview",
      jobId: null,
      // What changed, never a secret.
      payload: {
        id,
        fields: [
          ...Object.keys(fields).filter((k) => k in set),
          ...(privateKey ? ["privateKey"] : []),
          ...(password ? ["password"] : []),
          ...(passphrase ? ["passphrase"] : []),
        ],
        ...(moved ? { hostKeyCleared: true } : {}),
      },
      actor: "owner",
    });
    return this.view(this.row(id));
  }

  /**
   * Test connection (Servers → Testing the connection): the form's values,
   * nothing saved, a short timeout. With a server's id, credentials left out
   * are the kept ones, and its pinned host key is checked while the address
   * is the same.
   */
  async test(input: ServerTest): Promise<ServerTestResult> {
    const r = input.id ? this.row(input.id) : null;
    let creds: { privateKey?: string; password?: string; passphrase?: string } = input;
    if (r && !input.privateKey && !input.password) {
      const privateKey = await this.o.secrets.get(KEY(r.id));
      const password = privateKey ? undefined : await this.o.secrets.get(PASSWORD(r.id));
      const passphrase = input.passphrase ?? (await this.o.secrets.get(PASSPHRASE(r.id)));
      creds = {
        ...(privateKey ? { privateKey } : {}),
        ...(password ? { password } : {}),
        ...(privateKey && passphrase ? { passphrase } : {}),
      };
    }
    const none = { system: null, hostname: null, fingerprint: null };
    if (!creds.privateKey && !creds.password)
      return { ok: false, said: "Give a private key or a password to try.", ...none };
    const same = r && r.host === input.host && r.port === input.port;
    const srv = {
      name: r?.name || input.host,
      host: input.host,
      port: input.port,
      user: input.user,
    };
    let client: Client | undefined;
    try {
      const c = await connect(
        {
          host: input.host,
          port: input.port,
          user: input.user,
          hostKey: same && r ? r.hostKey : null,
          ...(creds.privateKey ? { privateKey: creds.privateKey } : { password: creds.password }),
          ...(creds.privateKey && creds.passphrase ? { passphrase: creds.passphrase } : {}),
        },
        TEST_TIMEOUT_MS,
      );
      client = c.client;
      const res = await exec(client, "uname -sr; uname -n", { timeoutMs: TEST_TIMEOUT_MS });
      const [system = "", hostname = ""] = res.stdout.trim().split("\n");
      const what = [system.trim(), hostname.trim() && `(${hostname.trim()})`]
        .filter(Boolean)
        .join(" ");
      return {
        ok: true,
        said: `Logged in as ${input.user}${what ? `: ${what}` : ""}.`,
        system: system.trim() || null,
        hostname: hostname.trim() || null,
        fingerprint: c.fingerprint,
      };
    } catch (error) {
      if (isHostKeyChanged(error))
        return {
          ok: false,
          said: `The server presented another host key than the one pinned (now ${error.offered}). Only trust it if you know why it changed; save, then accept it on the server's page.`,
          ...none,
          fingerprint: error.offered,
        };
      return { ok: false, said: sshWords(error, srv), ...none };
    } finally {
      client?.end();
    }
  }

  /** Connects with what the keychain holds, pinning the host key the first time. */
  async #connect(r: ServerRow): Promise<Client> {
    const cached = this.#clients.get(r.id);
    if (cached) return cached;
    const privateKey = await this.o.secrets.get(KEY(r.id));
    const password = privateKey ? undefined : await this.o.secrets.get(PASSWORD(r.id));
    const passphrase = privateKey ? await this.o.secrets.get(PASSPHRASE(r.id)) : undefined;
    if (!privateKey && !password) throw new Error("No key or password for this server.");
    try {
      const { client, fingerprint, keyLine } = await connect({
        host: r.host,
        port: r.port,
        user: r.user,
        hostKey: r.hostKey,
        ...(privateKey ? { privateKey } : { password: password as string }),
        ...(passphrase ? { passphrase } : {}),
      });
      if (!r.hostKey || !r.hostKeyLine)
        this.o.db
          .update(servers)
          .set({ hostKey: fingerprint, hostKeyLine: keyLine })
          .where(eq(servers.id, r.id))
          .run();
      this.o.db
        .update(servers)
        .set({ lastSeenAt: this.#now(), error: null })
        .where(eq(servers.id, r.id))
        .run();
      client.on("close", () => this.#clients.delete(r.id));
      client.on("error", () => this.#clients.delete(r.id));
      this.#clients.set(r.id, client);
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.o.db
        .update(servers)
        .set({
          error: message,
          ...(isHostKeyChanged(error) ? { hostKeyOffered: error.offered } : {}),
        })
        .where(eq(servers.id, r.id))
        .run();
      this.#publish("server.error", { id: r.id, error: message });
      throw error;
    }
  }

  /** The SSH connection to a server, for the backups (ADR-044); the host key is checked as always. */
  client(id: string): Promise<Client> {
    return this.#connect(this.row(id));
  }

  /**
   * One command on a server over Oraknid's own connection: a job's check
   * there (ADR-049). Its exit code and output.
   */
  async run(id: string, command: string, timeoutMs = 60_000) {
    const r = this.row(id);
    if (r.hostKeyOffered)
      throw new Error("The server's host key changed: accept it on the Servers page first.");
    return exec(await this.#connect(r), command, { timeoutMs });
  }

  /** A ready server's connection, with oraknid-monitor up to date (ADR-043 reads through it). */
  async monitor(id: string): Promise<Client> {
    const r = this.row(id);
    if (r.setup !== "ready") throw new Error(`${r.name} isn't set up yet.`);
    if (r.hostKeyOffered)
      throw new Error("The server's host key changed: accept it on the Servers page first.");
    const client = await this.#connect(r);
    if (r.monitorHash !== MONITOR_HASH) await this.#installMonitor(id);
    return client;
  }

  /**
   * Not reached for a while (ADR-026): a ready server with no reading for
   * three rounds of oraknid-monitor (at least two minutes), or whose last
   * connection failed. Its last document and readings stay, marked stale.
   */
  isStale(r: ServerRow): boolean {
    if (r.setup !== "ready") return false;
    if (r.error) return true;
    const every = (this.o.sampleEverySec ?? 15) * 1000;
    const after = Math.max(3 * every, 2 * 60_000);
    return r.lastSeenAt === null || this.#now() - r.lastSeenAt > after;
  }

  /** oraknid-monitor's last reading of a server (after a restart, the last one kept). */
  latest(id: string): ServerSample | null {
    const known = this.#latest.get(id);
    if (known) return known;
    const kept = this.o.db
      .select({ sample: serverSamples.sample })
      .from(serverSamples)
      .where(eq(serverSamples.serverId, id))
      .orderBy(desc(serverSamples.at))
      .get();
    if (!kept) return null;
    const sample = kept.sample as ServerSample;
    this.#latest.set(id, sample);
    return sample;
  }

  /** The key a server now presents is mine to accept (ADR-026). */
  acceptHostKey(id: string) {
    const r = this.row(id);
    if (!r.hostKeyOffered) throw new Error("No new host key is waiting.");
    this.o.db
      .update(servers)
      // The key line comes with the next connection.
      .set({ hostKey: r.hostKeyOffered, hostKeyLine: null, hostKeyOffered: null, error: null })
      .where(eq(servers.id, id))
      .run();
    this.o.bus.publish({
      type: "server.host-key-accepted",
      topic: "overview",
      jobId: null,
      payload: { id, fingerprint: r.hostKeyOffered },
      actor: "owner",
    });
  }

  async #with<T>(id: string, what: string, fn: () => Promise<T>): Promise<T> {
    if (this.#busy.has(id)) throw new Error(`Already ${this.#busy.get(id)}.`);
    this.#busy.set(id, what);
    this.#publish("server.busy", { id, what });
    try {
      return await fn();
    } finally {
      this.#busy.delete(id);
      this.#publish("server.idle", { id });
    }
  }

  /**
   * Setup, with my click: Oraknid's own key in place of a password,
   * discovery, the state document, oraknid-monitor.
   */
  setup(id: string): Promise<ServerView> {
    return this.#with(id, "setting up", async () => {
      let r = this.row(id);
      const client = await this.#connect(r);
      if (r.auth === "password") {
        const pair = newKeyPair(`oraknid-${id.slice(-8).toLowerCase()}`);
        const add = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF ${q(pair.publicKey)} ~/.ssh/authorized_keys || printf '%s\\n' ${q(pair.publicKey)} >> ~/.ssh/authorized_keys)`;
        const res = await exec(client, add);
        if (res.code !== 0)
          throw new Error(`Couldn't add Oraknid's key: ${res.stderr.trim() || res.stdout.trim()}`);
        await this.o.secrets.set(KEY(id), pair.privateKey);
        // The key works before the password goes.
        this.#drop(id);
        await this.o.secrets.delete(PASSWORD(id));
        this.o.db.update(servers).set({ auth: "oraknid-key" }).where(eq(servers.id, id)).run();
        r = this.row(id);
        await this.#connect(r);
        this.o.bus.publish({
          type: "server.key-installed",
          topic: "overview",
          jobId: null,
          payload: { id },
          actor: "owner",
        });
      }
      await this.#installMonitor(id);
      await this.#document(id);
      this.o.db.update(servers).set({ setup: "ready" }).where(eq(servers.id, id)).run();
      this.#publish("server.ready", { id });
      return this.view(this.row(id));
    });
  }

  async #installMonitor(id: string) {
    const client = await this.#connect(this.row(id));
    const res = await exec(
      client,
      `mkdir -p ~/.local/bin && cat > ~/${MONITOR_PATH} && chmod 755 ~/${MONITOR_PATH}`,
      { stdin: MONITOR_SCRIPT },
    );
    if (res.code !== 0) throw new Error(`Couldn't install oraknid-monitor: ${res.stderr.trim()}`);
    this.o.db.update(servers).set({ monitorHash: MONITOR_HASH }).where(eq(servers.id, id)).run();
  }

  /**
   * Read-only discovery and a new version of the state document; after a
   * job, naming what it changed (ADR-049). What was read of the server
   * before is forgotten: the tabs read it again.
   */
  discover(id: string, since?: string, job?: AfterJob): Promise<ServerState> {
    return this.#with(id, "discovering", async () => {
      const state = await this.#document(id, since, job);
      this.insight.forget(id);
      return state;
    });
  }

  async #document(id: string, since?: string, job?: AfterJob): Promise<ServerState> {
    const r = this.row(id);
    const client = await this.#connect(r);
    // What runs there too (ADR-043): containers, databases, the proxy's sites.
    if (this.row(id).monitorHash !== MONITOR_HASH) await this.#installMonitor(id);
    const found = [await discover(client), await insightSummary(client)]
      .filter(Boolean)
      .join("\n\n");
    const previous = this.state(id)?.body ?? "";
    mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
    let body: string;
    try {
      body = (
        await this.o.brain.serverState({
          cwd: this.o.workDir,
          name: r.name,
          description: r.description,
          previous,
          discovery: found,
          ...(since ? { since } : {}),
        })
      ).document;
    } catch (error) {
      // No Leg could write it: the discovery itself, said so.
      body = `# ${r.name}\n\n_The Eye couldn't write this document (${error instanceof Error ? error.message : String(error)}); what discovery found:_\n\n${found}`;
    }
    // What the job changed, said in the document whatever The Eye wrote (ADR-049).
    if (job?.changes && !body.includes(changesHeading(job.title)))
      body = `${body.trimEnd()}\n\n## ${changesHeading(job.title)} (${new Date(this.#now()).toISOString().slice(0, 10)})\n\n${
        job.changes.length ? job.changes.map((c) => `- ${c}`).join("\n") : "- It reported none."
      }\n`;
    return this.#save(id, body, "eye", found, job?.id ?? null);
  }

  #save(
    id: string,
    body: string,
    source: "eye" | "owner",
    discovery: string | null,
    jobId: string | null = null,
  ): ServerState {
    const version = (this.state(id)?.version ?? 0) + 1;
    const createdAt = this.#now();
    this.o.db
      .insert(serverStates)
      .values({
        id: newId(createdAt),
        serverId: id,
        version,
        body,
        source,
        discovery,
        jobId,
        createdAt,
      })
      .run();
    this.#publish("server.state", { id, version, source, ...(jobId ? { jobId } : {}) });
    return { version, body, source, jobId, createdAt };
  }

  /** My edit of the state document: a version too. */
  editState(id: string, body: string): ServerState {
    this.row(id);
    return this.#save(id, body, "owner", null);
  }

  state(id: string, version?: number): ServerState | null {
    const rows = this.o.db
      .select()
      .from(serverStates)
      .where(
        version === undefined
          ? eq(serverStates.serverId, id)
          : and(eq(serverStates.serverId, id), eq(serverStates.version, version)),
      )
      .orderBy(desc(serverStates.version))
      .limit(1)
      .all();
    const s = rows[0];
    return s
      ? {
          version: s.version,
          body: s.body,
          source: s.source,
          jobId: s.jobId,
          createdAt: s.createdAt,
        }
      : null;
  }

  /** Every version of its state document, newest first, without the bodies (ADR-049). */
  history(id: string): ServerStateVersion[] {
    this.row(id);
    return this.o.db
      .select({
        version: serverStates.version,
        source: serverStates.source,
        jobId: serverStates.jobId,
        createdAt: serverStates.createdAt,
        jobTitle: jobs.title,
      })
      .from(serverStates)
      .leftJoin(jobs, eq(jobs.id, serverStates.jobId))
      .where(eq(serverStates.serverId, id))
      .orderBy(desc(serverStates.version))
      .all();
  }

  /** The version a job's end wrote, and the one before it (ADR-049). */
  afterJob(id: string, jobId: string): { before: ServerState | null; after: ServerState } | null {
    const row = this.o.db
      .select({ version: serverStates.version })
      .from(serverStates)
      .where(and(eq(serverStates.serverId, id), eq(serverStates.jobId, jobId)))
      .orderBy(desc(serverStates.version))
      .get();
    const after = row ? this.state(id, row.version) : null;
    if (!after) return null;
    return { before: after.version > 1 ? this.state(id, after.version - 1) : null, after };
  }

  /**
   * What a job's Leg gets for a server its project has (ADR-026): an SSH
   * alias, its key (without a passphrase: the Leg can't type one) and the
   * pinned host key, and the state document.
   */
  async forLeg(id: string): Promise<{
    alias: string;
    name: string;
    host: string;
    port: number;
    user: string;
    privateKey: string;
    knownHost: string | null;
    state: string;
  }> {
    const r = this.row(id);
    const key = await this.o.secrets.get(KEY(id));
    if (!key) throw new Error(`No key for ${r.name}: set it up first.`);
    const passphrase = await this.o.secrets.get(PASSPHRASE(id));
    let privateKey = key;
    if (passphrase) {
      const parsed = ssh2.utils.parseKey(key, passphrase);
      const k = Array.isArray(parsed) ? parsed[0] : parsed;
      if (!k || k instanceof Error)
        throw new Error(`Couldn't open ${r.name}'s key with its passphrase.`);
      privateKey = k.getPrivatePEM();
    }
    return {
      alias: aliasOf(r),
      name: r.name,
      host: r.host,
      port: r.port,
      user: r.user,
      privateKey,
      knownHost: r.hostKeyLine
        ? `${r.port === 22 ? r.host : `[${r.host}]:${r.port}`} ${r.hostKeyLine}`
        : null,
      state: this.state(id)?.body ?? "(no state document yet)",
    };
  }

  /** A shell with a terminal on the server (ADR-028). */
  async shell(id: string, cols: number, rows: number) {
    const client = await this.#connect(this.row(id));
    return new Promise<import("ssh2").ClientChannel>((resolve, reject) =>
      client.shell({ term: "xterm-256color", cols, rows }, (err, ch) =>
        err ? reject(err) : resolve(ch),
      ),
    );
  }

  /** Off the server: Oraknid's key and oraknid-monitor when it can reach it, then everything kept here. */
  async remove(id: string): Promise<{ cleaned: boolean }> {
    const r = this.row(id);
    let cleaned = false;
    try {
      const client = await this.#connect(r);
      await exec(client, `rm -f ~/${MONITOR_PATH}`);
      if (r.auth === "oraknid-key")
        await exec(
          client,
          `[ -f ~/.ssh/authorized_keys ] && { grep -v ${q(`oraknid-${id.slice(-8).toLowerCase()}`)} ~/.ssh/authorized_keys || true; } > ~/.ssh/authorized_keys.oraknid && cat ~/.ssh/authorized_keys.oraknid > ~/.ssh/authorized_keys && rm -f ~/.ssh/authorized_keys.oraknid`,
        );
      cleaned = true;
    } catch {}
    this.#drop(id);
    await this.o.secrets.delete(KEY(id));
    await this.o.secrets.delete(PASSWORD(id));
    await this.o.secrets.delete(PASSPHRASE(id));
    for (const p of this.o.db.select().from(projects).all())
      if (p.serverId === id)
        // Its own project (ADR-049) stays hidden, archived, with its jobs' history.
        this.o.db
          .update(projects)
          .set({ archivedAt: p.archivedAt ?? this.#now() })
          .where(eq(projects.id, p.id))
          .run();
      else if (p.serverIds.includes(id))
        this.o.db
          .update(projects)
          .set({ serverIds: p.serverIds.filter((x) => x !== id) })
          .where(eq(projects.id, p.id))
          .run();
    this.o.db.delete(serverSamples).where(eq(serverSamples.serverId, id)).run();
    this.o.db.delete(serverStates).where(eq(serverStates.serverId, id)).run();
    this.o.db.delete(servers).where(eq(servers.id, id)).run();
    this.#latest.delete(id);
    this.insight.forget(id);
    this.o.bus.publish({
      type: "server.removed",
      topic: "overview",
      jobId: null,
      payload: { id, name: r.name, cleaned },
      actor: "owner",
    });
    return { cleaned };
  }

  /** Drops a server's connection: the next use connects again. */
  forget(id: string) {
    this.#drop(id);
  }

  #drop(id: string) {
    this.#clients.get(id)?.end();
    this.#clients.delete(id);
  }

  // ── oraknid-monitor (ADR-027)

  /** One reading of every ready server, kept for 24 hours. */
  async sampleAll() {
    const ready = this.o.db.select().from(servers).where(eq(servers.setup, "ready")).all();
    await Promise.all(
      ready
        .filter((r) => !r.hostKeyOffered && !this.#busy.has(r.id))
        .map(async (r) => {
          try {
            const client = await this.#connect(r);
            if (r.monitorHash !== MONITOR_HASH) await this.#installMonitor(r.id);
            const res = await exec(client, `~/${MONITOR_PATH} sample`, { timeoutMs: 20_000 });
            const sample = { at: this.#now(), ...JSON.parse(res.stdout.trim()) } as ServerSample;
            this.#latest.set(r.id, sample);
            if (this.#staleSaid.delete(r.id)) this.#publish("server.reached", { id: r.id });
            this.o.db.insert(serverSamples).values({ serverId: r.id, at: sample.at, sample }).run();
            this.o.db
              .update(servers)
              .set({ lastSeenAt: sample.at })
              .where(eq(servers.id, r.id))
              .run();
          } catch (error) {
            // A connection that stopped answering is dropped: the next round connects again.
            // The server goes stale (ADR-026) and says so once.
            this.#drop(r.id);
            const now = this.row(r.id);
            if (this.isStale(now) && !this.#staleSaid.has(r.id)) {
              this.#staleSaid.add(r.id);
              this.#publish("server.stale", {
                id: r.id,
                since: r.lastSeenAt,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }),
    );
    // The last day's readings; a server not reached keeps its last one (ADR-026: stale, not blank).
    this.o.db.$client
      .prepare(
        "delete from server_samples where at < ? and at < (select max(s.at) from server_samples s where s.server_id = server_samples.server_id)",
      )
      .run(this.#now() - DAY);
  }

  samples(id: string, since: number): ServerSample[] {
    return this.o.db
      .select()
      .from(serverSamples)
      .where(and(eq(serverSamples.serverId, id)))
      .orderBy(asc(serverSamples.at))
      .all()
      .filter((s) => s.at >= since)
      .map((s) => s.sample as ServerSample);
  }

  start() {
    const every = (this.o.sampleEverySec ?? 15) * 1000;
    const tick = () => void this.sampleAll().catch(() => {});
    tick();
    this.#timer = setInterval(tick, every);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
    for (const id of [...this.#clients.keys()]) this.#drop(id);
  }
}

/** A server's SSH alias in a Leg's config (ADR-026): `oraknid-<its name>`. */
export const aliasOf = (r: { id: string; name: string }) =>
  `oraknid-${
    r.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || r.id.slice(-6).toLowerCase()
  }`;

/** The heading of what a job changed, in a state document (ADR-049). */
export const changesHeading = (title: string) => `Changes by job “${title}”`;
