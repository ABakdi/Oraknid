#!/usr/bin/env node
/**
 * The review page (ADR-064, M16.1) in headless Chromium, at 1440 and 390
 * pixels wide: against apps/daemon/scripts/review-daemon.ts (its own data
 * folder and port, a design and a stand-in app under review). It checks
 * that the frame loads on the review's own origin with the overlay, that
 * select → composer → save makes a note with its selector and picture,
 * that its pin is drawn in the frame, that the page doesn't scroll
 * sideways, and that the app's console error and failed request are
 * captured; and that a design made of a page per device, with no
 * index.html, shows the page that fits each device as the device changes
 * (Laptop, Desktop, Phone landscape, Phone), never the desktop page hidden
 * at a phone's size, and that the Screen picker opens another. Prints one
 * line per check; exits 1 if any failed.
 *
 *   pnpm --filter @oraknid/web exec vite build   # the UI the daemon serves
 *   node scripts/review-check.mjs [--port 7518] [--shots dir] [--chromium /path]
 *
 * Never uses 7417 or the owner's data folder.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = Number(arg("port", "7518"));
const shots = arg("shots", "");
if (port === 7417) throw new Error("7417 is the owner's own Oraknid.");
if (shots) mkdirSync(shots, { recursive: true });

const daemon = spawn(
  "pnpm",
  [
    "--filter",
    "@oraknid/daemon",
    "exec",
    "tsx",
    "scripts/review-daemon.ts",
    "--port",
    String(port),
  ],
  { cwd: root, stdio: ["ignore", "pipe", "inherit"] },
);
const info = await new Promise((resolve, reject) => {
  let buf = "";
  daemon.stdout.on("data", (d) => {
    buf += d;
    const line = buf.split("\n").find((l) => l.startsWith("{"));
    if (line) resolve(JSON.parse(line));
  });
  daemon.on("exit", (code) => reject(new Error(`the daemon stopped (${code})`)));
});
process.on("exit", () => daemon.kill("SIGTERM"));

/** The middle of an element of the frame, on the page: the frame is scaled to fit its stage. */
async function whereInFrame(page, selector) {
  const el = await page.locator('iframe[title="What is reviewed"]').elementHandle();
  const outer = await el.evaluate((f) => {
    const r = f.getBoundingClientRect();
    return { x: r.left, y: r.top, scale: r.width / f.offsetWidth };
  });
  const inner = await (await el.contentFrame()).evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, selector);
  return { x: outer.x + inner.x * outer.scale, y: outer.y + inner.y * outer.scale };
}

const executablePath =
  arg("chromium", "") || (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
const browser = await chromium.launch({ executablePath });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

for (const [width, height] of [
  [1440, 900],
  [390, 844],
]) {
  const tag = `${width}px`;
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(
    ({ token, session }) => {
      localStorage.setItem("oraknid.token", token);
      sessionStorage.setItem("oraknid.unlock", session);
    },
    { token: info.token, session: info.session },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${info.url}/review/${info.design}`);
  await page.getByText("The design").first().waitFor({ timeout: 15_000 });
  const frameEl = page.locator('iframe[title="What is reviewed"]');
  await frameEl.waitFor();
  const src = await frameEl.getAttribute("src");
  check(
    `${tag}: the frame is on the review's own origin`,
    /^http:\/\/rv-[0-9a-f]{32}\.localhost:\d+\/$/.test(src ?? ""),
    src ?? "",
  );
  const frame = page.frameLocator('iframe[title="What is reviewed"]');
  await frame.locator("#play").waitFor({ timeout: 15_000 });
  check(`${tag}: the design is in the frame`, true);
  const overlay = await frameEl
    .elementHandle()
    .then((h) => h.contentFrame())
    .then((f) => f.evaluate(() => !!window.__oraknidOverlay));
  check(`${tag}: the overlay runs in it`, overlay);
  const sideways = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(`${tag}: the page doesn't scroll sideways`, sideways <= 0, `${sideways}px`);
  if (shots) await page.screenshot({ path: join(shots, `review-${width}.png`) });

  // Select → composer → save.
  await page.getByRole("button", { name: /Select/ }).click();
  // A real pointer at the button where it is drawn (the frame is scaled to fit: Playwright's
  // own click checks miss it under a CSS transform).
  const at = await whereInFrame(page, "#play");
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y);
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 10_000 });
  const described = await dialog.textContent();
  check(
    `${tag}: the composer names the part`,
    /<button> Play/.test(described ?? ""),
    described?.slice(0, 80),
  );
  const picture = await dialog.locator('img[alt="The selected part"]').count();
  check(`${tag}: a picture of the part is taken`, picture === 1);
  if (shots) await page.screenshot({ path: join(shots, `composer-${width}.png`) });
  await dialog.getByRole("button", { name: "Problem" }).click();
  await dialog.getByLabel("Your note").fill(`The play button is too small at ${width}`);
  await dialog.getByRole("button", { name: "Save note" }).click();
  await dialog.waitFor({ state: "hidden" });
  // The pin in the frame, numbered.
  const pins = await frameEl
    .elementHandle()
    .then((h) => h.contentFrame())
    .then((f) =>
      f
        .waitForFunction(
          () =>
            document.querySelector("oraknid-review-layer")?.shadowRoot?.querySelectorAll(".p")
              .length ?? 0,
          null,
          { timeout: 10_000 },
        )
        .then((h) => h.jsonValue()),
    );
  check(`${tag}: its pin is drawn on the frame`, pins >= 1, `${pins} pins`);
  // The note in the list (a sheet on a phone).
  if (width < 768) await page.getByRole("button", { name: /^\d+$/ }).click();
  const listed = await page.getByText(`The play button is too small at ${width}`).count();
  check(`${tag}: the note is listed`, listed >= 1);
  if (shots) await page.screenshot({ path: join(shots, `notes-${width}.png`) });
  if (width < 768) await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Select/ }).click();

  // The app: its error and its failed request heard.
  await page.goto(`${info.url}/review/${info.app}`);
  const appFrame = page.frameLocator('iframe[title="What is reviewed"]');
  await appFrame.locator("#title").waitFor({ timeout: 15_000 });
  const bar = page.getByText(/The app so far: 1 console errors or warnings, 1 failed requests/);
  const heard = await bar.waitFor({ timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  check(`${tag}: the app's console error and failed request are captured`, heard);
  if (shots) await page.screenshot({ path: join(shots, `app-${width}.png`) });
  check(`${tag}: no errors on the page`, errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
}

// A design made of a page per device, no index.html (2026-10-10, the Keys design): each device
// shows its own page, never the desktop page hidden at a phone's size (black).
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(
    ({ token, session }) => {
      localStorage.setItem("oraknid.token", token);
      sessionStorage.setItem("oraknid.unlock", session);
    },
    { token: info.token, session: info.session },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${info.url}/review/${info.screens}`);
  const frameEl = page.locator('iframe[title="What is reviewed"]');
  await frameEl.waitFor({ timeout: 15_000 });
  /** The screen the frame shows once it is on `want`, and whether its content is visible. */
  const shown = async (want) => {
    await page.waitForFunction(
      (w) =>
        document
          .querySelector('iframe[title="What is reviewed"]')
          ?.getAttribute("src")
          ?.endsWith(w),
      want,
      { timeout: 10_000 },
    );
    const f = await (await frameEl.elementHandle()).contentFrame();
    await f.waitForFunction(
      (w) => location.pathname === w && !!document.querySelector("#screen"),
      want,
      { timeout: 10_000 },
    );
    return f.evaluate(() => {
      const el = document.querySelector("#screen");
      const r = el.getBoundingClientRect();
      return {
        name: el.dataset.screen,
        visible: getComputedStyle(el).display !== "none" && r.width > 0 && r.height > 0,
        size: `${innerWidth}×${innerHeight}`,
      };
    });
  };
  for (const [label, value, want, name] of [
    ["Laptop", "", "/desktop.html", "desktop"],
    ["Desktop", "5", "/desktop.html", "desktop"],
    ["Phone landscape", "1", "/phone-landscape.html", "phone-landscape"],
    ["Phone", "0", "/phone-portrait.html", "phone-portrait"],
  ]) {
    if (value) await page.getByLabel("Device").selectOption(value);
    const s = await shown(want);
    check(
      `screens: ${label} shows ${name}, not black`,
      s.name === name && s.visible,
      `${s.name} at ${s.size}${s.visible ? "" : ", hidden"}`,
    );
    if (shots)
      await page.screenshot({ path: join(shots, `screens-${label.replace(" ", "-")}.png`) });
  }
  await page.getByLabel("Screen").selectOption("/brand/");
  const brand = await shown("/brand/");
  check("screens: the Screen picker opens brand/", brand.name === "brand" && brand.visible);
  check("screens: no errors on the page", errors.length === 0, errors.join(" | ").slice(0, 200));
  await context.close();
}

await browser.close();
daemon.kill("SIGTERM");
const failed = results.filter((r) => !r.ok).length;
console.log(
  failed ? `${failed} of ${results.length} checks failed` : `all ${results.length} checks passed`,
);
process.exit(failed ? 1 : 0);
