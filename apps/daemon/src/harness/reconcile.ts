import { isAbsolute, relative } from "node:path";
import { toolClass } from "@oraknid/leg-sdk";
import { eq } from "drizzle-orm";
import { attempts } from "../db/schema.ts";
import { parseSsh } from "../servers/remote.ts";
import { git } from "../workspace/git.ts";
import type { AttemptEvent, AttemptLog } from "./log.ts";
import type { AttemptDeps, AttemptOutcome, AttemptWhere, TaskRow } from "./types.ts";

// Uncertain actions reconciled after a restart (ADR-056 §1): an action an
// attempt asked for and never saw the result of is never re-run to find
// out. The tree is looked at — did the file change, is the commit there —
// and what the tree can't show (a command's effect on a server, a command
// whose effect isn't a file) is asked of the agent in the next session,
// to look and say, never to run again. Each finding is a `Reconciled` in
// the attempt log; `decideOutcome` sees what is still unresolved.

type Uncertain = AttemptEvent<"ActionUncertain">;
type Writer = ReturnType<AttemptLog["at"]>;

/** A git commit an agent ran: its effect is the branch's head having moved. */
const COMMITS = /\bgit\s+(?:-C\s+\S+\s+)?commit\b/;

/**
 * Each action the attempt before left uncertain and nothing reconciled yet,
 * looked at: the tree since `since` (the checkpoint before that attempt).
 * The findings, written to this attempt's log.
 */
export async function reconcile(
  log: AttemptLog,
  trail: Writer,
  o: {
    taskId: string;
    /** The attempt whose actions were left uncertain. */
    before: string;
    ws: AttemptWhere;
    /** The checkpoint before that attempt. */
    since: string;
    aliases: string[];
  },
): Promise<AttemptEvent<"Reconciled">[]> {
  const done = new Set(
    log.task(o.taskId, { kinds: ["Reconciled"], limit: 1000 }).map((e) => e.data.actionId),
  );
  const open = log
    .attempt(o.before, { kinds: ["ActionUncertain"], limit: 100 })
    .filter((e) => !done.has(e.data.actionId));
  if (!open.length) return [];
  let changed: string[] | null = null;
  const changedNow = async () => {
    if (changed) return changed;
    try {
      changed = await o.ws.tree.changedSince(o.since);
    } catch {
      changed = [];
    }
    return changed;
  };
  const out: AttemptEvent<"Reconciled">[] = [];
  for (const u of open) {
    const f = await findingOf(u, o, changedNow);
    out.push(
      trail.append("Reconciled", {
        actionId: u.data.actionId,
        tool: u.data.tool,
        input: u.data.input,
        ...f,
      }),
    );
  }
  return out;
}

async function findingOf(
  u: Uncertain,
  o: { ws: AttemptWhere; since: string; aliases: string[] },
  changedNow: () => Promise<string[]>,
): Promise<Pick<AttemptEvent<"Reconciled">["data"], "finding" | "detail">> {
  const { tool, input } = u.data;
  const cls = toolClass(tool);
  if (cls === "write" && input && !input.startsWith("{")) {
    const path = isAbsolute(input) ? relative(o.ws.cwd, input) : input;
    if (!path.startsWith(".."))
      return (await changedNow()).includes(path)
        ? { finding: "happened", detail: `${path} changed since the attempt began` }
        : { finding: "not-happened", detail: `${path} is as it was before the attempt` };
  }
  if (cls === "shell") {
    const ssh = o.aliases.length ? parseSsh(input, o.aliases) : null;
    if (ssh?.remote)
      return {
        finding: "ask-agent",
        detail: `a command on ${ssh.alias}: only the server shows whether it took effect`,
      };
    if (COMMITS.test(input) && o.ws.tree.single) {
      const moved = headMoved(o.ws.tree.single, o.since);
      if (moved !== null)
        return moved
          ? { finding: "happened", detail: "the branch has a commit made after the attempt began" }
          : { finding: "not-happened", detail: "no commit was made after the attempt began" };
    }
  }
  return {
    finding: "ask-agent",
    detail: "its effect isn't a file the tree shows: the agent looks, it doesn't run it again",
  };
}

/** Whether the branch's head moved since a checkpoint (made on top of it); null when git can't say. */
export function headMoved(g: Parameters<typeof git>[0], ckpt: string): boolean | null {
  try {
    return git(g, ["rev-parse", "HEAD"]).trim() !== git(g, ["rev-parse", `${ckpt}^`]).trim();
  } catch {
    return null;
  }
}

/**
 * Oraknid's own commit, reconciled (ADR-056 §1, §8): the attempt before
 * entered Done — a `Transition` carrying the checkpoint its commit is
 * measured from — and its outcome was never applied to the task (Oraknid
 * stopped while committing, or after, before the job's step was written).
 * If the commit is there (the branch moved past the checkpoint), the task
 * is done with it and nothing runs again; the attempt is recorded as it
 * ended. Null when there is nothing to reconcile or git can't tell (a
 * project of several repos).
 */
export function committedBeforeCrash(
  d: Pick<AttemptDeps, "db" | "silk" | "now">,
  log: AttemptLog,
  jobId: string,
  task: Pick<TaskRow, "id" | "title" | "attemptCount" | "settledAttempt">,
  before: { id: string; outcome: string | null; startedAt: number },
  tree: AttemptWhere["tree"],
): Extract<AttemptOutcome, { kind: "done" }> | null {
  if (task.attemptCount <= task.settledAttempt) return null;
  if (before.outcome !== null && before.outcome !== "abandoned" && before.outcome !== "succeeded")
    return null;
  const last = log.attempt(before.id, { kinds: ["Transition"], limit: 1 })[0];
  if (last?.data.to !== "Done" || !last.data.ckpt) return null;
  if (!tree.single || !tree.hasRef(last.data.ckpt)) return null;
  if (headMoved(tree.single, last.data.ckpt) !== true) return null;
  const sha = headSha(tree.single);
  const trail = log.at({ jobId, taskId: task.id, attemptId: before.id });
  trail.append("Reconciled", {
    actionId: last.data.key,
    tool: "commit",
    input: `the task's commit after ${last.data.ckpt}`,
    finding: "happened",
    detail: `Oraknid stopped after it committed the work${sha ? ` (${sha.slice(0, 10)})` : ""}: the task is done, nothing runs again`,
  });
  if (before.outcome !== "succeeded") {
    trail.append("Outcome", { kind: "succeeded", reason: "its commit was made before a restart" });
    trail.append("AttemptEnded", { reason: "succeeded" });
    d.db
      .update(attempts)
      .set({ endedAt: d.now(), outcome: "succeeded" })
      .where(eq(attempts.id, before.id))
      .run();
    d.silk.add({
      jobId,
      taskId: task.id,
      kind: "progress",
      title: `Done: ${task.title}`,
      body: `Committed before a restart${sha ? ` (${sha.slice(0, 10)})` : ""}; Oraknid found the commit on the job's branch and didn't run the task again.`,
      authoredBy: "eye",
    });
  }
  return { kind: "done", commit: sha, commits: [] };
}

/** The branch's head, or null when git can't say. */
export function headSha(g: Parameters<typeof git>[0]): string | null {
  try {
    return git(g, ["rev-parse", "HEAD"]).trim();
  } catch {
    return null;
  }
}

/** What is still unresolved: asked of the agent, its answer not heard yet. */
export function unresolved(log: AttemptLog, attemptId: string): AttemptEvent<"Reconciled">[] {
  const rows = log.attempt(attemptId, { kinds: ["Reconciled"], limit: 200 });
  const answered = new Set(
    rows.filter((r) => r.data.finding === "agent-said").map((r) => r.data.actionId),
  );
  return rows.filter((r) => r.data.finding === "ask-agent" && !answered.has(r.data.actionId));
}

/** The agent looked and said (the turn after it was asked): its words are the finding. */
export function heard(trail: Writer, asked: AttemptEvent<"Reconciled">[], said: string) {
  for (const a of asked)
    trail.append("Reconciled", {
      actionId: a.data.actionId,
      tool: a.data.tool,
      input: a.data.input,
      finding: "agent-said",
      detail: said.slice(-600),
    });
}

/** The findings, said for the next model: what happened, what didn't, what to look at. */
export function reconciledText(found: AttemptEvent<"Reconciled">[]): string {
  if (!found.length) return "";
  const line = (e: AttemptEvent<"Reconciled">) =>
    `- ${e.data.tool} \`${e.data.input.replace(/`/g, "'").slice(0, 160)}\`: ${
      e.data.finding === "happened"
        ? "it happened"
        : e.data.finding === "not-happened"
          ? "it didn't happen"
          : "look whether it took effect"
    } (${e.data.detail})`;
  return `## Reconciled after a restart\nOraknid looked at what the last attempt left uncertain; none of it is run again by Oraknid.\n${found.map(line).join("\n")}`;
}

/** The question for the agent about what only it can look at. */
export function reconcileQuestion(open: AttemptEvent<"Reconciled">[]): string {
  return `Before this attempt, a restart cut these actions short and their result was never seen:\n${open
    .map((e) => `- ${e.data.tool} \`${e.data.input.replace(/`/g, "'").slice(0, 200)}\``)
    .join(
      "\n",
    )}\nLook whether each one took effect (read the files, the server's state, the logs) without running it again, and say what you found for each. Then go on with the task and say DONE when it is finished.`;
}
