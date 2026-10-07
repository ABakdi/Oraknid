import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { scrubDeep, scrubSecrets } from "@oraknid/core";
import { and, eq, inArray } from "drizzle-orm";
import { ulid } from "ulid";
import type { Db } from "../db/open.ts";
import {
  attemptEvents,
  attempts,
  events,
  eyeMessages,
  eyePlans,
  jobs,
  projects,
  sessions,
  silkEntries,
  skills,
  taskEdges,
  tasks,
} from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { VERSION } from "../version.ts";
import { unzip, type ZipEntry, zip } from "./zip.ts";

// A job or a project as a zip, and back (Persistence-and-Recovery → Export,
// ADR-061): per job its record as `jobs.export` gives it, its Silk as
// markdown, its sessions' raw logs, and its rows, all scrubbed of known
// secrets and secret-shaped text (BR-13). Imported, its jobs are ended,
// read-only records: nothing runs.

export const EXPORT_FORMAT = "oraknid.export";
export const EXPORT_VERSION = 1;

interface Manifest {
  format: string;
  version: number;
  kind: "job" | "project";
  exportedAt: number;
  oraknid: string;
  project: { name: string; workspacePath: string } | null;
  jobs: { id: string; title: string }[];
}

export interface RecordsDeps {
  db: Db;
  bus: EventBus;
  /** `logs/` of the data folder: sessions' raw logs live in `logs/jobs/<job>/`. */
  logsDir: string;
  /** Known secret values, scrubbed from everything written. */
  known: () => Iterable<string>;
  /** A job's full record (`jobs.export`), already scrubbed. */
  record: (jobId: string) => unknown;
  now?: () => number;
}

/** The rows of a job, by table, as the import puts them back. */
function rowsOf(db: Db, jobId: string) {
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job) throw new Error(`No job ${jobId}.`);
  const taskRows = db.select().from(tasks).where(eq(tasks.jobId, jobId)).all();
  const taskIds = taskRows.map((t) => t.id);
  return {
    jobs: [job],
    skills: db
      .select()
      .from(skills)
      .where(and(eq(skills.id, job.skillId), eq(skills.version, job.skillVersion)))
      .all(),
    tasks: taskRows,
    taskEdges: taskIds.length
      ? db.select().from(taskEdges).where(inArray(taskEdges.taskId, taskIds)).all()
      : [],
    attempts: db.select().from(attempts).where(eq(attempts.jobId, jobId)).all(),
    attemptEvents: db.select().from(attemptEvents).where(eq(attemptEvents.jobId, jobId)).all(),
    sessions: db.select().from(sessions).where(eq(sessions.jobId, jobId)).all(),
    silkEntries: db.select().from(silkEntries).where(eq(silkEntries.jobId, jobId)).all(),
    eyeMessages: db.select().from(eyeMessages).where(eq(eyeMessages.jobId, jobId)).all(),
    eyePlans: db.select().from(eyePlans).where(eq(eyePlans.jobId, jobId)).all(),
    events: db.select().from(events).where(eq(events.jobId, jobId)).all(),
  };
}

type Rows = ReturnType<typeof rowsOf>;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "export";

function jobEntries(d: RecordsDeps, jobId: string, scrub: (s: string) => string): ZipEntry[] {
  const rows = scrubDeep(rowsOf(d.db, jobId), scrub);
  const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
  const out: ZipEntry[] = [
    { name: `jobs/${jobId}/job.json`, data: json(d.record(jobId)) },
    { name: `jobs/${jobId}/rows.json`, data: json(rows) },
  ];
  for (const s of rows.silkEntries)
    out.push({
      name: `jobs/${jobId}/silk/${slug(s.kind)}-${s.id}.md`,
      data: Buffer.from(`# ${s.title}\n\n${s.body}\n`),
    });
  for (const s of rows.sessions) {
    const file = s.logFile;
    if (!file || !existsSync(file)) continue;
    out.push({
      name: `jobs/${jobId}/logs/${basename(file)}`,
      data: Buffer.from(scrub(readFileSync(file, "utf8"))),
    });
  }
  return out;
}

/** A job, or every job of a project, as a zip (ADR-061). */
export function exportZip(
  d: RecordsDeps,
  what: { jobId: string } | { projectId: string },
): { name: string; data: Buffer } {
  const known = [...d.known()];
  const scrub = (s: string) => scrubSecrets(s, known);
  const now = d.now?.() ?? Date.now();
  const jobRows =
    "jobId" in what
      ? d.db.select().from(jobs).where(eq(jobs.id, what.jobId)).all()
      : d.db.select().from(jobs).where(eq(jobs.projectId, what.projectId)).all();
  if ("jobId" in what && !jobRows.length) throw new Error(`No job ${what.jobId}.`);
  const projectId = "jobId" in what ? jobRows[0]?.projectId : what.projectId;
  const project = projectId
    ? d.db.select().from(projects).where(eq(projects.id, projectId)).get()
    : undefined;
  if (!project) throw new Error(`No project ${projectId}.`);
  // Drafts are no record of work.
  const chosen = jobRows.filter((j) => j.state !== "draft");
  const manifest: Manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kind: "jobId" in what ? "job" : "project",
    exportedAt: now,
    oraknid: VERSION,
    project: { name: project.name, workspacePath: project.workspacePath },
    jobs: chosen.map((j) => ({ id: j.id, title: scrub(j.title) })),
  };
  const entries: ZipEntry[] = [
    { name: "manifest.json", data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
  ];
  if ("projectId" in what)
    entries.push({
      name: "project.json",
      data: Buffer.from(`${JSON.stringify(scrubDeep(project, scrub), null, 2)}\n`),
    });
  for (const j of chosen) entries.push(...jobEntries(d, j.id, scrub));
  const day = new Date(now).toISOString().slice(0, 10);
  const name =
    "jobId" in what
      ? `oraknid-job-${slug(jobRows[0]?.title ?? "job")}-${day}.zip`
      : `oraknid-project-${slug(project.name)}-${day}.zip`;
  return { name, data: zip(entries, new Date(now)) };
}

export interface ImportResult {
  projectId: string;
  imported: { id: string; title: string }[];
  skipped: { id: string; title: string; why: string }[];
}

/** What a job can't go on doing once imported: an ended record. */
const ENDED = new Set(["completed", "cancelled"]);

/**
 * A zip made by Oraknid, its jobs added as ended, read-only records under
 * `projectId`, or under a project of the zip's name (made, with a folder
 * of Oraknid's own, when none has it). A job already here is skipped.
 */
export function importZip(
  d: RecordsDeps & { importsDir: string },
  buf: Buffer,
  target: { projectId?: string | null } = {},
): ImportResult {
  const files = unzip(buf);
  const read = <T>(name: string): T => {
    const f = files.get(name);
    if (!f) throw new Error(`That zip has no ${name}: it isn't an export of Oraknid's.`);
    try {
      return JSON.parse(f.toString("utf8")) as T;
    } catch {
      throw new Error(`That zip's ${name} can't be read.`);
    }
  };
  const manifest = read<Manifest>("manifest.json");
  if (manifest.format !== EXPORT_FORMAT)
    throw new Error("That zip isn't an export of Oraknid's jobs or projects.");
  if (manifest.version > EXPORT_VERSION)
    throw new Error("That export comes from a newer Oraknid: update this one first.");
  const now = d.now?.() ?? Date.now();
  const projectId = target.projectId
    ? (d.db.select().from(projects).where(eq(projects.id, target.projectId)).get()?.id ??
      (() => {
        throw new Error(`No project ${target.projectId}.`);
      })())
    : projectFor(d, manifest.project?.name ?? "Imported", now);

  const result: ImportResult = { projectId, imported: [], skipped: [] };
  for (const { id, title } of manifest.jobs) {
    if (!/^[\w-]+$/.test(id)) {
      result.skipped.push({ id, title, why: "Its id isn't one Oraknid makes." });
      continue;
    }
    if (d.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, id)).get()) {
      result.skipped.push({ id, title, why: "It is already here." });
      continue;
    }
    const rows = read<Rows>(`jobs/${id}/rows.json`);
    const logDir = join(d.logsDir, "jobs", id);
    d.bus.atomically(() => {
      for (const s of rows.skills ?? []) d.db.insert(skills).values(s).onConflictDoNothing().run();
      for (const j of rows.jobs)
        d.db
          .insert(jobs)
          .values({
            ...j,
            projectId,
            state: ENDED.has(j.state) ? j.state : "cancelled",
            worktree: null,
            queuedAt: null,
            blockedUntil: null,
            finishedAt: j.finishedAt ?? now,
          })
          .run();
      for (const t of rows.tasks ?? []) d.db.insert(tasks).values(t).run();
      for (const e of rows.taskEdges ?? []) d.db.insert(taskEdges).values(e).run();
      for (const a of rows.attempts ?? []) d.db.insert(attempts).values(a).run();
      for (const { id: _, ...e } of rows.attemptEvents ?? [])
        d.db.insert(attemptEvents).values(e).run();
      for (const s of rows.sessions ?? [])
        d.db
          .insert(sessions)
          .values({ ...s, pid: null, logFile: join(logDir, basename(s.logFile)) })
          .run();
      for (const s of rows.silkEntries ?? []) d.db.insert(silkEntries).values(s).run();
      for (const m of rows.eyeMessages ?? [])
        d.db
          .insert(eyeMessages)
          .values({ ...m, projectId })
          .run();
      for (const p of rows.eyePlans ?? []) d.db.insert(eyePlans).values(p).run();
      for (const { seq: _, ...e } of rows.events ?? []) d.db.insert(events).values(e).run();
      d.bus.publish({
        type: "job.imported",
        topic: "overview",
        jobId: id,
        payload: { id, title, projectId, from: manifest.oraknid },
        actor: "owner",
      });
    });
    for (const [name, data] of files) {
      const prefix = `jobs/${id}/logs/`;
      if (!name.startsWith(prefix)) continue;
      const file = name.slice(prefix.length);
      if (file.includes("/")) continue;
      mkdirSync(logDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(logDir, file), data, { mode: 0o600 });
    }
    result.imported.push({ id, title });
  }
  return result;
}

/** The project of that name, or a new one with a folder of Oraknid's for its records. */
function projectFor(d: RecordsDeps & { importsDir: string }, name: string, now: number): string {
  const same = d.db.select().from(projects).where(eq(projects.name, name)).get();
  if (same) return same.id;
  const id = ulid(now);
  const folder = join(d.importsDir, `${slug(name)}-${id.slice(-6).toLowerCase()}`);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  d.db
    .insert(projects)
    .values({
      id,
      name,
      workspacePath: folder,
      isGitRepo: false,
      releaseBranch: "main",
      workBranch: "main",
      createdAt: now,
    })
    .run();
  d.bus.publish({
    type: "project.created",
    topic: "overview",
    jobId: null,
    payload: { id, name, imported: true },
    actor: "owner",
  });
  return id;
}
