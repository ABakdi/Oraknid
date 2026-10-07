import type { CiRun, ProjectView } from "@oraknid/contracts";
import type { Ctx } from "./actions.ts";
import { ansi } from "./markdown.ts";
import { ago, panelKey } from "./panels.ts";

// The terminal app's /ci (ADR-058): the current project's linked repos'
// latest GitHub Actions runs; a number shows a run's jobs and steps and the
// failing step's last lines. Everything through the API the web uses.

/** A run's state as a mark and a word, coloured. */
export function runState(r: Pick<CiRun, "status" | "conclusion">): string {
  if (r.status !== "completed") return ansi.magenta(`◐ ${r.status.replace("_", " ")}`);
  if (r.conclusion === "success") return ansi.green("✓ passed");
  if (
    r.conclusion === "failure" ||
    r.conclusion === "timed_out" ||
    r.conclusion === "startup_failure"
  )
    return ansi.red(`✗ ${r.conclusion === "failure" ? "failed" : r.conclusion.replace("_", " ")}`);
  return ansi.dim(`· ${r.conclusion ?? "done"}`);
}

const TAIL = 40;

export function ciCommand(c: Ctx, needProject: () => ProjectView) {
  return async () => {
    const p = needProject();
    const linked = p.repos.flatMap((r) =>
      r.github?.ready ? [{ repo: r.name, owner: r.github.owner, name: r.github.name }] : [],
    );
    if (!linked.length) {
      c.flash(
        `${p.name} has no GitHub repo linked: link one in the web UI (its Repo tab).`,
        "error",
      );
      return;
    }
    const rows: { repo: (typeof linked)[number]; run: CiRun }[] = [];
    const errors: string[] = [];
    for (const repo of linked) {
      try {
        const page = await c.api.ci.runs({ owner: repo.owner, name: repo.name });
        for (const run of page.items.slice(0, 10)) rows.push({ repo, run });
      } catch (e) {
        errors.push(`${repo.owner}/${repo.name}: ${(e as Error).message}`);
      }
    }
    const several = linked.length > 1;
    c.push({
      key: panelKey("ci"),
      title: `CI · ${p.name}`,
      lines: errors.map((e) => ansi.red(e)),
      items: rows.map(({ repo, run }) => ({
        label: `${runState(run)}  ${ansi.bold(run.name)} ${ansi.cyan(run.branch ?? "?")} ${ansi.dim(run.sha.slice(0, 7))}${several ? ansi.dim(` · ${repo.repo}`) : ""}`,
        detail: `${run.title} · ${run.event} · ${run.actor ?? "?"} · ${ago(Date.parse(run.updatedAt), c.now())}`,
      })),
      hint: rows.length ? "A number shows its jobs and the failing step's log." : "No runs yet.",
      onPick: async (i) => {
        const row = rows[i];
        if (!row) return;
        const ref = { owner: row.repo.owner, name: row.repo.name };
        const run = await c.api.ci.run({ ...ref, runId: row.run.id });
        const lines = [
          `${runState(run)}  ${ansi.bold(run.name)} on ${run.branch ?? "?"} at ${run.sha.slice(0, 7)}, attempt ${run.attempt}`,
          ansi.dim(run.url),
          "",
        ];
        for (const j of run.jobs) {
          lines.push(`${runState(j)}  ${ansi.bold(j.name)}`);
          for (const s of j.steps) lines.push(`    ${runState(s)}  ${s.name}`);
        }
        const failing = run.jobs.find(
          (j) => j.conclusion === "failure" || j.conclusion === "timed_out",
        );
        if (failing) {
          const log = await c.api.ci.log({ ...ref, jobId: failing.id });
          const section = log.sections.find((s) => s.failing) ?? log.sections[0];
          if (section) {
            lines.push("", ansi.bold(`The last lines of ${failing.name} → ${section.name}:`));
            lines.push(...section.lines.slice(-TAIL));
          }
        }
        c.push({
          key: panelKey("ci-run"),
          title: `CI · ${run.name} #${run.id}`,
          anchor: "bottom",
          lines,
          hint: "Re-run it in the web UI (its CI tab), or ask the helper.",
        });
      },
    });
  };
}
