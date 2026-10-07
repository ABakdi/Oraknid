import { promises as dns } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import tls from "node:tls";
import type { SiteCert, SiteCheck, SiteDns } from "@oraknid/contracts";

// What the daemon reads of a site from this computer (ADR-060): its DNS,
// its certificate from a TLS handshake, and one uptime check. Each takes
// where to connect, so tests point them at stand-ins on 127.0.0.1.

export interface Resolver {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  resolveCname(host: string): Promise<string[]>;
  /** Every address of a name (a server's host), as the system resolves it. */
  lookup(host: string): Promise<string[]>;
}

export const systemResolver: Resolver = {
  resolve4: (h) => dns.resolve4(h),
  resolve6: (h) => dns.resolve6(h),
  resolveCname: (h) => dns.resolveCname(h),
  lookup: async (h) => (await dns.lookup(h, { all: true })).map((a) => a.address),
};

const EMPTY = new Set(["ENODATA", "ENOTFOUND", "ESERVFAIL", "ENOTIMP", "EREFUSED"]);

/** A record type that isn't there is none, not an error. */
async function records(fn: () => Promise<string[]>): Promise<{ list: string[]; code?: string }> {
  try {
    return { list: await fn() };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "";
    if (EMPTY.has(code)) return { list: [], code };
    throw error;
  }
}

/** A, AAAA and CNAME of a domain, and whether one of its addresses is its server's. */
export async function readDns(
  r: Resolver,
  host: string,
  serverHost: string | null,
): Promise<SiteDns> {
  try {
    const [a, aaaa, cname] = await Promise.all([
      records(() => r.resolve4(host)),
      records(() => r.resolve6(host)),
      records(() => r.resolveCname(host)),
    ]);
    if (!a.list.length && !aaaa.list.length && !cname.list.length)
      return {
        a: [],
        aaaa: [],
        cname: [],
        pointsHere: null,
        error:
          a.code === "ENOTFOUND"
            ? "No such domain: DNS doesn't know it."
            : "DNS has no address for it.",
      };
    let pointsHere: boolean | null = null;
    if (serverHost) {
      const mine = isIP(serverHost)
        ? [serverHost]
        : await r.lookup(serverHost).catch(() => [] as string[]);
      if (mine.length) pointsHere = [...a.list, ...aaaa.list].some((x) => mine.includes(x));
    }
    return { a: a.list, aaaa: aaaa.list, cname: cname.list, pointsHere, error: null };
  } catch (error) {
    return {
      a: [],
      aaaa: [],
      cname: [],
      pointsHere: null,
      error: `DNS couldn't be asked: ${(error as Error).message}`,
    };
  }
}

/** The certificate a domain presents, read from a handshake (not verified, so an ended one is read too). */
export function readCert(
  host: string,
  o: { connectHost?: string; port?: number; timeoutMs?: number; now?: number } = {},
): Promise<Omit<SiteCert, "at">> {
  return new Promise((resolve) => {
    const done = (c: Omit<SiteCert, "at">) => {
      socket.destroy();
      resolve(c);
    };
    const fail = (error: string) =>
      done({ expiresAt: null, issuer: null, names: [], valid: null, error });
    const socket = tls.connect({
      host: o.connectHost ?? host,
      port: o.port ?? 443,
      servername: isIP(host) ? undefined : host,
      rejectUnauthorized: false,
      timeout: o.timeoutMs ?? 10_000,
    });
    socket.once("timeout", () => fail("No answer on port 443 in 10 seconds."));
    socket.once("error", (e) => fail(plainNet(e)));
    socket.once("secureConnect", () => {
      const cert = socket.getPeerCertificate();
      if (!cert?.valid_to) return fail("It presented no certificate.");
      const expiresAt = Date.parse(cert.valid_to);
      const names = (cert.subjectaltname ?? "")
        .split(/,\s*/)
        .filter((n) => n.startsWith("DNS:"))
        .map((n) => n.slice(4));
      if (!names.length && typeof cert.subject?.CN === "string") names.push(cert.subject.CN);
      const issuer = [cert.issuer?.O, cert.issuer?.CN]
        .flat()
        .filter((x): x is string => typeof x === "string")
        .join(" · ");
      const identity = tls.checkServerIdentity(host, cert);
      const ended = Number.isFinite(expiresAt) && expiresAt <= (o.now ?? Date.now());
      const problems = [
        ended ? "it has ended" : "",
        identity ? `it isn't for ${host} (it is for ${names.join(", ") || "another name"})` : "",
        socket.authorized ? "" : `it isn't trusted (${String(socket.authorizationError ?? "")})`,
      ].filter(Boolean);
      done({
        expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
        issuer: issuer || null,
        names,
        valid: problems.length === 0,
        error: problems.length ? `The certificate is wrong: ${problems.join("; ")}.` : null,
      });
    });
  });
}

/** One uptime check: a GET, redirects not followed; up is any answer below 500. */
export function checkUrl(
  url: string,
  o: { timeoutMs?: number; now?: () => number } = {},
): Promise<Omit<SiteCheck, "at">> {
  const now = o.now ?? Date.now;
  return new Promise((resolve) => {
    const started = now();
    let settled = false;
    const finish = (c: Omit<SiteCheck, "at">) => {
      if (settled) return;
      settled = true;
      resolve(c);
    };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return finish({ up: false, status: null, latencyMs: null, error: "Not an address." });
    }
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.request(
      u,
      {
        method: "GET",
        timeout: o.timeoutMs ?? 10_000,
        // An ended certificate is the certificate's problem, said there; the site still answers.
        rejectUnauthorized: false,
        headers: { "user-agent": "Oraknid uptime check", accept: "*/*" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const latencyMs = Math.max(0, Math.round(now() - started));
        res.destroy();
        finish({
          up: status > 0 && status < 500,
          status,
          latencyMs,
          error: status >= 500 ? `It answered ${status}.` : null,
        });
      },
    );
    req.once("timeout", () => {
      req.destroy();
      finish({ up: false, status: null, latencyMs: null, error: "No answer in 10 seconds." });
    });
    req.once("error", (e) =>
      finish({ up: false, status: null, latencyMs: null, error: plainNet(e) }),
    );
    req.end();
  });
}

/** A network error in words. */
export function plainNet(e: Error): string {
  const code = (e as { code?: string }).code;
  switch (code) {
    case "ECONNREFUSED":
      return "The connection was refused: nothing listens there.";
    case "ENOTFOUND":
      return "No such domain: DNS doesn't know it.";
    case "ECONNRESET":
      return "The connection was cut.";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "The host can't be reached from here.";
    case "ETIMEDOUT":
      return "No answer.";
    default:
      return e.message;
  }
}
