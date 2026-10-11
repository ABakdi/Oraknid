import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The models I use with OpenCode myself (ADR-068 §2), from its own config
// and history in my home, read only: its config's `model`, and the models
// of its assistant messages in its database, most used first. Never written,
// never sent anywhere; only the model ids leave this file.

/** A model id without its provider ("opencode/big-pickle" → "big-pickle"). */
const bare = (id: string) => id.slice(id.indexOf("/") + 1);

/** The `model` of OpenCode's own config (JSON or JSONC), or null. */
export function configModel(home: string): string | null {
  for (const name of ["opencode.json", "opencode.jsonc", "config.json"]) {
    const file = join(home, ".config", "opencode", name);
    if (!existsSync(file)) continue;
    try {
      const text = readFileSync(file, "utf8")
        // Comments out, outside strings: enough for a config file.
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, s) => s ?? "")
        .replace(/,(\s*[}\]])/g, "$1");
      const model = (JSON.parse(text) as { model?: unknown }).model;
      if (typeof model === "string" && model.trim()) return bare(model.trim());
    } catch {}
  }
  return null;
}

interface SqliteLike {
  prepare(sql: string): { all(): unknown[] };
  close(): void;
}

/** The models of OpenCode's assistant messages in its database, most used first; read only. */
export async function historyModels(home: string): Promise<string[]> {
  const file = join(home, ".local", "share", "opencode", "opencode.db");
  if (!existsSync(file)) return [];
  let db: SqliteLike | null = null;
  try {
    const { DatabaseSync } = (await import("node:sqlite")) as unknown as {
      DatabaseSync: new (path: string, o: { readOnly: boolean }) => SqliteLike;
    };
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT json_extract(data, '$.modelID') AS model, COUNT(*) AS n FROM message
         WHERE json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.modelID') IS NOT NULL
         GROUP BY model ORDER BY n DESC LIMIT 5`,
      )
      .all() as { model: string; n: number }[];
    // A model used now and then isn't mine: at least a tenth of the most used one's messages.
    const top = rows[0]?.n ?? 0;
    return rows.filter((r) => r.n >= Math.max(1, top / 10)).map((r) => bare(String(r.model)));
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {}
  }
}

/** What I use: the history's models, then the config's, each once. */
export async function preferredOf(home: string): Promise<string[]> {
  const out = await historyModels(home);
  const config = configModel(home);
  if (config && !out.includes(config)) out.push(config);
  return out;
}
