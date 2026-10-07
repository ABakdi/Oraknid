import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layer1Verdict } from "@oraknid/core";
import {
  type GuardContext,
  type GuardServer,
  type JudgeInput,
  type JudgeVerdict,
  judge,
  type Layer1,
  rules,
  StuckWatch,
  shapeOf,
  shapeRule,
  VerdictCache,
} from "@oraknid/guard";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import type { EyeBrain } from "./brain.ts";
import { conversation } from "./talk.ts";

// Auto mode in the daemon (ADR-053): layer 1 (the guard) run on a command
// before the policy reads it, layer 2 (the judge) on what neither settles,
// the stuck rule, and the log of every decision with its layer and reason.

/** The judge's verdicts, per job and task (normalised command, folder and task). */
const verdicts = new VerdictCache();
/** Blocks per task, for the stuck rule (3 in a row, 20 in a task). */
export const stuck = new StuckWatch();

/** How long the judge may take before its silence counts as BLOCK (ADR-053: 10 s). */
export const JUDGE_TIMEOUT_MS = 10_000;

/** A task settled (done, left out): its verdicts and its count of blocks go (bug 6). */
export function forgetTaskVerdicts(jobId: string, taskId: string) {
  verdicts.forgetTask(`${jobId}:${taskId}`);
  stuck.forget(`${jobId}:${taskId}`);
}

/** A job ended: every one of its tasks' verdicts and counts go. */
export function forgetJobVerdicts(jobId: string) {
  verdicts.forgetTasksStarting(`${jobId}:`);
  stuck.forgetStarting(`${jobId}:`);
}

/** What is held in memory for a task: the judge's verdicts and the blocks counted. */
export function heldFor(jobId: string, taskId: string) {
  return {
    verdicts: verdicts.countTask(`${jobId}:${taskId}`),
    blocks: stuck.count(`${jobId}:${taskId}`),
  };
}

/** Registries and code hosts a plain GET may read at once (layer 1's known hosts). */
const REGISTRIES = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "pkg.go.dev",
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "gitlab.com",
  "deno.land",
  "jsr.io",
  "rubygems.org",
  "repo.maven.apache.org",
  "nodejs.org",
];

const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "Cargo.lock",
];

/** What the guard knows of a job's attempt; read once per attempt, cheap to rebuild. */
export function guardContext(i: {
  cwd: string;
  scratch: string[];
  home: string;
  servers: GuardServer[];
  sshConfig: string | null;
  taskText: string;
  verify: string[];
}): GuardContext {
  let scripts: string[] = [];
  try {
    const pkg = JSON.parse(readFileSync(join(i.cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    scripts = Object.keys(pkg.scripts ?? {});
  } catch {}
  return {
    workspace: i.cwd,
    scratch: i.scratch,
    home: i.home,
    servers: i.servers,
    sshConfig: i.sshConfig,
    taskText: i.taskText,
    knownHosts: REGISTRIES,
    projectScripts: scripts,
    lockfiles: LOCKFILES.filter((f) => existsSync(join(i.cwd, f))),
    verify: i.verify,
  };
}

/** Layer 1 on a shell command; null when the guard can't run (the policy's fixed lists decide then). */
export async function layer1(command: string, ctx: GuardContext): Promise<Layer1 | null> {
  try {
    return await rules(command, ctx);
  } catch (error) {
    console.error("auto mode: layer 1 failed", error);
    return null;
  }
}

/** The policy's view of layer 1's verdict. */
export const asPolicyLayer1 = (v: Layer1 | null): Layer1Verdict | null => v;

/** The owner's own words about a job, for the judge: nothing an agent wrote. */
export function ownerWords(db: Db, jobId: string): string[] {
  try {
    return conversation(db, jobId)
      .filter((m) => m.author === "owner")
      .map((m) => m.text)
      .slice(-12);
  } catch {
    return [];
  }
}

/** Layer 2: the judge, through The Eye's Legs (stage 1 fast, stage 2 strong); no brain blocks. */
export async function judgeAction(
  brain: EyeBrain | undefined,
  input: JudgeInput,
  where: { jobId: string; taskId: string; cwd: string },
  timeoutMs = JUDGE_TIMEOUT_MS,
): Promise<JudgeVerdict> {
  if (!brain)
    return {
      verdict: "block",
      category: null,
      reason: "no judge is available, so it counts as blocked; try another way",
      stage: 1,
      cached: false,
    };
  return judge(
    input,
    {
      fast: async (prompt) => {
        const a = await brain.judgeAction({ jobId: where.jobId, cwd: where.cwd, stage: 1, prompt });
        return a.decision === "allow" ? "ALLOW" : "BLOCK";
      },
      strong: async (prompt) =>
        brain.judgeAction({ jobId: where.jobId, cwd: where.cwd, stage: 2, prompt }),
    },
    { cache: verdicts, taskKey: `${where.jobId}:${where.taskId}`, timeoutMs },
  );
}

/** The `shape:` rule for a command, for "approve all like this" at careful; null when it can't be read. */
export async function shapeRuleFor(command: string): Promise<string | null> {
  try {
    const s = await shapeOf(command);
    return s ? shapeRule(s) : null;
  } catch {
    return null;
  }
}

/** Whether one of my `shape:` rules for the job matches the command. */
export async function shapeApproved(command: string, allowRules: string[]): Promise<boolean> {
  const shapes = allowRules.filter((r) => r.startsWith("shape:"));
  if (!shapes.length) return false;
  const rule = await shapeRuleFor(command);
  return !!rule && shapes.includes(rule);
}

/** Who decided: layer 1, layer 2, layer 3, or the Leg's own auto mode (Claude Code). */
export type DecisionLayer = "rules" | "judge" | "owner" | "leg";

/** Every decision, with its layer and reason, in the audit log (ADR-053). */
export function logDecision(
  bus: EventBus,
  jobId: string,
  p: {
    taskId: string;
    tool: string;
    action: string;
    verdict: "allow" | "block" | "ask";
    layer: DecisionLayer;
    reason: string;
    rule?: string;
    stage?: 1 | 2;
    cached?: boolean;
  },
) {
  bus.publish({
    type: "policy.decision",
    topic: `job:${jobId}`,
    jobId,
    payload: { ...p, action: p.action.slice(0, 300) },
    actor: "eye",
  });
}
