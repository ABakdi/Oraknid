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
  /** A shadow repo holds checkpoints when the folder is not a git repo. */
  shadow: integer("shadow", { mode: "boolean" }).notNull().default(false),
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
    /** The job's worktree and branch (Sandboxing → Worktrees). */
    worktree: text("worktree"),
    branch: text("branch"),
    /** Job-level verification commands. */
    verify: json<string[]>("verify").notNull().default([]),
    unsandboxed: integer("unsandboxed", { mode: "boolean" }).notNull().default(false),
    /** Gates I waived for this job (Approvals → Overrides). */
    waived: json<string[]>("waived").notNull().default([]),
    /** My command rules for this job: regex sources (Security → allow/deny list). */
    allowRules: json<string[]>("allow_rules").notNull().default([]),
    denyRules: json<string[]>("deny_rules").notNull().default([]),
    /** A job blocked on quota resumes on its own at this time (Jobs-and-Projects → Blocked). */
    blockedUntil: integer("blocked_until"),
    /** Budget findings already reported ("tokens:warning"…), and the open "raise it?" question. */
    budgetFlags: json<string[]>("budget_flags").notNull().default([]),
    budgetQuestion: text("budget_question"),
    /** Job-level verification rounds so far (each failed round replans). */
    verifyRound: integer("verify_round").notNull().default(0),
    /** The active state a paused or waiting job returns to. */
    resumeState: text("resume_state"),
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
    /** Plan order, and the plan's own key for the task. */
    position: integer("position").notNull().default(0),
    planKey: text("plan_key"),
    /** Why the router chose its Leg model, for the UI. */
    routing: json<unknown>("routing"),
    /** I pinned it to a Leg model. */
    pinnedModelId: text("pinned_model_id"),
    /** I took it over: Oraknid leaves its scope alone (BR-18). */
    ownerHeld: integer("owner_held", { mode: "boolean" }).notNull().default(false),
    /** Escalation state across attempts (Drift-Control, ADR-013). */
    stepUp: integer("step_up").notNull().default(0),
    avoid: json<string[]>("avoid").notNull().default([]),
    escalation: integer("escalation").notNull().default(0),
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
  /** Paused by me: no new assignments, running work paused (Jobs-and-Projects → Controls). */
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  health: text("health").notNull(),
  /** The last health check's finding, in plain words. */
  healthDetail: text("health_detail"),
  /** Not eligible before this time (a rejected quota window). */
  limitedUntil: integer("limited_until"),
  createdAt: integer("created_at").notNull().default(0),
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

/** One Leg's try at one task (Core-Entities → Attempt). */
export const attempts = sqliteTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    jobId: text("job_id").notNull(),
    legId: text("leg_id").notNull(),
    legModelId: text("leg_model_id").notNull(),
    effort: text("effort"),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    outcome: text("outcome", { enum: ["succeeded", "failed", "reassigned", "abandoned"] }),
    escalations: json<string[]>("escalations").notNull(),
  },
  (t) => [index("attempts_task").on(t.taskId)],
);

/** One process or conversation of a Leg (Core-Entities → Session). */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id"),
    jobId: text("job_id"),
    taskId: text("task_id"),
    legId: text("leg_id").notNull(),
    legModelId: text("leg_model_id").notNull(),
    effort: text("effort"),
    nativeSessionId: text("native_session_id"),
    /** With its start time, so recovery never kills a reused pid. */
    pid: integer("pid"),
    pidStartTime: integer("pid_start_time"),
    logFile: text("log_file").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    endReason: text("end_reason"),
    endError: text("end_error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
    cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
    contextTokens: integer("context_tokens"),
    usageEstimated: integer("usage_estimated", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    index("sessions_leg_started").on(t.legId, t.startedAt),
    index("sessions_open").on(t.endedAt),
  ],
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
  result: json<unknown>("result"),
  /** Why it needs me, in plain words, when reconciliation could not tell. */
  problem: text("problem"),
  /** The approval or question waiting on me for this action, if any. */
  inboxItemId: text("inbox_item_id"),
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
    actor: text("actor").notNull().default("oraknid"),
  },
  (t) => [
    index("events_topic_seq").on(t.topic, t.seq),
    index("events_job").on(t.jobId),
    index("events_type").on(t.type),
  ],
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

/** Web push subscriptions, one per subscribed browser or phone (Notifications spec). */
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  endpoint: text("endpoint").primaryKey(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  deviceId: text("device_id"),
  createdAt: integer("created_at").notNull(),
});

/** What Oraknid last wrote to each mirror file, to notice my hand edits (ADR-007). */
export const silkMirror = sqliteTable(
  "silk_mirror",
  {
    jobId: text("job_id").notNull(),
    file: text("file").notNull(),
    hash: text("hash").notNull(),
    /** The open "import my edits?" question, if one was asked. */
    pendingItemId: text("pending_item_id"),
  },
  (t) => [primaryKey({ columns: [t.jobId, t.file] })],
);
