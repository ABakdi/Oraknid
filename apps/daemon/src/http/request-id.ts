import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * A request id on every API call (API-Contract): made by the daemon for
 * each request — a client's own `x-request-id` is not taken, so the log
 * holds only ids the daemon made — and given back in the `x-request-id`
 * header, in an error's `data.requestId`, and at the start of every log
 * line printed while the request runs.
 */
const store = new AsyncLocalStorage<string>();

export const REQUEST_ID_HEADER = "x-request-id";

/** The id of the request this code runs for, if any. */
export function currentRequestId(): string | undefined {
  return store.getStore();
}

export function newRequestId(): string {
  return `r-${randomBytes(6).toString("hex")}`;
}

/** Runs `fn` as part of request `id`: its log lines carry the id. */
export function withRequestId<T>(id: string, fn: () => T): T {
  return store.run(id, fn);
}

/** Express middleware: an id for the request, in its response's header, for all it runs. */
export function requestIds(_req: Request, res: Response, next: NextFunction): void {
  const id = newRequestId();
  res.locals.requestId = id;
  res.setHeader(REQUEST_ID_HEADER, id);
  store.run(id, next);
}

type Logger = Pick<Console, "log" | "error" | "warn">;
const tagged = new WeakSet<Logger>();

/**
 * Log lines printed during a request start with `[<id>]`. Done once per
 * console, over whatever its log, warn and error already do (the CLI
 * copies them to the daemon's log).
 */
export function tagConsoleWithRequestIds(target: Logger = console): void {
  if (tagged.has(target)) return;
  tagged.add(target);
  for (const name of ["log", "error", "warn"] as const) {
    const original = target[name].bind(target);
    target[name] = (...args: unknown[]) => {
      const id = store.getStore();
      if (id) original(`[${id}]`, ...args);
      else original(...args);
    };
  }
}
