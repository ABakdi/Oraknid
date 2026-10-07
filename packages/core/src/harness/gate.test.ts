import type { Autonomy } from "@oraknid/contracts";
import { describe, expect, it } from "vitest";
import type { PolicyVerdict } from "../policy.ts";
import { type GateFacts, type GateSource, gateStep, onceGrantFor, refusalKey } from "./gate.ts";

// The Gate's decision, table-tested (ADR-056 §3): source × the rules'
// verdict × the grants × the judge × the autonomy level (a production
// server's change is the rules' "ask", gated by nothing) → one decision.

const allow: PolicyVerdict = { verdict: "allow", reason: "reads only" };
const blocked: PolicyVerdict = {
  verdict: "deny",
  reason: "[CC Safety Net] rm -rf outside the folder",
  drift: null,
  message: "Blocked: rm -rf outside the folder.",
};
const never: PolicyVerdict = {
  verdict: "deny",
  reason: "never allowed: it runs as root",
  drift: "D7",
};
const gated: PolicyVerdict = { verdict: "ask", reason: "push needs my approval", gated: "push" };
const production: PolicyVerdict = {
  verdict: "ask",
  reason: "it may change VPS One, which is production",
  gated: null,
};
const judged: PolicyVerdict = {
  verdict: "judge",
  reason: "it is a install",
  programs: ["npm"],
  reach: "local",
};

type Row = [
  name: string,
  source: GateSource,
  rules: PolicyVerdict,
  more: Partial<Omit<GateFacts, "source" | "rules">>,
  expected: Record<string, unknown>,
];

const ok = { judge: { verdict: "allow" as const, reason: "it serves the task" } };
const no = {
  judge: { verdict: "block" as const, reason: "[Exfiltrating data] it sends files out" },
};
const auto: Autonomy = "auto";

const ROWS: Row[] = [
  // The rules allow.
  ["an allowed read", "prompt", allow, {}, { verdict: "allow", by: "rule", endsRow: true }],
  ["an allowed read, hook", "hook", allow, {}, { verdict: "allow", by: "rule", leaveToLeg: true }],
  ["an allowed tool call", "mcp", allow, {}, { verdict: "allow", by: "rule" }],
  ["an allowed check", "check", allow, {}, { verdict: "allow", by: "rule", log: null }],
  // Layer 1 blocks: counted toward the stuck rule; a check is only refused.
  ["a block", "prompt", blocked, {}, { verdict: "deny", by: "rule", counts: 1 }],
  ["a block, hook", "hook", blocked, {}, { verdict: "deny", by: "rule", counts: 1 }],
  ["a block, tool", "mcp", blocked, { command: false }, { verdict: "deny", counts: 1 }],
  ["a blocked check", "check", blocked, {}, { verdict: "deny", by: "rule", counts: null }],
  // What is never allowed: D7, not counted, no grant lifts it.
  ["never allowed", "prompt", never, {}, { verdict: "deny", drift: "D7", counts: null }],
  [
    "never allowed, let run once",
    "hook",
    never,
    { grants: { once: true } },
    { verdict: "deny", drift: "D7" },
  ],
  // Grants: what I let run once, a change the plan names.
  [
    "a block I let run once",
    "prompt",
    blocked,
    { grants: { once: true } },
    { verdict: "allow", by: "grant", scope: "once", endsRow: true },
  ],
  [
    "a block I let run once, hook",
    "hook",
    blocked,
    { grants: { once: true } },
    { verdict: "allow", by: "grant", scope: "once" },
  ],
  [
    "a tool call matches no once-grant",
    "mcp",
    blocked,
    { command: false, grants: { once: true } },
    { verdict: "deny", by: "rule" },
  ],
  [
    "a removal the plan names",
    "prompt",
    blocked,
    { ownBlock: true, grants: { planned: true } },
    { verdict: "ask", ask: "plan-change", by: "grant" },
  ],
  [
    "a removal the plan names, hook",
    "hook",
    blocked,
    { ownBlock: true, grants: { planned: true } },
    { verdict: "ask", ask: "plan-change" },
  ],
  [
    "a plan doesn't lift a secret's block",
    "prompt",
    blocked,
    { ownBlock: false, grants: { planned: true } },
    { verdict: "deny", counts: 1 },
  ],
  // Mine to approve: a gated action, a production change.
  ["a push", "prompt", gated, {}, { verdict: "ask", ask: "approval", by: "owner", gated: "push" }],
  ["a push, hook", "hook", gated, {}, { verdict: "ask", ask: "approval", log: null }],
  ["a push, check", "check", gated, {}, { verdict: "deny", by: "rule" }],
  [
    "a push I refused",
    "prompt",
    gated,
    { grants: { refused: true } },
    { verdict: "deny", by: "owner", drift: "D8", counts: "owner" },
  ],
  [
    "a push I refused, hook: decided at the prompt",
    "hook",
    gated,
    { grants: { refused: true } },
    { verdict: "ask", ask: "approval" },
  ],
  [
    "a production change at Full",
    "prompt",
    production,
    { autonomy: "full" },
    { verdict: "ask", ask: "approval", gated: null },
  ],
  [
    "a production change, tool",
    "mcp",
    production,
    { command: false },
    { verdict: "ask", ask: "approval" },
  ],
  ["a production check", "check", production, {}, { verdict: "allow", by: "rule" }],
  // The judge: risk only; Careful approves what it allows.
  ["judged, not asked yet", "prompt", judged, {}, { verdict: "judge" }],
  ["judged allowed", "prompt", judged, ok, { verdict: "allow", by: "judge", endsRow: true }],
  ["judged allowed, tool", "mcp", judged, { ...ok, autonomy: "full" }, { verdict: "allow" }],
  [
    "judged blocked (or the judge failed)",
    "prompt",
    judged,
    no,
    { verdict: "deny", by: "judge", counts: 2, drift: null },
  ],
  [
    "judged allowed at Careful",
    "prompt",
    judged,
    { ...ok, autonomy: "careful" },
    { verdict: "ask", ask: "approval", by: "owner" },
  ],
  [
    "judged allowed at Careful, refused before",
    "prompt",
    judged,
    { ...ok, autonomy: "careful", grants: { refused: true } },
    { verdict: "deny", drift: "D8" },
  ],
  [
    "a shape I approved at Careful",
    "prompt",
    judged,
    { autonomy: "careful", grants: { shape: true } },
    { verdict: "allow", by: "grant", scope: "job" },
  ],
  [
    "a shape counts only at Careful",
    "prompt",
    judged,
    { grants: { shape: true } },
    { verdict: "judge" },
  ],
  [
    "judged, hook: Claude Code's classifier judges",
    "hook",
    judged,
    {},
    { verdict: "allow", by: "leg", leaveToLeg: true },
  ],
  ["judged, check", "check", judged, {}, { verdict: "allow" }],
];

describe("the Gate's decision (ADR-056 §3)", () => {
  it.each(ROWS)("%s (%s)", (_name, source, rules, more, expected) => {
    const step = gateStep({
      source,
      rules,
      command: true,
      ownBlock: false,
      grants: {},
      autonomy: auto,
      ...more,
    });
    expect(step).toMatchObject(expected);
  });

  it("logs what it decides as the audit log always read: its layer and reason", () => {
    expect(
      gateStep({
        source: "prompt",
        rules: judged,
        command: true,
        ownBlock: false,
        grants: {},
        autonomy: auto,
        ...no,
      }),
    ).toMatchObject({ log: { verdict: "block", layer: "judge", reason: no.judge.reason } });
    expect(
      gateStep({
        source: "prompt",
        rules: gated,
        command: true,
        ownBlock: false,
        grants: {},
        autonomy: auto,
      }),
    ).toMatchObject({ log: { verdict: "ask", layer: "owner" } });
  });
});

describe("grants and refusals", () => {
  const once = (match: string) => ({
    kind: "allow-once" as const,
    scope: "once" as const,
    match,
    reason: "let it run once",
    at: 1,
  });

  it("matches a once-grant by the command's plain form, or by what it runs on a server", () => {
    const grants = [once("touch a"), once("'rm -rf /srv/old'")];
    expect(onceGrantFor(grants, "touch a", null)).toBe(0);
    expect(onceGrantFor(grants, "ssh vps 'rm -rf /srv/old'", "rm -rf /srv/old")).toBe(1);
    expect(onceGrantFor(grants, "touch b", null)).toBe(-1);
  });

  it("keys a refusal by its tool and its command or path", () => {
    expect(refusalKey({ tool: "Bash", command: "nmap x", path: null })).toBe("Bash:nmap x");
    expect(refusalKey({ tool: "Write", command: null, path: "/etc/x" })).toBe("Write:/etc/x");
  });

  it("keys a tool call with neither by its arguments: one refused email isn't every email", () => {
    const send = (to: string) =>
      refusalKey({ tool: "mcp__mail__send", command: null, path: null, input: { to } });
    expect(send("a@example.com")).toBe(send("a@example.com"));
    expect(send("a@example.com")).not.toBe(send("b@example.com"));
  });
});
