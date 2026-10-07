import type { EyeMessage, EyeThought, JobView, SessionLogEntry } from "@oraknid/contracts";
import { ansi, inline, renderMarkdown } from "./markdown.ts";

// The Eye's conversation as terminal lines (ADR-055), as the web reads it
// (M13.25): my prompts marked ›, replies in rendered Markdown, thinking live
// then folded to a line, three or more ended thoughts in a row as one.

export type TranscriptItem =
  | { kind: "message"; at: number; message: EyeMessage }
  | { kind: "thought"; at: number; thought: EyeThought }
  | { kind: "thoughts"; at: number; thoughts: EyeThought[] };

/** Messages and thoughts by time; thoughts that ended in a row of three or more folded. */
export function transcript(messages: EyeMessage[], thoughts: EyeThought[]): TranscriptItem[] {
  const merged: (
    | { kind: "message"; at: number; message: EyeMessage }
    | { kind: "thought"; at: number; thought: EyeThought }
  )[] = [
    ...messages.map((m) => ({ kind: "message" as const, at: m.createdAt, message: m })),
    ...thoughts.map((th) => ({ kind: "thought" as const, at: th.startedAt, thought: th })),
  ];
  merged.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "message" ? -1 : 1));
  const out: TranscriptItem[] = [];
  let run: EyeThought[] = [];
  const flush = () => {
    if (run.length >= 3) out.push({ kind: "thoughts", at: run[0]?.startedAt ?? 0, thoughts: run });
    else for (const th of run) out.push({ kind: "thought", at: th.startedAt, thought: th });
    run = [];
  };
  for (const item of merged) {
    if (
      item.kind === "thought" &&
      item.thought.outcome !== "thinking" &&
      !item.thought.interruptible
    ) {
      run.push(item.thought);
      continue;
    }
    flush();
    out.push(item);
  }
  flush();
  return out;
}

/** "41 s", "2 min 5 s". */
export function seconds(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

const ENDED: Record<string, string> = {
  done: ansi.green("✓"),
  failed: ansi.red("✗"),
  lost: ansi.red("✗"),
  stopped: ansi.dim("⊘"),
  redone: ansi.dim("↺"),
};

/** A thought's line: live with its time, or folded once ended ("Planned 9 tasks in 41 s"). */
export function thoughtLine(th: EyeThought, now: number): string {
  if (th.outcome === "thinking")
    return `${ansi.magenta("◐")} ${th.purpose}… ${ansi.dim(`· ${seconds(now - th.startedAt)} · ${th.model}${th.interruptible ? " · Esc stops" : ""}`)}`;
  const what = th.summary ?? th.purpose;
  const time = th.endedAt !== null ? ` in ${seconds(th.endedAt - th.startedAt)}` : "";
  return `${ENDED[th.outcome] ?? "·"} ${ansi.dim(`${what}${time} · ${th.model}`)}`;
}

/** What a running thought writes, its last few lines (thinking dim, text as it is). */
export function thoughtTail(entries: SessionLogEntry[], lines = 6): string[] {
  const shown: string[] = [];
  for (const e of entries) {
    if (e.kind === "thinking")
      for (const l of e.text.split("\n")) if (l.trim()) shown.push(ansi.dim(ansi.italic(l)));
    if (e.kind === "text") for (const l of e.text.split("\n")) if (l.trim()) shown.push(l);
    if (e.kind === "tool")
      shown.push(ansi.dim(`→ ${e.tool ?? "tool"} ${e.text.split("\n")[0] ?? ""}`));
  }
  return shown.slice(-lines).map((l) => `  ${ansi.dim("│")} ${l}`);
}

const INTENT: Record<string, string> = {
  instruction: "Instruction",
  task: "New work",
  context: "Context",
  later: "For later",
  stop: "Stop",
  question: "Question",
  report: "Report",
};

/** A message as lines: mine marked ›, The Eye's rendered, with what it did and its job. */
export function messageLines(
  m: EyeMessage,
  jobs: Map<string, JobView>,
  answered: boolean,
): string[] {
  if (m.author === "owner") {
    const [first = "", ...rest] = m.text.split("\n");
    return [`${ansi.cyan("›")} ${ansi.bold(first)}`, ...rest.map((l) => `  ${ansi.bold(l)}`)];
  }
  const out = renderMarkdown(m.text).map((l) => `  ${l}`);
  const meta: string[] = [];
  if (m.action) {
    meta.push(`[${INTENT[m.action.intent] ?? m.action.intent}]`);
    for (const d of m.action.did) meta.push(`· ${d}`);
    for (const t of m.action.report?.todo ?? []) meta.push(`· to do: ${t}`);
  }
  const job = m.jobId ? jobs.get(m.jobId) : undefined;
  if (job) meta.push(`· ${job.title}`);
  if (meta.length) out.push(`  ${ansi.dim(meta.join(" "))}`);
  if (m.questions?.length && !answered) {
    for (const [i, q] of m.questions.entries()) {
      out.push(`  ${ansi.yellow("?")} ${inline(q.prompt)}`);
      for (const [j, o] of q.options.entries())
        out.push(
          `     ${j + 1}. ${o.label}${o.id === q.recommended ? ansi.dim(" (recommended)") : ""}`,
        );
      if (i === m.questions.length - 1) out.push(ansi.dim("  Answer with /answer"));
    }
  }
  return out;
}
