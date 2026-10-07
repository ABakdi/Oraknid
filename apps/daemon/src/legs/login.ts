import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { legEnv } from "@oraknid/leg-antigravity";
import { resolveBinary, writeBaseConfig } from "@oraknid/leg-codex";
import type { Sandbox } from "@oraknid/os";
import { codexHomeOf, sandboxPlan } from "./plan.ts";
import type { LegRow } from "./registry.ts";

/** The link inside an OSC 8 hyperlink: whole, where the printed text is wrapped. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: reading the escape itself
const HYPERLINK = /\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)/;

// Logging a Leg in from the web UI (Legs → Adding a Leg, BR-22):
// Oraknid runs the official binary's own sign-in for the Leg's own
// folder, shows me its sign-in link, and passes back the code I paste.
// It never sees my password; the official binary keeps the login.
// Claude Code: `claude auth login`. Antigravity has no login command:
// `agy` signs in on its first start, and over SSH it prints a link and
// reads a code, so it runs under a pseudo-terminal with the SSH
// variables set (ADR-020). It runs in the Leg's own sandbox: outside it,
// `agy` finds my desktop keyring and never signs the Leg in (seen
// 2026-10-02 with agy 1.2.14). Codex (ADR-057): `codex login
// --device-auth` for the Leg's own CODEX_HOME shows a link and a one-time
// code I enter on OpenAI's page; it finishes by itself, nothing to paste.
// Where device codes are off for the account, its browser sign-in, which
// returns to localhost:1455 on this computer.

/** OSC 8 hyperlinks and other escape sequences the binary prints around the link. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are the escapes being removed
const ESCAPES = /\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;]*[A-Za-z]/g;

interface Pending {
  child: ChildProcess;
  output: string;
  exited: Promise<number | null>;
  timer: NodeJS.Timeout;
  /** Antigravity's earlier sign-in, put aside while I sign in again: back if this one doesn't finish. */
  aside?: { token: string; kept: string };
}

/** What starting a sign-in gives the UI: the link, and for Codex the code to enter there. */
export interface LoginStart {
  url: string;
  /** The one-time code to enter on the page (Codex's device sign-in). */
  userCode?: string;
  /** Anything else to know, in words. */
  note?: string;
}

const NO_DEVICE_CODES =
  "Device codes are off for this ChatGPT account, so this is Codex's browser sign-in: open the link in a browser on this computer (it returns to localhost:1455). Or turn on device code sign-in in ChatGPT's security settings and log in again.";

export class LegLogins {
  readonly #pending = new Map<string, Pending>();

  constructor(
    private readonly legsDir: string,
    /** Antigravity signs in inside the Leg's sandbox; tests may run without one. */
    private readonly sandbox: Sandbox | null = null,
    /** How long Done waits for Codex to see the sign-in finished. */
    private readonly codexWaitMs = 30_000,
  ) {}

  #agyHome(leg: LegRow) {
    const plan = this.sandbox ? sandboxPlan(leg, this.sandbox, this.legsDir) : null;
    return { plan, home: plan?.home ?? join(this.legsDir, leg.id, "home") };
  }

  /**
   * Signed in already, agy opens on its prompt and shows no link: signing in
   * again (another account, one out of quota) puts its token aside first.
   */
  #putAside(leg: LegRow): Pending["aside"] {
    const token = join(
      this.#agyHome(leg).home,
      ".gemini",
      "antigravity-cli",
      "antigravity-oauth-token",
    );
    if (!existsSync(token)) return undefined;
    const kept = `${token}.before-sign-in`;
    renameSync(token, kept);
    return { token, kept };
  }

  /** agy, in the Leg's sandbox when there is one, with the Leg's own home. */
  #agy(leg: LegRow, args: string[], terminal: boolean) {
    const { plan, home } = this.#agyHome(leg);
    const env = {
      ...legEnv(home, plan),
      ...(terminal
        ? {
            TERM: "xterm-256color",
            SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22",
            SSH_CLIENT: "127.0.0.1 0 22",
            SSH_TTY: "/dev/pts/0",
            BROWSER: "/bin/true",
          }
        : {}),
    };
    const quoted = [this.#binary(leg), ...args]
      .map((a) => `'${a.replaceAll("'", "'\\''")}'`)
      .join(" ");
    // A pseudo-terminal from util-linux's script(1), with a size: agy's sign-in screen wants one.
    const command = terminal ? "script" : this.#binary(leg);
    const argv = terminal ? ["-qfec", `stty rows 40 cols 120; exec ${quoted}`, "/dev/null"] : args;
    const wrapped = plan
      ? plan.sandbox.wrap({
          command,
          args: argv,
          cwd: home,
          writable: [home, ...plan.writable],
          readonly: plan.readonly,
          home,
          env,
          // Signing in may need the browser's callback to reach it: this computer's network, while I sign in.
          hostNetwork: true,
        })
      : { command, args: argv };
    return { ...wrapped, env, cwd: home };
  }

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
    const binary = String(
      (leg.config as { binary?: string }).binary ??
        (leg.kind === "antigravity" ? "agy" : leg.kind === "codex" ? "codex" : "claude"),
    );
    return leg.kind === "codex" ? resolveBinary(binary) : binary;
  }

  /** Codex for the Leg's own CODEX_HOME, its login kept in a file there (ADR-057). */
  #codexEnv(leg: LegRow): Record<string, string> {
    const home = join(this.legsDir, leg.id, "home");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const codexHome = codexHomeOf(leg, this.legsDir);
    writeBaseConfig(codexHome);
    return {
      PATH: process.env.PATH ?? "/usr/bin",
      LANG: process.env.LANG ?? "C.UTF-8",
      HOME: home,
      CODEX_HOME: codexHome,
      TERM: "dumb",
      NO_COLOR: "1",
      // The link is shown in the UI; nothing opens a browser on this machine.
      BROWSER: "/bin/true",
    };
  }

  /**
   * Codex's sign-in, its link (and with device codes, the code) once shown.
   * The process keeps waiting for the sign-in to complete on OpenAI's side.
   */
  async #startCodex(leg: LegRow, device: boolean): Promise<LoginStart> {
    const args = [
      "login",
      ...(device ? ["--device-auth"] : []),
      "-c",
      'cli_auth_credentials_store="file"',
    ];
    const child = spawn(this.#binary(leg), args, {
      env: this.#codexEnv(leg),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const pending: Pending = {
      child,
      output: "",
      exited: new Promise((resolve) => child.once("close", (code) => resolve(code))),
      // A device code lasts fifteen minutes.
      timer: setTimeout(() => this.cancel(leg.id), 16 * 60_000),
    };
    pending.timer.unref();
    child.once("error", (e) => {
      pending.output += `\n${e.message}`;
    });
    const add = (d: Buffer) => {
      pending.output += d.toString();
    };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    this.#pending.set(leg.id, pending);
    return new Promise<LoginStart>((resolve, reject) => {
      const deadline = setTimeout(() => {
        clearInterval(poll);
        this.cancel(leg.id);
        reject(new Error("Codex did not show a sign-in link within 20 s."));
      }, 20_000);
      const poll = setInterval(() => {
        const plain = pending.output.replace(ESCAPES, " ");
        const url = /https:\/\/\S+/.exec(plain)?.[0];
        const userCode = device
          ? /one-time code[^\n]*\n\s*([A-Z0-9]+(?:-[A-Z0-9]+)+)/i.exec(plain)?.[1]
          : undefined;
        if (url && (!device || userCode)) {
          clearInterval(poll);
          clearTimeout(deadline);
          resolve(userCode ? { url, userCode } : { url });
        } else if (child.exitCode !== null || child.signalCode !== null) {
          clearInterval(poll);
          clearTimeout(deadline);
          this.cancel(leg.id);
          const said = plain
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          const why = said.findLast((l) => /error|not enabled|failed/i.test(l)) ?? said.at(-1);
          reject(new Error(`Codex stopped before showing a link: ${why ?? "no output"}`));
        }
      }, 100);
    });
  }

  #spawn(leg: LegRow) {
    if (leg.kind === "antigravity") {
      const a = this.#agy(leg, [], true);
      return spawn(a.command, a.args, { cwd: a.cwd, env: a.env, stdio: ["pipe", "pipe", "pipe"] });
    }
    return spawn(this.#binary(leg), ["auth", "login", "--claudeai"], {
      env: this.#env(leg),
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  /** Starts the sign-in and returns the link to open. */
  async start(leg: LegRow): Promise<LoginStart> {
    if (leg.kind === "codex") {
      if ((leg.config as { auth?: string }).auth === "api-key")
        throw new Error("This Leg uses an OpenAI API key: there is nothing to log in.");
      this.cancel(leg.id);
      try {
        return await this.#startCodex(leg, true);
      } catch (error) {
        if (!/not enabled/i.test((error as Error).message)) throw error;
        return { ...(await this.#startCodex(leg, false)), note: NO_DEVICE_CODES };
      }
    }
    if (leg.kind !== "claude-code" && leg.kind !== "antigravity")
      throw new Error("Only Claude Code, Antigravity and Codex Legs log in this way.");
    if (leg.kind === "claude-code" && !(leg.config as { configDir?: string }).configDir)
      throw new Error("This Leg has no config folder of its own yet.");
    this.cancel(leg.id);
    const aside = leg.kind === "antigravity" ? this.#putAside(leg) : undefined;
    const child = this.#spawn(leg);
    const name = leg.kind === "antigravity" ? "Antigravity" : "Claude Code";
    const pending: Pending = {
      child,
      output: "",
      exited: new Promise((resolve) => child.once("close", (code) => resolve(code))),
      // A sign-in left open is abandoned after ten minutes.
      timer: setTimeout(() => this.cancel(leg.id), 10 * 60_000),
      ...(aside ? { aside } : {}),
    };
    pending.timer.unref();
    let chose = false;
    const add = (d: Buffer) => {
      const s = d.toString();
      pending.output += s;
      if (leg.kind !== "antigravity") return;
      // agy asks the terminal what it is, and waits: a plain terminal's answers.
      if (s.includes("\x1b[c") || s.includes("\x1b[>c"))
        child.stdin?.write("\x1b[?62;22c\x1b[>1;10;0c");
      if (s.includes("\x1b_G")) child.stdin?.write("\x1b_Gi=31;ENOTSUPPORTED\x1b\\");
      // Its first choice, "Google OAuth", is the one: a Google account's own sign-in.
      if (!chose && /login method/i.test(pending.output)) {
        chose = true;
        setTimeout(() => child.stdin?.write("\r"), 300);
      }
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
        const found =
          HYPERLINK.exec(pending.output)?.[1] ??
          /https:\/\/\S+/.exec(pending.output.replace(ESCAPES, " "))?.[0];
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
    if (leg.kind === "codex") return this.#finishCodex(leg, pending);
    const before = pending.output.length;
    // A terminal's Enter for agy, a line for claude.
    pending.child.stdin?.write(`${code.trim()}${leg.kind === "antigravity" ? "\r" : "\n"}`);
    if (leg.kind === "antigravity") return this.#finishAgy(leg, pending, before);
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

  /**
   * Codex finishes by itself once I've entered the code on OpenAI's page:
   * a while to see it exit; still waiting, the sign-in stays open to try again.
   */
  async #finishCodex(leg: LegRow, pending: Pending) {
    const exit = await Promise.race([
      pending.exited,
      new Promise<"waiting">((r) => setTimeout(() => r("waiting"), this.codexWaitMs)),
    ]);
    if (exit === "waiting")
      return {
        ok: false,
        detail:
          "Codex is still waiting: enter the code on OpenAI's page and sign in there, then press Done again.",
      };
    this.cancel(leg.id);
    const status = this.status(leg);
    if (status.loggedIn) return { ok: true, detail: status.detail };
    const lines = pending.output
      .replace(ESCAPES, " ")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    return {
      ok: false,
      detail:
        lines.findLast((l) => /error|expired|timed out|failed|denied/i.test(l)) ??
        "The sign-in did not succeed.",
    };
  }

  /** agy stays open after signing in: its own answer to "list models" says when it worked. */
  async #finishAgy(leg: LegRow, pending: Pending, before: number) {
    const deadline = Date.now() + 45_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const said = pending.output.slice(before).replace(ESCAPES, " ");
      if (/invalid|error|failed/i.test(said)) {
        this.cancel(leg.id);
        const line = said
          .split(/\r?\n|\r/)
          .map((l) => l.trim())
          .findLast((l) => /invalid|error|failed/i.test(l));
        return { ok: false, detail: line ?? "The code was not accepted." };
      }
      const status = this.status(leg);
      if (status.loggedIn) {
        this.cancel(leg.id, true);
        return { ok: true, detail: status.detail };
      }
      if (Date.now() > deadline || pending.child.exitCode !== null) {
        this.cancel(leg.id);
        return { ok: false, detail: "Antigravity did not finish the sign-in." };
      }
    }
  }

  /** What the official binary says about this Leg's login. */
  status(leg: LegRow): { loggedIn: boolean; detail: string } {
    if (leg.kind === "codex") {
      const r = spawnSync(this.#binary(leg), ["login", "status"], {
        env: this.#codexEnv(leg),
        encoding: "utf8",
        timeout: 15_000,
      });
      const line =
        `${r.stdout ?? ""}\n${r.stderr ?? ""}`
          .split("\n")
          .map((l) => l.trim())
          .find((l) => /logged in/i.test(l)) ?? "";
      return r.status === 0 && line && !/not logged in/i.test(line)
        ? { loggedIn: true, detail: `${line.replace(/\.$/, "")}.` }
        : { loggedIn: false, detail: "Not logged in." };
    }
    if (leg.kind === "antigravity") {
      // Listing its models needs a signed-in account (ADR-020).
      const a = this.#agy(leg, ["models"], false);
      const r = spawnSync(a.command, a.args, {
        cwd: a.cwd,
        env: a.env,
        encoding: "utf8",
        timeout: 30_000,
      });
      const said = `${r.stdout ?? ""}${r.stderr ?? ""}`;
      return r.status === 0 && !/authentication required|sign in/i.test(said)
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

  /** Ends a sign-in; one that didn't finish gives back the sign-in it replaced. */
  cancel(legId: string, signedIn = false) {
    const pending = this.#pending.get(legId);
    if (!pending) return;
    clearTimeout(pending.timer);
    try {
      pending.child.stdin?.end();
    } catch {}
    if (pending.child.exitCode === null) pending.child.kill("SIGTERM");
    this.#pending.delete(legId);
    const aside = pending.aside;
    if (!aside || !existsSync(aside.kept)) return;
    if (signedIn) rmSync(aside.kept, { force: true });
    else renameSync(aside.kept, aside.token);
  }

  stopAll() {
    for (const id of [...this.#pending.keys()]) this.cancel(id);
  }
}
