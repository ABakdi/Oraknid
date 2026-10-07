import {
  Id,
  SiteAddress,
  SiteCheck,
  SitePatch,
  SitesFound,
  SiteView,
  Timestamp,
} from "@oraknid/contracts";
import { ORPCError, os } from "@orpc/server";
import { z } from "zod";
import type { Sites } from "../sites/service.ts";

// Sites, domains, certificates and uptime (ADR-060, API-Contract → sites).
// They read public answers and change nothing of mine: they work away from
// home too.

const base = os.$context<{ sites: Sites }>();

async function guard<T>(fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ORPCError) throw error;
    if (error instanceof Error && error.constructor === Error)
      throw new ORPCError(
        /^No site/.test(error.message)
          ? "NOT_FOUND"
          : /already|being checked/.test(error.message)
            ? "CONFLICT"
            : "BAD_REQUEST",
        { message: error.message },
      );
    console.error("request failed", error);
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: "Something went wrong inside Oraknid; the details are in its log (oraknid logs).",
    });
  }
}

export const sitesRouter = {
  list: base.output(z.array(SiteView)).handler(({ context: c }) => c.sites.list()),
  /** The proxies' sites of my ready servers (or one), added once per domain. */
  find: base
    .input(z.object({ serverId: Id.optional() }).optional())
    .output(SitesFound)
    .handler(({ context: c, input }) => guard(() => c.sites.find(input?.serverId))),
  /** A domain or a URL of mine; checked at once. */
  add: base
    .input(z.object({ address: SiteAddress }))
    .output(SiteView)
    .handler(({ context: c, input }) => guard(() => c.sites.add(input.address))),
  update: base
    .input(SitePatch)
    .output(SiteView)
    .handler(({ context: c, input }) => guard(() => c.sites.update(input))),
  remove: base
    .input(z.object({ id: Id }))
    .handler(({ context: c, input }) => guard(() => c.sites.remove(input.id))),
  /** DNS, the certificate and an uptime check, now. */
  refresh: base
    .input(z.object({ id: Id }))
    .output(SiteView)
    .handler(({ context: c, input }) => guard(() => c.sites.refresh(input.id))),
  history: base
    .input(z.object({ id: Id, since: Timestamp.optional() }))
    .output(z.array(SiteCheck))
    .handler(({ context: c, input }) => guard(() => c.sites.history(input.id, input.since))),
};
