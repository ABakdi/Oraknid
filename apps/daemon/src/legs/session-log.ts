import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import type { SessionLogEntry } from "@oraknid/contracts";

const MAX_READ = 512 * 1024;
const MAX_OUTPUT = 2000;

/**
 * Reads a session's NDJSON log from byte `after` and turns it into lines a
 * person can follow (Checkpoint 1 → F1-3): streamed text joined, tool calls
 * shown by what they do, long outputs cut. Stops at the last whole line, so
 * `next` is always a safe place to resume from.
 */
export function readSessionLog(
  file: string,
  after = 0,
): { entries: SessionLogEntry[]; next: number } {
  if (!existsSync(file)) return { entries: [], next: after };
  const size = statSync(file).size;
  if (after >= size) return { entries: [], next: size };
  const length = Math.min(MAX_READ, size - after);
  const buf = Buffer.alloc(length);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, length, after);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(10);
  if (lastNl < 0) {
    if (after + length >= size) return { entries: [], next: after }; // a line still being written
    // One line longer than a read: skipped, so the rest of the log stays readable (Audit 1 → Q1-03).
    const end = nextNewline(file, after + length, size);
    return {
      entries: [
        {
          at: 0,
          kind: "result",
          ok: true,
          text: `(${end - after} bytes of output, too long to show)`,
        },
      ],
      next: end === size ? size : end + 1,
    };
  }
  const entries: SessionLogEntry[] = [];
  for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = toEntry(e);
    if (!entry) continue;
    const prev = entries.at(-1);
    if ((entry.kind === "text" || entry.kind === "thinking") && prev?.kind === entry.kind)
      prev.text += entry.text;
    else entries.push(entry);
  }
  return { entries, next: after + lastNl + 1 };
}

function toEntry(e: Record<string, unknown>): SessionLogEntry | null {
  const at = typeof e.at === "number" ? e.at : 0;
  switch (e.type) {
    case "text.delta":
      return { at, kind: "text", text: String(e.text ?? "") };
    case "thinking.delta":
      return { at, kind: "thinking", text: String(e.text ?? "") };
    case "tool.called":
      return {
        at,
        kind: "tool",
        tool: String(e.tool),
        text: describeTool(e.input),
      };
    case "tool.result":
      return { at, kind: "result", ok: e.ok !== false, text: cut(String(e.output ?? "")) };
    case "permission.requested": {
      const d = e.decision as { allow?: boolean; message?: string; why?: string } | undefined;
      const r = e.request as { tool?: string; command?: string | null; path?: string | null };
      return {
        at,
        kind: "permission",
        tool: r?.tool,
        ok: d?.allow === true,
        // Its layer and reason (ADR-053), else what the Leg was told.
        text: `${d?.allow ? "allowed" : "refused"}: ${r?.command ?? r?.path ?? r?.tool ?? ""}${d?.why ? ` (${d.why})` : d?.message ? ` (${d.message})` : ""}`,
      };
    }
    case "permission.denied": {
      // Refused before it ran, in the Leg's own auto mode or by Oraknid's hook in it (ADR-053).
      const r = e.request as { tool?: string; command?: string | null; path?: string | null };
      return {
        at,
        kind: "permission",
        tool: r?.tool,
        ok: false,
        text: `refused by ${e.by === "leg" ? "the Leg's auto mode" : "Oraknid's rules"}: ${r?.command ?? r?.path ?? r?.tool ?? ""} (${String(e.reason ?? "")})`,
      };
    }
    case "question":
      return { at, kind: "question", text: String(e.text ?? "") };
    case "turn.ended":
      return {
        at,
        kind: "turn",
        ok: e.reason === "completed",
        text: `turn ${e.reason}${e.error ? `: ${e.error}` : ""}`,
      };
    case "session.ended":
      return {
        at,
        kind: "end",
        ok: e.reason === "completed",
        text: `session ${e.reason}${e.error ? `: ${e.error}` : ""}`,
      };
    default:
      return null;
  }
}

/** What a tool call does, in one line: the command, the file, the pattern. */
function describeTool(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const pick = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.query ?? i.description;
  if (typeof pick === "string") return cut(pick, 600);
  const json = JSON.stringify(i);
  return cut(json === "{}" ? "" : json, 600);
}

function cut(s: string, max = MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

/** The offset of the next newline at or after `from`, or the file's size. */
function nextNewline(file: string, from: number, size: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  const fd = openSync(file, "r");
  try {
    for (let pos = from; pos < size; pos += chunk.length) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - pos), pos);
      const i = chunk.subarray(0, n).indexOf(10);
      if (i >= 0) return pos + i;
    }
    return size;
  } finally {
    closeSync(fd);
  }
}
