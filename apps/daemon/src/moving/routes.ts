import type express from "express";
import type { Db } from "../db/open.ts";
import type { EventBus } from "../events/bus.ts";
import type { Secrets } from "../os/secrets.ts";
import type { Paths } from "../paths.ts";
import { importAll } from "./move.ts";
import { importZip } from "./records.ts";
import { MAX_UNZIPPED } from "./zip.ts";

// Files into Oraknid for ADR-061: a zip of jobs or a project, and the
// archive of a whole Oraknid. Both from a browser on this computer only,
// as the body of the request, with a limit on its size.

export interface MovingRoutesDeps {
  db: Db;
  bus: EventBus;
  paths: Paths;
  secrets: Secrets;
  known: () => Iterable<string>;
}

const fail = (res: express.Response, status: number, message: string) => {
  if (res.headersSent) return void res.destroy();
  res.status(status).json({ message });
};

/** The request's body, refused past `max` bytes. */
function body(req: express.Request, max: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on("data", (d: Buffer) => {
      n += d.length;
      if (n > max) {
        reject(new Error("That file is too big to import."));
        req.destroy();
        return;
      }
      parts.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

export function attachMovingRoutes(app: express.Express, d: MovingRoutesDeps) {
  /** POST /api/records/import?projectId=: a zip of jobs or a project, its jobs as ended records. */
  app.post("/api/records/import", async (req, res) => {
    if (res.locals.remote === true)
      return fail(res, 403, "Imports go from a browser on the computer running Oraknid.");
    try {
      const data = await body(req, MAX_UNZIPPED);
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      const r = importZip(
        {
          db: d.db,
          bus: d.bus,
          logsDir: d.paths.logs,
          known: d.known,
          record: () => null,
          importsDir: `${d.paths.dataDir}/imported`,
        },
        data,
        { projectId },
      );
      res.json(r);
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error));
    }
  });

  /**
   * POST /api/moving/import with the archive as the body and its passphrase
   * in `x-oraknid-passphrase`: a fresh install only; its secrets and config
   * now, its database at the next start (ADR-061).
   */
  app.post("/api/moving/import", async (req, res) => {
    if (res.locals.remote === true)
      return fail(res, 403, "Importing goes from a browser on the computer running Oraknid.");
    const passphrase = req.headers["x-oraknid-passphrase"];
    if (typeof passphrase !== "string" || !passphrase)
      return fail(res, 400, "Give the archive's passphrase.");
    try {
      const data = await body(req, 4 * 1024 * 1024 * 1024 - 1);
      const r = await importAll({
        paths: d.paths,
        secrets: d.secrets,
        data,
        passphrase,
        stageOnly: true,
      });
      d.bus.publish({
        type: "oraknid.imported",
        topic: "overview",
        jobId: null,
        payload: { counts: r.manifest.counts, from: r.manifest.oraknid, applied: false },
        actor: "owner",
      });
      res.json({
        counts: r.manifest.counts,
        secrets: r.secrets,
        missing: r.missing,
        applied: r.applied,
      });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : String(error));
    }
  });
}
