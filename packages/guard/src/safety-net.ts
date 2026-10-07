import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCommand } from "cc-safety-net/api";
import aws from "../rulebooks/aws/rulebook.json" with { type: "json" };
import azure from "../rulebooks/azure/rulebook.json" with { type: "json" };
import gcloud from "../rulebooks/gcloud/rulebook.json" with { type: "json" };
import terraform from "../rulebooks/terraform/rulebook.json" with { type: "json" };

// CC Safety Net (MIT) as layer 1's block list (ADR-053): its built-in
// rules (force push, reset --hard, checkout --, rm -rf outside the folder,
// reading .env, ~/.ssh, ~/.aws…) and its official Terraform and cloud
// rulebooks, vendored in ../rulebooks (MIT). It reads its configuration
// from a home of Oraknid's own, never the owner's ~/.cc-safety-net, and a
// project's own rules may only add blocks (tighten only).

const RULEBOOKS = { terraform, aws, gcloud, azure } as const;

let home: string | null = null;

/** Writes Oraknid's CC Safety Net home (its rule.json and the rulebooks) and points the library at it. */
export function configureSafetyNet(dir?: string): string {
  const root = dir ?? join(tmpdir(), `oraknid-guard-${process.getuid?.() ?? "u"}`);
  const rules = join(root, "rules");
  for (const [name, book] of Object.entries(RULEBOOKS)) {
    mkdirSync(join(rules, name), { recursive: true });
    writeFileSync(join(rules, name, "rulebook.json"), `${JSON.stringify(book, null, 2)}\n`);
  }
  writeFileSync(
    join(rules, "rule.json"),
    `${JSON.stringify({ version: 1, rules: Object.keys(RULEBOOKS) }, null, 2)}\n`,
  );
  // The library reads these on every call (its environment is the process's).
  process.env.CC_SAFETY_NET_HOME = root;
  process.env.CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY = "1";
  delete process.env.CC_SAFETY_NET_LEVEL;
  delete process.env.SAFETY_NET_LEVEL;
  delete process.env.CC_SAFETY_NET_WORKTREE;
  delete process.env.SAFETY_NET_WORKTREE;
  home = root;
  cache.clear();
  return root;
}

/** A verdict per command and folder: the library reads its files on every call (2–5 ms). */
const cache = new Map<string, SafetyNetVerdict>();
const CACHE_SIZE = 4000;

export type SafetyNetVerdict = { block: false } | { block: true; reason: string; rule: string };

/** CC Safety Net's verdict on a command run in `cwd`. */
export function safetyNet(command: string, cwd: string): SafetyNetVerdict {
  if (!home) configureSafetyNet();
  const folder = cwd?.startsWith("/") && existsSync(cwd) ? cwd : tmpdir();
  const key = `${folder}\0${command}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let v: SafetyNetVerdict;
  try {
    const r = checkCommand({ command, cwd: folder });
    v = r.kind === "deny" ? { block: true, reason: r.reason, rule: r.ruleId } : { block: false };
  } catch {
    // An empty or odd command is not CC Safety Net's to judge: the rest of layer 1 still is.
    v = { block: false };
  }
  if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  cache.set(key, v);
  return v;
}
