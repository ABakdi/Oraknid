import type { NewTool, ToolView, UpdateTool } from "@oraknid/contracts";
import { eq, inArray } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { tools } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { newId } from "../ids.ts";
import type { Secrets } from "../os/secrets.ts";

// Tools for skills (ADR-021): MCP servers I set up once, which the
// daemon runs for the sessions of a job that has them.

export type ToolRow = typeof tools.$inferSelect;

const secretKey = (toolId: string, name: string) => `tool.${toolId}.${name}`;

export class ToolRegistry {
  constructor(
    private readonly db: Db,
    private readonly bus: EventBus,
    private readonly secrets: Secrets,
    private readonly now: () => number = Date.now,
  ) {}

  all(): ToolRow[] {
    return this.db.select().from(tools).orderBy(tools.name).all();
  }

  get(id: string): ToolRow {
    const row = this.db.select().from(tools).where(eq(tools.id, id)).get();
    if (!row) throw new Error(`No tool ${id}.`);
    return row;
  }

  /** The tools of these names that are set up; the rest are missing. */
  byNames(names: string[]): ToolRow[] {
    if (!names.length) return [];
    return this.db.select().from(tools).where(inArray(tools.name, names)).all();
  }

  missing(names: string[]): string[] {
    const have = new Set(this.byNames(names).map((t) => t.name));
    return names.filter((n) => !have.has(n));
  }

  async view(row: ToolRow, usedBy: string[]): Promise<ToolView> {
    const missingSecrets: string[] = [];
    for (const n of row.secretNames)
      if ((await this.secrets.get(secretKey(row.id, n))) === undefined) missingSecrets.push(n);
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      command: row.command,
      args: row.args,
      env: row.env,
      secretNames: row.secretNames,
      missingSecrets,
      reads: row.reads,
      sends: row.sends,
      untrusted: row.untrusted,
      usedBy,
      createdAt: row.createdAt,
    };
  }

  async create(input: NewTool): Promise<ToolRow> {
    if (this.db.select().from(tools).where(eq(tools.name, input.name)).get())
      throw new Error(`A tool named "${input.name}" exists already.`);
    const id = newId(this.now());
    for (const [name, value] of Object.entries(input.secrets))
      await this.secrets.set(secretKey(id, name), value);
    this.db
      .insert(tools)
      .values({
        id,
        name: input.name,
        description: input.description,
        command: input.command,
        args: input.args,
        env: input.env,
        secretNames: Object.keys(input.secrets),
        reads: input.reads,
        sends: input.sends,
        untrusted: input.untrusted,
        createdAt: this.now(),
      })
      .run();
    this.#publish("tool.created", { toolId: id, name: input.name });
    return this.get(id);
  }

  /** Secrets given here replace or add; an empty value removes that secret. */
  async update(input: UpdateTool): Promise<ToolRow> {
    const row = this.get(input.id);
    const secretNames = new Set(row.secretNames);
    for (const [name, value] of Object.entries(input.secrets ?? {})) {
      await this.secrets.set(secretKey(row.id, name), value);
      secretNames.add(name);
    }
    const { id: _id, secrets: _s, ...rest } = input;
    this.db
      .update(tools)
      .set({ ...rest, secretNames: [...secretNames] })
      .where(eq(tools.id, row.id))
      .run();
    this.#publish("tool.updated", { toolId: row.id, name: input.name ?? row.name });
    return this.get(row.id);
  }

  async remove(id: string) {
    const row = this.get(id);
    for (const n of row.secretNames) await this.secrets.delete(secretKey(id, n));
    this.db.delete(tools).where(eq(tools.id, id)).run();
    this.#publish("tool.removed", { toolId: id, name: row.name });
  }

  /** The server's whole environment: plain values and its secrets, read now (BR-13). */
  async environment(row: ToolRow): Promise<Record<string, string>> {
    const env: Record<string, string> = { ...row.env };
    for (const n of row.secretNames) {
      const v = await this.secrets.get(secretKey(row.id, n));
      if (v === undefined)
        throw new Error(
          `The tool "${row.name}" is missing its secret ${n}: set it in Settings → Tools.`,
        );
      env[n] = v;
    }
    return env;
  }

  /** What the policy needs to know of these tools' calls (ADR-021). */
  declarations(rows: ToolRow[]): Map<string, "read" | "send"> {
    const out = new Map<string, "read" | "send">();
    for (const t of rows) {
      for (const r of t.reads) out.set(`mcp__${t.name}__${r}`, "read");
      for (const s of t.sends) out.set(`mcp__${t.name}__${s}`, "send");
    }
    return out;
  }

  #publish(type: string, payload: Record<string, unknown>) {
    this.bus.publish({ type, topic: "overview", jobId: null, payload, actor: "owner" });
  }
}
