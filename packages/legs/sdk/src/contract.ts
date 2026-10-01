import { describe, expect, it } from "vitest";
import type {
  LegEvent,
  LegSession,
  PermissionDecision,
  PermissionRequest,
  SessionStart,
} from "./types.ts";

/**
 * How a contract backend should behave for one session:
 * - reply: every turn answers with text and reports usage
 * - slow: the first turn keeps streaming until interrupted
 * - tool: the first turn asks to run a shell command, then answers
 * - rate-limit: the first turn hits a usage limit
 */
export type Script = "reply" | "slow" | "tool" | "rate-limit";

export interface ContractHarness {
  /** Starts a session against a backend following `script`. */
  start(script: Script, overrides?: Partial<SessionStart>): Promise<LegSession>;
  supportsResume: boolean;
}

/** Reads events until `until` matches one; returns everything read. */
export async function readUntil(
  session: LegSession,
  until: (e: LegEvent) => boolean,
  ms = 5000,
): Promise<LegEvent[]> {
  const seen: LegEvent[] = [];
  const it = iterators.get(session) ?? session.events()[Symbol.asyncIterator]();
  iterators.set(session, it);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      it.next(),
      new Promise<"timeout">((r) =>
        setTimeout(() => r("timeout"), Math.max(1, deadline - Date.now())),
      ),
    ]);
    if (next === "timeout") break;
    if (next.done) return seen;
    seen.push(next.value);
    if (until(next.value)) return seen;
  }
  throw new Error(`timed out; saw ${JSON.stringify(seen.map((e) => e.type))}`);
}

const iterators = new WeakMap<LegSession, AsyncIterator<LegEvent>>();

const turnEnded = (e: LegEvent) => e.type === "turn.ended";

export const permissionRecorder = (decision: PermissionDecision) => {
  const asked: PermissionRequest[] = [];
  return {
    asked,
    onPermission: async (r: PermissionRequest) => {
      asked.push(r);
      return decision;
    },
  };
};

/** Every adapter passes this suite (Leg-Adapters: contract test kit). */
export function legContract(name: string, harness: () => ContractHarness) {
  describe(`${name} — Leg contract`, () => {
    it("answers a turn with text, usage and a completed end", async () => {
      const s = await harness().start("reply");
      const events = await readUntil(s, turnEnded);
      expect(events[0]?.type).toBe("turn.started");
      expect(events.some((e) => e.type === "text.delta")).toBe(true);
      const end = events.at(-1);
      expect(end).toMatchObject({ type: "turn.ended", reason: "completed", error: null });
      expect(s.usage().outputTokens).toBeGreaterThan(0);
      await s.kill();
    });

    it("takes a follow-up turn in the same session", async () => {
      const s = await harness().start("reply");
      await readUntil(s, turnEnded);
      await s.send("and again");
      const second = await readUntil(s, turnEnded);
      expect(second.at(-1)).toMatchObject({ type: "turn.ended", reason: "completed" });
      await s.kill();
    });

    it("ends a turn at a safe point when interrupted", async () => {
      const s = await harness().start("slow");
      await readUntil(s, (e) => e.type === "text.delta");
      await s.interrupt();
      const rest = await readUntil(s, turnEnded);
      expect(rest.at(-1)).toMatchObject({ type: "turn.ended", reason: "interrupted" });
      await s.kill();
    });

    it("asks before running a command, and runs it when allowed", async () => {
      const rec = permissionRecorder({ allow: true });
      const s = await harness().start("tool", { onPermission: rec.onPermission });
      const events = await readUntil(s, turnEnded);
      expect(rec.asked).toHaveLength(1);
      expect(rec.asked[0]?.command).toContain("echo");
      expect(events.find((e) => e.type === "tool.result")).toMatchObject({ ok: true });
      await s.kill();
    });

    it("does not run a command that was denied, and tells the Leg why", async () => {
      const rec = permissionRecorder({ allow: false, message: "Not on the allow list." });
      const s = await harness().start("tool", { onPermission: rec.onPermission });
      const events = await readUntil(s, turnEnded);
      const result = events.find((e) => e.type === "tool.result");
      expect(result).toMatchObject({ ok: false });
      expect((result as { output: string }).output).toContain("Not on the allow list.");
      await s.kill();
    });

    it("reports a usage limit with its window and reset time", async () => {
      const s = await harness().start("rate-limit");
      const events = await readUntil(s, turnEnded);
      const limit = events.find((e) => e.type === "rate_limit");
      expect(limit).toMatchObject({ type: "rate_limit", quota: { status: "rejected" } });
      expect(events.at(-1)).toMatchObject({ type: "turn.ended", reason: "rate-limited" });
      await s.kill();
    });

    it("ends its event stream when killed", async () => {
      const s = await harness().start("slow");
      await readUntil(s, (e) => e.type === "text.delta");
      await s.kill();
      const rest = await readUntil(s, (e) => e.type === "session.ended");
      expect(rest.at(-1)).toMatchObject({ type: "session.ended", reason: "killed" });
    });

    it("resumes a native session when it supports resume", async () => {
      const h = harness();
      if (!h.supportsResume) return;
      const s = await h.start("reply");
      await readUntil(s, turnEnded);
      const native = s.nativeSessionId();
      expect(native).toBeTruthy();
      await s.kill();
      const again = await h.start("reply", { resumeFrom: native });
      await readUntil(again, turnEnded);
      expect(again.nativeSessionId()).toBe(native);
      await again.kill();
    });
  });
}
