import { mkdirSync } from "node:fs";
import type { NewServer, ServerSample, ServerState, ServerView } from "@oraknid/contracts";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import ssh2, { type Client } from "ssh2";
import type { Db } from "../db/open.ts";
import { projects, serverSamples, serverStates, servers } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "../eye/brain.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { discover } from "./discovery.ts";
import { MONITOR_HASH, MONITOR_PATH, MONITOR_SCRIPT } from "./monitor.ts";
import { connect, exec, isHostKeyChanged, newKeyPair, q } from "./ssh.ts";

// My servers (Servers, ADR-026/027): reached over SSH with Oraknid's own
// key, discovered read-only, documented by The Eye, sampled by
// oraknid-monitor. Credentials live in the keychain.

export type ServerRow = typeof servers.$inferSelect;

const KEY = (id: string) => `server.${id}.key`;
const PASSWORD = (id: string) => `server.${id}.password`;
const PASSPHRASE = (id: string) => `server.${id}.passphrase`;
const DAY = 24 * 3600_000;

export class Servers {
  readonly #busy = new Map<string, string>();
  readonly #clients = new Map<string, Client>();
  readonly #latest = new Map<string, ServerSample>();
  #timer: NodeJS.Timeout | undefined;

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
  ) {}

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
    const projectIds = this.o.db
      .select({ id: projects.id, serverIds: projects.serverIds })
      .from(projects)
      .all()
      .filter((p) => p.serverIds.includes(r.id))
      .map((p) => p.id);
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
      busy: this.#busy.get(r.id) ?? null,
      stateVersion: version,
      latest: this.#latest.get(r.id) ?? null,
      projectIds,
      createdAt: r.createdAt,
    };
  }

  list(): ServerView[] {
    return this.o.db
      .select()
      .from(servers)
      .orderBy(asc(servers.name))
      .all()
      .map((r) => this.view(r));
  }

  async add(input: NewServer): Promise<ServerView> {
    if (!input.password && !input.privateKey)
      throw new Error("Give a password (used once) or a private key.");
    const id = newId(this.#now());
    if (input.privateKey) await this.o.secrets.set(KEY(id), `${input.privateKey.trim()}\n`);
    if (input.privateKey && input.passphrase)
      await this.o.secrets.set(PASSPHRASE(id), input.passphrase);
    if (input.password) await this.o.secrets.set(PASSWORD(id), input.password);
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

  async update(id: string, patch: { name?: string; description?: string }) {
    this.row(id);
    if (!Object.keys(patch).length) return;
    this.o.db.update(servers).set(patch).where(eq(servers.id, id)).run();
    this.#publish("server.updated", { id });
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

  /** Read-only discovery and a new version of the state document. */
  discover(id: string, since?: string): Promise<ServerState> {
    return this.#with(id, "discovering", () => this.#document(id, since));
  }

  async #document(id: string, since?: string): Promise<ServerState> {
    const r = this.row(id);
    const client = await this.#connect(r);
    const found = await discover(client);
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
    return this.#save(id, body, "eye", found);
  }

  #save(id: string, body: string, source: "eye" | "owner", discovery: string | null): ServerState {
    const version = (this.state(id)?.version ?? 0) + 1;
    const createdAt = this.#now();
    this.o.db
      .insert(serverStates)
      .values({ id: newId(createdAt), serverId: id, version, body, source, discovery, createdAt })
      .run();
    this.#publish("server.state", { id, version, source });
    return { version, body, source, createdAt };
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
      ? { version: s.version, body: s.body, source: s.source, createdAt: s.createdAt }
      : null;
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
    const alias = `oraknid-${
      r.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || id.slice(-6).toLowerCase()
    }`;
    return {
      alias,
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
      if (p.serverIds.includes(id))
        this.o.db
          .update(projects)
          .set({ serverIds: p.serverIds.filter((x) => x !== id) })
          .where(eq(projects.id, p.id))
          .run();
    this.o.db.delete(serverSamples).where(eq(serverSamples.serverId, id)).run();
    this.o.db.delete(serverStates).where(eq(serverStates.serverId, id)).run();
    this.o.db.delete(servers).where(eq(servers.id, id)).run();
    this.#latest.delete(id);
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
            this.o.db.insert(serverSamples).values({ serverId: r.id, at: sample.at, sample }).run();
            this.o.db
              .update(servers)
              .set({ lastSeenAt: sample.at })
              .where(eq(servers.id, r.id))
              .run();
          } catch {}
        }),
    );
    this.o.db
      .delete(serverSamples)
      .where(lt(serverSamples.at, this.#now() - DAY))
      .run();
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
