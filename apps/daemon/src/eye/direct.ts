import { perMinuteFrom, resetsAtFrom, tokensOf } from "@oraknid/core";
import { apiBase } from "@oraknid/leg-sdk";

// Light calls don't need an agent (ADR-066 §3): The Eye's text-only calls
// (naming a job, a message's triage, the judges' first stage, summaries)
// go to a model behind an OpenAI-compatible API in one plain chat
// completion: a compact prompt, no tools, no CLI, no session process.
// Calls to one model are spaced so its tokens a minute are never overrun.

/** A model The Eye can ask directly: its address and key. */
export interface DirectTarget {
  legId: string;
  legModelId: string;
  legName: string;
  model: string;
  baseUrl: string;
  credential: string | null;
}

export interface DirectReply {
  text: string;
  usage: { input: number; output: number; cacheRead: number; estimated: boolean };
}

/** A direct call its server refused or couldn't answer: its status and its own words. */
export class DirectFailed extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    /** How long the server asked to wait (`retry-after`, or its words), when it said. */
    readonly retryAfterMs: number | null,
  ) {
    super(message);
  }
}

/** The address of a Leg's model for a direct call, or null when its kind has none. */
export function directAddress(
  kind: string,
  config: Record<string, unknown>,
  model: string,
): string | null {
  if (kind === "oraknid-agent") {
    const endpoints = Array.isArray(config.endpoints)
      ? (config.endpoints as { model?: unknown; baseUrl?: unknown }[])
      : [];
    const own = endpoints.find((e) => e.model === model)?.baseUrl;
    if (typeof own === "string" && own) return own.replace(/\/+$/, "");
    return typeof config.baseUrl === "string" && config.baseUrl ? apiBase(config.baseUrl) : null;
  }
  if (kind === "openai-compatible")
    return typeof config.baseUrl === "string" && config.baseUrl ? apiBase(config.baseUrl) : null;
  return null;
}

/**
 * Tokens a minute per model (ADR-066 §5): what each one was sent in the
 * last minute, and its limit when its server said one (its headers, or a
 * refusal's words). A call that would overrun it waits for room instead
 * of failing.
 */
export class MinutePacer {
  readonly #sent = new Map<string, { at: number; tokens: number }[]>();
  readonly #limit = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}

  learn(key: string, tokensPerMinute: number) {
    if (tokensPerMinute > 0) this.#limit.set(key, tokensPerMinute);
  }

  limitOf(key: string): number | null {
    return this.#limit.get(key) ?? null;
  }

  record(key: string, tokens: number) {
    this.#sent.set(key, [...this.#recent(key), { at: this.now(), tokens }]);
  }

  /** How long to wait before `tokens` more fit in the minute: 0 when they do now. */
  waitFor(key: string, tokens: number): number {
    const limit = this.#limit.get(key);
    if (!limit) return 0;
    const recent = this.#recent(key);
    let used = recent.reduce((n, s) => n + s.tokens, 0);
    if (used + tokens <= limit) return 0;
    // The oldest sends leave the minute first.
    for (const s of recent) {
      used -= s.tokens;
      if (used + tokens <= limit) return Math.max(0, s.at + 60_000 - this.now());
    }
    return 60_000;
  }

  #recent(key: string) {
    const since = this.now() - 60_000;
    return (this.#sent.get(key) ?? []).filter((s) => s.at > since);
  }
}

/**
 * One chat completion, not streamed: the system prompt, the prompt, a
 * cap on the answer. Throws DirectFailed with the server's status and words.
 */
export async function directChat(
  http: typeof fetch,
  t: DirectTarget,
  r: { system: string; prompt: string; maxTokens: number; signal?: AbortSignal },
  pacer?: MinutePacer,
): Promise<DirectReply> {
  const key = t.legModelId;
  let res: Response;
  try {
    res = await http(`${t.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(t.credential ? { authorization: `Bearer ${t.credential}` } : {}),
      },
      body: JSON.stringify({
        model: t.model,
        messages: [
          { role: "system", content: r.system },
          { role: "user", content: r.prompt },
        ],
        temperature: 0,
        max_tokens: r.maxTokens,
        stream: false,
      }),
      ...(r.signal ? { signal: r.signal } : {}),
    });
  } catch (error) {
    throw new DirectFailed(
      `${t.legName} couldn't be reached: ${error instanceof Error ? error.message : String(error)}`,
      null,
      null,
    );
  }
  const headers = Object.fromEntries(res.headers.entries());
  const minute = perMinuteFrom(headers);
  if (minute?.tokens && pacer) pacer.learn(key, minute.tokens);
  const body = await res.text();
  if (!res.ok) {
    const retry = Number(headers["retry-after"]);
    const said = resetsAtFrom(body, Date.now());
    throw new DirectFailed(
      `The model server answered ${res.status}: ${body.replace(/\s+/g, " ").slice(0, 1000)}`,
      res.status,
      Number.isFinite(retry) && retry > 0 ? retry * 1000 : said ? said - Date.now() : null,
    );
  }
  let data: {
    choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[];
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  try {
    data = JSON.parse(body);
  } catch {
    throw new DirectFailed(`${t.legName} answered something that isn't JSON.`, res.status, null);
  }
  const content = data.choices?.[0]?.message?.content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p as { text?: string }).text ?? "").join("")
        : "";
  const u = data.usage;
  const reported = typeof u?.prompt_tokens === "number";
  return {
    text,
    usage: {
      input: u?.prompt_tokens ?? tokensOf(r.system + r.prompt),
      output: u?.completion_tokens ?? tokensOf(text),
      cacheRead: u?.prompt_tokens_details?.cached_tokens ?? 0,
      estimated: !reported,
    },
  };
}
