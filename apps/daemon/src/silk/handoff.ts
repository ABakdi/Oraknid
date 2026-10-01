import { existsSync, readFileSync } from "node:fs";
import { reconstructHandoff } from "@oraknid/core";
import type { LegEvent } from "@oraknid/leg-sdk";

/**
 * Rebuilds a handoff from a session's raw log and the workspace diff, for
 * when the Leg cannot write its own (Silk → Handoff).
 */
export function handoffFromLog(o: {
  goal: string;
  logFile: string;
  /** `git diff --stat` since the task's checkpoint, from Oraknid's own git handle (Audit 1 → S1-01). */
  diffStat: string;
  verifyOutput?: string | null;
}): string {
  const events: LegEvent[] = existsSync(o.logFile)
    ? readFileSync(o.logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as LegEvent];
          } catch {
            return [];
          }
        })
    : [];

  const commandOf = new Map<string, string>();
  const commands: { command: string; ok: boolean }[] = [];
  for (const e of events) {
    if (e.type === "tool.called" && typeof e.input.command === "string")
      commandOf.set(e.id, e.input.command);
    if (e.type === "tool.result" && commandOf.has(e.id)) {
      commands.push({ command: commandOf.get(e.id) as string, ok: e.ok });
    }
  }
  const lastText = [...events].reverse().find((e) => e.type === "turn.ended") as
    | Extract<LegEvent, { type: "turn.ended" }>
    | undefined;
  return reconstructHandoff({
    goal: o.goal,
    diffStat: o.diffStat,
    commands,
    lastText: lastText?.text ?? "",
    verifyOutput: o.verifyOutput ?? null,
  });
}
