import type { LegEvent } from "@oraknid/leg-sdk";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/open.ts";
import { sessions } from "../db/schema.ts";
import type { EventBus } from "../events/bus.ts";
import { handoffFromLog } from "../silk/handoff.ts";
import type { SilkStore } from "../silk/store.ts";
import { type AttemptEvent, type AttemptLog, inputSummary, type LogPlace } from "./log.ts";

// What an attempt writes to its log besides the Gate's decisions and the
// Verifier's reports (ADR-056 §1): the agent's actions and their results
// from its events, what it said once per turn; and what is read back from
// the log — the handoff's account of the attempt, the actions left
// uncertain by a restart.

type Writer = ReturnType<AttemptLog["at"]>;

/**
 * The agent's events, as the log keeps them: each tool call asked for, its
 * result (which the Gate reads: an action that ran ends the stuck row),
 * and its words at each turn's end, not every delta.
 */
export function recordEvents(log: Writer, ran: (actionId: string, ok: boolean) => void) {
  return (e: LegEvent) => {
    if (e.type === "tool.called")
      log.append("ActionRequested", { id: e.id, tool: e.tool, input: inputSummary(e.input) });
    else if (e.type === "tool.result") ran(e.id, e.ok);
    else if (e.type === "turn.ended")
      log.append("AgentText", { text: e.text.slice(-2000), reason: e.reason });
  };
}

const quote = (s: string) => `\`${s.replace(/`/g, "'").slice(0, 160)}\``;

/**
 * What an attempt did, from its log (ADR-056 §7): what was tried, what the
 * Gate refused, the last check report, what is uncertain. Bounded: its last
 * few events of each kind. Empty when the log has nothing of it.
 */
export function handoffFromAttempt(log: AttemptLog, attemptId: string): string {
  const parts: string[] = [];
  const tried = log.attempt(attemptId, { kinds: ["ActionRequested"], limit: 15 });
  if (tried.length)
    parts.push(
      `## What was tried (its last actions)\n${tried.map((e) => `- ${e.data.tool} ${quote(e.data.input)}`).join("\n")}`,
    );
  const refused = log
    .attempt(attemptId, { kinds: ["GateDecision"], limit: 100 })
    .filter((e) => e.data.verdict === "deny")
    .slice(-10);
  if (refused.length)
    parts.push(
      `## What Oraknid's Gate refused\n${refused.map((e) => `- ${quote(e.data.action)} — ${e.data.reason} (${e.data.by})`).join("\n")}`,
    );
  const checks = log.attempt(attemptId, { kinds: ["ChecksRan"], limit: 1 })[0];
  if (checks)
    parts.push(
      `## The last check report\n${checks.data.passed ? "Every check passed." : ""}${checks.data.results
        .map(
          (r) =>
            `- ${quote(r.command)}: ${r.ok ? "passes" : r.refused ? "refused" : r.broken ? `broken (${r.broken})` : `fails (exit ${r.exitCode})`}${!r.ok && r.output ? `\n\n\`\`\`\n${r.output.slice(-800)}\n\`\`\`` : ""}`,
        )
        .join("\n")}`,
    );
  const uncertain = log.attempt(attemptId, { kinds: ["ActionUncertain"], limit: 10 });
  if (uncertain.length) parts.push(uncertainText(uncertain));
  return parts.join("\n\n");
}

/** The actions left without a result, said for the next model and for me. */
export function uncertainText(list: AttemptEvent<"ActionUncertain">[]): string {
  return `## Uncertain after a restart\nThese actions started and their result was never seen: look whether they happened before doing them again.\n${list.map((e) => `- ${e.data.tool} ${quote(e.data.input)}`).join("\n")}`;
}

/**
 * An attempt that stopped with actions in flight (a crash, a restart):
 * each marked uncertain in its log, never re-run blindly (ADR-056 §1). The
 * controller reconciles them later (stage 5); for now they are recorded
 * and said. The ones marked now.
 */
export function markUncertain(log: AttemptLog, at: LogPlace): AttemptEvent<"ActionUncertain">[] {
  if (!at.attemptId) return [];
  return log.unmatched(at.attemptId).map((e) =>
    log.append(at, "ActionUncertain", {
      actionId: e.data.id,
      tool: e.data.tool,
      input: e.data.input,
    }),
  );
}

/**
 * What the attempt before left behind, taken over by the next (Durability
 * step 4; Audit 1 → D1-06): a crash leaves no handoff, so one is built now
 * from its session's log and its attempt log; what it left without a
 * result is marked uncertain, said in the job's events and to the next
 * model (in that handoff, or on its own).
 */
export async function takeOver(
  d: { db: Db; bus: EventBus; silk: SilkStore },
  log: AttemptLog,
  o: {
    jobId: string;
    task: { id: string; title: string; instructions: string };
    before: { id: string; outcome: string | null; startedAt: number };
  },
  diffStat: () => Promise<string>,
): Promise<void> {
  const { jobId, task, before } = o;
  const uncertain = markUncertain(log, { jobId, taskId: task.id, attemptId: before.id });
  if (uncertain.length)
    d.bus.publish({
      type: "task.actions-uncertain",
      topic: `job:${jobId}`,
      jobId,
      payload: {
        taskId: task.id,
        actions: uncertain.map((e) => ({ tool: e.data.tool, input: e.data.input })),
      },
    });
  if (before.outcome === "abandoned") {
    const handedOff = d.silk
      .all(jobId)
      .some((e) => e.kind === "handoff" && e.taskId === task.id && e.createdAt >= before.startedAt);
    const logFile = d.db
      .select({ logFile: sessions.logFile })
      .from(sessions)
      .where(eq(sessions.attemptId, before.id))
      .orderBy(desc(sessions.startedAt))
      .get()?.logFile;
    if (!handedOff && logFile) {
      d.silk.add({
        jobId,
        taskId: task.id,
        kind: "handoff",
        title: `Handoff: ${task.title}`,
        body: [
          handoffFromLog({ goal: task.instructions, logFile, diffStat: await diffStat() }),
          // What its attempt log says: tried, refused, the last checks, what is uncertain.
          handoffFromAttempt(log, before.id),
        ]
          .filter(Boolean)
          .join("\n\n"),
        authoredBy: "eye",
      });
      return;
    }
  }
  if (uncertain.length)
    d.silk.add({
      jobId,
      taskId: task.id,
      kind: "issue",
      title: `Uncertain after a restart: ${task.title}`,
      body: uncertainText(uncertain),
      authoredBy: "eye",
    });
}
