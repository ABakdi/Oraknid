import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legContract, readUntil } from "@oraknid/leg-sdk/contract";
import { createBwrapSandbox } from "@oraknid/os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOpenCodeAdapter } from "./adapter.ts";
import { type FakeMode, startFakeModel } from "./fake-model.ts";

// OpenCode really runs; only the model is a stand-in (ADR-015).
const HAVE = spawnSync("opencode", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!HAVE)("the OpenCode adapter against the real binary", () => {
  let fake: Awaited<ReturnType<typeof startFakeModel>>;
  const home = mkdtempSync(join(tmpdir(), "oraknid-opencode-home-"));
  beforeAll(async () => {
    fake = await startFakeModel();
  });
  afterAll(() => fake.close());

  it("runs inside the sandbox, and its edits land in the worktree", async () => {
    const sandbox = createBwrapSandbox();
    if (!sandbox.status().available) return;
    fake.setMode("tool");
    const cwd = mkdtempSync(join(tmpdir(), "oraknid-opencode-boxed-"));
    const legHome = mkdtempSync(join(tmpdir(), "oraknid-opencode-leghome-"));
    const s = await createOpenCodeAdapter().start({
      leg: {
        id: "leg2",
        name: "Boxed",
        kind: "opencode",
        config: { providerID: "fake", baseURL: fake.url, models: ["fake-model"] },
      },
      model: "fake-model",
      effort: null,
      cwd,
      systemPrompt: "",
      prompt: "Write a file.",
      resumeFrom: null,
      sandbox: {
        sandbox,
        home: legHome,
        writable: [],
        readonly: [],
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      },
      credential: "k",
      onPermission: async () => ({ allow: true }),
    });
    const events = await readUntil(s, (e) => e.type === "turn.ended", 30_000);
    expect(events.at(-1)).toMatchObject({ reason: "completed" });
    expect(spawnSync("cat", [join(cwd, "out.txt")], { encoding: "utf8" }).stdout).toBe("hello\n");
    await s.kill();
  }, 60_000);

  legContract("opencode", () => ({
    supportsResume: true,
    start: async (script, overrides) => {
      fake.setMode(script as FakeMode);
      const cwd = mkdtempSync(join(tmpdir(), "oraknid-opencode-work-"));
      return createOpenCodeAdapter().start({
        leg: {
          id: "leg1",
          name: "OpenCode test",
          kind: "opencode",
          config: { providerID: "fake", baseURL: fake.url, models: ["fake-model"], home },
        },
        model: "fake-model",
        effort: null,
        cwd,
        systemPrompt: "You are testing.",
        prompt: "Say hello.",
        resumeFrom: null,
        sandbox: null,
        credential: "test-key",
        onPermission: async () => ({ allow: true }),
        ...overrides,
      });
    },
  }));
});
