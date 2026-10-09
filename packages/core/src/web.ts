import type { Evaluations, PlanMeasures, WebPlan } from "@oraknid/contracts";
import { shapeEvaluations } from "./evaluations.ts";
import { likeness, meaningWords } from "./likeness.ts";

/**
 * Task kinds that may have no verify command: a plan or research gets a
 * second reasoning look instead; an evaluation step is mine (ADR-064 §1).
 */
const UNVERIFIED_OK = new Set(["plan", "research", "evaluation"]);
/** Task kinds that change files and so need a scope. */
const CHANGES_FILES = new Set(["implement", "test", "mechanical", "review"]);

/**
 * Checks a plan before it becomes The Web (The-Eye → Planning). Returns
 * every problem in plain words, so the brain can be told exactly what to
 * fix; empty means valid.
 */
export function validateWeb(plan: WebPlan): string[] {
  const problems: string[] = [];
  const keys = new Set<string>();
  for (const t of plan.tasks) {
    if (keys.has(t.key)) problems.push(`Task key "${t.key}" is used twice.`);
    keys.add(t.key);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (!keys.has(d))
        problems.push(`Task "${t.key}" depends on "${d}", which is not in the plan.`);
      if (d === t.key) problems.push(`Task "${t.key}" depends on itself.`);
    }
    if (t.verify.length === 0 && !UNVERIFIED_OK.has(t.kind)) {
      problems.push(
        `Task "${t.key}" (${t.kind}) has no verify command; every task that changes things must.`,
      );
    }
    if (t.kind === "evaluation" && !t.evaluation)
      problems.push(
        `Task "${t.key}" is an evaluation step: say what it shows in "evaluation": {"kind": "design" | "app" | "checkpoint", "why": "…"}.`,
      );
    if (t.kind === "evaluation" && t.dependsOn.length === 0)
      problems.push(
        `Evaluation step "${t.key}" depends on nothing: it comes after the work it shows.`,
      );
    if (t.kind !== "evaluation" && t.evaluation)
      problems.push(`Task "${t.key}" has an "evaluation" but is not of kind "evaluation".`);
    if (CHANGES_FILES.has(t.kind) && t.scope.length === 0) {
      problems.push(`Task "${t.key}" (${t.kind}) has no scope: say which paths it may change.`);
    }
    if (t.scope.some((g) => g.startsWith("/") || g.split("/").includes(".."))) {
      problems.push(
        `Task "${t.key}" has a scope outside the workspace; scopes are relative paths.`,
      );
    }
  }
  const cycle = findCycle(plan);
  if (cycle) problems.push(`The tasks depend on each other in a circle: ${cycle.join(" → ")}.`);
  return problems;
}

function findCycle(plan: WebPlan): string[] | null {
  const deps = new Map<string, string[]>();
  // With a duplicated key (reported separately), the first task counts.
  for (const t of plan.tasks) if (!deps.has(t.key)) deps.set(t.key, t.dependsOn);
  const state = new Map<string, "visiting" | "done">();
  const path: string[] = [];
  const visit = (k: string): string[] | null => {
    if (state.get(k) === "done") return null;
    if (state.get(k) === "visiting") return [...path.slice(path.indexOf(k)), k];
    state.set(k, "visiting");
    path.push(k);
    for (const d of deps.get(k) ?? []) {
      const c = deps.has(d) ? visit(d) : null;
      if (c) return c;
    }
    path.pop();
    state.set(k, "done");
    return null;
  };
  for (const k of deps.keys()) {
    const c = visit(k);
    if (c) return c;
  }
  return null;
}

/** Tasks whose dependencies are all done, in plan order. */
export function readyTasks<T extends { id: string; state: string; dependsOn: string[] }>(
  tasks: T[],
): T[] {
  const done = new Set(
    tasks.filter((t) => t.state === "done" || t.state === "skipped").map((t) => t.id),
  );
  return tasks.filter(
    (t) => (t.state === "pending" || t.state === "ready") && t.dependsOn.every((d) => done.has(d)),
  );
}

/** Matches a path against scope globs: `**` any depth, `*` within a segment, `?` one character. */
export function inScope(path: string, globs: string[]): boolean {
  const p = path.replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g.replace(/^\.\//, "")).test(p));
}

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      // "**/" matches zero or more directories; a trailing "**" matches everything.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A directory glob like "src/auth" covers what is inside it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

/**
 * Could two tasks touch the same file? Compares the fixed roots of their
 * scope globs (`src/auth/**` → `src/auth`): one root inside the other, or a
 * scope with no fixed root, can overlap (ADR-016: only disjoint tasks run
 * side by side).
 */
export function scopesOverlap(a: string[], b: string[]): boolean {
  const roots = (globs: string[]) =>
    globs.map(
      (g) =>
        g
          .replace(/^\.\//, "")
          .split("/")
          .filter(Boolean)
          .reduce<{ parts: string[]; open: boolean }>(
            (acc, seg) => {
              if (!acc.open || /[*?[{]/.test(seg)) return { ...acc, open: false };
              return { parts: [...acc.parts, seg], open: true };
            },
            { parts: [], open: true },
          ).parts,
    );
  const ra = roots(a);
  const rb = roots(b);
  if (ra.length === 0 || rb.length === 0) return true;
  const within = (x: string[], y: string[]) =>
    x.length <= y.length && x.every((s, i) => s === y[i]);
  return ra.some((x) => rb.some((y) => within(x, y) || within(y, x)));
}

/**
 * Could two tasks of this plan ever run at once: neither needing the
 * other, even through others? A chain can't; its tasks work in the job's
 * own tree one after another, as one task at a time always did. Done
 * tasks count, so a job that ran tasks side by side keeps doing so.
 */
export function canRunSideBySide(tasks: { id: string; dependsOn: string[] }[]): boolean {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const before = new Map<string, Set<string>>();
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    const known = before.get(id);
    if (known) return known;
    const out = new Set<string>();
    if (seen.has(id)) return out;
    seen.add(id);
    for (const d of byId.get(id)?.dependsOn ?? []) {
      out.add(d);
      for (const a of ancestors(d, seen)) out.add(a);
    }
    before.set(id, out);
    return out;
  };
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i] as { id: string };
      const b = tasks[j] as { id: string };
      if (!ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id)) return true;
    }
  return false;
}

/**
 * How two tasks' scopes conflict (ADR-050): "none" when they can't touch
 * the same file; "tight" when both name the same file or the same folder
 * two levels down or deeper (`src/auth/**` and `src/auth/login.ts`):
 * they wait for each other; "loose" when they meet only through a broad
 * scope (the whole repo, a top folder like `src/**`, `**\/*.ts`): they run
 * side by side, each in its own worktree, and a conflict at the merge is
 * redone on top of the newer work. A broad scope says little of what a
 * task will really change; serialising every task on it would make every
 * plan run one task at a time.
 */
export function scopeConflict(
  a: string[],
  b: string[],
): { kind: "none" | "loose" | "tight"; where: string | null } {
  if (!scopesOverlap(a, b)) return { kind: "none", where: null };
  const roots = (globs: string[]) =>
    globs.map((g) => {
      const parts: string[] = [];
      let exact = true;
      for (const seg of g.replace(/^\.\//, "").split("/").filter(Boolean)) {
        if (/[*?[{]/.test(seg)) {
          exact = false;
          break;
        }
        parts.push(seg);
      }
      return { parts, exact };
    });
  const within = (x: string[], y: string[]) =>
    x.length <= y.length && x.every((s, i) => s === y[i]);
  for (const x of roots(a))
    for (const y of roots(b)) {
      if (!within(x.parts, y.parts) && !within(y.parts, x.parts)) continue;
      const outer = x.parts.length <= y.parts.length ? x : y;
      // The same file named by both, or a folder deep enough to be one piece of work.
      if ((x.exact && y.exact && x.parts.length === y.parts.length) || outer.parts.length >= 2)
        return { kind: "tight", where: outer.parts.join("/") };
    }
  return { kind: "loose", where: null };
}

/** What a plan looks like, to compare The Eye's models on the same job (ADR-022). */
export function planMeasures(plan: WebPlan): PlanMeasures {
  const tasks = plan.tasks;
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const depthOf = new Map<string, number>();
  const depth = (key: string, seen = new Set<string>()): number => {
    const known = depthOf.get(key);
    if (known !== undefined) return known;
    // A circle can't be planned; it counts once rather than forever.
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = byKey.get(key)?.dependsOn ?? [];
    const d = 1 + Math.max(0, ...deps.map((k) => depth(k, seen)));
    depthOf.set(key, d);
    return d;
  };
  const kinds: Record<string, number> = {};
  for (const t of tasks) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
  const checks = tasks.reduce((n, t) => n + t.verify.length, 0);
  return {
    tasks: tasks.length,
    withChecks: tasks.length ? tasks.filter((t) => t.verify.length > 0).length / tasks.length : 0,
    checksPerTask: tasks.length ? checks / tasks.length : 0,
    depth: Math.max(0, ...tasks.map((t) => depth(t.key))),
    kinds,
  };
}

// ── The Web as a graph (after the piano job, 2026-10-04): a plan is a graph of
// dependent tasks, never a list of the same work twice.

type Planned = WebPlan["tasks"][number];

/** Words of a task's title that say nothing of what it is about. */
const TASK_WORDS =
  /\b(implement|implementation|add|adding|create|creating|build|building|write|writing|make|making|set|component|components|feature|features|support|task)\b/gi;
const PHASE = /\(?\bphase\s*\d+\)?:?/gi;

const titleCore = (title: string) => title.replace(PHASE, " ").replace(TASK_WORDS, " ");

/**
 * The same work planned twice: the same kind, and the same title in other
 * words ("Initialize React project" and "Initialize React TypeScript
 * project with Vite"), phase markers and generic verbs aside.
 */
export function sameTask(a: { title: string; kind: string }, b: { title: string; kind: string }) {
  if (a.kind !== b.kind) return false;
  const plain = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  if (plain(a.title) === plain(b.title)) return true;
  const x = meaningWords(titleCore(a.title));
  const y = meaningWords(titleCore(b.title));
  if (!x.size || !y.size) return false;
  if (x.size === y.size && [...x].every((w) => y.has(w))) return true;
  const [small, big] = x.size <= y.size ? [x, y] : [y, x];
  if (small.size >= 2 && [...small].every((w) => big.has(w))) return true;
  return likeness(titleCore(a.title), titleCore(b.title)) >= 0.6;
}

const FOUNDATION =
  /\b(scaffold\w*|bootstrap\w*|initiali[sz]\w*|init|set ?up|setup|skeleton|create (?:the |a )?(?:project|app|repo|repository|workspace)|install (?:the )?dependencies)\b/i;
const FINISHING =
  /\b(integrat\w*|end[- ]to[- ]end|e2e|wire (?:it |them |everything )?(?:up|together)|assembl\w*|final (?:check|review|polish|test)\w*|smoke test\w*)\b/i;

const edgeCount = (plan: WebPlan) => plan.tasks.reduce((n, t) => n + t.dependsOn.length, 0);

/** A plan of several tasks with no dependency at all, where the order plainly matters. */
export function orderMatters(plan: WebPlan): boolean {
  const ts = plan.tasks;
  if (ts.length < 2 || edgeCount(plan) > 0) return false;
  const kinds = new Set(ts.map((t) => t.kind));
  const builds = ts.some((t) => t.kind === "implement" || t.kind === "mechanical");
  return (
    ts.some((t) => FOUNDATION.test(t.title) || FINISHING.test(t.title)) ||
    new Set(ts.map((t) => t.phase).filter((p) => p !== undefined)).size > 1 ||
    (builds && (kinds.has("research") || kinds.has("plan") || kinds.has("test")))
  );
}

/**
 * What a planner should fix that doesn't make a plan unusable (The-Eye →
 * Planning): the same work twice, and a plan with no dependency at all
 * where the order plainly matters. Sent back once; Oraknid mends what
 * remains itself (`shapeWeb`).
 */
export function graphProblems(plan: WebPlan): string[] {
  const problems: string[] = [];
  const ts = plan.tasks;
  for (const [i, a] of ts.entries())
    for (const b of ts.slice(i + 1))
      if (sameTask(a, b))
        problems.push(`"${a.key}" and "${b.key}" are the same work ("${a.title}"): plan it once.`);
  if (orderMatters(plan))
    problems.push(
      `None of the ${ts.length} tasks depends on another, yet their order matters: give each task in "dependsOn" the keys of the tasks whose results it needs (the project's setup before its features, research before the work that uses it, integration and tests after the parts they cover), and keep tasks that don't need each other side by side.`,
    );
  return problems;
}

/**
 * A plan made into a sound graph before it becomes The Web: the same work
 * planned twice merged into one task; each phase after the one before; a
 * dependency on a task that isn't there, on itself or in a circle dropped;
 * and, as a last resort, a plan with no dependency at all where order
 * plainly matters put in order (setup and research, then the work, then
 * integration and tests). `known` are tasks already in The Web that new
 * tasks may depend on. Returns the plan and what was changed, in words.
 */
export function shapeWeb(
  plan: WebPlan,
  known: Set<string> = new Set(),
  /**
   * The evaluation steps the job's setting allows (ADR-064 §1); `add`: a
   * first plan, which gets the reviews work I'll see must have.
   */
  evaluations?: { setting: Evaluations; add: boolean },
): { plan: WebPlan; notes: string[] } {
  const notes: string[] = [];
  // The same work twice: the later merged into the earlier, references moved with it.
  const into = new Map<string, string>();
  const kept: Planned[] = [];
  for (const t of plan.tasks) {
    if (kept.some((k) => k.key === t.key)) {
      notes.push(`Task key "${t.key}" was used twice; the second was left out.`);
      continue;
    }
    const twin = kept.find((k) => sameTask(k, t));
    if (!twin) {
      kept.push({ ...t, dependsOn: [...t.dependsOn], scope: [...t.scope], verify: [...t.verify] });
      continue;
    }
    into.set(t.key, twin.key);
    twin.dependsOn = [...new Set([...twin.dependsOn, ...t.dependsOn])];
    twin.scope = [...new Set([...twin.scope, ...t.scope])];
    twin.verify = [...new Set([...twin.verify, ...t.verify])];
    if (t.instructions.trim() !== twin.instructions.trim())
      twin.instructions = `${twin.instructions}\n\n${t.instructions}`;
    notes.push(`"${t.title}" is the same work as "${twin.title}": planned once.`);
  }
  const resolve = (k: string) => into.get(k) ?? k;
  const keys = new Set(kept.map((t) => t.key));
  for (const t of kept)
    t.dependsOn = [...new Set(t.dependsOn.map(resolve))].filter((d) => {
      if (d === t.key) return false;
      if (keys.has(d) || known.has(d)) return true;
      notes.push(`"${t.title}" depended on "${d}", which isn't in the plan; dropped.`);
      return false;
    });

  // Chains of crumbs: small steps on the same place, one after another, are one task (ADR-052 §1).
  const merged = mergeCrumbs(kept);
  if (merged.length) {
    for (const m of merged) {
      for (const k of m.from) into.set(k, m.into);
      notes.push(
        `${m.from.length + 1} small steps one after another on the same place are one task: "${m.title}".`,
      );
    }
    const gone = new Set(merged.flatMap((m) => m.from));
    for (let i = kept.length - 1; i >= 0; i--)
      if (gone.has((kept[i] as Planned).key)) kept.splice(i, 1);
    for (const t of kept)
      t.dependsOn = [...new Set(t.dependsOn.map((d) => into.get(d) ?? d))].filter(
        (d) => d !== t.key,
      );
  }

  // Evaluation steps as the setting wants them, before the order is made (ADR-064 §1).
  if (evaluations) {
    const e = shapeEvaluations({ ...plan, tasks: kept }, evaluations.setting, {
      add: evaluations.add,
    });
    kept.splice(0, kept.length, ...e.plan.tasks);
    for (const t of kept) keys.add(t.key);
    notes.push(...e.notes);
  }

  // Phases in order: a phase's first tasks come after the previous phase's last ones.
  const phases = [...new Set(kept.map((t) => t.phase).filter((p): p is number => !!p))].sort(
    (a, b) => a - b,
  );
  for (const [i, p] of phases.entries()) {
    if (i === 0) continue;
    const prev = kept.filter((t) => t.phase === phases[i - 1]);
    const exits = prev.filter((t) => !prev.some((o) => o.dependsOn.includes(t.key)));
    const here = kept.filter((t) => t.phase === p);
    for (const t of here.filter((x) => !x.dependsOn.some((d) => here.some((h) => h.key === d))))
      t.dependsOn = [...new Set([...t.dependsOn, ...exits.map((e) => e.key)])];
  }

  // The last resort: no dependency at all where order plainly matters.
  const shaped: WebPlan = { ...plan, tasks: kept };
  if (orderMatters(shaped)) {
    const rank = (t: Planned) =>
      FINISHING.test(t.title) || t.kind === "test" || t.kind === "review"
        ? 2
        : FOUNDATION.test(t.title) || t.kind === "research" || t.kind === "plan"
          ? 0
          : 1;
    const ranks = [0, 1, 2].filter((r) => kept.some((t) => rank(t) === r));
    for (const [i, r] of ranks.entries()) {
      if (i === 0) continue;
      const before = kept.filter((t) => rank(t) === ranks[i - 1]).map((t) => t.key);
      for (const t of kept.filter((x) => rank(x) === r)) t.dependsOn = [...before];
    }
    if (edgeCount(shaped) > 0)
      notes.push(
        "The plan had no dependencies although its order matters: Oraknid ordered it itself (setup and research first, then the work, then integration and tests).",
      );
  }

  // No circle survives: a dependency that would close one is dropped, in plan order.
  const added = new Map<string, string[]>();
  const reaches = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (added.get(from) ?? []).some((n) => reaches(n, to, seen));
  };
  for (const t of kept) {
    const ok: string[] = [];
    for (const d of t.dependsOn) {
      if (keys.has(d) && reaches(d, t.key)) {
        notes.push(`"${t.title}" and "${d}" depended on each other in a circle; one link dropped.`);
        continue;
      }
      ok.push(d);
      added.set(t.key, [...(added.get(t.key) ?? []), d]);
    }
    t.dependsOn = ok;
  }
  return { plan: shaped, notes };
}

const NOTES = /(?:^|\/)notes\/|\.(?:md|txt)$/i;
const RANK_OF = { low: 0, medium: 1, high: 2 } as const;

/** Two tasks work on the same place: their scopes can meet, or both only write notes. */
const samePlace = (a: Planned, b: Planned) =>
  scopesOverlap(a.scope, b.scope) ||
  (a.scope.every((g) => NOTES.test(g)) && b.scope.every((g) => NOTES.test(g)));

/**
 * Chains of crumbs (ADR-052 §1, after the misahaty job of 2026-10-06, when one
 * `docker compose down` became eight tasks): three or more small tasks (not
 * rated high), each the only one after the one before and needing nothing
 * else, on the same place and in the same phase, are one task: its steps in
 * order, their scopes, checks and capabilities joined. Mutates the chain's
 * first task; returns each merge: the first task's key, the keys merged into
 * it, and its new title.
 */
export function mergeCrumbs(tasks: Planned[]): { into: string; from: string[]; title: string }[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const after = new Map<string, string[]>();
  for (const t of tasks)
    for (const d of t.dependsOn) after.set(d, [...(after.get(d) ?? []), t.key]);
  // An evaluation step is mine, never a crumb of an agent's (ADR-064 §1).
  const small = (t: Planned) =>
    t.difficulty !== "high" && t.kind !== "external" && t.kind !== "evaluation";
  /** The task that follows `a` as a crumb, if one does. */
  const next = (a: Planned): Planned | null => {
    const followers = after.get(a.key) ?? [];
    if (followers.length !== 1) return null;
    const b = byKey.get(followers[0] as string);
    if (!b) return null;
    if (b.dependsOn.length !== 1 || !small(a) || !small(b)) return null;
    if ((a.phase ?? null) !== (b.phase ?? null) || !samePlace(a, b)) return null;
    return b;
  };
  const inChain = new Set<string>();
  for (const t of tasks) {
    const b = next(t);
    if (b) inChain.add(b.key);
  }
  const out: { into: string; from: string[]; title: string }[] = [];
  for (const first of tasks) {
    if (inChain.has(first.key)) continue;
    const chain = [first];
    for (let b = next(first); b && !chain.includes(b); b = next(b)) chain.push(b);
    if (chain.length < 3) continue;
    const rest = chain.slice(1);
    const lower = (s: string) => `${s.charAt(0).toLowerCase()}${s.slice(1)}`;
    const joined = `${first.title}, then ${rest.map((t) => lower(t.title)).join(", then ")}`;
    const title = joined.length <= 100 ? joined : `${first.title} (and ${rest.length} more steps)`;
    const changes = chain.find((t) => CHANGES_FILES.has(t.kind));
    first.instructions = `Do these steps in one session, in order; plan them your own way.\n\n${chain
      .map((t, i) => `${i + 1}. **${t.title}**\n${t.instructions.trim()}`)
      .join("\n\n")}`;
    first.title = title;
    first.kind = changes?.kind ?? first.kind;
    first.scope = [...new Set(chain.flatMap((t) => t.scope))];
    first.verify = [...new Set(chain.flatMap((t) => t.verify))];
    first.requiredCapabilities = [...new Set(chain.flatMap((t) => t.requiredCapabilities))];
    first.difficulty = chain.reduce(
      (d, t) => (RANK_OF[t.difficulty] > RANK_OF[d] ? t.difficulty : d),
      first.difficulty,
    );
    out.push({ into: first.key, from: rest.map((t) => t.key), title });
  }
  return out;
}
