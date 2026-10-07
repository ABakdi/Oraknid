import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import {
  type CiArtifact,
  type CiBadge,
  type CiConclusion,
  type CiDispatchInput,
  type CiJob,
  type CiLog,
  type CiLogSection,
  type CiRun,
  type CiRunDetail,
  type CiRunPage,
  type CiStatus,
  type CiWorkflow,
  isCiFailure,
} from "@oraknid/contracts";
import { parse as parseYaml } from "yaml";
import type { Download } from "../cloud/routes.ts";
import { type GitHub, GitHubError } from "./github.ts";

// GitHub Actions inside Oraknid (ADR-058): a repository's runs, a run's jobs
// and steps, a job's log cut by step (the failing step first), artifacts,
// workflows run by hand, re-runs and cancels, a branch's badge, and a wait
// for a branch's runs (The Eye's `oraknid github-ci`). Everything through an
// account's token in the daemon; reads through GitHub.read, so ETags make an
// unchanged answer free and a refusal for the allowance pauses the account.

/** A repository, and the account that reads it. */
export interface CiRepo {
  owner: string;
  name: string;
  account: string;
}

/** How long an answer about something still running is kept before GitHub is asked again. */
export const LIVE_TTL = 10_000;
/** How long a finished thing's answer is kept. */
const DONE_TTL = 60_000;
/** Workflows and their files change rarely. */
const WORKFLOW_TTL = 5 * 60_000;
/** A job's log kept in memory: the last 4 MB, 2,000 lines a step, 20 logs. */
const LOG_BYTES = 4 * 1024 * 1024;
const LOG_LINES = 2000;
const LOGS_KEPT = 20;
/** The lines of the failing step shown with a failed check. */
export const TAIL_LINES = 40;

interface ApiRun {
  id: number;
  name?: string | null;
  display_title?: string | null;
  workflow_id: number;
  head_branch: string | null;
  head_sha: string;
  event: string;
  status: string | null;
  conclusion: string | null;
  run_attempt?: number;
  actor?: { login: string } | null;
  triggering_actor?: { login: string } | null;
  run_started_at?: string | null;
  created_at?: string;
  updated_at: string;
  html_url: string;
  pull_requests?: { number: number }[];
}

interface ApiStep {
  number: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

interface ApiJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url?: string | null;
  steps?: ApiStep[];
}

const q = encodeURIComponent;
const STATUSES = new Set(["queued", "in_progress", "completed", "waiting", "requested", "pending"]);
const status = (s: string | null | undefined): CiStatus =>
  (STATUSES.has(s ?? "") ? s : "queued") as CiStatus;
const CONCLUSIONS = new Set([
  "success",
  "failure",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
  "neutral",
  "stale",
  "startup_failure",
]);
const conclusion = (c: string | null | undefined): CiConclusion =>
  (c && CONCLUSIONS.has(c) ? c : null) as CiConclusion;

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const span = (from: string | null | undefined, to: string | null | undefined, now: number) => {
  const a = ms(from);
  if (Number.isNaN(a)) return null;
  const b = to ? ms(to) : now;
  return Number.isNaN(b) ? null : Math.max(0, Math.round(b - a));
};

export function runOf(r: ApiRun, now = Date.now()): CiRun {
  const started = r.run_started_at ?? r.created_at ?? null;
  const st = status(r.status);
  return {
    id: r.id,
    name: r.name || "workflow",
    title: r.display_title || "",
    workflowId: r.workflow_id,
    branch: r.head_branch,
    sha: r.head_sha,
    event: r.event,
    status: st,
    conclusion: conclusion(r.conclusion),
    attempt: r.run_attempt ?? 1,
    actor: r.triggering_actor?.login ?? r.actor?.login ?? null,
    startedAt: started,
    updatedAt: r.updated_at,
    durationMs: span(started, st === "completed" ? r.updated_at : null, now),
    url: r.html_url,
    pullRequests: (r.pull_requests ?? []).map((p) => p.number),
  };
}

export function jobOf(j: ApiJob, now = Date.now()): CiJob {
  const steps = (j.steps ?? []).map((s) => ({
    number: s.number,
    name: s.name,
    status: status(s.status),
    conclusion: conclusion(s.conclusion),
    startedAt: s.started_at ?? null,
    completedAt: s.completed_at ?? null,
  }));
  const st = status(j.status);
  return {
    id: j.id,
    name: j.name,
    status: st,
    conclusion: conclusion(j.conclusion),
    startedAt: j.started_at ?? null,
    completedAt: j.completed_at ?? null,
    durationMs: span(j.started_at, st === "completed" ? j.completed_at : null, now),
    url: j.html_url ?? null,
    steps,
    failingStep: steps.find((s) => isCiFailure(s.conclusion))?.name ?? null,
  };
}

// ── Logs ────────────────────────────────────────────────────────────

const STAMP = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) ?(.*)$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the escape is what is removed.
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/**
 * A job's log cut by step: each line's time against the steps' start times
 * (GitHub gives those to the second), a `##[group]` line starting the next
 * step when several began in the same second. Steps in order, the failing
 * ones first; `q` marks the matching lines.
 */
export function cutLog(
  text: string,
  job: Pick<CiJob, "id" | "name" | "steps">,
  o: { q?: string; lines?: number } = {},
): CiLog {
  const truncated = text.length > LOG_BYTES;
  const body = truncated ? text.slice(text.length - LOG_BYTES) : text;
  const raw = body.split(/\r?\n/);
  if (truncated) raw.shift(); // a partial first line
  if (raw.at(-1) === "") raw.pop();
  const steps = [...job.steps].sort((a, b) => a.number - b.number);
  const startSec = steps.map((s) => Math.floor(ms(s.startedAt) / 1000));
  const sections = new Map<number, string[]>();
  let cur = -1; // before the first step
  for (const line of raw) {
    const m = STAMP.exec(line);
    const at = m ? Math.floor(ms(m[1]) / 1000) : Number.NaN;
    const text = (m ? (m[2] ?? "") : line).replace(ANSI, "");
    if (!Number.isNaN(at)) {
      // The last step started by then.
      let cand = cur;
      for (let i = cur + 1; i < steps.length; i++) {
        const s = startSec[i] as number;
        if (Number.isNaN(s)) continue;
        if (s <= at) cand = i;
        else break;
      }
      if (cand > cur) {
        // Steps that began earlier and printed nothing are passed; of those that began in
        // the same second, the first is entered, and each group line starts the next.
        let first = cand;
        while (first > 0 && startSec[first - 1] === startSec[cand]) first--;
        if (cur < first) cur = first;
        else if (text.startsWith("##[group]")) cur += 1;
      }
    }
    const number = cur < 0 ? 0 : (steps[cur]?.number ?? 0);
    let list = sections.get(number);
    if (!list) {
      list = [];
      sections.set(number, list);
    }
    list.push(text);
  }
  const keep = o.lines ?? LOG_LINES;
  const needle = o.q?.trim().toLowerCase() ?? "";
  let matchCount = 0;
  const out: CiLogSection[] = [];
  const add = (number: number, name: string, c: CiConclusion, all: string[]) => {
    const cut = Math.max(0, all.length - keep);
    const lines = cut ? all.slice(cut) : all;
    const matches = needle
      ? lines.flatMap((l, i) => (l.toLowerCase().includes(needle) ? [i] : []))
      : [];
    matchCount += matches.length;
    out.push({ number, name, conclusion: c, failing: isCiFailure(c), lines, cut, matches });
  };
  const before = sections.get(0);
  if (before?.length && !steps.some((s) => s.number === 0))
    add(0, "Before the steps", null, before);
  for (const s of steps) {
    const lines = sections.get(s.number) ?? [];
    if (lines.length || isCiFailure(s.conclusion)) add(s.number, s.name, s.conclusion, lines);
  }
  const sorted = [...out.filter((s) => s.failing), ...out.filter((s) => !s.failing)];
  return { jobId: job.id, jobName: job.name, sections: sorted, matchCount, truncated };
}

// ── Workflows run by hand ───────────────────────────────────────────

/** The inputs of `on.workflow_dispatch` in a workflow file; null when it can't be run by hand. */
export function dispatchInputs(yamlText: string): CiDispatchInput[] | null {
  let doc: unknown;
  try {
    doc = parseYaml(yamlText);
  } catch {
    return null;
  }
  const on = (doc as Record<string, unknown> | null)?.on ?? (doc as Record<string, unknown>)?.true;
  if (on === "workflow_dispatch") return [];
  if (Array.isArray(on)) return on.includes("workflow_dispatch") ? [] : null;
  if (!on || typeof on !== "object" || !("workflow_dispatch" in on)) return null;
  const wd = (on as Record<string, unknown>).workflow_dispatch as {
    inputs?: Record<string, Record<string, unknown>>;
  } | null;
  return Object.entries(wd?.inputs ?? {}).map(([name, i]) => {
    const t = String(i?.type ?? "string");
    return {
      name,
      description: String(i?.description ?? ""),
      required: i?.required === true,
      type: (["string", "boolean", "choice", "number", "environment"].includes(t)
        ? t
        : "string") as CiDispatchInput["type"],
      default: i?.default === undefined || i?.default === null ? null : String(i.default),
      options: Array.isArray(i?.options) ? i.options.map(String) : [],
    };
  });
}

/** The words for GitHub refusing a change to Actions: which permission to grant. */
const PERMISSION =
  "the token can't change Actions on this repository: give a fine-grained token Actions: Read and write (a classic token needs repo, and workflow to run one by hand), then paste it again in Settings → Connections → GitHub.";

/** The outcome of waiting for a branch's runs. */
export type CiWait =
  | { state: "passing"; sha: string; runs: CiRun[] }
  | {
      state: "failing";
      sha: string;
      runs: CiRun[];
      run: CiRun;
      job: CiJob | null;
      step: string | null;
      tail: string[];
    }
  | { state: "timeout"; sha: string | null; runs: CiRun[] }
  | { state: "none"; why: string };

export class Ci {
  /** Completed jobs' logs: they never change. */
  readonly #logs = new Map<string, string>();

  constructor(
    private readonly github: GitHub,
    private readonly now: () => number = Date.now,
  ) {}

  #path(r: CiRepo, rest: string) {
    return `/repos/${q(r.owner)}/${q(r.name)}${rest}`;
  }

  async #read<T>(r: CiRepo, rest: string, ttl: number) {
    try {
      return await this.github.read<T>(this.#path(r, rest), r.account, { ttl });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404)
        throw new GitHubError(
          `GitHub has no such thing in ${r.owner}/${r.name}, or ${r.account}'s token can't read its Actions (give it Actions: Read).`,
          404,
        );
      throw e;
    }
  }

  async #send(r: CiRepo, rest: string, body?: unknown) {
    try {
      return await this.github.send(
        this.#path(r, rest),
        { method: "POST", ...(body !== undefined ? { body } : {}) },
        r.account,
      );
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404) && !e.retryAt)
        throw new GitHubError(`GitHub refused: ${PERMISSION} (${e.message})`, e.status);
      throw e;
    }
  }

  /** A repository's runs, newest first, 20 a page; on a branch, of a workflow, when asked. */
  async runs(
    r: CiRepo,
    o: { branch?: string | null; workflowId?: number | null; page?: number; perPage?: number } = {},
  ): Promise<CiRunPage> {
    const page = o.page ?? 1;
    const per = o.perPage ?? 20;
    const params = new URLSearchParams({ per_page: String(per), page: String(page) });
    if (o.branch) params.set("branch", o.branch);
    const base = o.workflowId ? `/actions/workflows/${o.workflowId}/runs` : "/actions/runs";
    const res = await this.#read<{ total_count: number; workflow_runs: ApiRun[] }>(
      r,
      `${base}?${params}`,
      LIVE_TTL,
    );
    const now = this.now();
    return {
      items: res.data.workflow_runs.map((x) => runOf(x, now)),
      page,
      next: res.next || page * per < res.data.total_count,
      total: res.data.total_count,
      stale: res.stale,
      retryAt: res.retryAt,
    };
  }

  /** A run with its jobs and their steps. */
  async run(r: CiRepo, runId: number): Promise<CiRunDetail> {
    const one = await this.#read<ApiRun>(r, `/actions/runs/${runId}`, LIVE_TTL);
    const done = one.data.status === "completed";
    const jobs = await this.#read<{ jobs: ApiJob[] }>(
      r,
      `/actions/runs/${runId}/jobs?per_page=100&filter=latest`,
      done ? DONE_TTL : LIVE_TTL,
    );
    const now = this.now();
    return { ...runOf(one.data, now), jobs: jobs.data.jobs.map((j) => jobOf(j, now)) };
  }

  /** One job, as its run lists it. */
  async job(r: CiRepo, jobId: number): Promise<CiJob> {
    const res = await this.#read<ApiJob>(r, `/actions/jobs/${jobId}`, LIVE_TTL);
    return jobOf(res.data, this.now());
  }

  /** A job's log as GitHub gives it: plain text, a completed job's kept. */
  async rawLog(r: CiRepo, jobId: number, done: boolean): Promise<string> {
    const key = `${r.account}/${r.owner}/${r.name}/${jobId}`;
    const kept = this.#logs.get(key);
    if (kept !== undefined) return kept;
    const res = await this.github.raw(this.#path(r, `/actions/jobs/${jobId}/logs`), r.account);
    const text = await res.text();
    if (done) {
      if (this.#logs.size >= LOGS_KEPT) {
        const oldest = this.#logs.keys().next().value;
        if (oldest !== undefined) this.#logs.delete(oldest);
      }
      this.#logs.set(
        key,
        text.length > LOG_BYTES * 2 ? text.slice(text.length - LOG_BYTES * 2) : text,
      );
    }
    return text;
  }

  /** A job's log, by step, the failing step first; `q` marks the matching lines. */
  async log(r: CiRepo, jobId: number, o: { q?: string } = {}): Promise<CiLog> {
    const job = await this.job(r, jobId);
    const text = await this.rawLog(r, jobId, job.status === "completed");
    return cutLog(text, job, o);
  }

  /** The last lines of a job's failing step (or of its log). */
  async tail(r: CiRepo, job: CiJob, n = TAIL_LINES): Promise<string[]> {
    const log = cutLog(await this.rawLog(r, job.id, job.status === "completed"), job);
    const failing = log.sections.find((s) => s.failing) ?? log.sections.at(-1);
    return failing ? failing.lines.slice(-n) : [];
  }

  async artifacts(r: CiRepo, runId: number): Promise<CiArtifact[]> {
    const res = await this.#read<{
      artifacts: {
        id: number;
        name: string;
        size_in_bytes: number;
        expired: boolean;
        created_at?: string | null;
        expires_at?: string | null;
      }[];
    }>(r, `/actions/runs/${runId}/artifacts?per_page=100`, LIVE_TTL);
    return res.data.artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      sizeBytes: a.size_in_bytes,
      expired: a.expired,
      createdAt: a.created_at ?? null,
      expiresAt: a.expires_at ?? null,
    }));
  }

  /** An artifact's zip, streamed from GitHub (ADR-046's download link carries it). */
  async openArtifact(r: CiRepo, artifactId: number): Promise<Download> {
    const meta = await this.#read<{ name: string; size_in_bytes: number; expired: boolean }>(
      r,
      `/actions/artifacts/${artifactId}`,
      DONE_TTL,
    );
    if (meta.data.expired)
      throw new GitHubError(`The artifact ${meta.data.name} has expired on GitHub.`, 410);
    const res = await this.github.raw(
      this.#path(r, `/actions/artifacts/${artifactId}/zip`),
      r.account,
    );
    if (!res.body) throw new Error("GitHub sent no file.");
    return {
      stream: Readable.fromWeb(res.body as unknown as WebReadableStream<Uint8Array>),
      name: `${meta.data.name}.zip`,
      size: Number(res.headers.get("content-length")) || null,
    };
  }

  /** The repository's workflows, each with whether it runs by hand and its inputs. */
  async workflows(r: CiRepo): Promise<CiWorkflow[]> {
    const res = await this.#read<{
      workflows: { id: number; name: string; path: string; state: string }[];
    }>(r, "/actions/workflows?per_page=100", WORKFLOW_TTL);
    const out: CiWorkflow[] = [];
    for (const w of res.data.workflows) {
      let inputs: CiDispatchInput[] | null = null;
      if (w.path.startsWith(".github/workflows/") && w.state === "active") {
        try {
          const file = await this.#read<{ content?: string; encoding?: string }>(
            r,
            `/contents/${w.path.split("/").map(q).join("/")}`,
            WORKFLOW_TTL,
          );
          if (file.data.content)
            inputs = dispatchInputs(Buffer.from(file.data.content, "base64").toString("utf8"));
        } catch {
          inputs = null;
        }
      }
      out.push({
        id: w.id,
        name: w.name,
        path: w.path,
        state: w.state,
        dispatch: inputs !== null,
        inputs: inputs ?? [],
      });
    }
    return out;
  }

  // ── Changes: the caller decides who may make them (ADR-053) ─────

  /** Runs it again: every job, or only those that failed. */
  async rerun(r: CiRepo, runId: number, failedOnly: boolean): Promise<void> {
    await this.#send(r, `/actions/runs/${runId}/${failedOnly ? "rerun-failed-jobs" : "rerun"}`);
  }

  async cancel(r: CiRepo, runId: number): Promise<void> {
    await this.#send(r, `/actions/runs/${runId}/cancel`);
  }

  /** Runs a workflow by hand on a branch or tag, with its inputs. */
  async dispatch(
    r: CiRepo,
    workflowId: number,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    const wf = (await this.workflows(r)).find((w) => w.id === workflowId);
    if (!wf) throw new GitHubError(`${r.owner}/${r.name} has no workflow ${workflowId}.`, 404);
    if (!wf.dispatch)
      throw new GitHubError(
        `${wf.name} can't be run by hand: its file has no on: workflow_dispatch.`,
        422,
      );
    const missing = wf.inputs.filter(
      (i) => i.required && i.default === null && !inputs[i.name]?.trim(),
    );
    if (missing.length)
      throw new GitHubError(
        `${wf.name} needs ${missing.map((i) => i.name).join(", ")} to run.`,
        422,
      );
    const known = new Set(wf.inputs.map((i) => i.name));
    const unknown = Object.keys(inputs).filter((k) => !known.has(k));
    if (unknown.length)
      throw new GitHubError(`${wf.name} takes no input ${unknown.join(", ")}.`, 422);
    await this.#send(r, `/actions/workflows/${workflowId}/dispatches`, { ref, inputs });
  }

  // ── A branch at a glance, and waiting for it ────────────────────

  /** The runs of a branch's latest commit (or of `sha`), the newest of each. */
  async #latest(r: CiRepo, branch: string, sha?: string | null, ttl = LIVE_TTL) {
    const res = await this.#read<{ total_count: number; workflow_runs: ApiRun[] }>(
      r,
      `/actions/runs?branch=${q(branch)}&per_page=30`,
      ttl,
    );
    const now = this.now();
    const runs = res.data.workflow_runs.map((x) => runOf(x, now));
    const head = sha ?? runs[0]?.sha ?? null;
    return {
      sha: head,
      runs: head ? runs.filter((x) => x.sha === head) : [],
      stale: res.stale,
    };
  }

  /** passing, failing, running or none, for a branch's latest commit. */
  async badge(r: CiRepo, branch: string): Promise<CiBadge> {
    const fullName = `${r.owner}/${r.name}`;
    try {
      const { sha, runs } = await this.#latest(r, branch);
      if (!runs.length)
        return { state: "none", branch, fullName, sha, run: null, failing: null, error: null };
      const failed = runs.find((x) => x.status === "completed" && isCiFailure(x.conclusion));
      const running = runs.find((x) => x.status !== "completed");
      const run = failed ?? running ?? (runs[0] as CiRun);
      let failing: string | null = null;
      if (failed) {
        const detail = await this.run(r, failed.id).catch(() => null);
        const job = detail?.jobs.find((j) => isCiFailure(j.conclusion));
        failing = job ? `${job.name}${job.failingStep ? ` → ${job.failingStep}` : ""}` : null;
      }
      return {
        state: failed ? "failing" : running ? "running" : "passing",
        branch,
        fullName,
        sha,
        run,
        failing,
        error: null,
      };
    } catch (e) {
      return {
        state: "unknown",
        branch,
        fullName,
        sha: null,
        run: null,
        failing: null,
        error: (e as Error).message,
      };
    }
  }

  /**
   * Waits for a branch's runs of `sha` (its latest commit when null) to end:
   * passing when every one passed, failing at the first that failed (with its
   * failing step's last lines), timeout when they still run, none when the
   * repository has no workflows.
   */
  async waitFor(
    r: CiRepo,
    branch: string,
    o: {
      sha?: string | null;
      timeoutMs: number;
      pollMs?: number;
      signal?: AbortSignal;
      sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    },
  ): Promise<CiWait> {
    const wf = await this.#read<{ total_count: number }>(
      r,
      "/actions/workflows?per_page=1",
      WORKFLOW_TTL,
    );
    if (!wf.data.total_count)
      return {
        state: "none",
        why: `${r.owner}/${r.name} has no GitHub Actions workflows: nothing runs on a push.`,
      };
    const poll = o.pollMs ?? 15_000;
    const sleep = o.sleep ?? delay;
    const until = this.now() + o.timeoutMs;
    let last: { sha: string | null; runs: CiRun[] } = { sha: o.sha ?? null, runs: [] };
    for (;;) {
      if (o.signal?.aborted) throw new Error("Stopped.");
      last = await this.#latest(r, branch, o.sha, Math.min(LIVE_TTL, poll / 2));
      const failed = last.runs.find(
        (x) =>
          x.status === "completed" && (isCiFailure(x.conclusion) || x.conclusion === "cancelled"),
      );
      if (failed && last.sha) {
        const detail = await this.run(r, failed.id);
        const job = detail.jobs.find((j) => isCiFailure(j.conclusion)) ?? null;
        const tail = job ? await this.tail(r, job).catch(() => []) : [];
        return {
          state: "failing",
          sha: last.sha,
          runs: last.runs,
          run: failed,
          job,
          step: job?.failingStep ?? null,
          tail,
        };
      }
      if (last.sha && last.runs.length && last.runs.every((x) => x.status === "completed"))
        return { state: "passing", sha: last.sha, runs: last.runs };
      if (this.now() + poll > until) return { state: "timeout", ...last };
      await sleep(poll, o.signal);
    }
  }
}

const delay = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** One Ci per GitHub, for the checks that have only the GitHub. */
const shared = new WeakMap<GitHub, Ci>();
export function ciOf(github: GitHub): Ci {
  let ci = shared.get(github);
  if (!ci) {
    ci = new Ci(github);
    shared.set(github, ci);
  }
  return ci;
}
