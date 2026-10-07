import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PermissionRequest } from "@oraknid/leg-sdk";
import { readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "./adapter.ts";

// Opt-in: ORAKNID_LIVE_CLAUDE=1 runs the real binary, inside bubblewrap,
// with the account logged into ~/.claude. The probe sends no message; the
// session uses Haiku and a couple of short turns.
const live = process.env.ORAKNID_LIVE_CLAUDE === "1";

describe.runIf(live)("Claude Code, for real (sandboxed)", () => {
  // A skipped describe's body still runs when tests are collected: no binary is looked up then.
  const binary = live ? realpathSync(join(homedir(), ".local/bin/claude")) : "claude";
  const configDir = join(homedir(), ".claude");
  const leg = {
    id: "live",
    name: "live",
    kind: "claude-code" as const,
    config: { binary, configDir },
  };

  function plan() {
    const root = mkdtempSync(join(tmpdir(), "oraknid-live-"));
    const home = join(root, "home");
    const work = join(root, "work");
    mkdirSync(home);
    mkdirSync(work);
    return {
      work,
      plan: {
        sandbox: createBwrapSandbox(),
        home,
        writable: [work, configDir],
        readonly: [dirname(binary)],
        env: { PATH: "/usr/bin", LANG: "C.UTF-8" },
      },
    };
  }

  it("probes the account and its models without spending tokens", async () => {
    const p = await createClaudeCodeAdapter().probe(leg, plan().plan);
    expect(p.ok, p.detail).toBe(true);
    expect(p.models.length).toBeGreaterThan(0);
    console.log(p.detail, p.models.map((m) => `${m.model}[${m.effortLevels.join(",")}]`).join(" "));
  }, 60_000);

  it("runs a turn in the sandbox and asks before running a command", async () => {
    const { work, plan: sandbox } = plan();
    const asked: PermissionRequest[] = [];
    const s = await createClaudeCodeAdapter().start({
      leg,
      model: "haiku",
      effort: null,
      cwd: work,
      systemPrompt: "You are being tested. Be brief.",
      prompt:
        "Run exactly this shell command with the Bash tool, then reply DONE: echo sandboxed > proof.txt",
      resumeFrom: null,
      sandbox,
      credential: null,
      onPermission: async (r) => {
        asked.push(r);
        return { allow: true };
      },
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 120_000);
    console.log(
      events
        .filter((e) => e.type !== "text.delta")
        .map((e) => JSON.stringify(e).slice(0, 160))
        .join("\n"),
    );
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", reason: "completed" });
    expect(asked.some((r) => r.command?.includes("proof.txt"))).toBe(true);
    expect(
      existsSync(join(work, "proof.txt")) && readFileSync(join(work, "proof.txt"), "utf8"),
    ).toBe("sandboxed\n");
    expect(s.usage().outputTokens).toBeGreaterThan(0);
    expect(s.nativeSessionId()).toBeTruthy();
    expect(s.pid()).toBeGreaterThan(0);
    await s.kill();
  }, 180_000);
});
