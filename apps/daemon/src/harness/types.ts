import type { Autonomy, MetricsSample } from "@oraknid/contracts";
import type { GatedAction } from "@oraknid/core";
import type { Sandbox } from "@oraknid/os";
import type { Db } from "../db/open.ts";
import type { tasks } from "../db/schema.ts";
import type { SideEffects } from "../engine/effects.ts";
import type { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "../eye/brain.ts";
import type { InboxStore } from "../inbox/store.ts";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";
import type { Servers } from "../servers/service.ts";
import type { SilkStore } from "../silk/store.ts";
import type { McpBroker } from "../tools/broker.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { GitHub } from "../workspace/github.ts";
import type { WorkTree } from "../workspace/tree.ts";
import type { VisualDeps } from "./visual.ts";

// What a task's attempt works with and ends as (ADR-056 §8): the daemon's
// parts it uses, the job as the attempt sees it, its folder, its outcome.

export type TaskRow = typeof tasks.$inferSelect;

export interface AttemptDeps {
  db: Db;
  bus: EventBus;
  silk: SilkStore;
  inbox: InboxStore;
  registry: LegRegistry;
  supervisor: LegSupervisor;
  sandbox: Sandbox;
  legsDir: string;
  now: () => number;
  /** The judge of auto mode (ADR-053); without one, what the rules leave counts as blocked. */
  brain?: EyeBrain;
  /** Tools for skills (ADR-021): the job's MCP servers, run by the daemon. */
  tools?: { registry: ToolRegistry; broker: McpBroker };
  /** The outbox: a tool's sends happen at most once (BR-6). */
  effects?: SideEffects;
  /** My servers, for a job whose project has some (ADR-026). */
  servers?: Servers;
  /** GitHub, for the checks Oraknid answers itself about the project's repo (ADR-038). */
  github?: GitHub;
  /** The machine's last few seconds of metrics: a new session waits for room (ADR-016). */
  machine?: () => MetricsSample[];
  /** Session rotation (BR-3): share of the context window. */
  rotateAt?: number;
  /** How often to look for a stall while waiting for a Leg. */
  stallCheckMs?: number;
  /** How long the drift judge may take, both stages (ADR-056); 30 s unless a test says. */
  driftJudgeMs?: number;
  maxTurns?: number;
  /** The visual check's renderer and judge (ADR-064 §5); without them it is skipped. */
  visual?: VisualDeps;
}

export interface AttemptJob {
  id: string;
  title: string;
  goal: string;
  autonomy: Autonomy;
  allowedLegIds: string[];
  moneyAllowed: boolean;
  waived: GatedAction[];
  unsandboxed: boolean;
  skillBody: string;
  /** The tools its sessions get, by name (ADR-021). */
  tools: string[];
  /** The skill's own checks for results that aren't code (Skills → Checks). */
  skillChecks?: string;
  /** The servers its project gave it (Servers → Servers in projects). */
  serverIds?: string[];
  /** Each server's role in the project (ADR-042). */
  serverRoles?: Record<string, { role: string; production: boolean | null }>;
  /** The server I chose or confirmed for its work on a server, "none", or not asked yet (ADR-042). */
  server?: string | null;
  /** The server whose own job this is: its place is the server, not a repo (ADR-049). */
  serverJob?: string | null;
  /** A project of several repos, as a Leg must know it (ADR-042). */
  layout?: string;
  /** Its project's ports on this computer its sandboxes may reach (Sandboxing → network). */
  localPorts?: number[];
  /** The project's other skills, whose guidance a task may get (Skills → Skills per project). */
  otherSkills?: { name: string; body: string }[];
  /** The job's inputs, rendered for context packs. */
  inputs: string;
}

/** Where an attempt works: its folder, its tree, its scratch and its trash. */
export interface AttemptWhere {
  cwd: string;
  tree: WorkTree;
  tmpDir: string;
  trash: string;
}

export type AttemptOutcome =
  | { kind: "done"; commit: string | null; commits?: { repo: string; sha: string }[] }
  | { kind: "retry"; reason: string }
  | { kind: "blocked"; reason: string; until: number | null }
  /** Left out by me; `dependents`: the tasks that need it are left out too (ADR-045). */
  | { kind: "skipped"; dependents?: boolean }
  | { kind: "owner-held" }
  | { kind: "cancel-job"; reason: string }
  /** Its Leg was paused, or its work in the job cancelled: stopped at a safe point, the job goes on. */
  | { kind: "leg-stopped"; how: "pause" | "cancel" | "room"; reason: string };
