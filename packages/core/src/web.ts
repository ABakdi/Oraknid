import type { WebPlan } from "@oraknid/contracts";

/** Task kinds that may have no verify command; they get a second reasoning look instead. */
const UNVERIFIED_OK = new Set(["plan", "research"]);
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
