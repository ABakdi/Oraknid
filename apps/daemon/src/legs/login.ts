import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { legEnv } from "@oraknid/leg-antigravity";
import type { LegRow } from "./registry.ts";

// Logging a Leg in from the web UI (Legs → Adding a Leg, BR-22):
// Oraknid runs the official binary's own sign-in for the Leg's own
// folder, shows me its sign-in link, and passes back the code I paste.
// It never sees my password; the official binary keeps the login.
// Claude Code: `claude auth login`. Antigravity has no login command:
// `agy` signs in on its first start, and over SSH it prints a link and
// reads a code, so it runs under a pseudo-terminal with the SSH
// variables set (ADR-020).

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
    if (leg.kind === "antigravity")
      return {
        // The same home the Leg runs with, so the sign-in is this Leg's.
        ...legEnv(join(this.legsDir, leg.id, "home"), null),
        TERM: "xterm-256color",
        SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22",
        SSH_CLIENT: "127.0.0.1 0 22",
        SSH_TTY: "/dev/pts/0",
        BROWSER: "/bin/true",
      };
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
    return String(
      (leg.config as { binary?: string }).binary ?? (leg.kind === "antigravity" ? "agy" : "claude"),
    );
  }

  #spawn(leg: LegRow) {
    if (leg.kind === "antigravity")
      // A pseudo-terminal from util-linux's script(1): agy's sign-in wants one.
      return spawn("script", ["-qfec", this.#binary(leg), "/dev/null"], {
        env: this.#env(leg),
        stdio: ["pipe", "pipe", "pipe"],
      });
    return spawn(this.#binary(leg), ["auth", "login", "--claudeai"], {
      env: this.#env(leg),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** Starts the sign-in and returns the link to open. */
  async start(leg: LegRow): Promise<{ url: string }> {
    if (leg.kind !== "claude-code" && leg.kind !== "antigravity")
      throw new Error("Only Claude Code and Antigravity Legs log in this way.");
    if (leg.kind === "claude-code" && !(leg.config as { configDir?: string }).configDir)
      throw new Error("This Leg has no config folder of its own yet.");
    this.cancel(leg.id);
    const child = this.#spawn(leg);
    const name = leg.kind === "antigravity" ? "Antigravity" : "Claude Code";
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
        reject(new Error(`${name} did not show a sign-in link within 20 s.`));
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
          reject(new Error(`${name} stopped before showing a link: ${pending.output.trim()}`));
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
    // A terminal's Enter for agy, a line for claude.
    pending.child.stdin?.write(`${code.trim()}${leg.kind === "antigravity" ? "\r" : "\n"}`);
    // Claude Code exits once logged in; agy goes on to its prompt, so a
    // quiet few seconds after the code is its success. With a wrong code
    // either says so and asks again.
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
      new Promise<"slow">((r) =>
        setTimeout(() => r("slow"), leg.kind === "antigravity" ? 8_000 : 60_000),
      ),
    ]);
    this.cancel(leg.id);
    const status = this.status(leg);
    if (status.loggedIn) return { ok: true, detail: status.detail };
    const lines = pending.output
      .replace(ESCAPES, " ")
      .split(/\r?\n|\r/)
      .map((l) => l.replace(/^.*?prompted >\s*/, "").trim())
      .filter(Boolean);
    // What went wrong, rather than the prompt asking again.
    const said = lines.findLast((l) => /invalid|error|failed/i.test(l)) ?? lines.at(-1);
    return {
      ok: false,
      detail:
        exit === "slow"
          ? `${leg.kind === "antigravity" ? "Antigravity" : "Claude Code"} did not finish the sign-in.`
          : (said ?? "The sign-in did not succeed."),
    };
  }

  /** What the official binary says about this Leg's login. */
  status(leg: LegRow): { loggedIn: boolean; detail: string } {
    if (leg.kind === "antigravity") {
      // Listing its models needs a signed-in account (ADR-020).
      const r = spawnSync(this.#binary(leg), ["models"], {
        env: this.#env(leg),
        encoding: "utf8",
        timeout: 30_000,
      });
      const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      return r.status === 0 && !/authentication required/i.test(said)
        ? { loggedIn: true, detail: "Signed in." }
        : { loggedIn: false, detail: said.trim().split("\n").at(-1) || "Not signed in." };
    }
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
