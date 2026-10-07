#!/usr/bin/env node
// A stand-in `codex` for tests (ADR-057), following codex-cli 0.161.0:
// the flags its `exec` and `exec resume` accept (from their --help), its
// `exec --json` events (codex-rs/exec, exec_events.rs), its hooks'
// protocol, `login status`, `login --device-auth`, `debug models` and the
// app server's `account/rateLimits/read`. The mode is read from
// $CODEX_HOME/.fake-codex-mode: reply | slow | tool | patch | mcp |
// rate-limit | no-device. A sign-in finishes when the test writes
// $CODEX_HOME/.fake-approved. Each run's arguments are kept in
// $CODEX_HOME/.fake-codex-args.json.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const home = process.env.CODEX_HOME;
if (args[0] === "--version") {
  console.log("codex-cli 0.161.0");
  process.exit(0);
}
if (!home || !existsSync(home)) {
  console.error(
    `Error: failed to resolve CODEX_HOME\n\nCaused by:\n    CODEX_HOME points to "${home}", but that path does not exist`,
  );
  process.exit(1);
}
const mode = existsSync(join(home, ".fake-codex-mode"))
  ? readFileSync(join(home, ".fake-codex-mode"), "utf8").trim()
  : "reply";
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const auth = join(home, "auth.json");
const approved = join(home, ".fake-approved");

const waitForApproval = () => {
  const timer = setInterval(() => {
    if (!existsSync(approved)) return;
    clearInterval(timer);
    writeFileSync(auth, JSON.stringify({ auth_mode: "chatgpt", tokens: { id_token: "fake" } }));
    console.error("Successfully logged in");
    process.exit(0);
  }, 50);
};

if (args[0] === "login") {
  if (args[1] === "status") {
    if (existsSync(auth)) {
      console.error("Logged in using ChatGPT");
      process.exit(0);
    }
    console.error("Not logged in");
    process.exit(1);
  }
  if (args.includes("--device-auth")) {
    if (mode === "no-device") {
      console.error(
        "Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.",
      );
      process.exit(1);
    }
    const B = "\x1b[94m";
    const G = "\x1b[90m";
    const R = "\x1b[0m";
    process.stderr.write(
      `\nWelcome to Codex [v${G}0.161.0${R}]\n${G}OpenAI's command-line coding agent${R}\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   ${B}https://auth.openai.com/codex/device${R}\n\n2. Enter this one-time code ${G}(expires in 15 minutes)${R}\n   ${B}ABCD-12345${R}\n\n${G}Continue only if you started this login in Codex. If a website or another person gave you this code, cancel.${R}\n`,
    );
    waitForApproval();
  } else {
    process.stderr.write(
      "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\n\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_fake&state=s1\n",
    );
    waitForApproval();
  }
} else if (args[0] === "debug" && args[1] === "models") {
  const level = (effort) => ({ effort, description: effort });
  console.log(
    JSON.stringify({
      models: [
        {
          slug: "gpt-6-sol",
          display_name: "GPT-6-Sol",
          visibility: "list",
          supported_in_api: true,
          supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(level),
          context_window: 272000,
        },
        {
          slug: "gpt-6-luna",
          display_name: "GPT-6-Luna",
          visibility: "list",
          supported_in_api: false,
          supported_reasoning_levels: ["low", "medium"].map(level),
          context_window: 272000,
        },
        {
          slug: "codex-auto-review",
          display_name: "Codex Auto Review",
          visibility: "hide",
          supported_reasoning_levels: [],
          context_window: 272000,
        },
      ],
    }),
  );
} else if (args[0] === "app-server") {
  createInterface({ input: process.stdin }).on("line", (line) => {
    const m = JSON.parse(line);
    if (m.method === "initialize")
      out({ id: m.id, result: { userAgent: "codex_cli_rs/0.161.0", codexHome: home } });
    else if (m.method === "account/rateLimits/read")
      out({
        id: m.id,
        result: {
          rateLimits: {
            limitId: "codex",
            primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1_800_000_000 },
            secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1_800_500_000 },
            planType: "plus",
          },
          rateLimitsByLimitId: null,
        },
      });
  });
} else if (args[0] === "exec") exec();
else {
  console.error(`error: unrecognized subcommand '${args[0]}'`);
  process.exit(2);
}

function exec() {
  const resume = args[1] === "resume";
  const rest = args.slice(resume ? 2 : 1);
  // The flags each accepts, from `codex exec --help` and `codex exec resume --help` (0.161.0).
  const valued = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "-i",
    "--image",
    "-m",
    "--model",
    "--output-schema",
    "-o",
    "--output-last-message",
    "--thread-source",
    "--cyber-access-program",
  ]);
  const execOnly = new Set([
    "--local-provider",
    "-p",
    "--profile",
    "-s",
    "--sandbox",
    "-C",
    "--cd",
    "--add-dir",
    "--color",
  ]);
  const switches = new Set([
    "--strict-config",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "--worktree",
    "--skip-git-repo-check",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--json",
  ]);
  const execSwitches = new Set(["--oss", "--approve-for-me"]);
  const resumeSwitches = new Set(["--last", "--all"]);
  const config = [];
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (valued.has(a) || (!resume && execOnly.has(a))) {
      if (a === "-c" || a === "--config") config.push(rest[i + 1]);
      i++;
    } else if (
      switches.has(a) ||
      (!resume && execSwitches.has(a)) ||
      (resume && resumeSwitches.has(a))
    ) {
      // a switch
    } else if (a.startsWith("-") && a !== "-") {
      console.error(`error: unexpected argument '${a}' found`);
      process.exit(2);
    } else positional.push(a);
  }
  writeFileSync(join(home, ".fake-codex-args.json"), JSON.stringify(args));
  const hookOf = (event) => {
    const c = config.find((x) => x.startsWith(`hooks.${event}=`));
    const m = c && /command=("(?:[^"\\]|\\.)*")/.exec(c);
    return m ? JSON.parse(m[1]) : null;
  };
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  const thread = resume ? positional[0] : randomUUID();
  const file = join(sessions, `${thread}.json`);
  if (resume && !existsSync(file)) {
    console.error(`Error: No saved session found with ID ${thread}`);
    process.exit(1);
  }
  const state = existsSync(file)
    ? JSON.parse(readFileSync(file, "utf8"))
    : {
        turns: [],
        totals: {
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_write_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
        },
      };

  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => {
    input += d;
  });
  process.stdin.on("end", () =>
    turn(input).catch((e) => {
      console.error(String(e));
      process.exit(1);
    }),
  );

  const runHook = (event, payload) => {
    const command = hookOf(event);
    // A Codex whose hooks don't run (a release that changed them): .fake-codex-no-hooks.
    if (!command || existsSync(join(home, ".fake-codex-no-hooks")))
      return { exit: 0, stdout: "", stderr: "" };
    const r = spawnSync("/bin/sh", ["-c", command], {
      input: JSON.stringify({
        session_id: thread,
        transcript_path: null,
        cwd: process.cwd(),
        hook_event_name: event,
        model: "gpt-6-sol",
        permission_mode: "bypassPermissions",
        turn_id: "turn-1",
        ...payload,
      }),
      encoding: "utf8",
      env: process.env,
    });
    return { exit: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const blocked = (r) => {
    if (r.exit === 2) return r.stderr.trim() || "blocked";
    try {
      const o = JSON.parse(r.stdout);
      if (o.hookSpecificOutput?.permissionDecision === "deny")
        return o.hookSpecificOutput.permissionDecisionReason;
    } catch {}
    return null;
  };
  let n = 0;
  const id = () => `item_${n++}`;
  const say = (text) =>
    out({ type: "item.completed", item: { id: id(), type: "agent_message", text } });

  async function turn(prompt) {
    state.turns.push(prompt);
    out({ type: "thread.started", thread_id: thread });
    out({ type: "turn.started" });
    if (mode === "rate-limit") {
      const message =
        "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Oct 9th, 2030 3:45 PM.";
      out({ type: "error", message });
      out({ type: "turn.failed", error: { message } });
      process.exit(1);
    }
    if (mode === "slow") {
      // Interrupted, codex exec ends the turn and exits with no event of its own.
      process.on("SIGINT", () => process.exit(130));
      for (;;) {
        say("thinking… ");
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    out({
      type: "item.completed",
      item: { id: id(), type: "reasoning", text: "**Answering the request**" },
    });
    if (mode === "tool") {
      const command = "echo hi";
      const why = blocked(
        runHook("PreToolUse", {
          tool_name: "Bash",
          tool_use_id: "call_1",
          tool_input: { command },
        }),
      );
      const item = { id: id(), type: "command_execution", command };
      if (why) {
        out({
          type: "item.completed",
          item: { ...item, aggregated_output: "", exit_code: null, status: "declined" },
        });
        say("I was not allowed to run it.");
      } else {
        out({
          type: "item.started",
          item: { ...item, aggregated_output: "", exit_code: null, status: "in_progress" },
        });
        out({
          type: "item.completed",
          item: { ...item, aggregated_output: "hi\n", exit_code: 0, status: "completed" },
        });
        say("Ran it.");
      }
    } else if (mode === "patch") {
      const patch = "*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** End Patch\n";
      const why = blocked(
        runHook("PreToolUse", {
          tool_name: "apply_patch",
          tool_use_id: "call_2",
          tool_input: { command: patch },
        }),
      );
      if (!why) {
        writeFileSync(join(process.cwd(), "notes.txt"), "hi\n");
        out({
          type: "item.completed",
          item: {
            id: id(),
            type: "file_change",
            changes: [{ path: join(process.cwd(), "notes.txt"), kind: "add" }],
            status: "completed",
          },
        });
      }
      say(why ? "Not allowed to write it." : "Wrote it.");
    } else if (mode === "mcp") {
      const why = blocked(
        runHook("PreToolUse", {
          tool_name: "mcp__oraknid-email__send",
          tool_use_id: "call_3",
          tool_input: { to: "a@b.c" },
        }),
      );
      const item = {
        id: id(),
        type: "mcp_tool_call",
        server: "oraknid-email",
        tool: "send",
        arguments: { to: "a@b.c" },
      };
      out({
        type: "item.started",
        item: { ...item, result: null, error: null, status: "in_progress" },
      });
      out({
        type: "item.completed",
        item: why
          ? { ...item, result: null, error: { message: why }, status: "failed" }
          : {
              ...item,
              result: { content: [{ type: "text", text: "sent" }] },
              error: null,
              status: "completed",
            },
      });
      say("Done.");
    } else say("hello");
    // The Stop hook, as Codex runs it: a block continues the turn with its reason.
    for (let i = 0; i < 5; i++) {
      const r = runHook("Stop", { last_assistant_message: "hello", stop_hook_active: i > 0 });
      let o = null;
      try {
        o = JSON.parse(r.stdout || "null");
      } catch {}
      if (o?.decision !== "block") break;
      say(`Fixed: ${o.reason.split("\n")[0]}`);
    }
    const t = state.totals;
    for (const [k, v] of Object.entries({
      input_tokens: 100,
      cached_input_tokens: 20,
      output_tokens: 10,
      reasoning_output_tokens: 4,
    }))
      t[k] += v;
    writeFileSync(file, JSON.stringify(state));
    out({ type: "turn.completed", usage: t });
    process.exit(0);
  }
}
