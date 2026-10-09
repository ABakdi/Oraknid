import {
  type EvaluationKind,
  type Evaluations,
  type PlannedEvaluation,
  type WebPlan,
  wantsEvaluation,
} from "@oraknid/contracts";

// Evaluation steps in the plan (ADR-064 §1): nodes of The Web that no agent
// works on. Oraknid opens a review for me; the tasks after it wait for my
// approval, and work that doesn't need what it reviews goes on beside it.
// The planner places them; `shapeEvaluations` keeps what the project's
// setting allows and adds what a plan for work I'll see must have.

type Planned = WebPlan["tasks"][number];

export const isEvaluation = (t: { kind: string }) => t.kind === "evaluation";

const DESIGN_WORDS =
  /\b(design|designs|mock-?ups?|wireframes?|prototypes?|look and feel|style ?guide)\b/i;
const DESIGN_DIR = /(?:^|\/)design(?:\/|$)/i;

/**
 * A task that makes the design (ADR-064 §2): its scope is the design
 * folder, or it is UI work named a design, a mock-up or a prototype.
 */
export function isDesignTask(
  t: Pick<Planned, "kind" | "title" | "scope" | "requiredCapabilities">,
) {
  if (isEvaluation(t)) return false;
  if (t.scope.length > 0 && t.scope.every((g) => DESIGN_DIR.test(g))) return true;
  return t.requiredCapabilities.includes("ui") && DESIGN_WORDS.test(t.title);
}

/** Work I will see or use: a task builds a UI or its design. */
export const planHasUi = (plan: WebPlan) =>
  plan.tasks.some(
    (t) => !isEvaluation(t) && (t.requiredCapabilities.includes("ui") || isDesignTask(t)),
  );

/** What an evaluation step of each kind is called, and why it is there when Oraknid adds it. */
export const EVALUATION_WORDS: Record<
  EvaluationKind,
  { title: string; why: string; does: string }
> = {
  design: {
    title: "Review the design",
    why: "The features are built to the design: I see it and say what to change before any feature code.",
    does: "the design",
  },
  app: {
    title: "Review the running app",
    why: "The finished work, running: I try it on my devices before the job is done.",
    does: "the running app",
  },
  checkpoint: {
    title: "Review the work so far",
    why: "A point where the work so far is worth my look before more is built on it.",
    does: "the work so far",
  },
};

/** An evaluation step for a plan, after `dependsOn`. */
export function evaluationTask(
  key: string,
  evaluation: PlannedEvaluation,
  dependsOn: string[],
  phase?: number,
): Planned {
  const w = EVALUATION_WORDS[evaluation.kind];
  return {
    key,
    title: w.title,
    instructions: `Oraknid opens ${w.does} for the owner to review: approved, the work after it goes on; notes come back as tasks, then a new round. ${evaluation.why}`,
    kind: "evaluation",
    dependsOn,
    scope: [],
    verify: [],
    requiredCapabilities: ["review"],
    difficulty: "low",
    ...(phase ? { phase } : {}),
    evaluation,
  };
}

const freeKey = (taken: Set<string>, base: string) => {
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}-${n}`;
  taken.add(key);
  return key;
};

/**
 * The plan's evaluation steps as the setting wants them (ADR-064 §1):
 * a kind it doesn't want is left out, the tasks after it then following
 * what it reviewed; with `add` (a first plan), work I'll see gets a design
 * review after its design tasks and a final review of the running app when
 * the planner left them out. A design review stands before every task
 * built on the design; work that doesn't need the design (an audio engine)
 * never waits for it. Returns the plan and what changed, in words.
 */
export function shapeEvaluations(
  plan: WebPlan,
  setting: Evaluations,
  o: { add?: boolean } = {},
): { plan: WebPlan; notes: string[] } {
  const notes: string[] = [];
  let tasks: Planned[] = plan.tasks.map((t) => ({ ...t, dependsOn: [...t.dependsOn] }));

  // Left out: a kind the setting doesn't want; what came after it follows what it reviewed.
  for (const t of tasks.filter(isEvaluation)) {
    const kind = t.evaluation?.kind ?? "checkpoint";
    if (wantsEvaluation(setting, kind)) continue;
    tasks = tasks.filter((x) => x.key !== t.key);
    for (const x of tasks)
      if (x.dependsOn.includes(t.key))
        x.dependsOn = [...new Set([...x.dependsOn.filter((d) => d !== t.key), ...t.dependsOn])];
    notes.push(`"${t.title}" was left out: this job has no ${kind} reviews.`);
  }

  const taken = new Set(tasks.map((t) => t.key));
  const shaped = (): WebPlan => ({ ...plan, tasks });
  const has = (kind: EvaluationKind) =>
    tasks.some((t) => isEvaluation(t) && t.evaluation?.kind === kind);
  if (o.add && planHasUi(shaped())) {
    const designs = tasks.filter(isDesignTask);
    if (designs.length && !has("design") && wantsEvaluation(setting, "design")) {
      const w = EVALUATION_WORDS.design;
      const phase = Math.max(0, ...designs.map((d) => d.phase ?? 0)) || undefined;
      tasks.push(
        evaluationTask(
          freeKey(taken, "review-design"),
          { kind: "design", why: w.why },
          designs.map((d) => d.key),
          phase,
        ),
      );
      notes.push(`Added "${w.title}" after the design: the features wait for my approval of it.`);
    }
    if (!has("app") && wantsEvaluation(setting, "app")) {
      const work = tasks.filter((t) => !isEvaluation(t));
      const ends = work.filter((t) => !work.some((x) => x.dependsOn.includes(t.key)));
      const w = EVALUATION_WORDS.app;
      const phase = Math.max(0, ...work.map((t) => t.phase ?? 0)) || undefined;
      tasks.push(
        evaluationTask(
          freeKey(taken, "review-app"),
          { kind: "app", why: w.why },
          ends.map((t) => t.key),
          phase,
        ),
      );
      notes.push(`Added "${w.title}" at the end: I try it before the job is done.`);
    }
  }

  // A design review stands before every task built on the design it reviews.
  for (const r of tasks.filter((t) => isEvaluation(t) && t.evaluation?.kind === "design")) {
    const reviewed = new Set(r.dependsOn);
    for (const x of tasks) {
      if (x.key === r.key || isEvaluation(x) || isDesignTask(x)) continue;
      if (!x.dependsOn.some((d) => reviewed.has(d))) continue;
      x.dependsOn = [...new Set([...x.dependsOn.filter((d) => !reviewed.has(d)), r.key])];
    }
  }
  return { plan: shaped(), notes };
}

/** The rules the planner is given for evaluation steps, as the setting wants them (ADR-064 §1). */
export function evaluationRules(setting: Evaluations): string {
  if (setting.mode === "none")
    return '- Evaluation steps: none for this job (the owner said so). Plan no task of kind "evaluation".';
  const kinds = (["design", "app", "checkpoint"] as const).filter((k) =>
    wantsEvaluation(setting, k),
  );
  return `- Evaluation steps (kind "evaluation"): where the owner looks at the work and approves it before what depends on it goes on. No agent works on one; it has no scope and no verify, and an "evaluation" object: {"kind": "design" | "app" | "checkpoint", "why": one line on why it is there, "run": the command that starts the app, for an app review, when you know it}. Allowed here: ${kinds.join(", ")}.
  - For anything the owner will see or use (a UI, a page, an app): a design task first (a clickable HTML and CSS design of the screens in \`design/\`, capability "ui"), then a "design" evaluation that depends on it, and every feature built on the design depends on that evaluation; and a final "app" evaluation that depends on the last tasks. Give UI tasks the capability "ui".
  - For bigger work, a "checkpoint" evaluation after a feature that is worth a look before more is built on it, with why; not after every task.
  - Work that doesn't need what an evaluation shows (an audio engine beside a UI design review) does not depend on it: it goes on in parallel.
  - A pure backend, a library, a script or a server job has no design: no design evaluation.`;
}
