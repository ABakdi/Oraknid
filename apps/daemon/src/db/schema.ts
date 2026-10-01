import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Tables follow docs/02-Architecture/Persistence-and-Recovery.md.
// Timestamps are epoch milliseconds; JSON columns hold contract shapes.

const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  workspacePath: text("workspace_path").notNull().unique(),
  isGitRepo: integer("is_git_repo", { mode: "boolean" }).notNull(),
  releaseBranch: text("release_branch").notNull(),
  workBranch: text("work_branch").notNull(),
  createdAt: integer("created_at").notNull(),
  archivedAt: integer("archived_at"),
});

export const skills = sqliteTable(
  "skills",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    source: text("source", { enum: ["built-in", "uploaded"] }).notNull(),
    body: text("body").notNull(),
    interview: integer("interview", { mode: "boolean" }).notNull(),
    requiredTools: json<string[]>("required_tools").notNull(),
    verify: json<string[]>("verify").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id, t.version] })],
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    inputs: json<unknown[]>("inputs").notNull(),
    skillId: text("skill_id").notNull(),
    skillVersion: integer("skill_version").notNull(),
    autonomy: text("autonomy", { enum: ["supervised", "standard", "full"] }).notNull(),
    allowedLegIds: json<string[]>("allowed_leg_ids").notNull(),
    budget: json<unknown>("budget").notNull(),
    state: text("state").notNull(),
    pauseReason: text("pause_reason"),
    blockedReason: text("blocked_reason"),
    webVersion: integer("web_version").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("jobs_project").on(t.projectId), index("jobs_state").on(t.state)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    kind: text("kind").notNull(),
    scope: json<string[]>("scope").notNull(),
    verify: json<string[]>("verify").notNull(),
    requiredCapabilities: json<string[]>("required_capabilities").notNull(),
    difficulty: text("difficulty", { enum: ["low", "medium", "high"] }).notNull(),
    state: text("state").notNull(),
    assignedLegId: text("assigned_leg_id"),
    assignedModelId: text("assigned_model_id"),
    effort: text("effort"),
    attemptCount: integer("attempt_count").notNull().default(0),
    budget: json<unknown>("budget"),
    leaseUntil: integer("lease_until"),
  },
  (t) => [index("tasks_job").on(t.jobId), index("tasks_state").on(t.state)],
);

export const taskEdges = sqliteTable(
  "task_edges",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    dependsOn: text("depends_on")
      .notNull()
      .references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOn] })],
);

export const legs = sqliteTable("legs", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  kind: text("kind").notNull(),
  config: json<Record<string, unknown>>("config").notNull(),
  secretRef: text("secret_ref"),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  health: text("health").notNull(),
  quota: json<unknown[]>("quota").notNull(),
});

export const legModels = sqliteTable(
  "leg_models",
  {
    id: text("id").primaryKey(),
    legId: text("leg_id")
      .notNull()
      .references(() => legs.id),
    model: text("model").notNull(),
    displayName: text("display_name").notNull(),
    hidden: integer("hidden", { mode: "boolean" }).notNull(),
    effortLevels: json<string[]>("effort_levels").notNull(),
    quota: json<unknown[]>("quota").notNull(),
    profile: json<unknown>("profile").notNull(),
  },
  (t) => [uniqueIndex("leg_models_leg_model").on(t.legId, t.model)],
);

export const silkEntries = sqliteTable(
  "silk_entries",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    taskId: text("task_id"),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    supersedes: text("supersedes"),
    authoredBy: json<unknown>("authored_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("silk_job_kind").on(t.jobId, t.kind)],
);

export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["approval", "question"] }).notNull(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    taskId: text("task_id"),
    raisedBy: json<unknown>("raised_by").notNull(),
    title: text("title").notNull(),
    detail: text("detail").notNull(),
    options: json<string[]>("options").notNull(),
    defaultOption: text("default_option"),
    state: text("state").notNull(),
    answer: text("answer"),
    answeredAt: integer("answered_at"),
    answeredByDeviceId: text("answered_by_device_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("inbox_state").on(t.state)],
);

/** The durable step journal (ADR-003). */
export const steps = sqliteTable(
  "steps",
  {
    jobId: text("job_id").notNull(),
    stepKey: text("step_key").notNull(),
    status: text("status", { enum: ["running", "done", "failed"] }).notNull(),
    inputHash: text("input_hash").notNull(),
    output: json<unknown>("output"),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.stepKey] })],
);

/** The side-effect outbox (BR-6). */
export const sideEffects = sqliteTable("side_effects", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  taskId: text("task_id"),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  action: text("action").notNull(),
  payload: json<Record<string, unknown>>("payload").notNull(),
  state: text("state").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Append-only. Feeds the live UI, stats and the audit log. */
export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    at: integer("at").notNull(),
    type: text("type").notNull(),
    topic: text("topic").notNull(),
    jobId: text("job_id"),
    payload: json<unknown>("payload"),
  },
  (t) => [index("events_topic_seq").on(t.topic, t.seq), index("events_job").on(t.jobId)],
);

export const devices = sqliteTable("devices", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  pairedAt: integer("paired_at").notNull(),
  lastSeenAt: integer("last_seen_at"),
  revokedAt: integer("revoked_at"),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: integer("updated_at").notNull().default(sql`(unixepoch() * 1000)`),
});
