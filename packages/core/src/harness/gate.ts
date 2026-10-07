import { createHash } from "node:crypto";
import type { Autonomy } from "@oraknid/contracts";
import { blockedMessage, type GatedAction, type PolicyVerdict } from "../policy.ts";

// The Gate's decision (ADR-056 §3), pure: what the rules said, the grants
// that apply, what the judge said and the autonomy level, to one verdict,
// for every source of an action. The daemon's Gate reads the facts (layer
// 1, the plan, the task's memory, the judge) and does what this says
// (the audit log, the stuck count, my questions); nothing here is read
// or written.

/** Where an action comes from. */
export type GateSource =
  /** The Leg's own permission prompt (canUseTool, OpenCode's ask). */
  | "prompt"
  /** Claude Code's PreToolUse hook, in its own auto mode: it can't wait for my answer. */
  | "hook"
  /** A call to one of the job's tools, through Oraknid's MCP broker. */
  | "mcp"
  /** A command of the task's checks, Oraknid's own (locally or on a server). */
  | "check";

/** Who settled it. */
export type GateBy = "rule" | "grant" | "judge" | "owner" | "leg";

/** The audit log's layer (ADR-053), as it has always read. */
export type GateLayer = "rules" | "judge" | "owner" | "leg";

/** How far a grant reaches. */
export type GrantScope = "once" | "task" | "job" | "plan";

/**
 * A scoped allowance, first-class (ADR-056 §3): what I let run once, all
 * like this for the job, an approved plan's own removals, the autonomy level.
 */
export interface Grant {
  kind: "allow-once" | "all-like-this" | "plan-change" | "autonomy";
  scope: GrantScope;
  /** What it matches: a command in its plain form. */
  match: string;
  reason: string;
  at: number;
}

/** What the Gate knows of one action when it decides; read before, nothing async here. */
export interface GateFacts {
  source: GateSource;
  /** The rules' verdict: the never-allowed list, layer 1, my rules, the gates, a server's own reading. */
  rules: PolicyVerdict;
  /** The action is a shell command. */
  command: boolean;
  /** A block of layer 1's own (CC Safety Net, our rules; not a secret going out): a plan may lift it. */
  ownBlock: boolean;
  grants: {
    /** I let this exact command run once. */
    once?: boolean;
    /** At Careful: a command shaped like one I approved for the job ("all like this"). */
    shape?: boolean;
    /** A change on a server that the job's plan names, not kept blocked in this attempt. */
    planned?: boolean;
    /** I refused this very request before (D8). */
    refused?: boolean;
  };
  /** The judge's verdict, once asked (an error is a block: high risk). */
  judge?: { verdict: "allow" | "block"; reason: string };
  autonomy: Autonomy;
}

/** What goes in the audit log for the decision, if anything. */
export interface GateLog {
  verdict: "allow" | "block" | "ask";
  layer: GateLayer;
  reason: string;
}

export type GateStep =
  | {
      verdict: "allow";
      by: GateBy;
      reason: string;
      layer: GateLayer;
      scope?: GrantScope;
      /** The hook gives no opinion: the Leg's own classifier decides (Claude Code's auto mode). */
      leaveToLeg?: true;
      /** An action ran because of it: the stuck row ends. */
      endsRow: boolean;
      log: GateLog | null;
    }
  | {
      verdict: "deny";
      by: GateBy;
      reason: string;
      layer: GateLayer;
      /** D7: forbidden, counts against the Leg; D8: a refused gate tried again. */
      drift: "D7" | "D8" | null;
      message?: string;
      /** Counted toward the stuck rule, and on which layer. */
      counts: 1 | 2 | "owner" | null;
      log: GateLog | null;
    }
  | {
      verdict: "ask";
      by: GateBy;
      reason: string;
      layer: GateLayer;
      /** Which question: a change the plan names, or an approval of a gated action. */
      ask: "plan-change" | "approval";
      gated: GatedAction | null;
      log: GateLog | null;
    }
  /** The judge is needed: ask it, then decide again with its verdict. */
  | { verdict: "judge" };

const deny = (
  rules: Extract<PolicyVerdict, { verdict: "deny" }>,
  by: GateBy,
  layer: GateLayer,
  counts: 1 | 2 | null,
): GateStep => ({
  verdict: "deny",
  by,
  reason: rules.reason,
  layer,
  drift: rules.drift,
  ...(rules.message ? { message: rules.message } : {}),
  counts: rules.drift ? null : counts,
  log: { verdict: "block", layer, reason: rules.reason },
});

/**
 * One action, one verdict (ADR-056 §3). In order: the rules (layer 1,
 * once) → the grants (what I let run once, an approved plan's removal,
 * all like this at Careful) → the judge (risk only) → the autonomy level
 * (Careful approves what the judge allows) → me.
 */
export function gateStep(f: GateFacts): GateStep {
  const r = f.rules;

  // A check is Oraknid's own: refused when the rules refuse it, or when it is a gated action.
  if (f.source === "check") {
    if (r.verdict === "deny") return deny(r, "rule", "rules", null);
    if (r.verdict === "ask" && r.gated)
      return {
        verdict: "deny",
        by: "rule",
        reason: `${r.reason}; a check never does that`,
        layer: "rules",
        drift: null,
        counts: null,
        log: null,
      };
    return {
      verdict: "allow",
      by: "rule",
      reason: r.reason,
      layer: "rules",
      endsRow: false,
      log: null,
    };
  }

  // What I let run once runs, once (ADR-053); never what is never allowed.
  if (f.command && f.grants.once && !(r.verdict === "deny" && r.drift))
    return {
      verdict: "allow",
      by: "grant",
      reason: "let it run once",
      layer: "owner",
      scope: "once",
      endsRow: true,
      log: { verdict: "allow", layer: "owner", reason: "let it run once" },
    };

  if (r.verdict === "deny") {
    // A block of layer 1's own on a change the plan names: asked of me at once (ADR-049).
    if (r.drift === null && f.command && f.ownBlock && f.grants.planned)
      return {
        verdict: "ask",
        by: "grant",
        reason: r.reason,
        layer: "rules",
        ask: "plan-change",
        gated: null,
        log: { verdict: "block", layer: "rules", reason: r.reason },
      };
    return deny(r, "rule", "rules", 1);
  }

  if (r.verdict === "allow") {
    if (f.source === "hook")
      // Left to the Leg's own classifier; a command's allow is in the audit log.
      return {
        verdict: "allow",
        by: "rule",
        reason: r.reason,
        layer: "rules",
        leaveToLeg: true,
        endsRow: false,
        log: f.command ? { verdict: "allow", layer: "rules", reason: r.reason } : null,
      };
    return {
      verdict: "allow",
      by: "rule",
      reason: r.reason,
      layer: "rules",
      endsRow: true,
      log: { verdict: "allow", layer: "rules", reason: r.reason },
    };
  }

  if (r.verdict === "ask") return approval(f, r.reason, r.gated);

  // The rules leave it to judgement. In the Leg's own auto mode its classifier is the judge.
  if (f.source === "hook")
    return {
      verdict: "allow",
      by: "leg",
      reason: r.reason,
      layer: "leg",
      leaveToLeg: true,
      endsRow: false,
      log: null,
    };
  // Careful: a shape I approved for the job passes without the judge.
  if (f.autonomy === "careful" && f.command && f.grants.shape)
    return {
      verdict: "allow",
      by: "grant",
      reason: "a command like one I approved for this job",
      layer: "owner",
      scope: "job",
      endsRow: true,
      log: {
        verdict: "allow",
        layer: "owner",
        reason: "a command like one I approved for this job",
      },
    };
  if (!f.judge) return { verdict: "judge" };
  if (f.judge.verdict === "block")
    return {
      verdict: "deny",
      by: "judge",
      reason: f.judge.reason,
      layer: "judge",
      drift: null,
      message: blockedMessage(f.judge.reason),
      counts: 2,
      log: { verdict: "block", layer: "judge", reason: f.judge.reason },
    };
  // Careful: what the judge allows and the rules didn't is mine to approve.
  if (f.autonomy === "careful")
    return approval(f, `${r.reason}; the judge would allow it, and at Careful I approve it`, null);
  const reason = `the judge allowed it: ${f.judge.reason}`;
  return {
    verdict: "allow",
    by: "judge",
    reason,
    layer: "judge",
    endsRow: true,
    log: { verdict: "allow", layer: "judge", reason },
  };
}

/** Mine to approve; asked once, trying it again after I refused is a gate bypass (D8). */
function approval(f: GateFacts, reason: string, gated: GatedAction | null): GateStep {
  // The hook asks through Claude Code's permission prompt, where it is logged and decided.
  const log: GateLog | null =
    f.source === "hook" ? null : { verdict: "ask", layer: "owner", reason };
  // The hook can't wait for me: Claude Code asks through its permission prompt, decided there.
  if (f.source !== "hook" && f.grants.refused)
    return {
      verdict: "deny",
      by: "owner",
      reason: "I already refused that",
      layer: "owner",
      drift: "D8",
      message: "I already refused that.",
      counts: null,
      log,
    };
  return { verdict: "ask", by: "owner", reason, layer: "owner", ask: "approval", gated, log };
}

/**
 * A refused request's key (D8): its tool and its command or path; a call
 * with neither (a job's tool through the broker) by its arguments, so
 * refusing one email doesn't refuse every later one.
 */
export function refusalKey(r: {
  tool: string;
  command: string | null;
  path: string | null;
  input?: Record<string, unknown>;
}): string {
  const what =
    r.command ??
    r.path ??
    `args:${createHash("sha256")
      .update(JSON.stringify(r.input ?? {}))
      .digest("hex")
      .slice(0, 16)}`;
  return `${r.tool}:${what}`;
}

/**
 * The once-grant this command uses, by its plain form, or by what it runs on
 * a server (`ssh <alias> '<remote>'` matches a grant of `'<remote>'`): its
 * index in `grants`, or -1.
 */
export function onceGrantFor(grants: Grant[], plain: string, remote: string | null): number {
  return grants.findIndex(
    (g) =>
      g.kind === "allow-once" &&
      (g.match === plain || (remote !== null && g.match.replace(/^'(.*)'$/, "$1") === remote)),
  );
}
