import { type ChildProcess, spawn } from "node:child_process";
import type { Inhibitor, InhibitorState } from "../inhibitor.ts";

export interface SystemdInhibitOptions {
  command?: string;
  /** How long a holder must survive to count as holding the lock. */
  settleMs?: number;
  /** Wait before restarting a holder that died while the lock was wanted. */
  restartDelayMs?: number;
}

/**
 * Holds a logind inhibitor lock through a `systemd-inhibit … sleep infinity`
 * child (ADR-012). The child dies with its process group, so a crashed
 * daemon never leaves the machine unable to sleep.
 */
export function createSystemdInhibitor(options: SystemdInhibitOptions = {}): Inhibitor {
  const command = options.command ?? "systemd-inhibit";
  const settleMs = options.settleMs ?? 400;
  const restartDelayMs = options.restartDelayMs ?? 5000;

  let holder: ChildProcess | undefined;
  let wanted: string | null = null;
  let restartTimer: NodeJS.Timeout | undefined;
  let current: InhibitorState = { held: false, mode: null, why: null, problem: null };
  const listeners = new Set<(s: InhibitorState) => void>();

  const set = (next: InhibitorState) => {
    current = next;
    for (const l of listeners) l(next);
  };

  /** Starts a holder; resolves to it once it has survived `settleMs`, or to the reason it died. */
  function startHolder(why: string, mode: "block" | "delay") {
    const what = mode === "block" ? "sleep:idle" : "sleep";
    const child = spawn(
      command,
      [`--what=${what}`, "--who=Oraknid", `--why=${why}`, `--mode=${mode}`, "sleep", "infinity"],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += d;
    });
    return new Promise<{ child: ChildProcess } | { error: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ child }), settleMs);
      child.once("error", (e) => {
        clearTimeout(timer);
        resolve({ error: e.message });
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ error: stderr.trim() || `systemd-inhibit exited with code ${code}` });
      });
    });
  }

  async function hold(why: string): Promise<InhibitorState> {
    let result = await startHolder(why, "block");
    let mode: "block" | "delay" = "block";
    let problem: string | null = null;
    if ("error" in result) {
      const blockError = result.error;
      result = await startHolder(why, "delay");
      mode = "delay";
      problem = `A blocking sleep lock was refused (${blockError}); holding a delay lock instead.`;
      if ("error" in result) {
        set({
          held: false,
          mode: null,
          why,
          problem: `Could not keep the machine awake: ${result.error}`,
        });
        return current;
      }
    }

    const previous = holder;
    holder = result.child;
    // Release the old lock only after the new one is held: no gap.
    if (previous) stop(previous);

    const mine = holder;
    mine.once("exit", () => {
      if (holder !== mine) return;
      holder = undefined;
      if (wanted === null) return;
      set({ held: false, mode: null, why: wanted, problem: "The sleep lock was lost; retrying." });
      restartTimer = setTimeout(() => {
        if (wanted !== null) void hold(wanted);
      }, restartDelayMs);
    });

    set({ held: true, mode, why, problem });
    return current;
  }

  function stop(child: ChildProcess) {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
  }

  return {
    async acquire(why) {
      wanted = why;
      if (current.held && current.why === why) return current;
      return hold(why);
    },
    async release() {
      wanted = null;
      clearTimeout(restartTimer);
      if (holder) {
        const h = holder;
        holder = undefined;
        h.removeAllListeners("exit");
        await new Promise<void>((resolve) => {
          if (h.exitCode !== null || h.signalCode !== null) return resolve();
          h.once("exit", () => resolve());
          h.kill("SIGTERM");
        });
      }
      set({ held: false, mode: null, why: null, problem: null });
    },
    state: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
