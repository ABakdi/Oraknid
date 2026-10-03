import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type express from "express";
import type { Cloud } from "./service.ts";

// Files in and out of Oraknid over HTTP (ADR-046). An upload is streamed
// to a temporary file (mine only) and handed to rclone; a download is a
// link made by a call of a paired, unlocked device, good once and for two
// minutes, streamed as it comes. Both only on this computer: away from
// home the tunnel carries text, not files.

export interface Download {
  stream: Readable;
  name: string;
  size: number | null;
  /** Its source's end: an error in words, or null. */
  done?: Promise<string | null>;
}

const TTL = 2 * 60_000;

/** One-time download links. */
export class Downloads {
  readonly #links = new Map<string, { open: () => Promise<Download>; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(open: () => Promise<Download>): { url: string; expiresAt: number } {
    for (const [k, v] of this.#links) if (v.expiresAt < this.now()) this.#links.delete(k);
    const token = randomBytes(24).toString("base64url");
    const expiresAt = this.now() + TTL;
    this.#links.set(token, { open, expiresAt });
    return { url: `/download/${token}`, expiresAt };
  }

  take(token: string) {
    const l = this.#links.get(token);
    this.#links.delete(token);
    return l && l.expiresAt >= this.now() ? l.open : null;
  }
}

/** A name for Content-Disposition: plain ASCII, and the real one in UTF-8. */
const disposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]|["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`;

const fail = (res: express.Response, status: number, message: string) => {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(status).json({ message });
};

export function attachCloudRoutes(app: express.Express, cloud: Cloud, downloads: Downloads) {
  /**
   * POST /api/cloud/upload?folder=&name=&size=&provider=&transfer=&replace=
   * with the file as the body. Placed before a byte is read: too big for
   * any one place is refused at once.
   */
  app.post("/api/cloud/upload", async (req, res) => {
    if (res.locals.remote === true)
      return fail(
        res,
        403,
        "Uploads go from a browser on the computer running Oraknid; away from home they aren't available yet.",
      );
    const q = req.query as Record<string, string | undefined>;
    const name = (q.name ?? "").trim();
    const size = Number(q.size);
    if (!name || name.includes("/") || name === "." || name === "..")
      return fail(res, 400, "A file needs a name, without a /.");
    if (!Number.isSafeInteger(size) || size < 0)
      return fail(res, 400, "Say the file's size (bytes).");
    const transfer = /^[\w-]{1,40}$/.test(q.transfer ?? "") ? (q.transfer as string) : undefined;
    let path: string;
    let providerId: string;
    try {
      path = [q.folder ?? "", name].filter(Boolean).join("/");
      providerId = await cloud.place(size, q.provider && q.provider !== "auto" ? q.provider : null);
      if (q.replace !== "1" && (await cloud.stat(providerId, path)))
        return fail(
          res,
          409,
          `There is already a file ${path} in ${cloud.label(providerId)}: replace it?`,
        );
    } catch (error) {
      return fail(res, 400, error instanceof Error ? error.message : String(error));
    }
    const file = cloud.tmpFile("up");
    let received = 0;
    let last = 0;
    try {
      const out = createWriteStream(file, { mode: 0o600 });
      req.on("data", (d: Buffer) => {
        received += d.length;
        if (received > size) req.destroy(new Error("More bytes came than the file's size."));
        const t = Date.now();
        if (transfer && t - last > 250) {
          last = t;
          cloud.transfer({
            id: transfer,
            name,
            phase: "receive",
            bytes: received,
            total: size,
            providerId,
            error: null,
          });
        }
      });
      await pipeline(req, out);
      if (received !== size)
        throw new Error(`The upload stopped: ${received} of ${size} bytes came.`);
      const put = await cloud.putFile(file, path, {
        placed: providerId,
        replace: q.replace === "1",
        ...(transfer ? { transfer } : {}),
      });
      res.json({ ...put, providerName: cloud.label(put.providerId) });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error));
    } finally {
      cloud.removeTmp(file);
    }
  });

  /** GET /download/<token>: the file, streamed. */
  app.get("/download/:token", async (req, res) => {
    const open = downloads.take(req.params.token ?? "");
    if (!open) return fail(res, 404, "That download link was used or has expired: ask again.");
    let d: Download;
    try {
      d = await open();
    } catch (error) {
      return fail(res, 400, error instanceof Error ? error.message : String(error));
    }
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", disposition(d.name));
    res.setHeader("Cache-Control", "no-store");
    if (d.size !== null) res.setHeader("Content-Length", String(d.size));
    try {
      await pipeline(d.stream, res);
      const err = await d.done;
      if (err) console.error("download ended badly:", err);
    } catch (error) {
      console.error("download failed:", error instanceof Error ? error.message : error);
      res.destroy();
    }
  });
}
