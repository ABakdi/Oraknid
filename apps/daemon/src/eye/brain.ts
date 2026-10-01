import { type Capability, type Difficulty, type SilkEntry, WebPlan } from "@oraknid/contracts";
import { type RouteCandidate, route, validateWeb } from "@oraknid/core";
import { z } from "zod";
import type { LegRegistry } from "../legs/registry.ts";
import type { LegSupervisor } from "../legs/supervisor.ts";

/**
 * The Eye's reasoning (ADR-008). Deterministic code decides; these calls
 * judge. Each is a short, stateless session built from Silk, answered as
 * JSON and validated.
 */
export interface EyeBrain {
  plan(input: PlanInput): Promise<WebPlan>;
  /** New tasks that fix what job-level verification found. */
  replan(input: PlanInput & { failure: string; done: string[] }): Promise<WebPlan>;
  /** Several Silk entries in one shorter entry. */
  summarize(input: {
    jobId: string;
    cwd: string;
    entries: SilkEntry[];
  }): Promise<{ title: string; body: string }>;
}

export interface PlanInput {
  jobId: string;
  cwd: string;
  goal: string;
  skill: string;
  silk: string;
  digest: string;
  verify: string[];
}

export class BrainFailed extends Error {}

const Summary = z.object({ title: z.string().min(1), body: z.string().min(1) });

const PLAN_RULES = `Rules for the plan:
- Small tasks, each doable in one focused session, ordered by "dependsOn" (keys of earlier tasks).
- Every task that changes files has a "scope": globs relative to the workspace, as narrow as possible.
- Every task that changes things has "verify": shell commands that exit 0 only when the task is really done. Oraknid runs them itself; prefer existing test, build, lint or type-check commands, and add tests as tasks when there are none.
- "difficulty" is honest: low for mechanical work, medium for normal features, high for design, hard debugging or architecture.
- "jobVerify": commands that prove the whole goal is met.
- Follow the job's method (the skill), e.g. write the canon before code when it says so.`;

export interface PoolLegBrainOptions {
  registry: LegRegistry;
  supervisor: LegSupervisor;
  /** My chosen Eye Leg model, if any (first-run setup). */
  pinnedModelId: () => string | null;
  moneyAllowed?: boolean;
}

/** v1 brain: borrows a Leg from the pool (ADR-008). */
export class PoolLegBrain implements EyeBrain {
  constructor(private readonly o: PoolLegBrainOptions) {}

  plan(i: PlanInput) {
    return this.#ask(
      i.jobId,
      i.cwd,
      "high",
      ["planning", "architecture"],
      WebPlan,
      planPrompt(i, null),
      "plan",
      validateWeb,
    );
  }

  replan(i: PlanInput & { failure: string; done: string[] }) {
    const extra = `The job-level verification failed after these tasks were done: ${i.done.join("; ")}.
Failure:
\`\`\`
${i.failure.slice(-4000)}
\`\`\`
Plan ONLY the new tasks needed to fix this. Do not repeat done work. Use new task keys.`;
    return this.#ask(
      i.jobId,
      i.cwd,
      "high",
      ["debugging", "planning"],
      WebPlan,
      planPrompt(i, extra),
      "replan",
      validateWeb,
    );
  }

  summarize(i: { jobId: string; cwd: string; entries: SilkEntry[] }) {
    const text = i.entries.map((e) => `## ${e.title}\n${e.body}`).join("\n\n");
    const prompt = `Summarise these job-memory entries into one entry that keeps every decision, name, path, command and open problem, in under 250 words.\n\n${text}`;
    return this.#ask(i.jobId, i.cwd, "low", ["summarize"], Summary, prompt, "summarize");
  }

  /** Picks the Leg model: mine if I pinned one, else the best router choice for the call. */
  #choose(difficulty: Difficulty, capabilities: Capability[]) {
    const candidates: RouteCandidate[] = [];
    for (const leg of this.o.registry.all()) {
      const view = this.o.registry.view(leg);
      for (const m of view.models.filter((x) => !x.hidden)) {
        candidates.push({
          legId: leg.id,
          legModelId: m.id,
          model: m.model,
          legName: leg.name,
          health: view.health,
          paused: view.paused,
          effortLevels: m.effortLevels,
          profile: m.profile,
          windows: [...view.quota, ...m.quota],
        });
      }
    }
    const pinned = this.o.pinnedModelId();
    const task = {
      kind: "plan" as const,
      difficulty,
      requiredCapabilities: capabilities,
      estimatedTokens: 30_000,
      stepUp: 0,
    };
    let r = route({ ...task, pinnedModelId: pinned }, candidates, {
      moneyAllowed: this.o.moneyAllowed ?? false,
    });
    // My Eye Leg unavailable: the next best Leg with planning strength, said so in the stream (The-Eye → The Eye Leg).
    if (pinned && r.ranked.length === 0)
      r = route(task, candidates, { moneyAllowed: this.o.moneyAllowed ?? false });
    const best = r.ranked[0];
    if (!best) {
      throw new BrainFailed(
        `No Leg can think for The Eye right now: ${r.excluded.map((e) => e.why).join(" ") || "there are no Legs."}`,
      );
    }
    return best;
  }

  async #ask<T>(
    jobId: string,
    cwd: string,
    difficulty: Difficulty,
    capabilities: Capability[],
    schema: z.ZodType<T>,
    prompt: string,
    call: string,
    /** Rules beyond the schema (e.g. The Web's): problems in words, empty when fine. */
    check: (value: T) => string[] = () => [],
  ): Promise<T> {
    const pick = this.#choose(difficulty, capabilities);
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    const session = await this.o.supervisor.start({
      legId: pick.candidate.legId,
      legModelId: pick.candidate.legModelId,
      effort: pick.effort,
      jobId,
      taskId: null,
      attemptId: `eye:${call}`,
      cwd,
      systemPrompt:
        "You are The Eye's reasoning step in Oraknid. You may read files in the workspace, but you change nothing: every edit or command will be refused. Answer with one JSON object only.",
      prompt: `${prompt}\n\nReply with a single \`\`\`json fenced block containing an object that matches this JSON Schema, and nothing else:\n${jsonSchema}`,
      onPermission: async (r) =>
        ["Read", "Glob", "Grep", "LS", "read_file", "list_dir", "search"].includes(r.tool)
          ? { allow: true }
          : { allow: false, message: "The Eye's reasoning step only reads; it changes nothing." },
    });
    // One iterator for the whole conversation: leaving a for-await would close the stream.
    const events = session.events[Symbol.asyncIterator]();
    try {
      let lastError = "";
      for (let tries = 0; tries < 2; tries++) {
        let text = "";
        for (let next = await events.next(); !next.done; next = await events.next()) {
          const e = next.value;
          if (e.type === "turn.ended") {
            if (e.reason !== "completed")
              throw new BrainFailed(
                `The Eye's reasoning on ${pick.candidate.legName} stopped: ${e.error ?? e.reason}.`,
              );
            text = e.text;
            break;
          }
        }
        const parsed = parseJson(text, schema);
        const problems = parsed.ok ? check(parsed.value) : [];
        if (parsed.ok && problems.length === 0) return parsed.value;
        lastError = parsed.ok ? problems.join(" ") : parsed.error;
        await session.session.send(
          `That answer was not valid: ${lastError}\nReply again with only the corrected \`\`\`json block.`,
        );
      }
      throw new BrainFailed(
        `The Eye's reasoning gave no valid answer twice (${call}): ${lastError}`,
      );
    } finally {
      await session.session.kill();
    }
  }
}

function planPrompt(i: PlanInput, extra: string | null): string {
  return [
    `Plan this job as a graph of tasks.\n\n# Goal\n${i.goal}`,
    i.skill ? `# The method this job follows\n${i.skill}` : "",
    i.silk ? `# What is known (Silk)\n${i.silk}` : "",
    i.digest ? `# The workspace\n${i.digest}` : "",
    i.verify.length
      ? `# The job must also pass\n${i.verify.map((v) => `- \`${v}\``).join("\n")}`
      : "",
    PLAN_RULES,
    extra ?? "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** The last ```json block (or the whole text), validated. */
export function parseJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  const raw = blocks.at(-1) ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "it was not JSON." };
  }
  const r = schema.safeParse(data);
  if (r.success) return { ok: true, value: r.data };
  return {
    ok: false,
    error: r.error.issues
      .slice(0, 8)
      .map((x) => `${x.path.join(".") || "(root)"}: ${x.message}`)
      .join("; "),
  };
}
