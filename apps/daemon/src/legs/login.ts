import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LegRow } from "./registry.ts";

// Logging a Claude Code Leg in from the web UI (Legs → Adding a Leg):
// Oraknid runs the official `claude auth login` for the Leg's own config
// folder, shows me its sign-in link, and passes back the code I paste.
// It never sees my password; the official binary keeps the login.

/** OSC 8 hyperlinks and other escape sequences the binary prints around the link. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the escapes being removed
const ESCAPES = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g;

interface Pending {
  child: ChildProcess;
  output: string;
  exited: Promise<number | null>;
  timer: NodeJS.Timeout;
}

export class LegLogins {
  readonly #pending = new Map<string, Pending>();

  constructor(private readonly legsDir: string) {}

  #env(leg: LegRow): Record<string, string> {
    const config = leg.config as { configDir?: string };
    const home = join(this.legsDir, leg.id, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    return {
      PATH: process.env.PATH ?? "/usr/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: home,
      CLAUDE_CONFIG_DIR: String(config.configDir ?? ""),
      // The link is shown in the UI; nothing opens a browser on this machine.
      BROWSER: "/bin/true",
    };
  }

  #binary(leg: LegRow) {
    return String((leg.config as { binary?: string }).binary ?? "claude");
  }

  /** Starts the sign-in and returns the link to open. */
  async start(leg: LegRow): Promise<{ url: string }> {
    if (leg.kind !== "claude-code") throw new Error("Only a Claude Code Leg logs in this way.");
    if (!(leg.config as { configDir?: string }).configDir)
      throw new Error("This Leg has no config folder of its own yet.");
    this.cancel(leg.id);
    const child = spawn(this.#binary(leg), ["auth", "login", "--claudeai"], {
      env: this.#env(leg),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending: Pending = {
      child,
      output: "",
      exited: new Promise((resolve) => child.once("close", (code) => resolve(code))),
      // A sign-in left open is abandoned after ten minutes.
      timer: setTimeout(() => this.cancel(leg.id), 10 * 60_000),
    };
    pending.timer.unref();
    const add = (d: Buffer) => {
      pending.output += d.toString();
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    this.#pending.set(leg.id, pending);
    const url = await new Promise<string>((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        reject(new Error("Claude Code did not show a sign-in link within 20 s."));
      }, 20_000);
      const poll = setInterval(() => {
        const found = /https:\/\/\S+/.exec(pending.output.replace(ESCAPES, " "))?.[0];
        if (found) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve(found);
        } else if (child.exitCode !== null) {
          clearInterval(poll);
          clearTimeout(deadline);
          reject(new Error(`Claude Code stopped before showing a link: ${pending.output.trim()}`));
        }
      }, 100);
    });
    return { url };
  }

  /** Passes the code shown after signing in, and says whether the Leg is now logged in. */
  async finish(leg: LegRow, code: string): Promise<{ ok: boolean; detail: string }> {
    const pending = this.#pending.get(leg.id);
    if (!pending) throw new Error("Start the sign-in first: the link has expired.");
    const before = pending.output.length;
    pending.child.stdin?.write(`${code.trim()}\n`);
    // The binary exits once logged in; with a wrong code it says so and asks again.
    const exit = await Promise.race([
      pending.exited,
      new Promise<"invalid">((resolve) => {
        const poll = setInterval(() => {
          if (/invalid|error|failed/i.test(pending.output.slice(before))) {
            clearInterval(poll);
            resolve("invalid");
          }
        }, 100);
        pending.exited.then(() => clearInterval(poll));
      }),
      new Promise<"slow">((r) => setTimeout(() => r("slow"), 60_000)),
    ]);
    this.cancel(leg.id);
    const status = this.status(leg);
    if (status.loggedIn) return { ok: true, detail: status.detail };
    const said = pending.output
      .replace(ESCAPES, " ")
      .split("\n")
      .map((l) => l.replace(/^.*?prompted >\s*/, "").trim())
      .filter(Boolean)
      .at(-1);
    return {
      ok: false,
      detail:
        exit === "slow"
          ? "Claude Code did not finish the sign-in."
          : (said ?? "The sign-in did not succeed."),
    };
  }

  /** What the official binary says about this Leg's login. */
  status(leg: LegRow): { loggedIn: boolean; detail: string } {
    const r = spawnSync(this.#binary(leg), ["auth", "status", "--json"], {
      env: this.#env(leg),
      encoding: "utf8",
      timeout: 15_000,
    });
    try {
      const s = JSON.parse(r.stdout) as {
        loggedIn?: boolean;
        email?: string;
        subscriptionType?: string;
      };
      return {
        loggedIn: s.loggedIn === true,
        detail: s.loggedIn
          ? `Logged in${s.email ? ` as ${s.email}` : ""}${s.subscriptionType ? ` (${s.subscriptionType})` : ""}.`
          : "Not logged in.",
      };
    } catch {
      return {
        loggedIn: false,
        detail: (r.stderr || r.stdout || "No answer from Claude Code.").trim(),
      };
    }
  }

  cancel(legId: string) {
    const pending = this.#pending.get(legId);
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      pending.child.stdin?.end();
    } catch {}
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    this.#pending.delete(legId);
  }

  stopAll() {
    for (const id of [...this.#pending.keys()]) this.cancel(id);
  }
}
