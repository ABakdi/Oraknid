import { request as httpRequest } from "node:http";
import { DEVICE_SIZES, type DeviceName } from "@oraknid/contracts";
import { findChromium } from "../harness/visual.ts";

// The render check (ADR-069 §4): before a review is shown to me, Oraknid
// loads what it shows itself, through the same frame the review page
// uses, at the review's devices, and looks at whether anything rendered.
// A blank page, a page that threw, a raw source file, a directory listing
// or "Not in the design" is never shown as a review: the ladder of ways
// to run goes on, then an agent, then a plain panel.
//
// Headless Chromium through playwright-core when this computer has both
// (as the visual check, harness/visual.ts); else a cheaper look over HTTP.

/** The devices every review is checked at: the smallest and the largest a review shows. */
export const CHECK_DEVICES: DeviceName[] = ["phone", "desktop"];

export interface RenderCheck {
  ok: boolean;
  /** Why not, in plain words; null when it rendered. */
  reason: string | null;
  /** The devices it rendered at (all of them when ok). */
  devices: DeviceName[];
  /** How it was looked at: in a browser, or over HTTP only. */
  how: "browser" | "http";
}

export interface RenderInput {
  /** The page's address: the review's frame (or the app's own port). */
  url: string;
  devices?: DeviceName[];
  signal?: AbortSignal;
}

export interface RenderChecker {
  check(i: RenderInput): Promise<RenderCheck>;
}

// ── What a page's HTML says about itself ──────────────────────────────

const SOURCE_EXT = /\.(?:tsx|ts|jsx|mts|cts|vue|svelte|astro)(?:[?#]|$)/i;
const JS_TYPE =
  /^\s*(?:text|application)\/(?:x-)?(?:javascript|ecmascript)\b|^\s*application\/(?:x-)?javascript\b/i;
const LISTING =
  /<title>\s*(?:Directory listing for|Index of)\b|<h1>\s*(?:Directory listing for|Index of)\b/i;
const NOT_THERE = /\b(?:Not in the design|No page \/|Cannot GET \/)/;

/** Text that reads as source code, not a page: imports, JSX, types. */
export function looksLikeSource(text: string): boolean {
  const head = text.slice(0, 4000);
  return (
    /^\s*(?:import\s[^\n]*\bfrom\s+["']|import\s+["']|export\s+(?:default|const|function|interface|type)\b)/m.test(
      head,
    ) && !/<html\b|<body\b|<!doctype/i.test(head)
  );
}

/** The scripts a page loads, by their src. */
export function scriptSources(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']?([^"'\s>]+)/gi)]
    .map((m) => m[1] as string)
    .filter((s) => !s.startsWith("/__oraknid/"));
}

/** The page's body with its scripts, styles and comments taken out, and Oraknid's overlay tag. */
export function bodyWithoutScripts(html: string): string {
  const body =
    /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(html)?.[1] ??
    html.replace(/<head\b[\s\S]*?<\/head>/i, "");
  return body
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?(?:html|head|body|meta|link|title)\b[^>]*>/gi, "")
    .trim();
}

interface Got {
  status: number;
  type: string;
  text: string;
  url: string;
}

/**
 * A GET on this computer, as a browser would: a review's frame
 * (rv-<key>.localhost) reached on 127.0.0.1 with its name as the Host
 * (Node may resolve *.localhost to ::1, where Oraknid doesn't listen);
 * redirects followed, a few.
 */
function get(url: string, signal?: AbortSignal, hops = 0): Promise<Got> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "http:") return reject(new Error(`${u.protocol} isn't looked at`));
    const local = u.hostname === "localhost" || u.hostname.endsWith(".localhost");
    const req = httpRequest(
      {
        host: local ? "127.0.0.1" : u.hostname,
        port: Number(u.port || 80),
        path: `${u.pathname}${u.search}`,
        method: "GET",
        headers: { host: u.host, accept: "text/html,*/*" },
        timeout: 15_000,
        ...(signal ? { signal } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && hops < 4) {
          res.resume();
          get(new URL(location, u).href, signal, hops + 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size <= 4 * 1024 * 1024) chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            status,
            type: String(res.headers["content-type"] ?? ""),
            text: Buffer.concat(chunks).toString("utf8"),
            url: u.href,
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("no answer in 15 s")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * The cheaper look, over HTTP (ADR-069 §4): answered 200, an HTML page (or
 * plain text that isn't source code), no directory listing, every script it
 * loads served as JavaScript, and a body with something in it once its
 * scripts are taken out, unless its scripts make it.
 */
export function httpRenderChecker(): RenderChecker {
  return {
    async check(i) {
      const devices = i.devices ?? CHECK_DEVICES;
      const fail = (reason: string): RenderCheck => ({
        ok: false,
        reason,
        devices: [],
        how: "http",
      });
      let res: Got;
      try {
        res = await get(i.url, i.signal);
      } catch (error) {
        if (i.signal?.aborted) throw error;
        return fail(`the page didn't load (${(error as Error).message})`);
      }
      const { type, text } = res;
      if (res.status >= 400)
        return fail(
          NOT_THERE.test(text)
            ? `there is no page at ${new URL(i.url).pathname} (${res.status})`
            : `the page answered ${res.status}`,
        );
      const path = new URL(res.url || i.url).pathname;
      if (SOURCE_EXT.test(path) || looksLikeSource(text))
        return fail(`the page is source code (${path}), not something a browser shows`);
      // No type said: a browser sniffs it, HTML when it starts with a tag, else text.
      const html = /html/i.test(type) || (!type && /^\s*</.test(text));
      if (!html) {
        if ((/^text\//i.test(type) || !type) && text.trim())
          return { ok: true, reason: null, devices, how: "http" };
        return fail(`the page came as ${type || "nothing a browser shows"}, not HTML`);
      }
      if (LISTING.test(text)) return fail("the page is a listing of files, not the app");
      if (NOT_THERE.test(text)) return fail(`there is no page at ${path}`);
      const scripts = scriptSources(text);
      for (const src of scripts.slice(0, 8)) {
        let u: URL;
        try {
          u = new URL(src, res.url || i.url);
        } catch {
          continue;
        }
        if (u.origin !== new URL(i.url).origin) continue;
        try {
          const s = await get(u.href, i.signal);
          const st = s.type;
          const body = s.text;
          if (s.status >= 400) return fail(`its script ${u.pathname} answered ${s.status}`);
          if (!JS_TYPE.test(st))
            return fail(
              `its script ${u.pathname} came as ${st || "an unknown type"}, not JavaScript: ${SOURCE_EXT.test(u.pathname) ? "the source code is served as it is, not built or run by a dev server" : "a browser won't run it"}`,
            );
          if (!body.trim()) return fail(`its script ${u.pathname} is empty`);
        } catch (error) {
          return fail(`its script ${u.pathname} didn't load (${(error as Error).message})`);
        }
      }
      if (!bodyWithoutScripts(text) && !scripts.length && !/<script\b[^>]*>\s*\S/i.test(text))
        return fail("the page is blank: its body is empty");
      return { ok: true, reason: null, devices, how: "http" };
    },
  };
}

type PlaywrightCore = typeof import("playwright-core");

/** In the page: whether something is painted beyond the background, and its text. */
const PAINTED = `(() => {
  const body = document.body;
  if (!body) return { painted: 0, text: "", contentType: document.contentType };
  const bg = getComputedStyle(body).backgroundColor;
  let painted = 0;
  const visual = new Set(["IMG","CANVAS","SVG","VIDEO","INPUT","BUTTON","SELECT","TEXTAREA","IFRAME","PICTURE","OBJECT","EMBED"]);
  for (const el of body.querySelectorAll("*")) {
    if (el.closest("oraknid-review-layer") || el.tagName === "SCRIPT" || el.tagName === "STYLE") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) continue;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim());
    if (
      own ||
      visual.has(el.tagName.toUpperCase()) ||
      s.backgroundImage !== "none" ||
      (s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "transparent" && s.backgroundColor !== bg) ||
      (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== "none")
    ) painted++;
    if (painted > 2) break;
  }
  return { painted, text: (body.innerText || "").trim().slice(0, 400), contentType: document.contentType };
})()`;

/**
 * The real look (ADR-069 §4): headless Chromium at each device, the page
 * loaded, given a few seconds to draw; it rendered when its body shows
 * text or painted elements beyond the background and nothing threw. Falls
 * back to the HTTP look when there is no Chromium or playwright-core.
 */
export function browserRenderChecker(
  o: {
    chromium?: () => string | null;
    load?: () => Promise<PlaywrightCore>;
    /** How long a page may take to draw something after it loaded. */
    settleMs?: number;
  } = {},
): RenderChecker {
  const http = httpRenderChecker();
  return {
    async check(i) {
      const devices = i.devices ?? CHECK_DEVICES;
      const executable = (o.chromium ?? findChromium)();
      let pw: PlaywrightCore | null = null;
      if (executable)
        try {
          pw = await (o.load ?? (() => import("playwright-core")))();
        } catch {
          pw = null;
        }
      if (!executable || !pw) return http.check(i);
      let browser: Awaited<ReturnType<PlaywrightCore["chromium"]["launch"]>>;
      try {
        browser = await pw.chromium.launch({
          executablePath: executable,
          headless: true,
          // A review's frame (rv-<key>.localhost) is on this computer's 127.0.0.1, where Oraknid listens.
          args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"],
        });
      } catch {
        return http.check(i);
      }
      const seen: DeviceName[] = [];
      try {
        for (const device of devices) {
          if (i.signal?.aborted) throw i.signal.reason ?? new Error("Stopped.");
          const size = DEVICE_SIZES[device];
          const touch = device.startsWith("phone") || device.startsWith("tablet");
          const context = await browser.newContext({
            viewport: size,
            deviceScaleFactor: 1,
            isMobile: touch,
            hasTouch: touch,
          });
          try {
            const p = await context.newPage();
            const errors: string[] = [];
            const badScripts: string[] = [];
            p.on("pageerror", (e) => errors.push(String(e.message ?? e).slice(0, 300)));
            p.on("response", (r) => {
              const req = r.request();
              if (req.resourceType() !== "script") return;
              const type = r.headers()["content-type"] ?? "";
              if (r.status() >= 400)
                badScripts.push(`${new URL(r.url()).pathname} answered ${r.status()}`);
              else if (!JS_TYPE.test(type))
                badScripts.push(
                  `${new URL(r.url()).pathname} came as ${type || "an unknown type"}, not JavaScript${SOURCE_EXT.test(r.url()) ? ": the source code is served as it is, not built or run by a dev server" : ""}`,
                );
            });
            let status = 0;
            try {
              const res = await p.goto(i.url, { waitUntil: "load", timeout: 30_000 });
              status = res?.status() ?? 0;
            } catch (error) {
              return {
                ok: false,
                reason: `the page didn't load on the ${device} (${(error as Error).message.split("\n")[0]})`,
                devices: seen,
                how: "browser",
              };
            }
            // Drawn after load (a single-page app renders from its scripts): a few seconds to.
            const end = Date.now() + (o.settleMs ?? 5000);
            let look = { painted: 0, text: "", contentType: "" };
            for (;;) {
              look = (await p.evaluate(PAINTED).catch(() => look)) as typeof look;
              if (look.painted > 0 || look.text || errors.length || Date.now() > end) break;
              await p.waitForTimeout(250);
            }
            const fail = (reason: string): RenderCheck => ({
              ok: false,
              reason: `${reason} (on the ${device})`,
              devices: seen,
              how: "browser",
            });
            const path = new URL(p.url()).pathname;
            if (status >= 400)
              return fail(
                NOT_THERE.test(look.text)
                  ? `there is no page at ${path} (${status})`
                  : `the page answered ${status}`,
              );
            if (
              SOURCE_EXT.test(path) ||
              (!/html/i.test(look.contentType) && looksLikeSource(look.text))
            )
              return fail(`the page is source code (${path}), not something a browser shows`);
            if (/Directory listing for|^Index of \//m.test(look.text))
              return fail("the page is a listing of files, not the app");
            if (NOT_THERE.test(look.text)) return fail(`there is no page at ${path}`);
            if (errors.length) return fail(`the page threw: ${errors[0]}`);
            if (!look.painted && !look.text)
              return fail(
                badScripts.length
                  ? `the page is blank: its script ${badScripts[0]}`
                  : "the page is blank: nothing drew on it",
              );
            seen.push(device);
          } finally {
            await context.close().catch(() => {});
          }
        }
      } finally {
        await browser.close().catch(() => {});
      }
      return { ok: true, reason: null, devices: seen, how: "browser" };
    },
  };
}
