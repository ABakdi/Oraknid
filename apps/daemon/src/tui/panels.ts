import type { JobView, Question, QuestionAnswer, ServerView, TaskView } from "@oraknid/contracts";
import { ansi } from "./markdown.ts";

// What the terminal app shows above the prompt besides the conversation
// (ADR-055): a panel, a numbered list or lines, opened by a command; Esc
// goes back to the one before.

export interface PanelItem {
  label: string;
  detail?: string;
}

export interface Panel {
  /** Unique: live updates and closing find it by this. */
  key: string;
  title: string;
  /** Lines above the list, or the whole panel. */
  lines?: string[];
  items?: PanelItem[];
  /** The item chosen with ↑↓ (0-based). */
  selected?: number;
  /** Text panels: lines scrolled up from the anchor. */
  scroll?: number;
  /** Logs read from their end; documents from their start. */
  anchor?: "top" | "bottom";
  /** Under the panel: what can be done here. */
  hint?: string;
  onPick?: (index: number) => void | Promise<void>;
  /** Words typed while the panel is open go here, not to The Eye (an answer). */
  onText?: (text: string) => void | Promise<void>;
  /** Live topics that make it read again, and how. */
  topics?: string[];
  refresh?: () => Promise<Partial<Panel>>;
  /** Called when it closes (a log stops being followed). */
  onClose?: () => void;
}

let next = 1;
export const panelKey = (name: string) => `${name}-${next++}`;

const TASK_ICON: Record<string, string> = {
  pending: ansi.dim("○"),
  ready: ansi.dim("◌"),
  assigned: ansi.yellow("◔"),
  running: ansi.magenta("◐"),
  verifying: ansi.magenta("◑"),
  done: ansi.green("✓"),
  failed: ansi.red("✗"),
  skipped: ansi.dim("⊘"),
  paused: ansi.yellow("‖"),
};

export const JOB_STATE: Record<string, string> = {
  running: ansi.magenta("running"),
  completed: ansi.green("completed"),
  failed: ansi.red("failed"),
  blocked: ansi.red("blocked"),
  paused: ansi.yellow("paused"),
  cancelled: ansi.dim("cancelled"),
};

export const jobState = (s: string) => JOB_STATE[s] ?? s;

/**
 * A job's plan as a tree: each task under the first task it depends on,
 * in plan order; the order the items are numbered in.
 */
export function planTree(tasks: TaskView[]): { task: TaskView; depth: number }[] {
  const ids = new Set(tasks.map((t) => t.id));
  const children = new Map<string, TaskView[]>();
  const roots: TaskView[] = [];
  for (const t of tasks) {
    const parent = t.dependsOn.find((d) => ids.has(d));
    if (parent) children.set(parent, [...(children.get(parent) ?? []), t]);
    else roots.push(t);
  }
  const out: { task: TaskView; depth: number }[] = [];
  const seen = new Set<string>();
  const walk = (t: TaskView, depth: number) => {
    if (seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ task: t, depth });
    for (const c of children.get(t.id) ?? []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  // A cycle leaves some out: they come last, flat.
  for (const t of tasks) walk(t, 0);
  return out;
}

export function taskLabel(t: TaskView, depth: number): string {
  const lead = depth ? `${"  ".repeat(depth - 1)}└ ` : "";
  const who = t.routing ? ansi.dim(` · ${t.routing.leg} · ${t.routing.model}`) : "";
  const why = t.waitingReason ? ansi.dim(` · ${t.waitingReason}`) : "";
  return `${lead}${TASK_ICON[t.state] ?? "·"} ${t.title}${who}${why}`;
}

export function jobLines(j: JobView): string[] {
  const done = j.tasks.filter((t) => t.state === "done").length;
  const out = [
    `${ansi.bold(j.title)}  ${jobState(j.state)}  ${ansi.dim(`${done}/${j.tasks.length} tasks · ${j.tokens.toLocaleString("en")} tokens`)}`,
  ];
  if (j.description) out.push(ansi.dim(j.description));
  if (j.pauseReason && j.state === "paused") out.push(ansi.yellow(`Paused: ${j.pauseReason}`));
  if (j.blockedReason && j.state === "blocked") out.push(ansi.red(`Blocked: ${j.blockedReason}`));
  if (j.branch) out.push(ansi.dim(`branch ${j.branch}`));
  if (!j.tasks.length) out.push(ansi.dim("No plan yet."));
  return out;
}

export function taskLines(t: TaskView): string[] {
  const out = [
    `${TASK_ICON[t.state] ?? "·"} ${ansi.bold(t.title)}  ${ansi.dim(`${t.kind} · ${t.difficulty} · ${t.state} · ${t.attemptCount} attempt${t.attemptCount === 1 ? "" : "s"}`)}`,
  ];
  if (t.routing)
    out.push(
      ansi.dim(
        `${t.routing.leg} · ${t.routing.model}${t.routing.effort ? ` · ${t.routing.effort}` : ""}`,
      ),
    );
  if (t.waitingReason) out.push(ansi.yellow(t.waitingReason));
  out.push("", ...t.instructions.split("\n"));
  if (t.verify.length) out.push("", ansi.bold("Checked by"), ...t.verify.map((v) => `  $ ${v}`));
  if (t.scope.length) out.push("", ansi.bold("May change"), ...t.scope.map((s) => `  ${s}`));
  return out;
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(1)} GB`;
export const bytes = (n: number | null | undefined) => {
  if (n === null || n === undefined) return "?";
  if (n >= 1024 ** 3) return gb(n);
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

export function ago(at: number | null, now = Date.now()): string {
  if (!at) return "never";
  const s = Math.round((now - at) / 1000);
  if (s < 60) return `${Math.max(0, s)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function serverLines(s: ServerView, now = Date.now()): string[] {
  const out = [
    `${ansi.bold(s.name)}  ${ansi.dim(`${s.user}@${s.host}:${s.port}`)}${s.production ? `  ${ansi.red("production")}` : ""}`,
  ];
  if (s.description) out.push(ansi.dim(s.description));
  out.push(
    `${s.setup === "ready" ? ansi.green("set up") : ansi.yellow("not set up yet")} · seen ${ago(s.lastSeenAt, now)}${s.busy ? ` · ${s.busy}` : ""}`,
  );
  if (s.error) out.push(ansi.red(s.error));
  if (s.hostKeyOffered)
    out.push(
      ansi.red("A different host key was offered: nothing connects until it is accepted (web UI)."),
    );
  const l = s.latest;
  if (l) {
    out.push(
      "",
      `cpu ${l.cpuPercent.toFixed(0)}% · load ${l.load1.toFixed(2)} · memory ${gb(l.memUsed)} of ${gb(l.memTotal)} · disk ${gb(l.diskUsed)} of ${gb(l.diskTotal)}`,
      `up ${Math.round(l.uptimeSec / 86_400)} d · ${l.connections} connections`,
    );
    if (l.services.length) out.push(ansi.dim(`services: ${l.services.slice(0, 12).join(", ")}`));
    if (l.ports.length) out.push(ansi.dim(`ports: ${l.ports.slice(0, 16).join(", ")}`));
  }
  return out;
}

/** One question as a panel's list: its options numbered, the recommended one said. */
export function questionItems(q: Question): PanelItem[] {
  return q.options.map((o) => ({
    label: `${o.label}${o.id === q.recommended ? ansi.dim(" (recommended)") : ""}`,
    ...(o.detail ? { detail: o.detail } : {}),
  }));
}

/** Numbers typed for a question that takes several ("1,3" or "1 3"); null if it is words. */
export function pickedNumbers(text: string, count: number): number[] | null {
  if (!/^\d+(\s*[, ]\s*\d+)*$/.test(text.trim())) return null;
  const ns = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number),
    ),
  ];
  return ns.every((n) => n >= 1 && n <= count) ? ns : null;
}

/** An answer to one question from an option's number or my words. */
export function answerOf(q: Question, pick: { options?: number[]; text?: string }): QuestionAnswer {
  return {
    questionId: q.id,
    options: (pick.options ?? []).map((n) => q.options[n - 1]?.id).filter((x): x is string => !!x),
    text: pick.text ?? "",
  };
}
