import { createReadStream, readFileSync, realpathSync, statSync } from "node:fs";
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { extname, join, sep } from "node:path";
import type { Duplex } from "node:stream";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { OVERLAY_JS, OVERLAY_PATH } from "./overlay.ts";
import { pagesIn, screenName } from "./screens.ts";
import type { ReviewRow, Reviews } from "./service.ts";

// The review's frame (ADR-064 §2–3): what I review, served on the review's
// own origin, http://rv-<key>.localhost:<port>/, so its pages run apart
// from Oraknid's (they can't read its storage nor call its API as me) and
// its absolute paths (/src/main.tsx, /@vite/client) work as in the app.
//
// - A design: its folder, read-only, nothing outside it (no "..", no dot
//   files, symlinks resolved and checked again).
// - An app: a reverse proxy to the job's local port on 127.0.0.1, that
//   port only, HTTP and websockets (HMR).
// - Each HTML page gets the overlay script (overlay.ts); nothing else is
//   changed and nothing is written into the project.

const HOST = /^rv-([0-9a-f]{32})\.localhost(?::(\d+))?$/;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
/** The largest HTML page the overlay is added to; a bigger one is passed on as it is. */
const HTML_MAX = 16 * 1024 * 1024;

/** The review key in a request's Host, when it names a review's frame on this daemon. */
export function reviewKeyOf(host: string | undefined, port: number): string | null {
  const m = HOST.exec(String(host ?? "").toLowerCase());
  if (!m) return null;
  if (Number(m[2] ?? 80) !== port) return null;
  return m[1] ?? null;
}

/** Only the review page, on this daemon's own origins, may frame it. */
export function frameAncestors(port: number) {
  return ["127.0.0.1", "localhost"].map((h) => `http://${h}:${port}`).join(" ");
}

/** The policy of a design's pages: its own files, inline styles and scripts, nothing from elsewhere. */
export function designCsp(port: number) {
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "form-action 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    `frame-ancestors ${frameAncestors(port)}`,
  ].join("; ");
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};
export const typeOf = (file: string) =>
  TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";

/** The overlay's tag, first in <head> so it hears the app's first errors. */
export const OVERLAY_TAG = `<script src="${OVERLAY_PATH}"></script>`;

/** The page with `tag` added at the top of its <head> (or of the page, without one). */
export function injectInto(html: string, tag: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head)
    return (
      html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
    );
  const root = /<html\b[^>]*>/i.exec(html);
  if (root)
    return (
      html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length)
    );
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + tag + html.slice(doctype[0].length);
  return tag + html;
}

const isHtml = (type: string | undefined) => /^\s*text\/html\b/i.test(type ?? "");

/**
 * A file of the design folder `root` for a request path, or null: decoded,
 * no dot segment (no "..", no .git or .env), resolved through symlinks and
 * still inside `root`; a folder gives its index.html.
 */
export function designFile(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p.startsWith("."))) return null;
  let real: string;
  try {
    real = realpathSync(join(root, ...parts));
  } catch {
    return null;
  }
  if (real !== root && !real.startsWith(root + sep)) return null;
  try {
    let s = statSync(real);
    if (s.isDirectory()) {
      const index = realpathSync(join(real, "index.html"));
      if (!index.startsWith(root + sep)) return null;
      s = statSync(index);
      real = index;
    }
    return s.isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * A design folder with no index.html (2026-10-09: the Keys design had
 * desktop.html, phone-landscape.html, phone-portrait.html and brand/ only,
 * and the review opened on "Not in the design"): a page of its screens,
 * made by Oraknid, nothing written into the design, each a link. It only
 * lists (2026-10-10): the review page picks the screen that fits the
 * device it shows (`reviews.screens`) at every device change, which a
 * script here could not (it ran once, on first load; inlined away from
 * home it can't move its frame).
 */
export function designIndex(root: string, urlPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  } catch {
    return null;
  }
  if (path.includes("\0") || path.includes("\\")) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.some((p) => p.startsWith("."))) return null;
  let dir: string;
  try {
    dir = realpathSync(join(root, ...parts));
    if (dir !== root && !dir.startsWith(root + sep)) return null;
    if (!statSync(dir).isDirectory()) return null;
  } catch {
    return null;
  }
  const pages = pagesIn(dir);
  if (!pages.length) return null;
  // From the top of the design, so "/brand" (no slash) links as "/brand/" does.
  const folder = parts.map((p) => `${p}/`).join("");
  const items = pages
    .map(
      (n) =>
        `<li><a href="${escapeHtml(encodeURI(`/${folder}${n}`))}">${escapeHtml(screenName(n))}</a></li>`,
    )
    .join("");
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>The design's screens</title>
<style>body{font:15px system-ui,sans-serif;margin:2rem;color:#ddd;background:#16161a}a{color:#9cf}li{margin:.4rem 0}small{color:#999}</style>
<h1>The design's screens</h1><small>This design has no index.html: its pages, by name. The review page opens the one that fits its device; Screen picks another.</small>
<ul>${items}</ul>`;
}

export interface FrameOptions {
  reviews: Reviews;
  /** The daemon's port, known once it listens. */
  port: () => number;
}

/**
 * The frame's requests, before anything else of the daemon's: true when
 * the request was a review frame's (and answered).
 */
export function reviewFrames(o: FrameOptions) {
  const find = (req: IncomingMessage): ReviewRow | null | undefined => {
    const key = reviewKeyOf(req.headers.host, o.port());
    if (!key) return undefined;
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return null;
    return o.reviews.byKey(key);
  };

  function http(req: IncomingMessage, res: ServerResponse): boolean {
    const row = find(req);
    if (row === undefined) return false;
    const port = o.port();
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!row) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("This review is not open any more.");
      return true;
    }
    const path = new URL(req.url ?? "/", "http://frame").pathname;
    if (path === OVERLAY_PATH) {
      res.setHeader("Content-Type", "text/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.end(OVERLAY_JS);
      return true;
    }
    if (row.kind === "design") serveDesign(row, req, res, port);
    else proxyApp(row, req, res, port);
    return true;
  }

  /** A websocket of the app (its HMR), to its port only. */
  function upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const row = find(req);
    if (row === undefined) return false;
    if (row?.kind !== "app") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return true;
    }
    const target = Number(row.target);
    const up: Socket = connect(target, "127.0.0.1", () => {
      const headers = upstreamHeaders(req.headers, target);
      let raw = `${req.method ?? "GET"} ${req.url ?? "/"} HTTP/1.1\r\n`;
      for (const [k, v] of Object.entries(headers))
        for (const value of Array.isArray(v) ? v : [v])
          if (value !== undefined) raw += `${k}: ${value}\r\n`;
      up.write(`${raw}\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    const end = () => {
      up.destroy();
      socket.destroy();
    };
    up.on("error", end);
    socket.on("error", end);
    up.on("close", () => socket.destroy());
    socket.on("close", () => up.destroy());
    return true;
  }

  function serveDesign(row: ReviewRow, req: IncomingMessage, res: ServerResponse, port: number) {
    res.setHeader("Content-Security-Policy", designCsp(port));
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end();
      return;
    }
    const root = o.reviews.designRoot(row);
    const file = root ? designFile(root, req.url ?? "/") : null;
    const listing = !file && root ? designIndex(root, req.url ?? "/") : null;
    if (listing) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(req.method === "HEAD" ? undefined : injectInto(listing, OVERLAY_TAG));
      return;
    }
    if (!file) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        injectInto("<!doctype html><title>Not found</title><p>Not in the design.</p>", OVERLAY_TAG),
      );
      return;
    }
    const type = typeOf(file);
    res.setHeader("Content-Type", type);
    if (isHtml(type)) {
      const body = Buffer.from(injectInto(readFileSync(file, "utf8"), OVERLAY_TAG));
      res.setHeader("Content-Length", body.length);
      res.end(req.method === "HEAD" ? undefined : body);
      return;
    }
    res.setHeader("Content-Length", statSync(file).size);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(file)
      .on("error", () => res.destroy())
      .pipe(res);
  }

  function proxyApp(row: ReviewRow, req: IncomingMessage, res: ServerResponse, port: number) {
    const target = Number(row.target);
    const up = httpRequest(
      {
        host: "127.0.0.1",
        port: target,
        method: req.method,
        path: req.url ?? "/",
        headers: { ...upstreamHeaders(req.headers, target), "accept-encoding": "identity" },
      },
      (upRes) => {
        const headers = { ...upRes.headers };
        // Framed by the review page only; the app's own frame rule would hide it there.
        delete headers["x-frame-options"];
        const csp = headers["content-security-policy"];
        const ours = `frame-ancestors ${frameAncestors(port)}`;
        headers["content-security-policy"] = [
          ...(csp === undefined ? [] : Array.isArray(csp) ? csp : [csp]),
          ours,
        ];
        headers["referrer-policy"] = "same-origin";
        const type = headers["content-type"];
        if (!isHtml(type) || req.method === "HEAD" || upRes.statusCode === 304) {
          res.writeHead(upRes.statusCode ?? 502, headers);
          upRes.pipe(res);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let passed = false;
        upRes.on("data", (c: Buffer) => {
          if (passed) return;
          size += c.length;
          chunks.push(c);
          if (size > HTML_MAX) {
            // Too big to look into: passed on as it came.
            passed = true;
            res.writeHead(upRes.statusCode ?? 502, headers);
            for (const x of chunks) res.write(x);
            upRes.pipe(res);
          }
        });
        upRes.on("end", () => {
          if (passed) return;
          let body: Buffer = Buffer.concat(chunks);
          try {
            body = decode(body, String(headers["content-encoding"] ?? ""));
            delete headers["content-encoding"];
          } catch {
            res.writeHead(upRes.statusCode ?? 502, headers);
            res.end(body);
            return;
          }
          const out = Buffer.from(injectInto(body.toString("utf8"), OVERLAY_TAG));
          delete headers["transfer-encoding"];
          headers["content-length"] = String(out.length);
          res.writeHead(upRes.statusCode ?? 200, headers);
          res.end(out);
        });
        upRes.on("error", () => res.destroy());
      },
    );
    up.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.statusCode = 502;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Content-Security-Policy", designCsp(port));
      res.setHeader("Cache-Control", "no-store");
      res.end(
        injectInto(
          `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Waiting for the app</title><body style="font:15px system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5;color:#444"><h1 style="font-size:1.1rem">The app isn't answering on port ${target}</h1><p>It may still be starting: this page tries again every few seconds.</p><p style="color:#888;font-size:13px">${escapeHtml((error as NodeJS.ErrnoException).code ?? error.message)}</p></body>`,
          OVERLAY_TAG,
        ),
      );
    });
    req.pipe(up);
  }

  return { http, upgrade };
}

/** The request's headers as the app expects them: addressed to it, from itself. */
function upstreamHeaders(h: IncomingHttpHeaders, port: number): IncomingHttpHeaders {
  const out: IncomingHttpHeaders = { ...h, host: `127.0.0.1:${port}` };
  if (out.origin) out.origin = `http://127.0.0.1:${port}`;
  if (typeof out.referer === "string") {
    try {
      const u = new URL(out.referer);
      out.referer = `http://127.0.0.1:${port}${u.pathname}${u.search}`;
    } catch {
      delete out.referer;
    }
  }
  return out;
}

function decode(body: Buffer, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case "":
    case "identity":
      return body;
    case "gzip":
    case "x-gzip":
      return gunzipSync(body);
    case "deflate":
      return inflateSync(body);
    case "br":
      return brotliDecompressSync(body);
    default:
      throw new Error(`Unknown encoding ${encoding}`);
  }
}

export const escapeHtml = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
