import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEVICE_SIZES, type DeviceName, type Experience } from "@oraknid/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, type Db, openDatabase } from "../db/open.ts";
import { BrainFailed } from "../eye/brain.ts";
import { BASE_CRITERIA, type VisualVerdict } from "../eye/visual-judge.ts";
import { createVerifier } from "./verifier.ts";
import {
  chromiumRenderer,
  designPages,
  findChromium,
  parseVisualCheck,
  type Renderer,
  readShot,
  runVisualCheck,
  type VisionJudge,
  type VisualDeps,
  type VisualEvent,
  visionJudge,
} from "./visual.ts";

// The visual check (ADR-064 §5) with a stand-in renderer and judge: pass,
// fail with reasons, skipped without Chromium or a model that reads images.
// And once with the real headless Chromium, when this computer has one.

const EXPERIENCE: Experience = {
  feel: "A hardware synth.",
  layouts: [
    { device: "Phone (portrait)", layout: "Keyboard at the bottom." },
    { device: "Desktop", layout: "A panel of knobs." },
  ],
  controls: ["knobs"],
  references: [],
  criteria: ["On the phone, the keyboard spans the width.", "The sound designer uses knobs."],
};

function design(files: Record<string, string> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "oraknid-visual-"));
  mkdirSync(join(cwd, "design"));
  const all = {
    "index.html": "<!doctype html><title>Keys</title><h1>Keys</h1>",
    "player.phone.html": "<!doctype html><p>phone</p>",
    "player.desktop.html": "<!doctype html><p>desktop</p>",
    ...files,
  };
  for (const [name, content] of Object.entries(all))
    writeFileSync(join(cwd, "design", name), content);
  return cwd;
}

/** Writes a small PNG-like file per page and device, as a renderer would. */
const fakeRenderer = (
  o: { overflow?: (d: string) => boolean; seen?: unknown[] } = {},
): Renderer => ({
  async render(i) {
    o.seen?.push(i);
    const shots = i.pages.flatMap((p) =>
      p.devices.map((device) => {
        const base = p.name.replace(/\.html$/, "");
        const file = join(
          i.outDir,
          `${base}${base.endsWith(`.${device}`) ? "" : `.${device}`}.png`,
        );
        writeFileSync(file, `png:${p.name}:${device}`);
        return {
          device,
          page: p.name,
          file,
          ...DEVICE_SIZES[device],
          overflow: o.overflow?.(device) ?? false,
          errors: [],
        };
      }),
    );
    return { ok: true, shots };
  },
});

const judging = (decide: (criterion: string) => VisualVerdict, calls?: unknown[]): VisionJudge => ({
  async judge(i) {
    calls?.push(i);
    return { ok: true, model: "Claude A · opus", verdicts: i.criteria.map(decide) };
  },
});

function deps(o: Partial<VisualDeps> & { events?: VisualEvent[] } = {}): VisualDeps {
  return {
    renderer: o.renderer ?? fakeRenderer(),
    judge: o.judge ?? judging((criterion) => ({ criterion, pass: true, reason: "It shows it." })),
    experience: o.experience ?? (() => EXPERIENCE),
    publish: (_jobId, e) => o.events?.push(e),
  };
}

const TASK = { id: "T1", title: "Design the screens" };

describe("parseVisualCheck", () => {
  it("reads the target, devices, folder and address, and says what's wrong", () => {
    expect(parseVisualCheck("oraknid visual-check")).toEqual({
      target: "design",
      devices: null,
      dir: "design",
      url: null,
    });
    expect(
      parseVisualCheck(
        "oraknid visual-check --target app --devices phone,tablet --url=http://localhost:5173/",
      ),
    ).toEqual({
      target: "app",
      devices: ["phone", "tablet"],
      dir: "design",
      url: "http://localhost:5173/",
    });
    expect(parseVisualCheck("oraknid visual-check --devices phone,watch")).toEqual({
      error: expect.stringMatching(/^Unknown device watch/),
    });
    expect(parseVisualCheck("oraknid visual-check --target app")).toEqual({
      error: expect.stringMatching(/needs its address/),
    });
    expect(parseVisualCheck("oraknid visual-check --target app --url https://example.com")).toEqual(
      { error: expect.stringMatching(/not a localhost address/) },
    );
    expect(parseVisualCheck("oraknid github-repo")).toBeNull();
  });
});

describe("designPages", () => {
  it("renders the index at every device and a device's page at its own", () => {
    const cwd = design();
    const pages = designPages(cwd, "design", ["phone", "desktop"]);
    expect(Array.isArray(pages) && pages.map((p) => [p.name, p.devices])).toEqual([
      ["index.html", ["phone", "desktop"]],
      ["player.desktop.html", ["desktop"]],
      ["player.phone.html", ["phone"]],
    ]);
    expect(designPages(cwd, "../elsewhere", ["phone"])).toMatch(/inside the job's folder/);
    expect(designPages(cwd, "nothing", ["phone"])).toMatch(/There is no nothing\/ folder/);
  });
});

describe("the visual check (ADR-064 §5)", () => {
  it("passes when every experience criterion holds, screenshots in the task's folder, an event for the report", async () => {
    const cwd = design();
    const events: VisualEvent[] = [];
    const calls: { criteria: string[]; shots: { path: string; device: string }[] }[] = [];
    const r = await runVisualCheck("oraknid visual-check --target design", {
      deps: deps({
        events,
        judge: judging((criterion) => ({ criterion, pass: true, reason: "Seen." }), calls),
      }),
      jobId: "J1",
      cwd,
      task: TASK,
    });
    expect(r?.ok).toBe(true);
    // The experience's devices (phone and desktop), judged against its criteria.
    expect(calls[0]?.criteria).toEqual(EXPERIENCE.criteria);
    expect(calls[0]?.shots.map((s) => [s.device, s.path])).toEqual([
      ["phone", ".oraknid/visual/T1/index.phone.png"],
      ["desktop", ".oraknid/visual/T1/index.desktop.png"],
      ["desktop", ".oraknid/visual/T1/player.desktop.png"],
      ["phone", ".oraknid/visual/T1/player.phone.png"],
    ]);
    expect(r?.output).toMatch(/every criterion holds/);
    expect(r?.output).toContain(".oraknid/visual/T1/index.phone.png");
    expect(events).toEqual([
      expect.objectContaining({
        taskId: "T1",
        taskTitle: "Design the screens",
        target: "design",
        devices: ["phone", "desktop"],
        passed: true,
        skipped: null,
        model: "Claude A · opus",
      }),
    ]);
    expect(events[0]?.shots).toHaveLength(4);
    // The same pixels are not judged twice (a stop hook runs the checks every turn).
    const again = await runVisualCheck("oraknid visual-check --target design", {
      deps: deps({
        events,
        judge: judging(() => ({ criterion: "x", pass: false, reason: "x" }), calls),
      }),
      jobId: "J1",
      cwd,
      task: TASK,
    });
    expect(again?.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    // A screenshot reads back for the report, only from the visual folder.
    expect(readShot(cwd, ".oraknid/visual/T1/index.phone.png").dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
    expect(() => readShot(cwd, "design/index.html")).toThrow("Not a screenshot");
  });

  it("fails with a reason per criterion, and what it can see without a judge", async () => {
    const cwd = design({ "index.html": "<!doctype html><p>wide</p>" });
    const events: VisualEvent[] = [];
    const r = await runVisualCheck("oraknid visual-check --devices phone,desktop", {
      deps: deps({
        events,
        renderer: fakeRenderer({ overflow: (d) => d === "phone" }),
        judge: judging((criterion) =>
          criterion.includes("knobs")
            ? {
                criterion,
                pass: false,
                reason: "The sound designer is number fields and dropdowns.",
              }
            : { criterion, pass: true, reason: "The keyboard spans the width." },
        ),
      }),
      jobId: "J2",
      cwd,
      task: TASK,
    });
    expect(r?.ok).toBe(false);
    expect(r?.output).toMatch(/2 of 3 criteria failed/);
    expect(r?.output).toContain(
      "✗ The sound designer uses knobs. — The sound designer is number fields and dropdowns.",
    );
    expect(r?.output).toContain("✗ Nothing scrolls sideways at the device's width.");
    expect(r?.output).toContain("✓ On the phone, the keyboard spans the width.");
    expect(r?.signature).toMatch(/^visual:/);
    expect(events[0]).toMatchObject({ passed: false });
    expect(events[0]?.verdicts.filter((v) => !v.pass)).toHaveLength(2);
  });

  it("is skipped, not failed, without Chromium, and says why once", async () => {
    const cwd = design();
    const events: VisualEvent[] = [];
    const run = () =>
      runVisualCheck("oraknid visual-check", {
        deps: deps({ events, renderer: chromiumRenderer({ chromium: () => null }) }),
        jobId: "J3",
        cwd,
        task: TASK,
      });
    const r = await run();
    expect(r).toMatchObject({ ok: true, exitCode: 0 });
    expect(r?.output).toMatch(/^Visual check skipped: no Chromium on this computer/);
    await run();
    expect(events).toEqual([
      expect.objectContaining({ skipped: expect.stringMatching(/no Chromium/) }),
    ]);
  });

  it("is skipped, not failed, without a model that reads images", async () => {
    const cwd = design();
    const events: VisualEvent[] = [];
    const judge = visionJudge({
      brain: {
        judgeVisual: async () => {
          throw new BrainFailed("No Leg reads images: no Leg model has the vision capability.");
        },
      },
      local: { canSee: () => false, look: async () => ({ model: "", text: "" }) },
    });
    const r = await runVisualCheck("oraknid visual-check", {
      deps: deps({ events, judge }),
      jobId: "J4",
      cwd,
      task: TASK,
    });
    expect(r?.ok).toBe(true);
    expect(r?.output).toMatch(
      /^Visual check skipped: no model could look at the screenshots: No Leg reads images/,
    );
    expect(events[0]).toMatchObject({
      passed: true,
      skipped: expect.stringMatching(/No Leg reads images/),
    });
    // The screenshots are still in the report.
    expect(events[0]?.shots.length).toBeGreaterThan(0);
  });

  it("falls back to a local vision model when no Leg reads images", async () => {
    const cwd = design();
    const looked: string[][] = [];
    const judge = visionJudge({
      brain: {
        judgeVisual: async () => {
          throw new BrainFailed("No Leg reads images.");
        },
      },
      local: {
        canSee: () => true,
        look: async (prompt, files) => {
          looked.push(files);
          const criteria = [...prompt.matchAll(/^\d+\. (.+)$/gm)]
            .map((m) => m[1] as string)
            .filter((c) => EXPERIENCE.criteria.includes(c));
          return {
            model: "qwen2.5-vl (local)",
            text: `\`\`\`json\n${JSON.stringify({ verdicts: criteria.map((criterion) => ({ criterion, pass: true, reason: "ok" })) })}\n\`\`\``,
          };
        },
      },
    });
    const r = await runVisualCheck("oraknid visual-check", {
      deps: deps({ judge }),
      jobId: "J5",
      cwd,
      task: null,
    });
    expect(r?.ok).toBe(true);
    expect(r?.output).toMatch(/judged by qwen2.5-vl \(local\)/);
    // Without a task, the job's own folder.
    expect(looked[0]?.[0]).toContain(join(".oraknid", "visual", "job"));
  });

  it("judges against the base criteria when the spec has no experience section", async () => {
    const cwd = design();
    const calls: { criteria: string[] }[] = [];
    await runVisualCheck("oraknid visual-check --devices phone", {
      deps: deps({
        experience: () => null,
        judge: judging((criterion) => ({ criterion, pass: true, reason: "ok" }), calls),
      }),
      jobId: "J6",
      cwd,
      task: TASK,
    });
    expect(calls[0]?.criteria).toEqual(BASE_CRITERIA);
  });

  it("runs as a check through the Verifier, like Oraknid's other own checks", async () => {
    const db: Db = await openDatabase({ file: ":memory:" });
    try {
      const cwd = design();
      const events: VisualEvent[] = [];
      const verifier = createVerifier(
        { db, visual: deps({ events }) },
        { id: "J7" },
        {
          cwd,
          localCommit: () => null,
          plan: () => null,
          servers: () => [],
          refuse: () => null,
          signal: new AbortController().signal,
          task: TASK,
        },
      );
      const r = await verifier.run(["oraknid visual-check --devices desktop", "true"]);
      expect(r.passed).toBe(true);
      expect(r.results[0]?.output).toMatch(/Visual check of the design on desktop/);
      expect(events).toHaveLength(1);
      // Without a renderer and judge set up, it says so and is skipped.
      const bare = createVerifier(
        { db },
        { id: "J8" },
        {
          cwd,
          localCommit: () => null,
          plan: () => null,
          servers: () => [],
          refuse: () => null,
          signal: new AbortController().signal,
        },
      );
      const s = await bare.run(["oraknid visual-check"]);
      expect(s.results[0]).toMatchObject({ ok: true });
      expect(s.results[0]?.output).toMatch(/skipped/);
    } finally {
      closeDatabase(db);
    }
  });
});

describe.skipIf(!findChromium())("the visual check in a real headless Chromium", () => {
  afterEach(() => {});
  it("renders the design at each device's size and sees a page that scrolls sideways", async () => {
    const cwd = design({
      "index.html":
        '<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0"><div style="width:600px;height:50px;background:#c00">wide</div></body>',
    });
    const renderer = chromiumRenderer();
    const outDir = join(cwd, ".oraknid", "visual", "T9");
    mkdirSync(outDir, { recursive: true });
    const devices: DeviceName[] = ["phone", "desktop"];
    const r = await renderer.render({
      pages: [{ name: "index.html", url: `file://${join(cwd, "design", "index.html")}`, devices }],
      outDir,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.shots.map((s) => [s.device, s.width, s.height, s.overflow])).toEqual([
      ["phone", 390, 844, true],
      ["desktop", 1440, 900, false],
    ]);
  }, 60_000);
});
