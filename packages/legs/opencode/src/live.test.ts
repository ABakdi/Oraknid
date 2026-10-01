import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readUntil } from "@oraknid/leg-sdk/contract";
import { describe, expect, it } from "vitest";
import { createOpenCodeAdapter } from "./adapter.ts";

// A real run on OpenCode's free models: no account, no key. Only with ORAKNID_LIVE=1
// (it calls OpenCode Zen over the network).
const LIVE =
  process.env.ORAKNID_LIVE === "1" &&
  spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!LIVE)("OpenCode on its free models, for real", () => {
  it("lists the free models and writes a file with one of them", async () => {
    const adapter = createOpenCodeAdapter();
    const leg = { id: "live", name: "OpenCode — free", kind: "opencode" as const, config: {} };
    const probe = await adapter.probe(leg, null);
    expect(probe.ok, probe.detail).toBe(true);
    const model =
      probe.models.find((m) => m.model === "big-pickle")?.model ?? probe.models[0]?.model;
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-oc-live-"));
    const s = await adapter.start({
      leg: { ...leg, config: { home: mkdtempSync(join(tmpdir(), "oraknid-oc-live-home-")) } },
      model: model as string,
      effort: null,
      cwd,
      systemPrompt: "You are a coding agent working in the current folder.",
      prompt: "Create a file named hi.txt containing exactly the word hi. Then say DONE.",
      resumeFrom: null,
      sandbox: null,
      credential: null,
      onPermission: async () => ({ allow: true }),
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 180_000);
    expect(events.at(-1)).toMatchObject({ type: "turn.ended", reason: "completed" });
    expect(readFileSync(join(cwd, "hi.txt"), "utf8").trim()).toBe("hi");
    await s.kill();
  }, 240_000);
});
