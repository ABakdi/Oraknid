import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { ReviewFramePage } from "@oraknid/contracts";
import { designFile, injectInto, typeOf } from "./frame.ts";
import { OVERLAY_JS } from "./overlay.ts";
import { ReviewError, type ReviewRow, type Reviews } from "./service.ts";

// A review's page away from home (ADR-064, M16.1): the Nest's tunnel carries
// API calls, not a frame's requests, so the page comes as one document: its
// stylesheets, scripts and images inlined, the overlay in it. The review
// page shows it in a sandboxed frame (srcdoc). Links are followed by asking
// for the next page. A module script that imports others can't run so.

/** The most one page carries, its files included. */
const PAGE_MAX = 12 * 1024 * 1024;
/** The most one of its files may weigh to be inlined. */
const FILE_MAX = 3 * 1024 * 1024;

type Got = { type: string; body: Buffer } | null;

export async function framePage(
  reviews: Reviews,
  row: ReviewRow,
  path: string,
): Promise<ReviewFramePage> {
  const page = new URL(path || row.entry, "http://frame");
  const get = getter(reviews, row);
  const first = await get(page.pathname + page.search);
  if (!first) throw new ReviewError(`No page ${page.pathname} in what is reviewed.`, "NOT_FOUND");
  const missing: string[] = [];
  let budget = PAGE_MAX;
  const fetchInline = async (href: string, base: string): Promise<Got> => {
    if (!href || /^(data|blob|javascript|mailto|tel):/i.test(href) || href.startsWith("#"))
      return null;
    let u: URL;
    try {
      u = new URL(href, `http://frame${base}`);
    } catch {
      return null;
    }
    if (u.host !== "frame") return null;
    const got = await get(u.pathname + u.search);
    if (!got) {
      missing.push(u.pathname);
      return null;
    }
    if (got.body.length > FILE_MAX || got.body.length > budget) {
      missing.push(`${u.pathname} (too big to carry away from home)`);
      return null;
    }
    budget -= got.body.length;
    return { ...got, body: got.body };
  };
  const dataUrl = (g: { type: string; body: Buffer }) =>
    `data:${g.type.split(";")[0]};base64,${g.body.toString("base64")}`;
  const cssInlined = async (css: string, base: string) =>
    replaceAsync(css, /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, async (m, _q, href: string) => {
      const g = await fetchInline(href.trim(), base);
      return g ? `url("${dataUrl(g)}")` : m;
    });

  let html = first.type.startsWith("text/html")
    ? first.body.toString("utf8")
    : `<pre>${first.body.toString("utf8").replaceAll("<", "&lt;")}</pre>`;
  const base = page.pathname;
  html = await replaceAsync(html, /<link\b[^>]*>/gi, async (tag) => {
    const rel = attr(tag, "rel")?.toLowerCase() ?? "";
    const href = attr(tag, "href") ?? "";
    if (rel.includes("stylesheet")) {
      const g = await fetchInline(href, base);
      if (!g) return tag;
      const css = await cssInlined(
        g.body.toString("utf8"),
        new URL(href, `http://frame${base}`).pathname,
      );
      return `<style>${css.replaceAll("</style", "<\\/style")}</style>`;
    }
    // Icons, preloads and manifests are not needed in the frame.
    if (/icon|preload|modulepreload|manifest|prefetch/.test(rel)) return "";
    return tag;
  });
  html = await replaceAsync(
    html,
    /<script\b([^>]*)>\s*<\/script>/gi,
    async (tag, attrs: string) => {
      const src = attr(attrs, "src");
      if (!src) return tag;
      const g = await fetchInline(src, base);
      if (!g) return "";
      const type = attr(attrs, "type");
      const js = g.body.toString("utf8");
      if (type === "module" && /^\s*import\s|\bimport\s*\(/m.test(js))
        missing.push(`${src} (a module script: it may not run away from home)`);
      return `<script${type ? ` type="${type}"` : ""}>${js.replaceAll("</script", "<\\/script")}</script>`;
    },
  );
  html = await replaceAsync(html, /<(img|source|video|audio)\b[^>]*>/gi, async (tag) => {
    const src = attr(tag, "src");
    let out = tag.replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "");
    if (src) {
      const g = await fetchInline(src, base);
      if (g) out = out.replace(/\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, ` src="${dataUrl(g)}"`);
    }
    return out;
  });
  html = await replaceAsync(
    html,
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    async (_m, attrs: string, css: string) =>
      `<style${attrs}>${await cssInlined(css, base)}</style>`,
  );
  const config = `<script>window.__oraknidReview=${JSON.stringify({ snapshot: true, path: page.pathname + page.search }).replaceAll("<", "\\u003c")};</script>`;
  html = injectInto(html, `${config}<script>${OVERLAY_JS}</script>`);
  return { path: page.pathname + page.search, html, missing: [...new Set(missing)].slice(0, 30) };
}

/** Reads a path of the design's folder, or GETs it from the app's port. */
function getter(reviews: Reviews, row: ReviewRow): (path: string) => Promise<Got> {
  if (row.kind === "design") {
    const root = reviews.designRoot(row);
    return async (path) => {
      const file = root ? designFile(root, path) : null;
      if (!file) return null;
      return { type: typeOf(file), body: readFileSync(file) };
    };
  }
  const port = Number(row.target);
  return (path) =>
    new Promise<Got>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: "GET",
          headers: { host: `127.0.0.1:${port}`, "accept-encoding": "identity", accept: "*/*" },
          timeout: 5000,
        },
        (res) => {
          if ((res.statusCode ?? 500) >= 400) {
            res.resume();
            resolve(null);
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > FILE_MAX + 1) {
              req.destroy();
              resolve(null);
              return;
            }
            chunks.push(c);
          });
          res.on("end", () =>
            resolve({
              type: String(res.headers["content-type"] ?? "application/octet-stream"),
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? m[4] ?? "") : null;
}

async function replaceAsync(
  s: string,
  re: RegExp,
  // biome-ignore lint/suspicious/noExplicitAny: the match's groups, as replace gives them
  fn: (...m: any[]) => Promise<string>,
): Promise<string> {
  const jobs: Promise<string>[] = [];
  s.replace(re, (...m) => {
    jobs.push(fn(...m));
    return "";
  });
  const out = await Promise.all(jobs);
  let i = 0;
  return s.replace(re, () => out[i++] ?? "");
}
