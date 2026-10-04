import type {
  BackupDestination,
  BackupRetention,
  BackupSchedule,
  BackupTarget,
  ProjectRepo,
  Question,
  QuestionAnswer,
  ServerRole,
} from "@oraknid/contracts";
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

/** A repo a job of a project of several repos works in (ADR-042). */
export interface JobRepo {
  name: string;
  folder: string;
  /** Its worktree, at its folder inside the job's folder. */
  worktree: string;
}

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
  /** The skills its jobs may use; The Eye picks one per job (Skills → Skills per project). Empty: the default. */
  skillIds: json<string[]>("skill_ids").notNull().default([]),
  /** The servers its jobs may use (Servers → Servers in projects). None by default. */
  serverIds: json<string[]>("server_ids").notNull().default([]),
  /** Each of its servers' role in it, by server id (ADR-042). */
  serverRoles: json<Record<string, ServerRole>>("server_roles").notNull().default({}),
  /**
   * Its git repositories, each with its branches and GitHub link (ADR-042):
   * one with folder "" when the folder is the repo, several in their
   * folders, none when it isn't one. (Its single GitHub link of ADR-038
   * moved into its one repo, migration 0031.)
   */
  repos: json<ProjectRepo[]>("repos").notNull().default([]),
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

/** My servers (Servers, ADR-026). Credentials are in the keychain, never here. */
export const servers = sqliteTable("servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  host: text("host").notNull(),
  port: integer("port").notNull(),
  user: text("user").notNull(),
  /** In my words: what it is and what it has. */
  description: text("description").notNull(),
  /** Pinned at the first connection: SHA-256 of its host key, base64. */
  hostKey: text("host_key"),
  /** The pinned host key itself ("type base64"), for a Leg's known_hosts. */
  hostKeyLine: text("host_key_line"),
  /** A key presented that isn't the pinned one, waiting for my word. */
  hostKeyOffered: text("host_key_offered"),
  /** How Oraknid logs in: its own key, my key, or (until setup) a password. */
  auth: text("auth", { enum: ["oraknid-key", "my-key", "password"] }).notNull(),
  /** new → ready once Oraknid's key, discovery, document and monitor are done. */
  setup: text("setup", { enum: ["new", "ready"] })
    .notNull()
    .default("new"),
  monitorHash: text("monitor_hash"),
  lastSeenAt: integer("last_seen_at"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});

/** Each version of a server's state document. */
export const serverStates = sqliteTable(
  "server_states",
  {
    id: text("id").primaryKey(),
    serverId: text("server_id").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    /** Written by The Eye from a discovery, or by me. */
    source: text("source", { enum: ["eye", "owner"] }).notNull(),
    /** The discovery it came from, when The Eye wrote it. */
    discovery: text("discovery"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("server_states_server").on(t.serverId, t.version)],
);

/** oraknid-monitor's readings, the last 24 hours (ADR-027). */
export const serverSamples = sqliteTable(
  "server_samples",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    serverId: text("server_id").notNull(),
    at: integer("at").notNull(),
    sample: json<unknown>("sample").notNull(),
  },
  (t) => [index("server_samples_server").on(t.serverId, t.at)],
);

/** The Oraknid helper's conversation (ADR-024): what I asked, what it said and did. */
export const helperMessages = sqliteTable("helper_messages", {
  id: text("id").primaryKey(),
  author: text("author", { enum: ["owner", "helper"] }).notNull(),
  text: text("text").notNull(),
  /** Its actions: done, failed, or waiting for my Confirm. */
  actions: json<unknown[]>("actions").notNull(),
  at: integer("at").notNull(),
});

/** Chats with my models (ADR-025): talk and research, attached projects read-only. */
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  legId: text("leg_id").notNull(),
  legModelId: text("leg_model_id").notNull(),
  effort: text("effort"),
  /** Projects it may read. */
  projectIds: json<string[]>("project_ids").notNull(),
  /** The Leg's own session, to continue the conversation where the adapter can. */
  nativeSessionId: text("native_session_id"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    author: text("author", { enum: ["owner", "model"] }).notNull(),
    text: text("text").notNull(),
    /** Which model answered. */
    model: text("model"),
    error: text("error"),
    at: integer("at").notNull(),
  },
  (t) => [index("chat_messages_chat").on(t.chatId, t.at)],
);

/** Every plan The Eye asked for and its shadow's, to compare models (ADR-022). */
export const eyePlans = sqliteTable(
  "eye_plans",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id").notNull(),
    pairId: text("pair_id").notNull(),
    call: text("call", { enum: ["plan", "replan"] }).notNull(),
    role: text("role", { enum: ["primary", "shadow"] }).notNull(),
    model: text("model").notNull(),
    plan: json<unknown>("plan"),
    error: text("error"),
    ms: integer("ms").notNull(),
    firstTry: integer("first_try", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("eye_plans_job").on(t.jobId)],
);

/** Tools for skills: MCP servers the daemon runs for a job's sessions (ADR-021). */
export const tools = sqliteTable("tools", {
  id: text("id").primaryKey(),
  /** The name skills ask for, e.g. "email". */
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  command: text("command").notNull(),
  args: json<string[]>("args").notNull(),
  /** Environment variables whose values are secrets in the keychain. */
  secretNames: json<string[]>("secret_names").notNull(),
  /** Plain environment, never secret. */
  env: json<Record<string, string>>("env").notNull(),
  /** Its tools that only read; anything else writes. */
  reads: json<string[]>("reads").notNull(),
  /** Its tools that send (the gated action `send`). */
  sends: json<string[]>("sends").notNull(),
  /** What it returns is outside content (BR-15). */
  untrusted: integer("untrusted", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at").notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id),
    /** Waiting for a free slot under the running-jobs limit (ADR-016). */
    queuedAt: integer("queued_at"),
    /** Higher runs first among queued jobs. */
    priority: integer("priority").notNull().default(0),
    title: text("title").notNull(),
    /**
     * Who named it (Jobs-and-Projects → A job's name and description): I typed
     * the title ("me", kept), The Eye named it ("eye"), or nobody yet (its
     * goal's first line, named when a model can).
     */
    namedBy: text("named_by", { enum: ["me", "eye"] }),
    /** One or two sentences: what it's for, then, once it ends, what it did. */
    description: text("description"),
    /** What the description says: its purpose, its outcome, or mine (kept). */
    describedAs: text("described_as", { enum: ["purpose", "outcome", "mine"] }),
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
    /**
     * In a project of several repos (ADR-042): the repos it touched, each a
     * worktree on the job branch at its folder inside `worktree`.
     */
    repos: json<JobRepo[]>("repos").notNull().default([]),
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
    /** The tools this job's sessions get, by name (ADR-021). */
    tools: json<string[]>("tools").notNull().default([]),
    /** The skills The Eye chooses from when I didn't pick one; empty once chosen (Phase 8). */
    skillChoices: json<string[]>("skill_choices").notNull().default([]),
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
    /** The commit of its work, once done (the task drawer's diff). */
    /** The attempt whose outcome was last applied: one recorded but not applied is replayed (Audit 1 → D1-12). */
    settledAttempt: integer("settled_attempt").notNull().default(0),
    /** Its own worktree while it runs beside others (ADR-016). */
    worktree: text("worktree"),
    commit: text("commit"),
    /** In a project of several repos, its commit in each repo it changed (ADR-042). */
    commits: json<{ repo: string; sha: string }[]>("commits").notNull().default([]),
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
    /** Providers (Leg kinds) that hit a usage limit on this task (ADR-009). */
    limitedKinds: json<string[]>("limited_kinds").notNull().default([]),
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
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOn] }),
    index("task_edges_depends").on(t.dependsOn),
  ],
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
    covers: json<string[]>("covers").notNull().default([]),
    authoredBy: json<unknown>("authored_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("silk_job_kind").on(t.jobId, t.kind)],
);

/** My conversation with The Eye about a job (Checkpoint 1 → F1-4). */
export const eyeMessages = sqliteTable(
  "eye_messages",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    /** The project's conversation is its messages from every job (ADR-034). */
    projectId: text("project_id").notNull().default(""),
    author: text("author", { enum: ["owner", "eye"] }).notNull(),
    text: text("text").notNull(),
    /** What The Eye made of my message and did about it (its replies only). */
    action: json<unknown>("action"),
    /** The Eye's questions with options (ADR-037); my answers on my message. */
    questions: json<Question[] | null>("questions"),
    itemId: text("item_id"),
    answers: json<QuestionAnswer[] | null>("answers"),
    replyTo: text("reply_to"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("eye_messages_job").on(t.jobId, t.createdAt),
    index("eye_messages_project").on(t.projectId, t.createdAt),
  ],
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
    /** Asked with options (ADR-037), and my structured answers. */
    questions: json<Question[] | null>("questions"),
    answers: json<QuestionAnswer[] | null>("answers"),
  },
  (t) => [index("inbox_state").on(t.state), index("inbox_job").on(t.jobId)],
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
  (t) => [index("attempts_task").on(t.taskId), index("attempts_job").on(t.jobId)],
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
    index("sessions_job").on(t.jobId),
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
  /** sha256 of the device's token; the token itself is never stored. */
  tokenHash: text("token_hash").notNull().default(""),
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

type Address = { name: string; address: string };
type Attachment = { filename: string; contentType: string; size: number };

/** My mail accounts (ADR-032). Passwords are in the keychain, never here (BR-13). */
export const mailAccounts = sqliteTable("mail_accounts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull(),
  provider: text("provider", { enum: ["gmail", "outlook", "imap"] }).notNull(),
  /** IMAP (folders on the server) or POP3 (downloaded into folders kept here). */
  protocol: text("protocol", { enum: ["imap", "pop"] })
    .notNull()
    .default("imap"),
  login: text("login").notNull(),
  /** The incoming server, IMAP or POP3 (its columns kept their first name). */
  incomingHost: text("imap_host").notNull(),
  incomingPort: integer("imap_port").notNull(),
  incomingSecurity: text("imap_security", { enum: ["tls", "starttls", "plain"] }).notNull(),
  smtpHost: text("smtp_host").notNull(),
  smtpPort: integer("smtp_port").notNull(),
  smtpSecurity: text("smtp_security", { enum: ["tls", "starttls", "plain"] }).notNull(),
  /** An agent's draft is sent without asking me. Off unless I turn it on. */
  autoSend: integer("auto_send", { mode: "boolean" }).notNull().default(false),
  /** The provider doesn't file sent mail itself: Oraknid appends it to Sent. */
  appendSent: integer("append_sent", { mode: "boolean" }).notNull(),
  /** POP: a message deleted for good here is deleted on the server too. Off: left there. */
  deleteFromServer: integer("delete_from_server", { mode: "boolean" }).notNull().default(false),
  state: text("state", { enum: ["new", "syncing", "ready", "reconnect", "error"] })
    .notNull()
    .default("new"),
  error: text("error"),
  lastSyncAt: integer("last_sync_at"),
  createdAt: integer("created_at").notNull(),
});

export const mailFolders = sqliteTable(
  "mail_folders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    path: text("path").notNull(),
    name: text("name").notNull(),
    specialUse: text("special_use"),
    /** A change means every UID held for it is void. */
    uidValidity: text("uid_validity"),
    /** The highest UID fetched so far. */
    lastUid: integer("last_uid").notNull().default(0),
    syncedAt: integer("synced_at"),
  },
  (t) => [uniqueIndex("mail_folders_path").on(t.accountId, t.path)],
);

/** Headers of every synced message; bodies cached once opened. */
export const mailMessages = sqliteTable(
  "mail_messages",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    folderId: text("folder_id").notNull(),
    uid: integer("uid").notNull(),
    messageId: text("message_id"),
    inReplyTo: text("in_reply_to"),
    references: json<string[]>("references").notNull(),
    /** Gmail's X-GM-THRID, or the first Message-ID the conversation refers to. */
    threadId: text("thread_id").notNull(),
    subject: text("subject").notNull(),
    fromName: text("from_name").notNull(),
    fromAddress: text("from_address").notNull(),
    to: json<Address[]>("to").notNull(),
    cc: json<Address[]>("cc").notNull(),
    replyTo: json<Address[]>("reply_to").notNull(),
    date: integer("date").notNull(),
    flags: json<string[]>("flags").notNull(),
    size: integer("size").notNull(),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull(),
    snippet: text("snippet").notNull().default(""),
    text: text("text"),
    html: text("html"),
    attachments: json<Attachment[]>("attachments"),
    imagesAllowed: integer("images_allowed", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("mail_messages_uid").on(t.folderId, t.uid),
    index("mail_messages_folder_date").on(t.folderId, t.date),
    index("mail_messages_thread").on(t.accountId, t.threadId),
    index("mail_messages_message_id").on(t.accountId, t.messageId),
  ],
);

/** What I or an agent wrote and hasn't sent yet: an agent's waits for my approval. */
export const mailDrafts = sqliteTable(
  "mail_drafts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    to: json<string[]>("to").notNull(),
    cc: json<string[]>("cc").notNull(),
    bcc: json<string[]>("bcc").notNull(),
    subject: text("subject").notNull(),
    html: text("html").notNull(),
    text: text("text").notNull(),
    replyToId: text("reply_to_id"),
    forwardOfId: text("forward_of_id"),
    threadId: text("thread_id"),
    /** Their bytes are files in the data folder (mail/drafts/<id>/). */
    attachments: json<Attachment[]>("attachments").notNull(),
    author: text("author", { enum: ["owner", "agent"] }).notNull(),
    jobId: text("job_id"),
    state: text("state", { enum: ["draft", "waiting", "sending", "sent", "failed"] })
      .notNull()
      .default("draft"),
    /** The inbox item asking me to approve it, when a job wrote it. */
    approvalItemId: text("approval_item_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => [index("mail_drafts_account").on(t.accountId, t.state)],
);

/** Senders whose remote images I allowed. */
export const mailImageSenders = sqliteTable(
  "mail_image_senders",
  {
    accountId: text("account_id").notNull(),
    address: text("address").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.address] })],
);

/**
 * POP accounts: each message downloaded, by the server's UIDL, so none is
 * fetched twice, even once I deleted it here. `messageId` is the row that
 * holds it; null once it is gone from Oraknid.
 */
export const mailPopUidls = sqliteTable(
  "mail_pop_uidls",
  {
    accountId: text("account_id").notNull(),
    uidl: text("uidl").notNull(),
    messageId: text("message_id"),
    /** Deleted here for good with "delete from the server" on: the next pass deletes it there. */
    deleteOnServer: integer("delete_on_server", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.uidl] }),
    index("mail_pop_uidls_message").on(t.messageId),
  ],
);

/** age keys for backups (ADR-044): the public half; the private one is in the keychain. */
export const backupKeys = sqliteTable("backup_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  publicKey: text("public_key").notNull(),
  imported: integer("imported", { mode: "boolean" }).notNull().default(false),
  /** When I took the private key away, once; null until then. */
  exportedAt: integer("exported_at"),
  createdAt: integer("created_at").notNull(),
});

/** A database's backup plan (ADR-044); its password is in the keychain. */
export const backupPlans = sqliteTable("backup_plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  serverId: text("server_id").notNull(),
  target: json<BackupTarget>("target").notNull(),
  schedule: json<BackupSchedule>("schedule").notNull(),
  destination: json<BackupDestination>("destination").notNull(),
  retention: json<BackupRetention>("retention").notNull(),
  keyId: text("key_id"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  /** Its next time; one in the past at start is a missed run. */
  nextRunAt: integer("next_run_at"),
  createdAt: integer("created_at").notNull(),
});

/** Each run of a plan: what it made, or what went wrong. */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    id: text("id").primaryKey(),
    planId: text("plan_id").notNull(),
    state: text("state", { enum: ["running", "ok", "failed"] }).notNull(),
    trigger: text("trigger", { enum: ["schedule", "missed", "manual"] }).notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    size: integer("size"),
    durationMs: integer("duration_ms"),
    checksum: text("checksum"),
    /** Where it went: this computer's folder, or a server's. */
    destination: json<BackupDestination>("destination").notNull(),
    path: text("path"),
    keyId: text("key_id"),
    error: text("error"),
    verifiedAt: integer("verified_at"),
    verifyOk: integer("verify_ok", { mode: "boolean" }),
    verifyNote: text("verify_note"),
    prunedAt: integer("pruned_at"),
  },
  (t) => [index("backup_runs_plan").on(t.planId, t.startedAt)],
);

/**
 * My cloud storage providers (ADR-046): what the pages show and how to
 * reach each one; its credentials are in Oraknid's encrypted rclone
 * config, under `remote`, never here.
 */
export const cloudProviders = sqliteTable("cloud_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["s3", "drive", "dropbox", "mega"] }).notNull(),
  /** Its section in the rclone config. */
  remote: text("remote").notNull().unique(),
  /** The bucket and folder, or the folder in the account; "" for the whole account. */
  root: text("root").notNull(),
  /** What the pages say about it (preset, endpoint, region, e-mail): nothing secret. */
  info: json<Record<string, string | null>>("info").notNull(),
  limitBytes: integer("limit_bytes"),
  unlimited: integer("unlimited", { mode: "boolean" }).notNull().default(false),
  priority: integer("priority").notNull().default(0),
  usedBytes: integer("used_bytes"),
  freeBytes: integer("free_bytes"),
  totalBytes: integer("total_bytes"),
  checkedAt: integer("checked_at"),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
});
