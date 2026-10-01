import type { SilkEntry } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import {
  buildContextPack,
  current,
  estimateTokens,
  parseMirrorEdits,
  reconstructHandoff,
  renderMirror,
} from "./silk.ts";

let n = 0;
const entry = (over: Partial<SilkEntry>): SilkEntry => ({
  id: `01J9Z3K8W2Q4V6X8Y0A1B2C${String(n++).padStart(3, "0")}`,
  jobId: "J",
  taskId: null,
  kind: "decision",
  title: "t",
  body: "b",
  supersedes: null,
  covers: [],
  authoredBy: "eye",
  createdAt: n,
  ...over,
});

const task = {
  id: "T1",
  title: "Add login",
  instructions: "Build the login form.",
  scope: ["src/auth/**"],
  verify: ["pnpm test auth"],
};

describe("context pack", () => {
  it("drops what a summary covers from the current entries", () => {
    const a = entry({ id: "a" });
    const b = entry({ id: "b" });
    const sum = entry({ id: "s", covers: ["a", "b"] });
    expect(current([a, b, sum, entry({ id: "c" })]).map((e) => e.id)).toEqual(["s", "c"]);
  });

  it("puts the task first and follows the spec's order", () => {
    const pack = buildContextPack({
      task,
      goal: "A todo app",
      skill: "Canon first.",
      entries: [
        entry({ kind: "decision", title: "Use SQLite" }),
        entry({ kind: "handoff", taskId: "T1", title: "Handoff T1", body: "half done" }),
        entry({ kind: "handoff", taskId: "T2", title: "Handoff T2" }),
        entry({ kind: "issue", title: "Flaky", body: "src/auth/login.spec.ts flakes" }),
        entry({ kind: "issue", taskId: "T9", title: "Unrelated", body: "src/billing" }),
      ],
      digest: "src/auth/login.ts",
      capTokens: 10_000,
    });
    const order = [
      "# Your task",
      "# The job's goal",
      "# Decisions",
      "# Where the last session",
      "# Known issues",
      "# The files",
    ].map((h) => pack.text.indexOf(h));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > (order[k - 1] as number)))).toBe(true);
    expect(pack.text).toContain("half done");
    expect(pack.text).not.toContain("Handoff T2");
    expect(pack.text).toContain("Flaky");
    expect(pack.text).not.toContain("Unrelated");
    expect(pack.text).toContain("`pnpm test auth`");
  });

  it("leaves superseded entries out", () => {
    const old = entry({ title: "Use Postgres" });
    const pack = buildContextPack({
      task,
      goal: "g",
      skill: "",
      entries: [old, entry({ title: "Use SQLite", supersedes: old.id })],
      digest: "",
      capTokens: 10_000,
    });
    expect(pack.text).toContain("Use SQLite");
    expect(pack.text).not.toContain("Use Postgres");
  });

  it("fits the cap by shortening the oldest entries, keeping my words and the task whole", () => {
    const long = "x".repeat(4000);
    const mine = entry({ title: "My decision", body: "keep this", authoredBy: "owner" });
    const old = entry({ title: "Old", body: long, createdAt: 1 });
    const newer = entry({ title: "Newer", body: long, createdAt: 2 });
    const pack = buildContextPack({
      task,
      goal: "g",
      skill: "",
      entries: [old, newer, mine],
      digest: "",
      capTokens: 1300,
    });
    expect(pack.tokens).toBeLessThanOrEqual(1300);
    expect(pack.text).toContain("keep this");
    expect(pack.text).toContain("Build the login form.");
    expect(pack.shortened).toContain(old.id);
    expect(pack.text).toContain("## Old (shortened)");
  });

  it("trims the digest last", () => {
    const pack = buildContextPack({
      task,
      goal: "g",
      skill: "",
      entries: [],
      digest: "d".repeat(8000),
      capTokens: 600,
    });
    expect(pack.text).toContain("digest trimmed to fit");
    expect(estimateTokens(pack.text)).toBeLessThanOrEqual(600);
  });
});

describe("mirror", () => {
  it("renders one file per kind and the latest handoff per task, with markers", () => {
    const d = entry({ kind: "decision", title: "Use SQLite", body: "WAL." });
    const files = renderMirror("Todo app", [
      d,
      entry({ kind: "handoff", taskId: "T1", title: "First", createdAt: 1 }),
      entry({ kind: "handoff", taskId: "T1", title: "Latest", createdAt: 9 }),
    ]);
    expect(files["decisions.md"]).toContain(`## Use SQLite\n<!-- silk:${d.id} by:eye -->\n\nWAL.`);
    expect(files["handoffs/T1.md"]).toContain("Latest");
    expect(files["handoffs/T1.md"]).not.toContain("First");
    expect(files["README.md"]).toContain("Silk — Todo app");
  });

  it("finds my hand edits: changed sections supersede, new sections are added", () => {
    const d = entry({ kind: "decision", title: "Use SQLite", body: "WAL." });
    const same = entry({ kind: "decision", title: "Keep", body: "unchanged" });
    const text = `${renderMirror("j", [d, same])["decisions.md"]?.replace("WAL.", "WAL, synchronous=FULL.")}\n## Also\nUse pnpm.\n`;
    expect(parseMirrorEdits("decisions.md", text, [d, same])).toEqual([
      { supersedes: d.id, kind: "decision", title: "Use SQLite", body: "WAL, synchronous=FULL." },
      { supersedes: null, kind: "decision", title: "Also", body: "Use pnpm." },
    ]);
  });

  it("ignores files that are not Silk files", () => {
    expect(parseMirrorEdits("README.md", "## x\ny", [])).toEqual([]);
  });

  it("keeps the latest version of each entry", () => {
    const a = entry({});
    const b = entry({ supersedes: a.id });
    expect(current([a, b]).map((e) => e.id)).toEqual([b.id]);
  });
});

describe("rebuilt handoff", () => {
  it("has the handoff's headings, the diff, the failed commands as traps, and says it was rebuilt", () => {
    const h = reconstructHandoff({
      goal: "Add login",
      diffStat: " src/auth/login.ts | 40 ++++",
      commands: [
        { command: "pnpm test auth", ok: false },
        { command: "pnpm lint", ok: true },
      ],
      lastText: "Tests still fail on the redirect.",
      verifyOutput: "FAIL login redirects",
    });
    for (const heading of [
      "Goal of the task",
      "Done so far",
      "Current state",
      "Next steps",
      "Open questions",
      "Traps",
    ]) {
      expect(h).toContain(`## ${heading}`);
    }
    expect(h).toContain("src/auth/login.ts | 40");
    expect(h).toMatch(/## Traps\n\n- `pnpm test auth` failed/);
    expect(h).toContain("Rebuilt by Oraknid");
  });
});
