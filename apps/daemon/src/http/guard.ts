import type { IncomingMessage } from "node:http";

/**
 * Until devices are paired (M1.8), the daemon only answers requests that
 * come from this machine and are addressed to it by a local name. The
 * Host check stops DNS-rebinding; the Origin check stops a web page in my
 * browser from calling the API behind my back.
 */
export function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const remote = req.socket.remoteAddress ?? "";
  if (!LOOPBACK.has(remote)) return false;

  const host = req.headers.host ?? "";
  if (!localOrigins(port).hosts.has(host)) return false;

  // Another site may link to the UI (an email's link), not frame it, post to it
  // or fetch from it (Audit 2).
  if (
    req.headers["sec-fetch-site"] === "cross-site" &&
    // A page load, or the app's service worker fetching it again (dest "empty"); never a frame.
    !(
      req.headers["sec-fetch-mode"] === "navigate" &&
      ["document", "empty"].includes(String(req.headers["sec-fetch-dest"]))
    )
  )
    return false;

  const origin = req.headers.origin;
  if (origin !== undefined && !localOrigins(port).origins.has(origin)) return false;
  return true;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function localOrigins(port: number) {
  const names = ["127.0.0.1", "localhost", "[::1]"];
  return {
    hosts: new Set(names.map((n) => `${n}:${port}`)),
    origins: new Set(names.map((n) => `http://${n}:${port}`)),
  };
}
