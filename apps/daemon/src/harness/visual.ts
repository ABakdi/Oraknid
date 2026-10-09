import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEVICE_SIZES,
  DeviceName,
  type Experience,
  experienceDevices,
  experienceMarkdown,
} from "@oraknid/contracts";
import { BrainFailed, BrainStopped, type EyeBrain, parseJson } from "../eye/brain.ts";
import type { VerifyResult } from "../eye/verify.ts";
import {
  BASE_CRITERIA,
  type ShotForJudge,
  type VisualJudgeInput,
  type VisualVerdict,
  VisualVerdicts,
  verdictProblems,
  visualPrompt,
} from "../eye/visual-judge.ts";

// The visual check (ADR-064 §5), a check Oraknid answers itself like
// `oraknid github-…` (ADR-056 §4):
//
//   oraknid visual-check [--target design|app] [--devices phone,tablet,desktop]
//                        [--dir design] [--url http://localhost:5173/]
//
// Headless Chromium renders the design's pages (from files) or the running
// app (a local address only) at each device's size; the screenshots go to
// the job's folder, .oraknid/visual/<task>/; a vision-capable model judges
// them against the spec's experience criteria, pass or fail with a reason
// each. No Chromium, or no model that reads images: skipped, said why, and
// not a failure. The screenshots and verdicts are an event, which the
// task's report shows.

export const VISUAL_CHECK = /^oraknid\s+visual-check((?:\s+\S+)*)\s*$/;

export interface VisualCheck {
  target: "design" | "app";
  /** The devices named, or null: the experience's, else phone and desktop. */
  devices: DeviceName[] | null;
  dir: string;
  url: string | null;
}

/** The check's parts, or why it can't run as written; null: not a visual check. */
export function parseVisualCheck(command: string): VisualCheck | { error: string } | null {
  const m = VISUAL_CHECK.exec(command.trim());
  if (!m) return null;
  const words = (m[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const out: VisualCheck = { target: "design", devices: null, dir: "design", url: null };
  const value = (i: number, name: string): [string, number] => {
    const w = words[i] as string;
    if (w.includes("=")) return [w.slice(w.indexOf("=") + 1), i];
    const next = words[i + 1];
    if (next === undefined) throw new Error(`--${name} needs a value.`);
    return [next, i + 1];
  };
  try {
    for (let i = 0; i < words.length; i++) {
      const w = words[i] as string;
      const flag = w.replace(/^--/, "").split("=")[0];
      if (!w.startsWith("--"))
        return { error: `Unknown word "${w}": use --target, --devices, --dir or --url.` };
      let v: string;
      [v, i] = value(i, flag ?? "");
      if (flag === "target") {
        if (v !== "design" && v !== "app") return { error: "--target is design or app." };
        out.target = v;
      } else if (flag === "devices") {
        const names = v.split(",").filter(Boolean);
        const bad = names.filter((n) => !DeviceName.safeParse(n).success);
        if (bad.length)
          return {
            error: `Unknown device ${bad.join(", ")}: use ${DeviceName.options.join(", ")}.`,
          };
        out.devices = names as DeviceName[];
      } else if (flag === "dir") out.dir = v;
      else if (flag === "url") out.url = v;
      else return { error: `Unknown option --${flag}: use --target, --devices, --dir or --url.` };
    }
  } catch (error) {
    return { error: (error as Error).message };
  }
  if (out.target === "app" && !out.url)
    return { error: "The running app needs its address: --url http://localhost:<port>/." };
  if (out.url && !isLocalUrl(out.url))
    return {
      error: `Only the job's own app on this computer is looked at: ${out.url} is not a localhost address.`,
    };
  return out;
}

const isLocalUrl = (u: string) => {
  try {
    const url = new URL(u);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
};

/** One screenshot taken. */
export interface Shot extends ShotForJudge {
  /** Absolute. */
  file: string;
}

export interface RenderInput {
  pages: { name: string; url: string; devices: DeviceName[] }[];
  outDir: string;
  signal?: AbortSignal;
}

/** Takes the screenshots, or says why it can't (no Chromium): then the check is skipped. */
export interface Renderer {
  render(
    i: RenderInput,
  ): Promise<{ ok: true; shots: Omit<Shot, "path">[] } | { ok: false; skipped: string }>;
}

/** Judges the screenshots, or says why it can't (no model reads images): then the check is skipped. */
export interface VisionJudge {
  judge(
    i: VisualJudgeInput & { files: string[] },
  ): Promise<
    { ok: true; model: string; verdicts: VisualVerdict[] } | { ok: false; skipped: string }
  >;
}

export interface VisualDeps {
  renderer: Renderer;
  judge: VisionJudge;
  /** The job's experience section, as stored at the interview. */
  experience: (jobId: string) => Experience | null;
  /** The event the task's report shows. */
  publish?: (jobId: string, payload: VisualEvent) => void;
}

/** What the visual check found, as its event carries it. */
export interface VisualEvent {
  taskId: string | null;
  taskTitle: string | null;
  target: "design" | "app";
  devices: DeviceName[];
  /** Relative to the job's folder. */
  shots: { device: string; page: string; path: string }[];
  verdicts: VisualVerdict[];
  passed: boolean;
  skipped: string | null;
  model: string | null;
}

/** At most this many screenshots a check: the judge reads every one. */
const MAX_SHOTS = 12;

/** Verdicts by what was seen: the same pixels and criteria are not judged twice (a stop hook runs checks every turn). */
const judged = new Map<string, { model: string; verdicts: VisualVerdict[] }>();
/** Why a job's visual check was skipped, said already. */
const skipSaid = new Set<string>();

export async function runVisualCheck(
  command: string,
  o: {
    deps: VisualDeps;
    jobId: string;
    cwd: string;
    task: { id: string; title: string } | null;
    signal?: AbortSignal;
  },
): Promise<VerifyResult | null> {
  const parsed = parseVisualCheck(command);
  if (!parsed) return null;
  const started = Date.now();
  const done = (ok: boolean, output: string, signature?: string): VerifyResult => ({
    command,
    ok,
    exitCode: ok ? 0 : 1,
    output,
    signature: ok ? null : (signature ?? `visual:${output.slice(0, 80)}`),
    ms: Date.now() - started,
  });
  if ("error" in parsed) return done(false, parsed.error, "visual:usage");
  const experience = o.deps.experience(o.jobId);
  const devices = parsed.devices ?? experienceDevices(experience);
  const folder = o.task ? o.task.id : "job";
  const outDir = join(o.cwd, ".oraknid", "visual", folder);
  const event = (e: Omit<VisualEvent, "taskId" | "taskTitle" | "target" | "devices">) => {
    // Skipped, it is said once a job and reason, not on every run of the checks.
    if (e.skipped && !e.verdicts.some((v) => !v.pass)) {
      const said = `${o.jobId}:${e.skipped}`;
      if (skipSaid.has(said)) return;
      skipSaid.add(said);
      if (skipSaid.size > 500) skipSaid.delete(skipSaid.values().next().value as string);
    }
    o.deps.publish?.(o.jobId, {
      taskId: o.task?.id ?? null,
      taskTitle: o.task?.title ?? null,
      target: parsed.target,
      devices,
      ...e,
    });
  };

  // What to render: the design's pages from files, or the app at its address.
  let pages: RenderInput["pages"];
  if (parsed.target === "app") pages = [{ name: "app", url: parsed.url as string, devices }];
  else {
    const found = designPages(o.cwd, parsed.dir, devices);
    if (typeof found === "string") return done(false, found, "visual:no-design");
    pages = found;
  }

  mkdirSync(outDir, { recursive: true });
  const rendered = await o.deps.renderer.render({
    pages,
    outDir,
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!rendered.ok) {
    const why = `Visual check skipped: ${rendered.skipped}`;
    event({ shots: [], verdicts: [], passed: true, skipped: rendered.skipped, model: null });
    return done(true, why);
  }
  const shots: Shot[] = rendered.shots.map((s) => ({ ...s, path: relative(o.cwd, s.file) }));
  if (!shots.length) return done(false, "Nothing was rendered: no page at the devices asked.");
  const listed = shots.map((s) => `- ${s.device}, ${s.page}: ${s.path}`).join("\n");

  // What can't be missed by looking: a page that didn't load, or one that scrolls sideways.
  const automatic: VisualVerdict[] = [];
  const broken = shots.filter((s) => s.errors.some((e) => e.startsWith("load:")));
  if (broken.length)
    automatic.push({
      criterion: "Every page loads.",
      pass: false,
      reason: broken.map((s) => `${s.page} on ${s.device}: ${s.errors[0]}`).join("; "),
    });
  const wide = shots.filter((s) => s.overflow);
  if (wide.length)
    automatic.push({
      criterion: "Nothing scrolls sideways at the device's width.",
      pass: false,
      reason: `Wider than the screen: ${wide.map((s) => `${s.page} on ${s.device}`).join(", ")}.`,
    });

  const criteria = experience?.criteria.length ? experience.criteria : BASE_CRITERIA;
  const key = createHash("sha256")
    .update(o.jobId)
    .update(JSON.stringify(criteria))
    .update(
      shots
        .map((s) => {
          try {
            return createHash("sha256").update(readFileSync(s.file)).digest("hex");
          } catch {
            return s.path;
          }
        })
        .join(","),
    )
    .digest("hex");
  let verdict = judged.get(key) ?? null;
  if (!verdict) {
    const r = await o.deps.judge.judge({
      jobId: o.jobId,
      cwd: o.cwd,
      target: parsed.target === "app" ? "the running app" : "the design",
      criteria,
      experience: experience ? experienceMarkdown(experience) : "",
      shots: shots.map(({ file: _f, ...s }) => s),
      files: shots.map((s) => s.file),
    });
    if (!r.ok) {
      const passed = automatic.length === 0;
      if (!passed && !skipSaid.has(key)) skipSaid.add(key);
      else if (!passed)
        return done(
          false,
          `Visual check failed again: ${automatic.map((v) => `${v.criterion} ${v.reason}`).join(" ")}\nScreenshots:\n${listed}`,
          "visual:automatic",
        );
      event({
        shots: shots.map((s) => ({ device: s.device, page: s.page, path: s.path })),
        verdicts: automatic,
        passed,
        skipped: r.skipped,
        model: null,
      });
      return done(
        passed,
        `${passed ? "Visual check skipped" : "Visual check failed"}: ${
          passed ? r.skipped : automatic.map((v) => `${v.criterion} ${v.reason}`).join(" ")
        }${passed ? "" : ` (and not judged: ${r.skipped})`}\nScreenshots:\n${listed}`,
        "visual:automatic",
      );
    }
    verdict = { model: r.model, verdicts: r.verdicts };
    judged.set(key, verdict);
    if (judged.size > 200) judged.delete(judged.keys().next().value as string);
    const all = [...automatic, ...verdict.verdicts];
    event({
      shots: shots.map((s) => ({ device: s.device, page: s.page, path: s.path })),
      verdicts: all,
      passed: all.every((v) => v.pass),
      skipped: null,
      model: r.model,
    });
  }
  const all = [...automatic, ...verdict.verdicts];
  const failed = all.filter((v) => !v.pass);
  const lines = all.map((v) => `${v.pass ? "✓" : "✗"} ${v.criterion} — ${v.reason}`).join("\n");
  return done(
    failed.length === 0,
    `Visual check of ${parsed.target === "app" ? "the running app" : "the design"} on ${devices.join(", ")}, judged by ${verdict.model}: ${
      failed.length ? `${failed.length} of ${all.length} criteria failed` : "every criterion holds"
    }.\n${lines}\nScreenshots:\n${listed}`,
    `visual:${failed
      .map((v) => v.criterion)
      .join("|")
      .slice(0, 200)}`,
  );
}

/**
 * The design's pages to render: `index.html` at every device, a page named
 * for a device (`player.phone.html`) at that device only, any other page at
 * every device; at most MAX_SHOTS screenshots, index first.
 */
export function designPages(
  cwd: string,
  dir: string,
  devices: DeviceName[],
): RenderInput["pages"] | string {
  const root = resolve(cwd, dir);
  if (root !== resolve(cwd) && !root.startsWith(resolve(cwd) + sep))
    return `--dir must be inside the job's folder, not ${dir}.`;
  if (!existsSync(root) || !statSync(root).isDirectory())
    return `There is no ${dir}/ folder: the design task makes it (design/index.html, a page per screen and device).`;
  const files = readdirSync(root)
    .filter((f) => f.endsWith(".html"))
    .sort((a, b) => (a === "index.html" ? -1 : b === "index.html" ? 1 : a.localeCompare(b)));
  if (!files.length) return `${dir}/ has no HTML page.`;
  const pages: RenderInput["pages"] = [];
  let count = 0;
  for (const f of files) {
    const named = DeviceName.options.find((d) => f.endsWith(`.${d}.html`));
    const at = named ? devices.filter((d) => d === named) : devices;
    if (!at.length) continue;
    const take = at.slice(0, Math.max(0, MAX_SHOTS - count));
    if (!take.length) break;
    pages.push({ name: f, url: pathToFileURL(join(root, f)).href, devices: take });
    count += take.length;
  }
  return pages.length ? pages : `No page of ${dir}/ is for ${devices.join(", ")}.`;
}

// ── The real renderer and judges ──────────────────────────────────────

/** A Chromium on this computer: mine, the system's, or none. */
export function findChromium(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates = [
    env.ORAKNID_CHROMIUM,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((x): x is string => !!x);
  return candidates.find((c) => existsSync(c)) ?? null;
}

type PlaywrightCore = typeof import("playwright-core");

/**
 * Headless Chromium through playwright-core, as scripts/ui-perf.mjs drives
 * it: each page at each device's viewport, a screenshot of what the screen
 * shows, whether it scrolls sideways, and the errors it threw.
 */
export function chromiumRenderer(
  o: { chromium?: () => string | null; load?: () => Promise<PlaywrightCore> } = {},
): Renderer {
  return {
    async render(i) {
      const executable = (o.chromium ?? findChromium)();
      if (!executable)
        return {
          ok: false,
          skipped:
            "no Chromium on this computer (install chromium, or set ORAKNID_CHROMIUM to a Chrome or Chromium).",
        };
      let pw: PlaywrightCore;
      try {
        // Loaded when first needed (a dependency, kept out of the bundle): missing, it skips.
        pw = await (o.load ?? (() => import("playwright-core")))();
      } catch {
        return { ok: false, skipped: "playwright-core isn't installed with Oraknid." };
      }
      let browser: Awaited<ReturnType<PlaywrightCore["chromium"]["launch"]>>;
      try {
        browser = await pw.chromium.launch({ executablePath: executable, headless: true });
      } catch (error) {
        return {
          ok: false,
          skipped: `Chromium (${executable}) didn't start: ${(error as Error).message.split("\n")[0]}`,
        };
      }
      const shots: Omit<Shot, "path">[] = [];
      try {
        for (const page of i.pages) {
          for (const device of page.devices) {
            if (i.signal?.aborted) break;
            const size = DEVICE_SIZES[device];
            const touch = device.startsWith("phone") || device.startsWith("tablet");
            const context = await browser.newContext({
              viewport: size,
              deviceScaleFactor: 1,
              isMobile: touch,
              hasTouch: touch,
            });
            const p = await context.newPage();
            const errors: string[] = [];
            p.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 300)));
            try {
              await p.goto(page.url, { waitUntil: "load", timeout: 20_000 });
              await p.waitForTimeout(300);
            } catch (error) {
              errors.unshift(`load: ${(error as Error).message.split("\n")[0]}`);
            }
            const overflow = await p
              // In the page: wider than the screen, it scrolls sideways.
              .evaluate<boolean>(
                "document.documentElement.scrollWidth > document.documentElement.clientWidth + 1",
              )
              .catch(() => false);
            const base = page.name.replace(/\.html$/, "").replace(/[^\w.-]+/g, "-");
            const file = join(
              i.outDir,
              `${base}${base.endsWith(`.${device}`) ? "" : `.${device}`}.png`,
            );
            await p.screenshot({ path: file, fullPage: false }).catch(() => {});
            await context.close();
            if (existsSync(file))
              shots.push({ device, page: page.name, file, ...size, overflow, errors });
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
      return { ok: true, shots };
    },
  };
}

/**
 * The judge: a Leg whose model reads images (capability "vision"), else a
 * local vision model with the OCR role; neither, the check is skipped.
 */
export function visionJudge(o: {
  brain?: Pick<EyeBrain, "judgeVisual">;
  local?: {
    canSee(): boolean;
    look(prompt: string, files: string[]): Promise<{ model: string; text: string }>;
  };
}): VisionJudge {
  return {
    async judge(i) {
      const why: string[] = [];
      if (o.brain?.judgeVisual) {
        try {
          const r = await o.brain.judgeVisual(i);
          return { ok: true, model: r.model, verdicts: r.verdicts };
        } catch (error) {
          if (error instanceof BrainStopped) throw error;
          why.push(error instanceof Error ? error.message : String(error));
          if (!(error instanceof BrainFailed)) return { ok: false, skipped: why.join(" ") };
        }
      }
      if (o.local?.canSee()) {
        try {
          const prompt = `${visualPrompt(i, true)}\n\nReply with a single \`\`\`json block: {"verdicts": [{"criterion": "...", "pass": true, "reason": "..."}]}`;
          const r = await o.local.look(prompt, i.files);
          const parsed = parseJson(r.text, VisualVerdicts);
          if (parsed.ok && !verdictProblems(i.criteria, parsed.value).length)
            return { ok: true, model: r.model, verdicts: parsed.value.verdicts };
          why.push(
            `the local vision model's answer wasn't usable (${parsed.ok ? "a criterion missing" : parsed.error})`,
          );
        } catch (error) {
          why.push(`the local vision model failed: ${(error as Error).message}`);
        }
      }
      return {
        ok: false,
        skipped: why.length
          ? `no model could look at the screenshots: ${why.join("; ")}`
          : "no model that reads images: give a Leg model the vision capability, or a local vision model the OCR role.",
      };
    },
  };
}

/** A screenshot of a job's visual check, as a data URL, for its report (only from its own folder). */
export function readShot(worktree: string | null, path: string): { dataUrl: string } {
  if (!worktree) throw new Error("This job has no folder.");
  if (!/^\.oraknid\/visual\/[\w-]+\/[\w.-]+\.png$/.test(path) || path.includes(".."))
    throw new Error("Not a screenshot of a visual check.");
  const file = join(worktree, path);
  if (!existsSync(file)) throw new Error("That screenshot is gone.");
  return { dataUrl: `data:image/png;base64,${readFileSync(file).toString("base64")}` };
}
