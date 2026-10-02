#!/usr/bin/env node
// A stand-in `agy` for tests, following Antigravity's headless docs
// (ADR-020). Where the docs are silent (the soft-deny notice, the quota
// error) it follows the adapter's guess. The mode is read from
// $HOME/.fake-agy-mode: reply | slow | tool | rate-limit | signed-out.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const home = process.env.HOME ?? ".";
const mode = existsSync(join(home, ".fake-agy-mode"))
  ? readFileSync(join(home, ".fake-agy-mode"), "utf8").trim()
  : "reply";
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const usage = {
  input_tokens: 10,
  output_tokens: 5,
  thinking_tokens: 2,
  cache_read_tokens: 0,
  total_tokens: 17,
};

if (args[0] === "--version") {
  console.log("1.0.0-fake");
  process.exit(0);
}
const token = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
// Interactive start, not signed in, over SSH: a link, then a code.
if (
  args.length === 0 &&
  mode === "signed-out" &&
  !existsSync(token) &&
  process.env.SSH_CONNECTION
) {
  process.stdout.write(
    "Sign in: open https://accounts.google.com/o/oauth2/auth?client=agy&state=x1\r\nEnter the authorization code: ",
  );
  createInterface({ input: process.stdin }).on("line", (code) => {
    if (code.trim() !== "good-code") {
      process.stdout.write("Invalid code, try again.\r\nEnter the authorization code: ");
      return;
    }
    mkdirSync(join(home, ".gemini", "antigravity-cli"), { recursive: true });
    writeFileSync(token, "fake-token");
    // On to its prompt, as the real one does.
    process.stdout.write("Signed in.\r\n> ");
  });
  setInterval(() => {}, 1000);
} else if (args[0] === "models") {
  if (mode === "signed-out" && !existsSync(token)) {
    console.error("error: authentication required");
    process.exit(1);
  }
  console.log("gemini-3.8-pro-high\ngemini-3.8-flash-high");
  process.exit(0);
} else main();

function main() {
  const at = args.indexOf("--conversation");
  const conversation = at >= 0 ? args[at + 1] : `conv-${process.pid}-${Date.now()}`;
  const store = join(home, ".fake-agy");
  mkdirSync(store, { recursive: true });
  const history = join(store, `${conversation}.json`);
  const past = existsSync(history) ? JSON.parse(readFileSync(history, "utf8")) : [];

  const allowed = () => {
    const f = join(home, ".gemini", "antigravity-cli", "settings.json");
    const list = existsSync(f)
      ? (JSON.parse(readFileSync(f, "utf8")).permissions?.allow ?? [])
      : [];
    return list.map((p) => new RegExp(/^command\(regex:(.*)\)$/.exec(p)?.[1] ?? "$^"));
  };

  const result = (extra) =>
    out({
      event: "result",
      result: {
        conversation_id: conversation,
        status: "SUCCESS",
        response: "",
        error: "",
        usage,
        num_turns: past.length,
        ...extra,
      },
    });

  const lines = createInterface({ input: process.stdin });
  lines.on("line", async (line) => {
    const content = JSON.parse(line).message.content;
    past.push(content);
    writeFileSync(history, JSON.stringify(past));
    out({ event: "init", init: { cwd: process.cwd(), permission_mode: "default" } });
    if (mode === "rate-limit") {
      result({
        status: "ERROR",
        error: "RESOURCE_EXHAUSTED: weekly quota exceeded, resets in 3600s",
      });
      process.exit(1);
    }
    if (mode === "slow") {
      process.on("SIGINT", () => {
        result({ status: "INTERRUPTED" });
        process.exit(130);
      });
      for (;;) {
        out({
          event: "step_update",
          step_update: { step_index: 0, state: "ACTIVE", text_delta: "thinking… " },
        });
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (mode === "tool" && !/^Denied:/m.test(content)) {
      const command = "echo hi";
      if (allowed().some((r) => r.test(command))) {
        const tool_info = { id: "t1", name: "run_command", input: { command } };
        out({
          event: "step_update",
          step_update: { step_index: 1, state: "ACTIVE", step_type: "TOOL", tool_info },
        });
        out({
          event: "step_update",
          step_update: {
            step_index: 1,
            state: "DONE",
            step_type: "TOOL",
            tool_info: { ...tool_info, output: "hi\n" },
          },
        });
        out({
          event: "step_update",
          step_update: { step_index: 2, state: "DONE", text_delta: "Ran it." },
        });
        result({ response: "Ran it." });
      } else {
        console.error(`notice: permission denied for command(${command}): not in the allow list`);
        out({
          event: "step_update",
          step_update: { step_index: 1, state: "DONE", text_delta: "I need approval." },
        });
        result({ response: "I need approval." });
      }
      return;
    }
    out({
      event: "step_update",
      step_update: { step_index: 0, state: "DONE", text_delta: "hello" },
    });
    result({ response: "hello" });
  });
  lines.on("close", () => process.exit(0));
}
