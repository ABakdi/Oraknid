import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import express, { type Express } from "express";

// ADR-070: the web UI is served from memory. Its files are read once, at
// start (and again when a new build lands); no request for the page or
// its assets waits on the thread pool, so the page loads even when every
// file read in the process is stuck behind something slow.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

interface Held {
  body: Buffer;
  type: string;
}

/** Everything a request for the UI needs, kept in memory. */
export interface WebUiFiles {
  /** By URL path: `/index.html`, `/assets/app-1234.js`. */
  files: Map<string, Held>;
  index: Held | undefined;
  /** index.html's mtime when read: a new build is read again. */
  stamp: number;
  bytes: number;
}

/** Reads the built UI into memory, up to `maxBytes` (what is left over is served from disk). */
export function readWebUi(dir: string, maxBytes = 64 * 1024 * 1024): WebUiFiles {
  const files = new Map<string, Held>();
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const size = statSync(p).size;
        if (bytes + size > maxBytes) continue;
        const body = readFileSync(p);
        bytes += body.length;
        const url = `/${relative(dir, p).split(sep).join("/")}`;
        files.set(url, {
          body,
          type: TYPES[extname(p).toLowerCase()] ?? "application/octet-stream",
        });
      }
    }
  };
  walk(dir);
  return { files, index: files.get("/index.html"), stamp: mtime(join(dir, "index.html")), bytes };
}

function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Serves the web UI from `dir`: its files from memory, then from disk for
 * anything not held (express.static), and the app's index.html for every
 * other path but the API's and /live.
 */
export function serveWebUi(app: Express, dir: string, o: { maxBytes?: number } = {}) {
  let ui = readWebUi(dir, o.maxBytes);
  // A new build (`oraknid install --gui`, a clone rebuilt): its index.html is newer.
  // statSync, never the pool: a stat of one local file.
  const fresh = () => {
    const now = mtime(join(dir, "index.html"));
    if (now !== ui.stamp) ui = readWebUi(dir, o.maxBytes);
    return ui;
  };
  const sendIndex = (res: express.Response) => {
    const index = fresh().index;
    if (!index) return false;
    res.set("Cache-Control", "no-cache").type(index.type).send(index.body);
    return true;
  };
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      return next();
    }
    if (path === "/index.html") return sendIndex(res) ? undefined : next();
    const held = ui.files.get(path);
    if (held) {
      res.set("Cache-Control", "public, max-age=3600").type(held.type).send(held.body);
      return;
    }
    // A page of the app (no file name): its index, never a look on disk first.
    if (!/^\/(api\/|live$)/.test(path) && !extname(path) && sendIndex(res)) return;
    next();
  });
  app.use(express.static(dir, { index: false, maxAge: "1h" }));
  // Relative to its folder: a path with a hidden folder in it (~/.local/…) is served all the same.
  app.get(/^\/(?!api\/|live$).*/, (_req, res) => {
    if (!sendIndex(res)) res.sendFile("index.html", { root: dir });
  });
  return { bytes: () => ui.bytes, held: () => ui.files.size };
}
