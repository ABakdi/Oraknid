import type { JobState } from "@oraknid/contracts";
import { isTerminalJob } from "@oraknid/core";
import type { EventBus } from "../events/bus.ts";
import type { InboxStore } from "../inbox/store.ts";
import {
  AwaitingOwner,
  DID_NOT_HAPPEN,
  EffectDenied,
  type EffectSpec,
  HAPPENED,
  type SideEffects,
} from "./effects.ts";
import { faultPoint } from "./faults.ts";
import type { JobStore } from "./jobs.ts";
import { hashInput, NonDeterministicStep, type StepJournal } from "./journal.ts";

/** What a job's program can do. The Eye is a program (M1.6); tests write their own. */
export interface JobContext {
  readonly jobId: string;
  /** Aborted when I pause or cancel, or the daemon stops: reach a safe point. */
  readonly signal: AbortSignal;
  state(): JobState;
  setState(to: JobState, reason?: string): void;
  /**
   * Runs `fn` once per key for this job. After a crash, pause or restart, a
   * completed step returns its recorded output instead of running again.
   * Outputs must be JSON.
   */
  step<T>(key: string, input: unknown, fn: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /**
   * Performs an external action at most once (BR-6), after my approval
   * when gated (BR-5). `perform` gets the idempotency key to pass on.
   */
  effect<T>(
    spec: EffectSpec,
    perform: (idempotencyKey: string, signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}

export type JobProgram = (ctx: JobContext) => Promise<void>;

type Stop = "pause" | "cancel" | "shutdown";

class StopRequested extends Error {
  constructor(readonly stop: Stop) {
    super(`stop: ${stop}`);
  }
}

interface Run {
  controller: AbortController;
  stop: Stop | null;
  reason: string | null;
  done: Promise<void>;
}

export interface RunnerOptions {
  jobs: JobStore;
  journal: StepJournal;
  effects: SideEffects;
  inbox: InboxStore;
  bus: EventBus;
  program: JobProgram;
  /** BR-7: how long a Leg gets to reach a safe point before I'm told it is overdue. */
  safePointTimeoutMs?: number;
}

/**
 * Runs job programs durably (ADR-003): the journal makes them resumable,
 * the outbox keeps their side effects to at most once, and pause waits
 * for a safe point (BR-7).
 */
export class JobRunner {
  readonly #runs = new Map<string, Run>();
  /** Shutting down: no new run may start (Audit 1 → D1-08). */
  #closing = false;

  constructor(private readonly o: RunnerOptions) {}

  isRunning(jobId: string) {
    return this.#runs.has(jobId);
  }

  /** Starts (or, after recovery, restarts) a job's program. */
  start(jobId: string) {
    if (this.#closing) throw new Error("Oraknid is stopping; the job goes on at the next start.");
    if (this.#runs.has(jobId)) return;
    const job = this.o.jobs.require(jobId);
    if (isTerminalJob(job.state as JobState)) throw new Error("That job has already ended.");
    if (job.state === "paused" || job.state === "waiting") {
      throw new Error("That job is parked; resume it instead.");
    }
    const controller = new AbortController();
    const run: Run = { controller, stop: null, reason: null, done: Promise.resolve() };
    this.#runs.set(jobId, run);
    run.done = this.#loop(jobId, run).finally(() => this.#runs.delete(jobId));
  }

  /** Pauses at the next safe point. Resolves once the job is paused. */
  async pause(jobId: string, reason = "Paused by me.") {
    const run = this.#runs.get(jobId);
    if (!run) {
      const job = this.o.jobs.require(jobId);
      if (job.state !== "paused") this.o.jobs.transition(jobId, "paused", reason);
      return;
    }
    await this.#stop(jobId, run, "pause", reason);
  }

  async resume(jobId: string) {
    // A pause still reaching its safe point finishes first; then this resume applies (Audit 1 → Q1-09).
    const stopping = this.#runs.get(jobId);
    if (stopping?.stop === "pause") await stopping.done;
    const job = this.o.jobs.require(jobId);
    if (isTerminalJob(job.state as JobState)) throw new Error("That job has already ended.");
    if (job.state !== "paused" && job.state !== "waiting" && job.state !== "blocked") {
      if (!this.#runs.has(jobId)) this.start(jobId);
      return;
    }
    const to = (job.resumeState as JobState | null) ?? "running";
    this.o.jobs.transition(jobId, to, null);
    this.start(jobId);
  }

  async cancel(jobId: string, reason = "Cancelled by me.") {
    const run = this.#runs.get(jobId);
    if (run) await this.#stop(jobId, run, "cancel", reason);
    else this.o.jobs.transition(jobId, "cancelled", reason);
  }

  /** The daemon is stopping: every job reaches a safe point and keeps its state for next start. */
  async shutdown() {
    this.#closing = true;
    await Promise.all([...this.#runs].map(([id, run]) => this.#stop(id, run, "shutdown", null)));
  }

  async #stop(jobId: string, run: Run, stop: Stop, reason: string | null) {
    if (!run.stop) {
      run.stop = stop;
      run.reason = reason;
      if (stop !== "shutdown") {
        this.o.bus.publish({
          type: stop === "pause" ? "job.pausing" : "job.cancelling",
          topic: `job:${jobId}`,
          jobId,
          payload: { reason },
        });
      }
      run.controller.abort(new StopRequested(stop));
    }
    const overdue = setTimeout(() => {
      this.o.bus.publish({
        type: "job.safe-point-overdue",
        topic: `job:${jobId}`,
        jobId,
        payload: { waitedMs: this.o.safePointTimeoutMs ?? 120_000 },
      });
    }, this.o.safePointTimeoutMs ?? 120_000);
    try {
      await run.done;
    } finally {
      clearTimeout(overdue);
    }
  }

  async #loop(jobId: string, run: Run) {
    const ctx = this.#context(jobId, run);
    try {
      await this.o.program(ctx);
      const job = this.o.jobs.require(jobId);
      if (!isTerminalJob(job.state as JobState)) {
        throw new Error("The plan ended without finishing the job.");
      }
    } catch (error) {
      try {
        this.#settle(jobId, run, error);
      } catch (settleError) {
        // The failure could not be recorded as a state (e.g. a job still in draft):
        // never lose it silently (BR-17).
        const message = settleError instanceof Error ? settleError.message : String(settleError);
        this.o.bus.publish({
          type: "job.error",
          topic: `job:${jobId}`,
          jobId,
          payload: {
            message: `${error instanceof Error ? error.message : String(error)} (${message})`,
          },
        });
      }
    }
  }

  #settle(jobId: string, run: Run, error: unknown) {
    const { jobs, bus } = this.o;
    const state = jobs.require(jobId).state as JobState;
    if (run.stop) {
      // Whatever was in flight was cut short on purpose.
      if (run.stop === "pause" && state !== "paused") jobs.transition(jobId, "paused", run.reason);
      if (run.stop === "cancel") jobs.transition(jobId, "cancelled", run.reason);
      return;
    }
    if (error instanceof AwaitingOwner) {
      jobs.transition(jobId, "waiting", error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    bus.publish({ type: "job.error", topic: `job:${jobId}`, jobId, payload: { message } });
    if (!isTerminalJob(state)) jobs.transition(jobId, "blocked", message);
  }

  #context(jobId: string, run: Run): JobContext {
    const { jobs, journal, effects, inbox } = this.o;
    const checkStop = () => {
      if (run.stop) throw new StopRequested(run.stop);
    };

    return {
      jobId,
      signal: run.controller.signal,
      state: () => jobs.require(jobId).state as JobState,
      setState: (to, reason) => {
        checkStop();
        jobs.transition(jobId, to, reason ?? null);
      },

      async step<T>(key: string, input: unknown, fn: (signal: AbortSignal) => Promise<T>) {
        checkStop();
        faultPoint(`step:${key}:before`);
        const hash = hashInput(input);
        const done = journal.get(jobId, key);
        if (done?.status === "done") {
          if (done.inputHash !== hash) throw new NonDeterministicStep(jobId, key);
          return done.output as T;
        }
        journal.begin(jobId, key, hash);
        let output: T;
        try {
          output = await fn(run.controller.signal);
        } catch (error) {
          checkStop();
          journal.fail(jobId, key, error instanceof Error ? error.message : String(error));
          throw error;
        }
        faultPoint(`step:${key}:after-run`);
        journal.complete(jobId, key, output);
        faultPoint(`step:${key}:after-commit`);
        return output;
      },

      async effect<T>(
        spec: EffectSpec,
        perform: (idempotencyKey: string, signal: AbortSignal) => Promise<T>,
      ) {
        checkStop();
        let row = effects.intend(jobId, spec);
        faultPoint(`effect:${spec.key}:after-intend`);

        // My answer to an approval or a "did it happen?" question.
        if (row.inboxItemId) {
          const item = inbox.get(row.inboxItemId);
          if (item?.state === "answered") {
            if (row.state === "intended") {
              if (item.answer === "Approve") effects.approve(row.idempotencyKey);
              else effects.deny(row.idempotencyKey);
            } else if (row.state === "performing") {
              effects.resolve(row.idempotencyKey, item.answer === HAPPENED);
            }
            row = effects.get(row.idempotencyKey) ?? row;
          } else if (item?.state === "open") {
            throw new AwaitingOwner(row.inboxItemId, `Waiting for my answer: ${item.title}`);
          }
        }

        switch (row.state) {
          case "performed":
          case "confirmed":
            return row.result as T;
          case "denied":
            throw new EffectDenied(row.action);
          case "intended": {
            const id = effects.requestApproval(
              row,
              spec.describe ?? `${row.action} ${JSON.stringify(row.payload)}`,
              spec.title,
            );
            throw new AwaitingOwner(id, `Waiting for my approval: ${row.action}`);
          }
          case "performing": {
            // Caught mid-way by a crash or an interruption: check before anything else.
            if (!row.inboxItemId) row = await effects.reconcile(row);
            if (row.state === "performed") return row.result as T;
            if (row.state === "performing") {
              const id = effects.askWhetherItHappened(row);
              throw new AwaitingOwner(
                id,
                `Waiting for me to say whether "${row.action}" happened.`,
              );
            }
            break;
          }
          case "failed":
            throw new Error(row.problem ?? `"${row.action}" failed.`);
        }

        effects.set(row.idempotencyKey, "performing");
        faultPoint(`effect:${spec.key}:after-performing`);
        let result: T;
        try {
          result = await perform(row.idempotencyKey, run.controller.signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (run.stop) {
            // Interrupted on purpose: whether it happened must be checked, like after a crash.
            effects.set(row.idempotencyKey, "performing", {
              problem: `"${row.action}" was interrupted and may or may not have happened.`,
            });
            throw new StopRequested(run.stop);
          }
          effects.set(row.idempotencyKey, "failed", { problem: message });
          throw error;
        }
        faultPoint(`effect:${spec.key}:after-perform`);
        effects.set(row.idempotencyKey, "performed", { result: result ?? null, problem: null });
        faultPoint(`effect:${spec.key}:after-record`);
        return result;
      },
    };
  }
}

export { DID_NOT_HAPPEN, HAPPENED };
