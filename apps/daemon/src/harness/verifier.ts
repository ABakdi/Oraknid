import type { GitHubLink } from "@oraknid/contracts";
import type { SandboxPlan } from "@oraknid/leg-sdk";
import type { Db } from "../db/open.ts";
import { runBuiltinCheck } from "../eye/builtin-checks.ts";
import { looksBroken, runVerify, type VerifyResult } from "../eye/verify.ts";
import { runServerCheck } from "../servers/checks.ts";
import { isGuardCheck, type JobServerRef } from "../servers/remote.ts";
import type { Servers } from "../servers/service.ts";
import type { GitHub } from "../workspace/github.ts";
import { githubLinkOf, githubLinksOf } from "../workspace/github-tool.ts";
import type { CheckLine } from "./log.ts";

// The Verifier (ADR-056 §4): one runner for checks, used by the task, the
// stop hook, the checks tried before the work, the merge and the job. Built
// once per job and tree with its sandbox, servers and built-in checks: a
// check on one of the job's servers (`ssh <alias> …`) runs there over
// Oraknid's own connection; `oraknid github-…` is answered by Oraknid; every
// other runs in the sandbox. Each command is read by the Gate's rules first
// (refused, it is a failed check, never run). The report tells a broken
// check (it can't run: syntax, a missing tool, ssh setup) from a failing
// one; a guard (what the work must keep true) must pass before the work.
// Repairing a broken check is the caller's outcome, never the Verifier's.

/** What a run of checks found. */
export interface CheckReport {
  /** Every check ran and passed. */
  passed: boolean;
  /** In order, stopping at the first failure. */
  results: VerifyResult[];
  /** The checks that failed (one: the run stops at it). */
  failures: VerifyResult[];
  /** Failed checks that look broken themselves, with why: The Eye's to look at, not the agent's. */
  broken: { command: string; hint: string }[];
  /** The results of the guards among them. */
  guards: VerifyResult[];
}

/** What a run of checks is for, in the log. */
export interface RunOptions {
  timeoutMs?: number;
  /** Run before any work (ADR-052 §2): a guard failing now is wrong itself. */
  before?: boolean;
  /** Why they ran, for the attempt log: "turn", "stop", "before", "repair", "merge", "job". */
  why?: string;
}

export interface VerifierDeps {
  db: Db;
  servers?: Servers;
  github?: GitHub;
}

/** Where the checks run and who may refuse them. */
export interface VerifierWhere {
  cwd: string;
  /** The project's own branch's commit here, for `oraknid github-branch`. */
  localCommit: (branch: string, repo: string | null) => string | null;
  /** The sandbox the checks run in; null: unsandboxed. */
  plan: () => SandboxPlan | null;
  /** The job's servers, as its commands name them (filled in when prepared). */
  servers: () => JobServerRef[];
  /** Made ready before the first run (the attempt's servers). */
  prepare?: () => Promise<void>;
  /** The Gate's refusal of a check's command, or null (ADR-056 §3). */
  refuse: (command: string, where: "local" | "server") => string | null;
  signal: AbortSignal;
  /** The link of the repo a built-in check names, in place of the project's rule. */
  linkFor?: (repo: string | null) => GitHubLink | string | null;
  /** The attempt log: every run is recorded as `ChecksRan`. */
  log?: { append: (kind: "ChecksRan", data: ChecksRanData) => unknown };
}

type ChecksRanData = { passed: boolean; results: CheckLine[]; why: string };

export type Verifier = ReturnType<typeof createVerifier>;

export function createVerifier(d: VerifierDeps, job: { id: string }, where: VerifierWhere) {
  /**
   * A project's linked repo for a built-in check (ADR-042): the one named
   * with `--repo`, or the only one; why there is none, said.
   */
  const linkFor = (repo: string | null): GitHubLink | string | null => {
    const repos = githubLinksOf(d.db, job.id);
    if (repo) {
      const r = repos.find((x) => x.name.toLowerCase() === repo.toLowerCase());
      if (!r)
        return `This project has no repo named ${repo}: its repos are ${repos.map((x) => x.name).join(", ")}.`;
      return r.github;
    }
    const linked = repos.filter((x) => x.github);
    if (repos.length > 1 && linked.length > 1)
      return `This project has several repos: name one with --repo (${linked.map((x) => x.name).join(", ")}).`;
    return (repos.length === 1 ? repos[0]?.github : linked[0]?.github) ?? null;
  };

  /** Checks Oraknid answers itself: on one of the job's servers, or about GitHub. */
  const builtin = async (command: string): Promise<VerifyResult | null> => {
    const servers = where.servers();
    const onServer =
      servers.length && d.servers
        ? await runServerCheck(command, {
            servers,
            run: (id, remote) => (d.servers as Servers).run(id, remote),
            refuse: (c) => where.refuse(c, "server"),
          })
        : null;
    return (
      onServer ??
      runBuiltinCheck(command, {
        ...(d.github ? { github: d.github } : {}),
        link: githubLinkOf(d.db, job.id),
        linkFor: where.linkFor ?? linkFor,
        localCommit: where.localCommit,
      })
    );
  };

  return {
    /** Runs the checks, in order, stopping at the first failure; recorded in the attempt log. */
    async run(checks: string[], o: RunOptions = {}): Promise<CheckReport> {
      await where.prepare?.();
      const results = await runVerify(checks, where.cwd, where.plan(), {
        signal: where.signal,
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        refuse: (command) => where.refuse(command, "local"),
        builtin,
      });
      const report = reportOf(results, !!o.before);
      where.log?.append("ChecksRan", {
        passed: report.passed,
        results: linesOf(report),
        why: o.why ?? (o.before ? "before" : "turn"),
      });
      return report;
    },
  };
}

/**
 * The report of a run: a failure that looks like the check's own (syntax,
 * a missing tool) is broken; so is a guard failing before any work
 * (ADR-049). A check the Gate refused is neither: it failed.
 */
export function reportOf(results: VerifyResult[], before = false): CheckReport {
  const failures = results.filter((r) => !r.ok);
  const broken = failures.flatMap((r) => {
    const hint =
      looksBroken(r) ??
      (before && isGuardCheck(r.command)
        ? "it guards what the work must keep true, yet fails before any work"
        : null);
    return hint ? [{ command: r.command, hint }] : [];
  });
  return {
    passed: results.every((r) => r.ok),
    results,
    failures,
    broken,
    guards: results.filter((r) => isGuardCheck(r.command)),
  };
}

/** The report as the log keeps it: each check's end of output. */
export function linesOf(report: CheckReport): CheckLine[] {
  return report.results.map((r) => {
    const broken = report.broken.find((b) => b.command === r.command)?.hint;
    return {
      command: r.command,
      ok: r.ok,
      exitCode: r.exitCode,
      output: r.ok ? "" : r.output.slice(-1500),
      ...(r.exitCode === null && r.output.startsWith("Oraknid did not run this check")
        ? { refused: true }
        : {}),
      ...(broken ? { broken } : {}),
      ...(isGuardCheck(r.command) ? { guard: true } : {}),
    };
  });
}
