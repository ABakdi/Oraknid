// Secrets never reach logs, events or exports (BR-13, Security → Secrets).

const PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // API keys (OpenAI-style, Anthropic-style)
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,}/g,
];

/** Replaces known secret values (longest first) and secret-shaped strings with [secret]. */
export function scrubSecrets(text: string, known: Iterable<string> = []): string {
  let out = text;
  const values = [...known].filter((v) => v.length >= 6).sort((a, b) => b.length - a.length);
  for (const v of values) out = out.split(v).join("[secret]");
  for (const p of PATTERNS)
    out = out.replace(p, (m, bearer) =>
      typeof bearer === "string" && m.startsWith(bearer) ? `${bearer}[secret]` : "[secret]",
    );
  return out;
}
