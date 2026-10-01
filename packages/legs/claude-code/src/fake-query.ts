import type { Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { Channel } from "@oraknid/leg-sdk";
import type { Script } from "@oraknid/leg-sdk/contract";
import type { QueryFn } from "./adapter.ts";

/**
 * A scripted stand-in for the Agent SDK's query(): the same messages and
 * control calls, without a binary or an account. The first turn follows
 * `script`; later turns reply.
 */
export function fakeQuery(script: Script, seen: { options: Options[] } = { options: [] }): QueryFn {
  return ({ prompt, options }) => {
    seen.options.push(options);
    const out = new Channel<SDKMessage>();
    const sessionId = options.resume ?? `sess-${Math.random().toString(36).slice(2)}`;
    let closed = false;
    let stopSlow: (() => void) | null = null;
    let turn = 0;
    const m = (x: unknown) => out.push(x as SDKMessage);

    const text = (t: string) => {
      m({
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: t } },
      });
    };
    const result = (subtype: string, isError: boolean, resultText: string) =>
      m({
        type: "result",
        subtype,
        is_error: isError,
        result: resultText,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 0,
        },
        modelUsage: { [options.model ?? "m"]: { contextWindow: 200_000 } },
        num_turns: 1,
        session_id: sessionId,
      });

    async function runTurn(kind: Script) {
      if (kind === "reply") {
        text("o");
        text("k");
        result("success", false, "ok");
      } else if (kind === "slow") {
        await new Promise<void>((resolve) => {
          stopSlow = resolve;
          const tick = () => {
            if (closed || stopSlow === null) return;
            text(".");
            setTimeout(tick, 10);
          };
          tick();
        });
        stopSlow = null;
        result("error_during_execution", true, "");
      } else if (kind === "tool") {
        const input = { command: "echo hi" };
        m({
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input }] },
          session_id: sessionId,
        });
        const decision = await (options.canUseTool as NonNullable<Options["canUseTool"]>)(
          "Bash",
          input,
          {
            signal: new AbortController().signal,
            toolUseID: "t1",
          } as never,
        );
        const ok = decision?.behavior === "allow";
        m({
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "t1",
                is_error: !ok,
                content: decision && "message" in decision ? decision.message : "hi",
              },
            ],
          },
          session_id: sessionId,
        });
        text("done");
        result("success", false, "done");
      } else {
        m({
          type: "rate_limit_event",
          rate_limit_info: {
            status: "rejected",
            rateLimitType: "five_hour",
            resetsAt: 1_790_000_000,
            utilization: 1,
          },
          session_id: sessionId,
        });
        m({
          type: "assistant",
          error: "rate_limit",
          message: { content: [] },
          session_id: sessionId,
        });
        result("success", true, "");
      }
    }

    m({ type: "system", subtype: "init", session_id: sessionId });
    void (async () => {
      for await (const _msg of prompt as AsyncIterable<SDKUserMessage>) {
        if (closed) break;
        turn++;
        await runTurn(turn === 1 ? script : "reply");
      }
      out.end();
    })();

    const q = {
      [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
      interrupt: async () => {
        stopSlow?.();
        return undefined;
      },
      close: () => {
        closed = true;
        stopSlow?.();
        out.end();
      },
      supportedModels: async () => [
        {
          value: "opus",
          displayName: "Opus",
          description: "",
          supportedEffortLevels: ["low", "medium", "high"],
        },
        { value: "haiku", displayName: "Haiku", description: "" },
      ],
      accountInfo: async () => ({ email: "me@example.com", subscriptionType: "max" }),
    };
    return q as unknown as Query;
  };
}
