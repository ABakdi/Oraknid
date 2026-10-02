import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ParsedSkill, parseSkill } from "@oraknid/core";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { skills } from "../db/schema.ts";

export type SkillRow = typeof skills.$inferSelect;

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A fixed ULID-shaped id for a built-in skill, the same on every machine. */
export function stableId(name: string): string {
  const bytes = createHash("sha256").update(`oraknid-skill:${name}`).digest();
  let id = "0";
  for (let i = 0; id.length < 26; i++) id += CROCKFORD[(bytes[i] as number) % 32];
  return id;
}

export const BUILT_IN_DEFAULT = stableId("canon-driven-development");

/** Finds the repo's skills/ folder from this module (src/ or dist/). */
function builtInDir(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "skills");
    if (existsSync(join(candidate, "canon-driven-development.md"))) return candidate;
    dir = dirname(dir);
  }
  return null;
}

/** The skills library (docs/01-Specification/Skills.md). Jobs pin the version they start with. */
export class SkillStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Built-ins are refreshed at start: a changed file becomes a new version. */
  seedBuiltIns(dir = builtInDir()): number {
    if (!dir) return 0;
    let added = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const parsed = parseSkill(readFileSync(join(dir, file), "utf8"), file.replace(/\.md$/, ""));
      if (this.#save(stableId(parsed.name), parsed, "built-in")) added++;
    }
    return added;
  }

  upload(markdown: string, fallbackName: string): { skill: SkillRow; ignored: string[] } {
    const parsed = parseSkill(markdown, fallbackName);
    const existing = this.db
      .select()
      .from(skills)
      .where(and(eq(skills.name, parsed.name), eq(skills.source, "uploaded")))
      .get();
    const id = existing?.id ?? stableId(`uploaded:${parsed.name}:${this.now()}`);
    this.#save(id, parsed, "uploaded");
    return { skill: this.latest(id) as SkillRow, ignored: parsed.ignored };
  }

  /** A new version of one of my skills; built-ins are read-only. */
  edit(id: string, markdown: string): { skill: SkillRow; ignored: string[] } {
    const current = this.latest(id);
    if (!current) throw new Error(`No skill ${id}.`);
    if (current.source === "built-in")
      throw new Error("Built-in skills are read-only. Upload a copy to change it.");
    const parsed = parseSkill(markdown, current.name);
    this.#save(id, parsed, "uploaded");
    return { skill: this.latest(id) as SkillRow, ignored: parsed.ignored };
  }

  /** Removes one of my skills, unless a job that hasn't ended uses it. */
  remove(id: string, inUse: (id: string) => string[]) {
    const current = this.latest(id);
    if (!current) throw new Error(`No skill ${id}.`);
    if (current.source === "built-in") throw new Error("Built-in skills cannot be deleted.");
    const jobs = inUse(id);
    if (jobs.length)
      throw new Error(`"${current.name}" is used by jobs that haven't ended: ${jobs.join(", ")}.`);
    this.db.delete(skills).where(eq(skills.id, id)).run();
  }

  latest(id: string): SkillRow | undefined {
    return this.db
      .select()
      .from(skills)
      .where(eq(skills.id, id))
      .orderBy(desc(skills.version))
      .get();
  }

  version(id: string, version: number): SkillRow | undefined {
    return this.db
      .select()
      .from(skills)
      .where(and(eq(skills.id, id), eq(skills.version, version)))
      .get();
  }

  /** The latest version of every skill. */
  list(): SkillRow[] {
    const latest = new Map<string, SkillRow>();
    for (const s of this.db.select().from(skills).orderBy(desc(skills.version)).all()) {
      if (!latest.has(s.id)) latest.set(s.id, s);
    }
    // The default first (the job form's choice), then by name.
    return [...latest.values()].sort((a, b) =>
      a.id === BUILT_IN_DEFAULT ? -1 : b.id === BUILT_IN_DEFAULT ? 1 : a.name.localeCompare(b.name),
    );
  }

  #save(id: string, p: ParsedSkill, source: "built-in" | "uploaded"): boolean {
    const latest = this.latest(id);
    if (
      latest &&
      latest.body === p.body &&
      latest.description === p.description &&
      latest.interview === p.interview
    ) {
      return false;
    }
    this.db
      .insert(skills)
      .values({
        id,
        version: (latest?.version ?? 0) + 1,
        name: p.name,
        description: p.description,
        source,
        body: p.body,
        interview: p.interview,
        requiredTools: p.requiredTools,
        verify: p.verify,
        createdAt: this.now(),
      })
      .run();
    return true;
  }
}
