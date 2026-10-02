import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FoundAgent } from "@oraknid/contracts";
import type { LegRow } from "./registry.ts";

// Finding agents on this machine (Legs → Finding agents): it only looks,
// installs nothing, and adds nothing until I click.

interface Program {
  kind: "claude-code" | "opencode" | "antigravity";
  binary: string;
  label: string;
  name: string;
  /** Where its installer puts it, besides PATH. */
  usual: (home: string) => string[];
}

const PROGRAMS: Program[] = [
  {
    kind: "claude-code",
    binary: "claude",
    label: "Claude Code",
    name: "Claude",
    usual: (h) => [join(h, ".local/bin/claude"), join(h, ".claude/local/claude")],
  },
  {
    kind: "opencode",
    binary: "opencode",
    label: "OpenCode",
    name: "OpenCode — free models",
    usual: (h) => [join(h, ".opencode/bin/opencode"), join(h, ".local/bin/opencode")],
  },
  {
    kind: "antigravity",
    binary: "agy",
    label: "Antigravity",
    name: "Antigravity",
    usual: (h) => [join(h, ".local/bin/agy")],
  },
];

const SERVERS = [
  { port: 11434, label: "Ollama" },
  { port: 1234, label: "LM Studio" },
  { port: 8080, label: "llama.cpp" },
  { port: 8000, label: "vLLM" },
];

export interface DiscoverOptions {
  path?: string;
  home?: string;
  /** Model servers to look at: tests use their own. */
  servers?: { url: string; label: string }[];
  fetch?: typeof fetch;
}

/**
 * The program as found (a launcher that survives updates, e.g.
 * ~/.local/bin/claude) and the file it really is (to tell Legs apart).
 */
function locate(p: Program, path: string, home: string): { path: string; real: string } | null {
  const candidates = [...path.split(":").map((d) => join(d, p.binary)), ...p.usual(home)];
  for (const c of candidates) {
    try {
      if (c && existsSync(c)) return { path: c, real: realpathSync(c) };
    } catch {}
  }
  return null;
}

function version(binary: string): string | null {
  const r = spawnSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (r.status !== 0) return null;
  return /\d+\.\d+(\.\d+)?/.exec(`${r.stdout} ${r.stderr}`)?.[0] ?? null;
}

/** A name not yet taken by one of my Legs. */
function unique(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  for (let n = 2; ; n++) if (!taken.has(`${name} ${n}`)) return `${name} ${n}`;
}

export async function discoverAgents(
  legs: LegRow[],
  o: DiscoverOptions = {},
): Promise<FoundAgent[]> {
  const path = o.path ?? process.env.PATH ?? "";
  const home = o.home ?? homedir();
  const http = o.fetch ?? fetch;
  const taken = new Set(legs.map((l) => l.name));
  const found: FoundAgent[] = [];

  for (const p of PROGRAMS) {
    const at = locate(p, path, home);
    if (!at) continue;
    const where = at.path;
    const v = version(where);
    const usedBy = legs
      .filter((l) => {
        if (l.kind !== p.kind) return false;
        const b = String((l.config as { binary?: string }).binary ?? p.binary);
        try {
          const real = b.includes("/")
            ? realpathSync(b)
            : locate({ ...p, binary: b }, path, home)?.real;
          return real === at.real;
        } catch {
          return false;
        }
      })
      .map((l) => l.name);
    const name = unique(p.name, taken);
    taken.add(name);
    found.push({
      kind: p.kind,
      label: `${p.label}${v ? ` ${v}` : ""}`,
      where,
      detail:
        p.kind === "opencode"
          ? "OpenCode's own free models, no account needed."
          : p.kind === "claude-code"
            ? "Your Claude account: log the Leg in from its card."
            : "Your Google account: log the Leg in from its card.",
      suggestedName: name,
      config:
        p.kind === "opencode"
          ? { binary: where, package: "@opencode/ai/providers/openai-compatible", models: [] }
          : p.kind === "antigravity"
            ? { binary: where, models: [] }
            : { binary: where },
      usedBy,
    });
  }

  const servers =
    o.servers ?? SERVERS.map((s) => ({ url: `http://127.0.0.1:${s.port}/v1`, label: s.label }));
  await Promise.all(
    servers.map(async (s) => {
      try {
        const res = await http(`${s.url}/models`, { signal: AbortSignal.timeout(1500) });
        if (!res.ok) return;
        const models = ((await res.json()) as { data?: { id: string }[] }).data ?? [];
        if (!Array.isArray(models)) return;
        const usedBy = legs
          .filter(
            (l) =>
              l.kind === "openai-compatible" &&
              String((l.config as { baseUrl?: string }).baseUrl ?? "").replace(/\/+$/, "") ===
                s.url,
          )
          .map((l) => l.name);
        const name = unique(`${s.label} on this machine`, taken);
        taken.add(name);
        found.push({
          kind: "openai-compatible",
          label: `${s.label}, ${models.length} model${models.length === 1 ? "" : "s"}`,
          where: s.url,
          detail: models
            .slice(0, 5)
            .map((m) => m.id)
            .join(", ")
            .concat(models.length > 5 ? "…" : ""),
          suggestedName: name,
          config: { baseUrl: s.url },
          usedBy,
        });
      } catch {}
    }),
  );
  return found;
}
