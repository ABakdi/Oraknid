import type {
  ImportDotEnvResult,
  ProjectSecretsView,
  ProjectSecretView,
  SecretEnvironment,
  SetProjectSecret,
} from "@oraknid/contracts";
import { SecretEnvironment as EnvSchema } from "@oraknid/contracts";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { jobs, projectSecrets, projects, settings } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";
import { aliasOf, type Servers } from "../servers/service.ts";
import { exec, q } from "../servers/ssh.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { parseDotEnv, toDotEnv } from "./dotenv.ts";

// A project's secrets per environment (ADR-059). The rows say what
// exists; each value is in the keychain under `project.secret.<id>`, read
// only to hand it to a job's sandbox or to write it on a server, and never
// returned by anything here. Every value read becomes a known secret, so
// the scrub (BR-13) takes it out of events, logs and results.

export const secretKey = (id: string) => `project.secret.${id}`;
export const projectEnvironmentKey = (projectId: string) => `project.environment.${projectId}`;
export const jobEnvironmentKey = (jobId: string) => `job.environment.${jobId}`;

const MASK = "••••••••" as const;

/** Names Oraknid or the sandbox set themselves: a secret can't replace them. */
const RESERVED = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  "LANG",
  "TERM",
]);
const RESERVED_PREFIXES = [
  "ORAKNID_",
  "XDG_",
  "LC_",
  "LD_",
  "GIT_",
  "CLAUDE_",
  "CODEX_",
  "OPENCODE_",
  "SSH_",
];

/** Why a name can't be a secret's, or null. */
export function refusedName(name: string): string | null {
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || name.length > 128)
    return "not an environment variable's name (A–Z, 0–9 and _)";
  if (RESERVED.has(name) || RESERVED_PREFIXES.some((p) => name.startsWith(p)))
    return `${name} is set by Oraknid itself`;
  return null;
}

type Row = typeof projectSecrets.$inferSelect;

export interface ProjectSecretsOptions {
  db: Db;
  bus: EventBus;
  secrets: Secrets;
  servers?: Servers;
  now?: () => number;
}

export class ProjectSecrets {
  readonly #now: () => number;
  /** Jobs whose `project.secrets.used` was said, with the names: said again only when they change. */
  readonly #said = new Map<string, string>();

  constructor(private readonly o: ProjectSecretsOptions) {
    this.#now = o.now ?? Date.now;
    // A deleted project's secrets go with it.
    o.bus.subscribe((e) => {
      if (e.type !== "project.deleted") return;
      const id = (e.payload as { id?: unknown } | null)?.id;
      if (typeof id === "string") void this.removeProject(id).catch(() => {});
    });
  }

  /** The servers, once that service is up (it starts after the tools' broker). */
  attachServers(servers: Servers) {
    this.o.servers = servers;
  }

  #publish(type: string, payload: Record<string, unknown>, jobId: string | null = null) {
    this.o.bus.publish({
      type,
      topic: jobId ? `job:${jobId}` : "overview",
      jobId,
      payload,
      actor: jobId ? "eye" : "owner",
    });
  }

  #project(projectId: string) {
    const p = this.o.db.select().from(projects).where(eq(projects.id, projectId)).get();
    if (!p) throw new Error(`No project ${projectId}.`);
    return p;
  }

  #view(r: Row): ProjectSecretView {
    return {
      id: r.id,
      projectId: r.projectId,
      environment: r.environment,
      name: r.name,
      masked: MASK,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  rows(projectId: string, environment?: SecretEnvironment): Row[] {
    return this.o.db
      .select()
      .from(projectSecrets)
      .where(
        environment
          ? and(
              eq(projectSecrets.projectId, projectId),
              eq(projectSecrets.environment, environment),
            )
          : eq(projectSecrets.projectId, projectId),
      )
      .orderBy(asc(projectSecrets.environment), asc(projectSecrets.name))
      .all();
  }

  /** Names, environments and when set; never a value. */
  list(projectId: string): ProjectSecretsView {
    this.#project(projectId);
    return {
      projectId,
      defaultEnvironment: this.defaultEnvironment(projectId),
      secrets: this.rows(projectId).map((r) => this.#view(r)),
    };
  }

  defaultEnvironment(projectId: string): SecretEnvironment {
    return readSetting(this.o.db, projectEnvironmentKey(projectId), EnvSchema, "dev");
  }

  setDefaultEnvironment(projectId: string, environment: SecretEnvironment): ProjectSecretsView {
    this.#project(projectId);
    writeSetting(this.o.db, projectEnvironmentKey(projectId), EnvSchema, environment, this.#now());
    this.#publish("project.environment.set", { projectId, environment });
    return this.list(projectId);
  }

  /** A job's own environment, chosen at its creation. */
  setJobEnvironment(jobId: string, environment: SecretEnvironment) {
    writeSetting(this.o.db, jobEnvironmentKey(jobId), EnvSchema, environment, this.#now());
  }

  /**
   * The environment a job runs in: its own when chosen; a server job's
   * follows its server (production when the server is, testing
   * otherwise); else its project's default.
   */
  jobEnvironment(jobId: string): SecretEnvironment {
    const own = readSetting(this.o.db, jobEnvironmentKey(jobId), EnvSchema.nullable(), null);
    if (own) return own;
    const job = this.o.db
      .select({ projectId: jobs.projectId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (!job) return "dev";
    const p = this.o.db.select().from(projects).where(eq(projects.id, job.projectId)).get();
    if (p?.serverId) return this.o.servers?.isProduction(p.serverId) ? "production" : "testing";
    return this.defaultEnvironment(job.projectId);
  }

  /** Sets (or replaces) one; the value goes to the keychain only. */
  async set(input: SetProjectSecret): Promise<ProjectSecretView> {
    this.#project(input.projectId);
    const why = refusedName(input.name);
    if (why) throw new Error(`Can't keep ${input.name}: ${why}.`);
    const now = this.#now();
    const existing = this.o.db
      .select()
      .from(projectSecrets)
      .where(
        and(
          eq(projectSecrets.projectId, input.projectId),
          eq(projectSecrets.environment, input.environment),
          eq(projectSecrets.name, input.name),
        ),
      )
      .get();
    const id = existing?.id ?? newId(now);
    // The keychain first: a row never says a value exists that isn't kept.
    await this.o.secrets.set(secretKey(id), input.value);
    if (existing)
      this.o.db
        .update(projectSecrets)
        .set({ updatedAt: now })
        .where(eq(projectSecrets.id, id))
        .run();
    else
      this.o.db
        .insert(projectSecrets)
        .values({
          id,
          projectId: input.projectId,
          environment: input.environment,
          name: input.name,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    this.#publish("project.secret.set", {
      projectId: input.projectId,
      environment: input.environment,
      name: input.name,
      replaced: !!existing,
    });
    const row = this.o.db.select().from(projectSecrets).where(eq(projectSecrets.id, id)).get();
    return this.#view(row as Row);
  }

  /** Many at once from a `.env` text; what couldn't be read is said by line, never by value. */
  async importDotEnv(input: {
    projectId: string;
    environment: SecretEnvironment;
    text: string;
  }): Promise<ImportDotEnvResult> {
    this.#project(input.projectId);
    const parsed = parseDotEnv(input.text);
    const set: string[] = [];
    const skipped = [...parsed.skipped];
    for (const e of parsed.entries) {
      const why = refusedName(e.name);
      if (why) {
        skipped.push({ line: e.line, reason: why });
        continue;
      }
      if (!e.value) {
        skipped.push({ line: e.line, reason: `${e.name} has no value` });
        continue;
      }
      if (e.value.length > 64 * 1024) {
        skipped.push({ line: e.line, reason: `${e.name} is longer than 64 KB` });
        continue;
      }
      await this.set({ ...input, name: e.name, value: e.value });
      set.push(e.name);
    }
    return { set, skipped };
  }

  async remove(id: string): Promise<void> {
    const row = this.o.db.select().from(projectSecrets).where(eq(projectSecrets.id, id)).get();
    if (!row) throw new Error(`No secret ${id}.`);
    await this.o.secrets.delete(secretKey(id)).catch(() => false);
    this.o.db.delete(projectSecrets).where(eq(projectSecrets.id, id)).run();
    this.#publish("project.secret.removed", {
      projectId: row.projectId,
      environment: row.environment,
      name: row.name,
    });
  }

  /** Every secret of a project, rows and keychain entries (its deletion). */
  async removeProject(projectId: string): Promise<number> {
    const rows = this.rows(projectId);
    for (const r of rows) await this.o.secrets.delete(secretKey(r.id)).catch(() => false);
    this.o.db.delete(projectSecrets).where(eq(projectSecrets.projectId, projectId)).run();
    this.o.db
      .delete(settings)
      .where(eq(settings.key, projectEnvironmentKey(projectId)))
      .run();
    return rows.length;
  }

  /** The names a job's environment has (no value). */
  namesForJob(jobId: string, environment = this.jobEnvironment(jobId)): string[] {
    const job = this.o.db
      .select({ projectId: jobs.projectId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    return job ? this.rows(job.projectId, environment).map((r) => r.name) : [];
  }

  /** The values of one project and environment, by name (each now a known secret). */
  async values(projectId: string, environment: SecretEnvironment): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const r of this.rows(projectId, environment)) {
      const v = await this.o.secrets.get(secretKey(r.id));
      if (v !== undefined) out[r.name] = v;
    }
    return out;
  }

  /**
   * What a job's session gets as environment variables in its sandbox:
   * its project's secrets of its environment, nothing of another
   * project's. Said in the job's events by name.
   */
  async envForJob(jobId: string): Promise<Record<string, string>> {
    const job = this.o.db
      .select({ projectId: jobs.projectId })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .get();
    if (!job) return {};
    const environment = this.jobEnvironment(jobId);
    const env = await this.values(job.projectId, environment);
    const names = Object.keys(env).sort();
    const said = `${environment}:${names.join(",")}`;
    if (names.length && this.#said.get(jobId) !== said) {
      this.#said.set(jobId, said);
      this.#publish("project.secrets.used", { environment, names }, jobId);
    }
    return env;
  }

  /**
   * The env tool's write (ADR-059): the job's environment's values (or the
   * one named) written as `NAME=value` lines on one of the job's servers,
   * mine only (umask 077, then 0600), through a temporary file renamed
   * into place. The values go on the command's stdin; the answer names the
   * path and the variables, never a value.
   */
  async writeEnvFile(
    jobId: string,
    a: { server: string; path: string; environment?: SecretEnvironment | undefined },
  ): Promise<string> {
    const servers = this.o.servers;
    if (!servers) throw new Error("Servers aren't available here.");
    const path = envFilePath(a.path);
    const job = this.o.db.select().from(jobs).where(eq(jobs.id, jobId)).get();
    if (!job) throw new Error(`No job ${jobId}.`);
    const project = this.#project(job.projectId);
    const ids = project.serverId ? [project.serverId] : project.serverIds;
    const wanted = a.server.trim().toLowerCase();
    const serverId = ids.find((id) => {
      try {
        const r = servers.row(id);
        return [r.id.toLowerCase(), r.name.toLowerCase(), aliasOf(r)].includes(wanted);
      } catch {
        return false;
      }
    });
    if (!serverId)
      throw new Error(
        `${a.server} isn't one of this job's servers: write the env file only to a server its project has.`,
      );
    const server = servers.row(serverId);
    const environment = a.environment ?? this.jobEnvironment(jobId);
    const production = servers.isProduction(serverId, project.serverRoles[serverId]);
    if (environment === "production" && !production)
      throw new Error(
        `${server.name} isn't production for this project: production values go only to a production server.`,
      );
    if (production && environment !== "production")
      throw new Error(
        `${server.name} is production: it gets only the production values (environment "production").`,
      );
    const values = await this.values(project.id, environment);
    const names = Object.keys(values).sort();
    if (!names.length)
      throw new Error(
        `This project has no ${environment} secrets: the owner sets them in the project's Secrets.`,
      );
    if (server.hostKeyOffered)
      throw new Error(
        "The server's host key changed: the owner accepts it on the Servers page first.",
      );
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
    const tmp = `${path}.oraknid-${Date.now().toString(36)}`;
    const command = [
      "umask 077",
      `mkdir -p -- ${q(dir)}`,
      `cat > ${q(tmp)}`,
      `chmod 600 ${q(tmp)}`,
      `mv -f -- ${q(tmp)} ${q(path)}`,
    ].join(" && ");
    const client = await servers.client(serverId);
    const res = await exec(client, command, { stdin: toDotEnv(values), timeoutMs: 30_000 });
    if (res.code !== 0) {
      const known = Object.values(values);
      let why = res.stderr.trim() || `exit ${res.code}`;
      for (const v of known) if (v) why = why.split(v).join("[secret]");
      throw new Error(`Couldn't write ${path} on ${server.name}: ${why.slice(0, 300)}`);
    }
    this.#publish(
      "project.secret.written",
      { serverId, server: server.name, path, environment, names },
      jobId,
    );
    return `Wrote ${names.length} variable${names.length === 1 ? "" : "s"} (${names.join(", ")}) to ${path} on ${server.name}, mode 0600. The values aren't shown.`;
  }
}

/**
 * Where an env file may go: a full path, or one under the login's home
 * (`~/…` or relative). No `..`, no control characters.
 */
export function envFilePath(raw: string): string {
  let p = raw.trim();
  if (!p) throw new Error("Name the env file's path on the server (e.g. /srv/app/.env).");
  if ([...p].some((ch) => ch.charCodeAt(0) < 32))
    throw new Error("That path has control characters.");
  if (p.split("/").includes("..")) throw new Error("That path goes up with ..: give it in full.");
  if (p.startsWith("~/")) p = p.slice(2);
  if (p.startsWith("~")) throw new Error("Only your own home (~/) can be named that way.");
  if (p.endsWith("/")) throw new Error("That path is a folder: name the file (e.g. .env).");
  if (p.length > 1024) throw new Error("That path is too long.");
  return p;
}
