import { spawnSync } from "node:child_process";
import type { InstallStep } from "../service.ts";

export type Run = (
  cmd: string,
  args: string[],
) => { status: number | null; stdout: string; stderr: string };

/** Runs a command and waits; sudo asks for its password on the terminal itself. */
export const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["inherit", "pipe", "pipe"],
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? r.error?.message ?? "" };
};

/** One install step from one command: ok on exit 0, otherwise what it said. */
export function stepper(run: Run) {
  return (name: string, cmd: string, args: string[]): InstallStep => {
    const r = run(cmd, args);
    return {
      step: name,
      ok: r.status === 0,
      detail: r.status === 0 ? "done" : (r.stderr || r.stdout).trim() || `exit ${r.status}`,
    };
  };
}

/** A word for sh: left alone when plain, single-quoted otherwise. */
export function shQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The prefix that runs a command as root: nothing for root, sudo otherwise. */
export function rootPrefix(uid = process.getuid?.() ?? 0): string[] {
  return uid === 0 ? [] : ["sudo"];
}

/** Like stepper, but each command runs as root (through sudo when I am not root). */
export function rootStepper(run: Run, sudo: string[]) {
  const step = stepper(run);
  return (name: string, cmd: string, args: string[]): InstallStep => {
    const [first, ...rest] = sudo;
    return first ? step(name, first, [...rest, cmd, ...args]) : step(name, cmd, args);
  };
}
