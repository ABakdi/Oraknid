import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shellWord } from "./parse.ts";

// Codex's hooks, answered by Oraknid (ADR-057). Codex runs a hook as a
// command, with the event as JSON on stdin; this one is a few lines of
// Node that pass it to the adapter over a unix socket and print the
// answer. The socket's folder is bound into the sandbox, as the MCP
// bridges' are (ADR-021).

/** The hook command's script: the event in, Oraknid's answer out. */
const HOOK_SCRIPT = `import { connect } from "node:net";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let stop = false;
  try { stop = JSON.parse(input).hook_event_name === "Stop"; } catch {}
  // A tool Oraknid couldn't check is not run (exit 2 blocks it); a turn's end goes ahead.
  const fail = (why) => {
    if (stop) process.exit(0);
    process.stderr.write("Oraknid could not check this action (" + why + "), so it was not run.\\n");
    process.exit(2);
  };
  const s = connect(process.argv[2]);
  let out = "";
  s.setEncoding("utf8");
  s.on("error", (e) => fail(e.message));
  s.on("data", (d) => { out += d; });
  s.on("end", () => {
    let r;
    try { r = JSON.parse(out); } catch { return fail("no answer"); }
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    process.exit(typeof r.exit === "number" ? r.exit : 0);
  });
  s.end(input);
});
`;

/** What the hook prints and how it exits (Codex's hook protocol). */
export interface HookReply {
  exit: number;
  stdout?: string;
  stderr?: string;
}

export interface HookServer {
  /** The folder holding the socket and the script: writable in the sandbox. */
  dir: string;
  /** The hook command for Codex's config. */
  command: string;
  close(): void;
}

/** Listens for one session's hook calls; `handle` answers each. */
export async function startHookServer(
  handle: (input: Record<string, unknown>) => Promise<HookReply>,
): Promise<HookServer> {
  const dir = mkdtempSync(join(tmpdir(), "oraknid-codex-"));
  const script = join(dir, "hook.mjs");
  const socket = join(dir, "hook.sock");
  writeFileSync(script, HOOK_SCRIPT);
  const server: Server = createServer({ allowHalfOpen: true }, (client) => {
    let body = "";
    client.setEncoding("utf8");
    client.on("data", (d) => {
      body += d;
    });
    client.on("error", () => {});
    client.on("end", () => {
      let input: Record<string, unknown>;
      try {
        input = JSON.parse(body) as Record<string, unknown>;
      } catch {
        client.end(JSON.stringify({ exit: 2, stderr: "Oraknid could not read the hook's input." }));
        return;
      }
      handle(input)
        .catch(
          (e: unknown): HookReply => ({
            exit: input.hook_event_name === "Stop" ? 0 : 2,
            stderr: `Oraknid's check failed (${e instanceof Error ? e.message : String(e)}), so it was not run.`,
          }),
        )
        .then((reply) => {
          if (!client.destroyed) client.end(JSON.stringify(reply));
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  return {
    dir,
    command: [process.execPath, script, socket].map(shellWord).join(" "),
    close: () => {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
