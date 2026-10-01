import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PolicyVerdict } from "@oraknid/core";
import type { SandboxPlan } from "@oraknid/leg-sdk";

export interface VerifyResult {
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** The end of the output, where failures are. */
  output: string;
  /** A fingerprint of the failure, stable across runs, for D3 (same failure again). */
  signature: string | null;
  ms: number;
}

const TAIL = 8000;

/**
 * Runs verify commands itself (BR-1): a Leg's word that work is done
 * counts for nothing. Each runs in the job's sandbox, without the Leg's
 * home (Sandboxing), one after another, stopping at the first failure.
 */
export async function runVerify(
  commands: string[],
  cwd: string,
  plan: SandboxPlan | null,
  o: {
    timeoutMs?: number;
    signal?: AbortSignal;
    /** The command policy (Audit 1 → S1-03): a refused command is a failed check, never run. */
    refuse?: (command: string) => string | null;
  } = {},
): Promise<VerifyResult[]> {
  const results: VerifyResult[] = [];
  for (const command of commands) {
    const refused = o.refuse?.(command);
    if (refused) {
      results.push({
        command,
        ok: false,
        exitCode: null,
        output: `Oraknid did not run this check: ${refused}.`,
        signature: signatureOf(command, refused),
        ms: 0,
      });
      break;
    }
    const r = await runOne(command, cwd, plan, o);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

function runOne(
  command: string,
  cwd: string,
  plan: SandboxPlan | null,
  o: { timeoutMs?: number; signal?: AbortSignal },
): Promise<VerifyResult> {
  const started = Date.now();
  // Without the Leg's home (Sandboxing): a throwaway one, gone after the check.
  const home = plan ? mkdtempSync(join(tmpdir(), "oraknid-check-")) : null;
  const wrapped =
    plan && home
      ? plan.sandbox.wrap({
          command: "/bin/sh",
          args: ["-c", command],
          cwd,
          writable: [cwd, home],
          readonly: plan.readonly,
          home,
          env: { ...plan.env, CI: "1" },
        })
      : { command: "/bin/sh", args: ["-c", command] };
  return new Promise((resolve) => {
    const child = spawn(wrapped.command, wrapped.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: o.timeoutMs ?? 10 * 60_000,
      killSignal: "SIGKILL",
      ...(o.signal ? { signal: o.signal } : {}),
    });
    let out = "";
    const add = (d: Buffer) => {
      out = (out + d.toString()).slice(-TAIL * 4);
    };
    child.stdout.on("data", add);
    child.stderr.on("data", add);
    const finish = (exitCode: number | null, extra = "") => {
      if (home) rmSync(home, { recursive: true, force: true });
      const output = `${out}${extra}`.slice(-TAIL);
      const ok = exitCode === 0;
      resolve({
        command,
        ok,
        exitCode,
        output,
        signature: ok ? null : signatureOf(command, output),
        ms: Date.now() - started,
      });
    };
    child.on("error", (e) => finish(null, `\n${e.message}`));
    child.on("close", (code, signal) => finish(code, signal ? `\n[killed: ${signal}]` : ""));
  });
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** The failure's shape without what changes run to run: numbers, times, paths of temp dirs, hex ids. */
export function signatureOf(command: string, output: string): string {
  const lines = output
    .split("\n")
    .filter((l) => /error|fail|assert|expected|exception|✗|×/i.test(l))
    .slice(-12)
    .map((l) =>
      l
        .replace(ANSI, "")
        .replace(/\/tmp\/[^\s:]+/g, "<tmp>")
        .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
        .replace(/\d+(\.\d+)?/g, "<n>")
        .trim(),
    );
  return createHash("sha256")
    .update(`${command}\n${lines.join("\n")}`)
    .digest("hex")
    .slice(0, 16);
}

/** What the policy says about a check: refused when never allowed, or gated (it would need me). */
export function verifyRefusal(v: PolicyVerdict): string | null {
  if (v.verdict === "deny") return v.reason;
  if (v.verdict === "ask" && v.gated) return `${v.reason}; a check never does that`;
  return null;
}
