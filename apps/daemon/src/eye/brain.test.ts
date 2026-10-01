import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import { type Action, scriptedLeg } from "../testing/scripted-leg.ts";
import { PoolLegBrain } from "./brain.ts";

let daemon: Daemon | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const task = (key: string, deps: string[] = []) => ({
  key,
  title: key,
  instructions: "x",
  kind: "implement",
  dependsOn: deps,
  scope: ["a"],
  verify: ["true"],
  requiredCapabilities: ["implementation"],
  difficulty: "low",
});
const answer = (tasks: unknown[]) =>
  `\`\`\`json\n${JSON.stringify({ summary: "s", tasks, jobVerify: [] })}\n\`\`\``;

async function brainWith(replies: string[]) {
  const sent: string[] = [];
  const leg = scriptedLeg((t): Action[] => {
    sent.push(t.message);
    return [{ say: replies[t.turn - 1] ?? "" }];
  });
  const dir = mkdtempSync(join(tmpdir(), "oraknid-brain-"));
  daemon = await startDaemon({
    paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
    port: 0,
    dbFile: ":memory:",
    os: fakeOs({ keychain: true }).os,
    adapters: { "claude-code": leg.adapter },
  });
  await daemon.registry.create({
    kind: "claude-code",
    name: "Claude",
    config: { binary: "claude" },
  });
  await daemon.health.checkAll();
  const brain = new PoolLegBrain({
    registry: daemon.registry,
    supervisor: daemon.supervisor,
    pinnedModelId: () => null,
  });
  const input = {
    jobId: "01J9Z3K8W2Q4V6X8Y0A1B2C3D4",
    cwd: dir,
    goal: "g",
    skill: "",
    silk: "",
    digest: "",
    verify: [],
  };
  return { brain, input, sent };
}

describe("The Eye's brain", () => {
  it("returns a valid plan from a borrowed Leg, on the strongest model for planning", async () => {
    const { brain, input, sent } = await brainWith([answer([task("t1")])]);
    const plan = await brain.plan(input);
    expect(plan.tasks.map((t) => t.key)).toEqual(["t1"]);
    expect(sent[0]).toMatch(/^Plan this job as a graph of tasks/);
  });

  it("tells the Leg exactly what was wrong with its plan, and accepts the corrected one", async () => {
    const { brain, input, sent } = await brainWith([
      answer([task("a", ["b"]), task("b", ["a"])]),
      answer([task("a"), task("b", ["a"])]),
    ]);
    const plan = await brain.plan(input);
    expect(plan.tasks.map((t) => t.dependsOn)).toEqual([[], ["a"]]);
    expect(sent[1]).toMatch(
      /That answer was not valid: The tasks depend on each other in a circle: a → b → a/,
    );
  });

  it("gives up after a second bad answer, saying why", async () => {
    const { brain, input } = await brainWith(["not json", "still not"]);
    await expect(brain.plan(input)).rejects.toThrow(
      "The Eye's reasoning gave no valid answer twice (plan): it was not JSON.",
    );
  });
});
