import { createHash } from "node:crypto";
import { fence, saysCheckBroken } from "@oraknid/core";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { tasks } from "../db/schema.ts";
import { BrainStopped, type CheckRepair, type GitHubForRepair } from "../eye/brain.ts";
import { type JobServerRef, plainServerCheck } from "../servers/remote.ts";
import { readSetting, writeSetting } from "../settings.ts";
import { githubLinkOf, githubLinksOf } from "../workspace/github-tool.ts";
import type { AttemptDeps, AttemptJob, AttemptWhere, TaskRow } from "./types.ts";
import type { CheckReport, RunOptions } from "./verifier.ts";

// A task's checks around its attempt (ADR-052 §2, ADR-056 §4): the Stop
// hook's run (and what it ran standing for the turn's end, bug 5), broken
// checks repaired by The Eye (the controller's Repairing), and the checks
// tried once before the work. Every run goes through the one Verifier.

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

/** What the Stop hook ran when it let the turn end: it stands when the work is the same (bug 5). */
export type StopRun = { verify: string[]; tree: string; report: CheckReport };

export function taskChecks(
  d: AttemptDeps,
  job: AttemptJob,
  task: TaskRow,
  o: {
    ws: AttemptWhere;
    ckpt: string;
    scopeBase: string;
    servers: JobServerRef[];
    prepareServers: () => Promise<void>;
    run: (commands: string[], o?: RunOptions) => Promise<CheckReport>;
    log: { append: (kind: "StopRequested", data: { text: string }) => unknown };
    event: (type: string, payload: Record<string, unknown>) => void;
    /** A check was corrected: the task's scope follows it (M13.22). */
    corrected: () => void;
  },
) {
  const { ws, servers, event } = o;
  let stopRun = null as StopRun | null;

  /** The work as it stands, to tell whether it changed since the checks ran. */
  const treeState = async () => {
    try {
      return hash(await ws.tree.diffSince(o.scopeBase));
    } catch {
      return `unknown:${d.now()}`;
    }
  };

  /** The project's GitHub repos a check may be about, for The Eye's look at it (ADR-038, ADR-042). */
  const githubForRepair = (): GitHubForRepair => {
    if (!ws.tree.several) {
      const l = githubLinkOf(d.db, job.id);
      return l ? { repo: `${l.owner}/${l.name}`, visibility: l.visibility } : null;
    }
    const repos = githubLinksOf(d.db, job.id).filter((x) => x.github);
    return repos.length
      ? repos.map((x) => ({
          repo: `${x.github?.owner}/${x.github?.name}`,
          visibility: x.github?.visibility ?? "private",
          name: x.name,
        }))
      : null;
  };

  /**
   * Broken checks repaired, never counted against an agent (The-Eye → A check
   * that is wrong; ADR-052 §2): a failure that looks like the check's own
   * (syntax, quoting, a missing tool), or one the agent shows with evidence
   * to be the check's, is looked at by The Eye on its strongest model. A
   * broken check is replaced by one that tests the same thing, and the checks
   * run again; at most twice.
   */
  const repairBroken = async (
    checked: CheckReport,
    report: string,
    rerun: () => Promise<CheckReport>,
    before = false,
  ): Promise<CheckReport> => {
    const said = before ? null : saysCheckBroken(report);
    const looked = new Set<string>();
    for (let repairs = 0; repairs < 2 && d.brain; repairs++) {
      const bad = checked.failures[0];
      if (!bad || looked.has(bad.command)) break;
      // A guard (what the work must keep true) failing before any work is wrong itself (ADR-049):
      // the Verifier's report says so.
      const guard = before && checked.guards.some((g) => g.command === bad.command);
      const own = checked.broken.find((b) => b.command === bad.command)?.hint ?? null;
      const hint = own ?? (said ? `the agent says the check is broken: “${said}”` : null);
      if (!hint) break;
      looked.add(bad.command);
      let repair: CheckRepair;
      try {
        repair = await d.brain.repairCheck({
          jobId: job.id,
          cwd: ws.cwd,
          task: { title: task.title, instructions: task.instructions },
          command: bad.command,
          output: bad.output,
          hint,
          report: before ? "(The check was run before any work, to test it.)" : report,
          github: githubForRepair(),
          ...(servers.length
            ? { servers: servers.map((s) => ({ alias: s.alias, name: s.name })) }
            : {}),
          ...(guard ? { guard: true } : {}),
        });
      } catch (error) {
        // I stopped The Eye's thinking (M13.25): the job pauses here.
        if (error instanceof BrainStopped) throw error;
        break;
      }
      event("task.check-reviewed", {
        command: bad.command,
        broken: repair.broken,
        replacement: repair.broken ? repair.command : null,
        reason: repair.reason,
        ...(before ? { before: true } : {}),
        ...(!own && said ? { agentSaid: said } : {}),
      });
      if (!repair.broken) break;
      task.verify = task.verify.map((v) => (v === bad.command ? repair.command : v));
      // The file a corrected check names is the task's to write (M13.22).
      o.corrected();
      d.db.update(tasks).set({ verify: task.verify }).where(eq(tasks.id, task.id)).run();
      d.silk.add({
        jobId: job.id,
        taskId: task.id,
        kind: "decision",
        title: `Check corrected: ${task.title}`,
        body: `\`${bad.command}\` was wrong (${repair.reason}). It is now \`${repair.command}\`.`,
        authoredBy: "eye",
      });
      checked = await rerun();
    }
    return checked;
  };

  return {
    treeState,
    repairBroken,

    /**
     * The checks in the loop (ADR-052 §2): before the agent may end its turn,
     * Oraknid runs them; a failure keeps it working (a Leg's Stop hook, three
     * times at most). A check that looks broken lets it stop: The Eye looks
     * at the check, not the agent.
     */
    async onStop(said = ""): Promise<string | null> {
      if (!task.verify.length) return null;
      o.log.append("StopRequested", { text: said.slice(-1000) });
      const report = await o.run(task.verify, { why: "stop" });
      const bad = report.failures[0];
      if (!bad || report.broken.length) {
        // It lets the turn end now, nothing done after: the turn's end uses this run (bug 5).
        stopRun = { verify: [...task.verify], tree: await treeState(), report };
        return null;
      }
      event("task.checks-held", { command: bad.command, exitCode: bad.exitCode });
      return `Oraknid ran the task's checks and this one fails, so the task isn't done yet:\n${fence(bad.command)}\nfailed (exit ${bad.exitCode}):\n${fence(bad.output.slice(-2000))}\nFix the work, not the check, then finish. If the check itself is wrong, say why and finish.`;
    },

    /** What the Stop hook ran as it let the turn end, if it did: taken once (bug 5). */
    takeStopRun(): StopRun | null {
      const r = stopRun;
      stopRun = null;
      return r;
    },

    /**
     * Checks tested before they judge (ADR-052 §2): each of the task's checks
     * run once before its first attempt. Failing on work not done yet is what
     * a check should do; a broken one (syntax, quoting, a missing tool) is
     * repaired now, before any agent can be failed by it. What the run left in
     * the folder is put back. Said in the job's events.
     */
    async tryFirst(): Promise<void> {
      if (!task.verify.length || !d.brain) return;
      const key = `eye.checksTried.${task.id}`;
      if (readSetting(d.db, key, z.boolean(), false)) return;
      const tried: { command: string; state: string }[] = [];
      // A check on a server in its plain form, `ssh <alias>` alone (ADR-049): kept so.
      await o.prepareServers();
      const plain = task.verify.map((v) =>
        servers.length
          ? plainServerCheck(
              v,
              servers.map((s) => s.alias),
            )
          : v,
      );
      if (plain.some((v, i) => v !== task.verify[i])) {
        const was = task.verify.filter((v, i) => v !== plain[i]);
        task.verify = plain;
        d.db.update(tasks).set({ verify: task.verify }).where(eq(tasks.id, task.id)).run();
        d.silk.add({
          jobId: job.id,
          taskId: task.id,
          kind: "decision",
          title: `Check put in its plain form: ${task.title}`,
          body: `${was.map((v) => `\`${v}\``).join(", ")} named the job's own ssh setup, which isn't where checks run: a check reaches a server by its alias alone, and Oraknid runs it there over its own connection.`,
          authoredBy: "eye",
        });
      }
      for (let i = 0; i < task.verify.length; i++) {
        const command = task.verify[i] as string;
        const before = { timeoutMs: 3 * 60_000, before: true, why: "before" };
        const first = await o.run([command], before);
        const r = first.results[0];
        if (!r) continue;
        if (r.ok) {
          tried.push({ command, state: "passes before the work" });
          continue;
        }
        // A guard failing before any work is wrong (ADR-049): repaired like a broken one.
        if (!first.broken.length) {
          tried.push({ command, state: "fails on the work not done yet" });
          continue;
        }
        const after = await repairBroken(
          first,
          "",
          () => o.run([task.verify[i] as string], before),
          true,
        );
        const current = task.verify[i] as string;
        tried.push({
          command,
          state:
            current !== command
              ? `broken, repaired as \`${current}\``
              : after.results[0] && after.broken.length
                ? "looks broken, and The Eye kept it"
                : "fails on the work not done yet",
        });
      }
      try {
        if ((await ws.tree.changedSince(o.ckpt)).length) await ws.tree.rollback(o.ckpt, ws.trash);
      } catch {}
      writeSetting(d.db, key, z.boolean(), true);
      event("task.checks-tried", { checks: tried });
    },
  };
}
