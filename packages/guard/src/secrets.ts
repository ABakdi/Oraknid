import { lintSource } from "@secretlint/core";
import { creator as recommended } from "@secretlint/secretlint-rule-preset-recommend";

// Secrets going out (ADR-053, layer 1): a command that reaches the network
// is scanned with secretlint's recommended rules and a compact set of
// gitleaks-style patterns; a credential in it blocks it.

/** gitleaks-style patterns for what secretlint's preset misses or reads late. */
const PATTERNS: { id: string; what: string; re: RegExp }[] = [
  {
    id: "aws-access-key",
    what: "an AWS access key",
    re: /\b(A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/,
  },
  {
    id: "aws-secret-key",
    what: "an AWS secret key",
    re: /aws.{0,20}?(secret|key).{0,20}?['"=:\s]\s*[A-Za-z0-9/+=]{40}\b/i,
  },
  {
    id: "private-key",
    what: "a private key",
    re: /-----BEGIN[ A-Z0-9_-]*PRIVATE KEY( BLOCK)?-----/,
  },
  {
    id: "github-token",
    what: "a GitHub token",
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  { id: "gitlab-token", what: "a GitLab token", re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", what: "a Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: "slack-webhook",
    what: "a Slack webhook",
    re: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/,
  },
  { id: "anthropic-key", what: "an Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "openai-key", what: "an OpenAI API key", re: /\bsk-(proj-|svcacct-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: "google-api-key", what: "a Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "stripe-key", what: "a Stripe key", re: /\b(sk|rk)_(live|test)_[A-Za-z0-9]{20,}\b/ },
  { id: "npm-token", what: "an npm token", re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "pypi-token", what: "a PyPI token", re: /\bpypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{50,}\b/ },
  {
    id: "sendgrid-key",
    what: "a SendGrid key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  },
  { id: "twilio-key", what: "a Twilio key", re: /\bSK[0-9a-fA-F]{32}\b/ },
  { id: "digitalocean-token", what: "a DigitalOcean token", re: /\bdo[opr]_v1_[a-f0-9]{64}\b/ },
  { id: "hf-token", what: "a Hugging Face token", re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  {
    id: "jwt",
    what: "a JSON web token",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  },
  {
    id: "basic-auth-url",
    what: "a password in a URL",
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{6,}@[^\s/]+/i,
  },
  {
    id: "bearer-token",
    what: "a bearer token",
    re: /authorization:\s*(bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/i,
  },
];

/** Programs that send what they are given outside the machine. */
export const NETWORK = new Set(
  `curl wget ssh scp sftp rsync nc ncat netcat socat telnet ftp http https xh httpie gh glab aws gcloud az
   git mail sendmail mailx msmtp s3cmd rclone`.split(/\s+/),
);

/** A credential found by the patterns; fast and synchronous. */
export function secretByPattern(text: string): { id: string; what: string } | null {
  for (const p of PATTERNS) if (p.re.test(text)) return { id: p.id, what: p.what };
  return null;
}

const CONFIG = {
  rules: [{ id: "@secretlint/secretlint-rule-preset-recommend", rule: recommended }],
};

/** A credential found by secretlint's recommended rules, or null. */
export async function secretBySecretlint(
  text: string,
): Promise<{ id: string; what: string } | null> {
  const r = await lintSource({
    source: { content: text, filePath: "/command.sh", ext: ".sh", contentType: "text" },
    options: { config: CONFIG as never, noPhysicFilePath: true, maskSecrets: true },
  });
  const m = r.messages[0];
  if (!m) return null;
  return { id: m.ruleId, what: m.message.replace(/:.*$/, "").replace(/^found /i, "") };
}
