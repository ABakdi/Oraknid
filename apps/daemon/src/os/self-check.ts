import { readFile } from "node:fs/promises";
import { request } from "node:http";

// ADR-070: the daemon looks at itself. Every 30 s it reads a small file
// through the thread pool and asks for its own index; when it can't for
// two minutes on end, it says why and exits non-zero, so the service
// manager starts it again. Seen 2026-10-16: alive, /health answering, and
// every page hanging behind a thread pool full of keychain calls.

export interface Probe {
  name: string;
  run: () => Promise<void>;
}

export interface SelfCheckOptions {
  probes: Probe[];
  everyMs?: number;
  /** How long one probe may take. */
  timeoutMs?: number;
  /** Failing this long on end: the daemon exits. */
  giveUpMs?: number;
  now?: () => number;
  log: (message: string) => void;
  /** Ends the process (tests: a stand-in); only under a service manager that restarts it. */
  exit?: ((code: number) => void) | null;
}

/** The promise, or its failing once `ms` have gone by. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms);
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

export function startSelfCheck(o: SelfCheckOptions) {
  const now = o.now ?? Date.now;
  const giveUp = o.giveUpMs ?? 120_000;
  let failingSince: number | null = null;
  let running = false;
  let ended = false;

  /** One round: every probe, each within its time. */
  const check = async (): Promise<{ ok: boolean; problems: string[] }> => {
    if (running || ended) return { ok: true, problems: [] };
    running = true;
    try {
      const problems: string[] = [];
      for (const p of o.probes) {
        try {
          await within(p.run(), o.timeoutMs ?? 10_000, p.name);
        } catch (error) {
          problems.push(error instanceof Error ? error.message : String(error));
        }
      }
      if (!problems.length) {
        if (failingSince !== null)
          o.log(`Self-check: well again after ${Math.round((now() - failingSince) / 1000)} s.`);
        failingSince = null;
        return { ok: true, problems };
      }
      if (failingSince === null) {
        failingSince = now();
        o.log(`Self-check failed: ${problems.join("; ")}.`);
      }
      const failing = now() - failingSince;
      if (failing >= giveUp) {
        if (o.exit) {
          ended = true;
          o.log(
            `Self-check: failing for ${Math.round(failing / 1000)} s (${problems.join("; ")}); exiting so the service manager starts Oraknid again.`,
          );
          o.exit(70);
        } else if (failing - giveUp < (o.everyMs ?? 30_000)) {
          o.log(
            `Self-check: failing for ${Math.round(failing / 1000)} s (${problems.join("; ")}); no service manager restarts Oraknid here, so it keeps running. Restart it: oraknid stop, then oraknid start.`,
          );
        }
      }
      return { ok: false, problems };
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void check(), o.everyMs ?? 30_000);
  timer.unref();
  return {
    check,
    stop() {
      ended = true;
      clearInterval(timer);
    },
  };
}

/** Reads a small file through the thread pool. */
export function poolProbe(file: string): Probe {
  return {
    name: "a file read through the thread pool",
    run: async () => {
      await readFile(file);
    },
  };
}

/** Asks the daemon for its own page, as a browser would. */
export function pageProbe(url: () => string): Probe {
  return {
    name: "its own page",
    run: () =>
      new Promise<void>((resolve, reject) => {
        const req = request(`${url()}/`, { agent: false }, (res) => {
          res.resume();
          res.once("end", () =>
            (res.statusCode ?? 500) < 500
              ? resolve()
              : reject(new Error(`its page answered ${res.statusCode}`)),
          );
        });
        req.once("error", reject);
        req.end();
      }),
  };
}

/** A service manager restarts this daemon: the service's unit says so, or systemd runs it. */
export function supervised(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ORAKNID_SUPERVISED === "1" || !!env.INVOCATION_ID;
}
