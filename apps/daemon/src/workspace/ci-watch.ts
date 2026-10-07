import { isCiFailure, type ProjectRepo } from "@oraknid/contracts";
import { z } from "zod";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import { readSetting, writeSetting } from "../settings.ts";
import type { Ci } from "./github-ci.ts";

// CI watched (ADR-058): every few minutes, the runs of each linked repo's
// release and work branches are read (with ETags: nothing costs while
// nothing changed); a run that ended failing since Oraknid started watching
// that branch is told once, as `ci.failed` (the notification router routes
// it, quiet hours included). What was told is kept, so a restart doesn't
// tell it again; a run re-run and failing again is told again.

const KEY = "ci.watched";
const Watched = z.record(
  z.string(),
  z.object({ since: z.number(), told: z.array(z.string()).default([]) }),
);
const TOLD_KEPT = 50;

export interface CiWatchDeps {
  db: Db;
  bus: EventBus;
  ci: Pick<Ci, "runs" | "run">;
  projects: {
    list(): {
      id: string;
      name: string;
      archivedAt: number | null;
      serverId?: string | null;
      repos: ProjectRepo[];
    }[];
  };
  intervalMs?: number;
  /** The first look, after the start (the daemon's start isn't slowed). */
  firstMs?: number;
  now?: () => number;
}

export function startCiWatch(d: CiWatchDeps) {
  const now = d.now ?? Date.now;
  let busy = false;

  async function tick(): Promise<number> {
    if (busy) return 0;
    busy = true;
    let told = 0;
    try {
      const state = readSetting(d.db, KEY, Watched, {});
      const refused = new Set<string>();
      for (const p of d.projects.list()) {
        if (p.archivedAt || p.serverId) continue;
        for (const repo of p.repos) {
          const l = repo.github;
          if (!l?.ready || refused.has(l.account)) continue;
          const r = { owner: l.owner, name: l.name, account: l.account };
          const fullName = `${l.owner}/${l.name}`;
          for (const branch of [...new Set([repo.releaseBranch, repo.workBranch])]) {
            const key = `${fullName}#${branch}`.toLowerCase();
            const st = state[key] ?? { since: now(), told: [] };
            state[key] = st;
            let page: Awaited<ReturnType<Ci["runs"]>>;
            try {
              page = await d.ci.runs(r, { branch, perPage: 10 });
            } catch {
              // GitHub refused this account (its allowance, a slow-down, the token): the next look.
              refused.add(l.account);
              break;
            }
            for (const run of page.items) {
              const id = `${run.id}:${run.attempt}`;
              if (run.status !== "completed" || !isCiFailure(run.conclusion)) continue;
              if (Date.parse(run.updatedAt) <= st.since || st.told.includes(id)) continue;
              const detail = await d.ci.run(r, run.id).catch(() => null);
              const job = detail?.jobs.find((j) => isCiFailure(j.conclusion));
              d.bus.publish({
                type: "ci.failed",
                topic: "overview",
                jobId: null,
                payload: {
                  projectId: p.id,
                  projectName: p.name,
                  repo: repo.name,
                  fullName,
                  branch,
                  runId: run.id,
                  attempt: run.attempt,
                  name: run.name,
                  title: run.title,
                  conclusion: run.conclusion,
                  url: run.url,
                  failing: job
                    ? `${job.name}${job.failingStep ? ` → ${job.failingStep}` : ""}`
                    : null,
                },
              });
              st.told = [...st.told, id].slice(-TOLD_KEPT);
              told++;
            }
          }
        }
      }
      writeSetting(d.db, KEY, Watched, state);
    } finally {
      busy = false;
    }
    return told;
  }

  const run = () => void tick().catch((e) => console.error("ci watch failed", e));
  const first = setTimeout(run, d.firstMs ?? 20_000);
  first.unref();
  const timer = setInterval(run, d.intervalMs ?? 3 * 60_000);
  timer.unref();
  return {
    tick,
    stop() {
      clearTimeout(first);
      clearInterval(timer);
    },
  };
}
