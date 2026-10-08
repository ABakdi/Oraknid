import { createHash } from "node:crypto";
import { SideEffects } from "../engine/effects.ts";
import type { BrokerSession } from "../tools/broker.ts";
import type { ToolRow } from "../tools/registry.ts";
import { asPermission, type Gate } from "./gate.ts";
import type { AttemptDeps, AttemptJob } from "./types.ts";

// The job's tools for an attempt's sessions (ADR-021), through Oraknid's
// MCP broker: every call decided by the Gate (ADR-056 §3), a send made at
// most once (BR-6), what came from outside marking the task untrusted
// (BR-15). Opened with the attempt's first session, closed with it.

const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

export function jobTools(
  d: AttemptDeps,
  job: AttemptJob,
  taskId: string,
  o: {
    toolRows: ToolRow[];
    gate: Gate;
    event: (type: string, payload: Record<string, unknown>) => void;
  },
) {
  const { toolRows, gate, event } = o;
  let open = null as BrokerSession | null;
  /** A send's place in the outbox: the same message, to the same place, is one action. */
  const sendSpec = (tool: ToolRow, name: string, args: Record<string, unknown>) => ({
    key: `mcp:${tool.name}:${name}:${hash(JSON.stringify(args))}`,
    taskId,
  });
  return {
    /** The broker's session for this attempt, opened once; null without tools. */
    async open(): Promise<BrokerSession | null> {
      if (open || !toolRows.length || !d.tools) return open;
      open = await d.tools.broker.open(
        toolRows,
        {
          decide: async (tool, name, args) => {
            const sends = tool.sends.includes(name) && d.effects;
            const spec = sendSpec(tool, name, args);
            if (sends) {
              // At most once (BR-6): a send already made, or caught mid-way by a crash, isn't made again.
              const before = d.effects?.get(SideEffects.keyOf(job.id, spec));
              if (before?.state === "performed" || before?.state === "confirmed")
                return {
                  allow: false,
                  message: `This exact ${name} was already made in this job; Oraknid doesn't repeat it.`,
                };
              if (before?.state === "performing")
                return {
                  allow: false,
                  message: `An identical ${name} was interrupted mid-way; the owner is asked whether it happened before it is tried again.`,
                };
            }
            const judged = d.tools?.registry.judge(tool, { jobId: job.id }, name, args);
            const v = asPermission(
              await gate.decide({
                source: "mcp",
                request: {
                  tool: `mcp__${tool.name}__${name}`,
                  input: args,
                  command: null,
                  path: null,
                },
                ...(judged !== undefined ? { judged } : {}),
              }),
            );
            // Work on the project's linked repo passes without asking: said in the job's events (ADR-038).
            if (v.allow && typeof judged === "object")
              event("tool.linked", { tool: tool.name, name, reason: "the project's linked repo" });
            if (v.allow && sends && d.effects) {
              const row = d.effects.intend(job.id, {
                ...spec,
                action: `${tool.name}.${name}`,
                payload: { tool: tool.name, name, args },
              });
              d.effects.set(row.idempotencyKey, "performing");
            }
            return v;
          },
          done: (tool, name, r) => {
            if (r.allowed && tool.sends.includes(name) && d.effects) {
              const key = SideEffects.keyOf(job.id, sendSpec(tool, name, r.args));
              if (d.effects.get(key)?.state === "performing")
                d.effects.set(
                  key,
                  r.ok ? "performed" : "failed",
                  r.ok ? { result: { bytes: r.bytes } } : { problem: "the tool said it failed" },
                );
            }
            event("tool.called", {
              tool: tool.name,
              name,
              allowed: r.allowed,
              ok: r.ok,
              bytes: r.bytes,
              ...(r.flags.length ? { flags: r.flags } : {}),
            });
            // What came from outside makes the task untrusted (BR-15).
            if (r.allowed && tool.untrusted)
              gate.markUntrusted(
                `read from ${tool.name} (${name}): gated actions ask me from now on`,
              );
          },
        },
        { jobId: job.id },
      );
      return open;
    },
    close() {
      open?.close();
    },
  };
}
