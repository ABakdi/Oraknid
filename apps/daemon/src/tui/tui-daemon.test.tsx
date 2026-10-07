import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { render } from "ink-testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { type Daemon, startDaemon } from "../daemon.ts";
import { resolvePaths } from "../paths.ts";
import { fakeOs } from "../testing/fake-os.ts";
import type { Api } from "./actions.ts";
import { App } from "./app.tsx";
import { LiveSocket } from "./live.ts";
import { plain } from "./markdown.ts";

// The terminal app against a whole daemon (ADR-055): the CLI's token, the
// real procedures and the live socket; a data folder and port of its own.

let daemon: Daemon | undefined;
let live: LiveSocket | undefined;
let app: { unmount: () => void } | undefined;
afterEach(async () => {
  app?.unmount();
  live?.close();
  await daemon?.close();
});

describe("the terminal app on a daemon", () => {
  it("talks to it with the CLI's token: the project, live, commands, settings, local models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oraknid-tui-"));
    daemon = await startDaemon({
      paths: resolvePaths({ ORAKNID_DATA_DIR: dir, ORAKNID_CONFIG_DIR: dir }),
      port: 0,
      dbFile: ":memory:",
      os: fakeOs().os,
      webDir: null,
    });
    const api: Api = createORPCClient(
      new RPCLink({
        url: `${daemon.url}/api`,
        headers: { authorization: `Bearer ${daemon.cliToken}` },
      }),
    );
    await api.projects.create({
      name: "piano",
      workspacePath: mkdtempSync(join(tmpdir(), "oraknid-tui-ws-")),
      initGit: false,
    });
    live = new LiveSocket(daemon.url, daemon.cliToken);
    live.start();
    const r = render(<App api={api} live={live} size={{ rows: 40, columns: 110 }} />);
    app = r;
    const frame = () => plain(r.lastFrame() ?? "");
    const until = async (pred: (f: string) => boolean, ms = 5000) => {
      const deadline = Date.now() + ms;
      while (!pred(frame())) {
        if (Date.now() > deadline) throw new Error(`timed out; the screen:\n${frame()}`);
        await new Promise((res) => setTimeout(res, 25));
      }
    };
    const run = async (line: string) => {
      for (const ch of line) {
        r.stdin.write(ch);
        await new Promise((res) => setTimeout(res, 3));
      }
      // Past the completion menu: a command with nothing after it runs as it is.
      r.stdin.write("\r");
      await new Promise((res) => setTimeout(res, 50));
    };
    const esc = async () => {
      r.stdin.write("\x1b");
      await new Promise((res) => setTimeout(res, 80));
    };

    await until((f) => f.includes("◉ piano") && f.includes("● live"));
    expect(frame()).toContain("Nothing said yet.");

    await run("/projects");
    await until((f) => f.includes("1. piano") && f.includes("● current"));
    await esc();

    // Settings read and written through their real procedures.
    await run("/settings max-running-jobs 3");
    await until((f) => f.includes("max-running-jobs is now 3."));
    await run("/settings terminal on");
    await until((f) => f.includes("terminal is now on."));
    expect(await api.settings.terminal()).toBe(true);
    await run("/settings");
    await until((f) => f.includes("max-tasks-per-job: auto") && f.includes("interview-rounds:"));
    await esc();

    // Local models (ADR-054) through the daemon's own procedures; a daemon without them is
    // tested against the stand-in API (tui.test.tsx).
    await run("/models");
    await until((f) => f.includes("Local models") && f.includes("None yet."));
    await esc();

    await run("/doctor");
    await until((f) => f.includes("Doctor") && /[✓✗] /.test(f));
    await esc();

    await run("/servers");
    await until((f) => f.includes("No servers yet"));
  });
});
