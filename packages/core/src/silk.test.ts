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
  it("takes earlier jobs' standing Silk after the job's own, and cuts it first (ADR-034)", () => {
    const earlier = [
      entry({ jobId: "E", kind: "decision", title: "Use Web Audio", authoredBy: "owner" }),
      entry({
        jobId: "E",
        kind: "architecture",
        title: "Synth in src/synth",
        body: "x".repeat(800),
      }),
      entry({ jobId: "E", kind: "fact", title: "Use SQLite", body: "an older word" }),
      entry({ jobId: "E", kind: "later", title: "Some day, MIDI" }),
      entry({ jobId: "E", kind: "progress", title: "T1 done" }),
    ];
    const own = [entry({ kind: "decision", title: "Use SQLite", authoredBy: "owner" })];
    const big = buildContextPack({
      task,
      goal: "g",
      skill: "",
      entries: own,
      earlier,
      digest: "",
      capTokens: 10_000,
    });
    expect(big.text).toContain("# From earlier jobs in this project");
    expect(big.text).toContain("## Use Web Audio");
    expect(big.text).toContain("## Synth in src/synth");
    // Notes for later and progress stay with their job; the job's own word wins over an earlier one.
    expect(big.text).not.toContain("MIDI");
    expect(big.text).not.toContain("T1 done");
    expect(big.text).not.toContain("an older word");
    expect(big.text.indexOf("# Decisions and architecture")).toBeLessThan(
      big.text.indexOf("# From earlier jobs in this project"),
    );
    // Short of room, an earlier job's entries are cut to their titles, even mine; the job's own stay.
    const small = buildContextPack({
      task,
      goal: "g",
      skill: "",
      entries: own,
      earlier,
      digest: "",
      capTokens: estimateTokens(big.text) - 150,
    });
    expect(small.text).toContain("## Synth in src/synth (shortened)");
    expect(small.text).toContain("## Use SQLite\nb");
    // Only the job's own entries are offered for a summary.
    expect(small.shortened.every((id) => own.some((e) => e.id === id))).toBe(true);
  });

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

  it("names Oraknid's own GitHub checks as its own, not the Leg's to run (after the piano job)", () => {
    const pack = buildContextPack({
      task: { ...task, verify: ["pnpm test auth", "oraknid github-branch dev"] },
      goal: "A todo app",
      skill: "",
      entries: [],
      digest: "",
      capTokens: 10_000,
    });
    expect(pack.text).toContain("- `pnpm test auth`\n");
    expect(pack.text).toContain(
      "- `oraknid github-branch dev` — Oraknid's own check of GitHub, run after you finish; there is no `oraknid` command for you, so don't run it",
    );
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

  it("reads back what it wrote, every kind and every file, headings in bodies included (ADR-072 §4)", () => {
    // A small seeded generator: the same cases every run.
    let seed = 72;
    const rand = (k: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % k;
    };
    const pieces = [
      "## Uncertain after a restart",
      "These actions started and their result was never seen.",
      "- edit `src/app.ts`",
      "# A top heading",
      "### A small one",
      "##not a heading",
      "",
      "```\n## inside a fence\n```",
      "<!-- a comment -->",
      "<!-- silk:01J9Z3K8W2Q4V6X8Y0A1B2CZZZ by:eye -->",
      "## Fake\n<!-- silk:01J9Z3K8W2Q4V6X8Y0A1B2CYYY by:eye -->",
      "trailing   ",
      "Ünïcödé — and a long dash",
    ];
    const kinds = [
      "decision",
      "architecture",
      "progress",
      "issue",
      "fact",
      "interview-answer",
      "later",
      "handoff",
    ] as const;
    const authors = ["eye", "owner", { legId: "L1" }] as const;
    for (let round = 0; round < 200; round++) {
      const entries: SilkEntry[] = [];
      for (let i = 0; i < 1 + rand(12); i++) {
        const body = Array.from({ length: rand(6) }, () => pieces[rand(pieces.length)]).join("\n");
        const live = current(entries);
        const prev = live.length && rand(4) === 0 ? live[rand(live.length)] : undefined;
        const kind = prev?.kind ?? (kinds[rand(kinds.length)] as SilkEntry["kind"]);
        entries.push(
          entry({
            kind,
            taskId: prev ? prev.taskId : kind === "handoff" ? `T${rand(3)}` : null,
            title: `${["Use SQLite", "Uncertain after a restart: Build it", "## odd", "Title"][rand(4)]} ${round}.${i}`,
            body,
            authoredBy: authors[rand(3)] as SilkEntry["authoredBy"],
            supersedes: prev?.id ?? null,
          }),
        );
      }
      const files = renderMirror("Round", entries);
      for (const [file, text] of Object.entries(files))
        expect(parseMirrorEdits(file, text, entries), `${file}, round ${round}`).toEqual([]);
    }
  });

  it("puts back together an entry a mirror written before ADR-072 cut at a heading in its body", () => {
    const e = entry({
      kind: "issue",
      title: "Uncertain after a restart: Construct the main routing",
      body: "## Uncertain after a restart\nThese actions started and their result was never seen.\n- edit `src/app.ts`",
    });
    // As the mirror was written before: no end marker.
    const old = `# Issues\n\n## ${e.title}\n<!-- silk:${e.id} by:eye -->\n\n${e.body}\n`;
    expect(parseMirrorEdits("issues.md", old, [e])).toEqual([]);
    // A section I added after it is still mine, and new.
    expect(parseMirrorEdits("issues.md", `${old}\n## Mine\nA real one.\n`, [e])).toEqual([
      { supersedes: null, kind: "issue", title: "Mine", body: "A real one." },
    ]);
  });

  it("is no edit when a section says what an entry of Oraknid's says, current or superseded (ADR-072 §3)", () => {
    const a = entry({ kind: "progress", title: "Step 1", body: "Started." });
    const b = entry({ kind: "progress", title: "Step 1", body: "Done.", supersedes: a.id });
    // An older mirror, put back by git: a's version.
    const older = renderMirror("j", [a])["progress.md"] as string;
    expect(parseMirrorEdits("progress.md", older, [a, b])).toEqual([]);
    // A section changed back to what Oraknid wrote before: no edit either.
    const changedBack = (renderMirror("j", [a, b])["progress.md"] as string).replace(
      "Done.",
      "Started.",
    );
    expect(parseMirrorEdits("progress.md", changedBack, [a, b])).toEqual([]);
    // My own entries are not Oraknid's: going back to the version I superseded is an edit.
    const mine = entry({ kind: "progress", title: "Mine", body: "v1", authoredBy: "owner" });
    const mine2 = entry({
      kind: "progress",
      title: "Mine",
      body: "v2",
      authoredBy: "owner",
      supersedes: mine.id,
    });
    const back = (renderMirror("j", [mine, mine2])["progress.md"] as string).replace("v2", "v1");
    expect(parseMirrorEdits("progress.md", back, [mine, mine2])).toEqual([
      { supersedes: mine2.id, kind: "progress", title: "Mine", body: "v1" },
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
  it("lists the last commands only, each on one line (2026-10-08: a 1.5 MB handoff)", () => {
    const h = reconstructHandoff({
      goal: "Scaffold",
      diffStat: "",
      commands: Array.from({ length: 3000 }, (_, i) => ({
        command: i === 2999 ? `cat > big.ts <<'EOF'\n${"x".repeat(50_000)}\nEOF` : `pnpm test ${i}`,
        ok: i % 2 === 0,
      })),
      lastText: "",
      verifyOutput: null,
    });
    expect(h).toContain(`Commands run (the last 40 of 3000)`);
    expect(h).toContain("pnpm test 2998");
    expect(h).not.toContain("pnpm test 10\n");
    expect(h).toContain("cat > big.ts <<'EOF'…");
    expect(h.length).toBeLessThan(5000);
  });

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
