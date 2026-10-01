import { spawnSync } from "node:child_process";
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
  cwd: string;
  /** The task's last checkpoint; HEAD until checkpoints exist. */
  since?: string;
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
  const diff = spawnSync("git", ["diff", "--stat", o.since ?? "HEAD"], {
    cwd: o.cwd,
    encoding: "utf8",
  });
  return reconstructHandoff({
    goal: o.goal,
    diffStat: diff.status === 0 ? diff.stdout : "",
    commands,
    lastText: lastText?.text ?? "",
    verifyOutput: o.verifyOutput ?? null,
  });
}
