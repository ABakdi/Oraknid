import { createHash, randomBytes } from "node:crypto";

// OAuth2 for Gmail and Outlook (ADR-032, ADR-063): XOAUTH2 for IMAP and
// SMTP, with an app I register myself at Google or Microsoft (its client id,
// and Google's client secret, kept by Oraknid). Two ways to sign in:
// - in the browser, the authorization code flow with PKCE, back to this
//   daemon on 127.0.0.1 (Google's "desktop app", Microsoft's too);
// - with a code typed on Microsoft's page (the device code flow), which
//   needs no address back to this computer.
// Tokens never leave the daemon: the refresh token in the keychain, the
// access token in memory until it expires.

export type OAuthProvider = "google" | "microsoft";

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
  /** Microsoft only: where a device code is asked for. */
  deviceUrl?: string;
}

export const OAUTH: Record<
  OAuthProvider,
  OAuthEndpoints & {
    scope: string;
    extra: Record<string, string>;
    provider: "gmail" | "outlook";
    name: string;
  }
> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://mail.google.com/ openid email",
    // A refresh token every time, so a reconnect replaces a revoked one.
    extra: { access_type: "offline", prompt: "consent" },
    provider: "gmail",
    name: "Google",
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    deviceUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/devicecode",
    scope:
      "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
    extra: { prompt: "select_account" },
    provider: "outlook",
    name: "Microsoft",
  },
};

export interface Tokens {
  accessToken: string;
  /** Epoch ms. */
  expiresAt: number;
  refreshToken: string | null;
  /** From the id token, when there is one. */
  email: string | null;
}

/** A sign-in the provider refused for good (revoked, expired, wrong secret): only signing in again helps. */
export class OAuthRevoked extends Error {}

/** The app I registered: its id, and its secret when the provider wants one (Google). */
export interface OAuthClient {
  clientId: string;
  clientSecret: string | null;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** The address to open in the browser, and what the callback needs to finish. */
export function authorizationUrl(
  o: { provider: OAuthProvider; clientId: string; redirectUri: string; loginHint?: string },
  endpoints: OAuthEndpoints,
): { url: string; state: string; verifier: string } {
  const p = OAUTH[o.provider];
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const url = new URL(endpoints.authUrl);
  url.search = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.redirectUri,
    response_type: "code",
    scope: p.scope,
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    ...p.extra,
    ...(o.loginHint ? { login_hint: o.loginHint } : {}),
  }).toString();
  return { url: url.toString(), state, verifier };
}

type TokenAnswer = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  error?: string;
  error_description?: string;
};

async function post(
  http: typeof fetch,
  url: string,
  body: Record<string, string>,
): Promise<{ res: Response; json: TokenAnswer & Record<string, unknown> }> {
  let res: Response;
  try {
    res = await http(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new Error(
      `Couldn't reach the sign-in server: ${error instanceof Error ? error.message : error}`,
    );
  }
  const json = (await res.json().catch(() => ({}))) as TokenAnswer & Record<string, unknown>;
  return { res, json };
}

/** Pending, refused for good, or tokens: a token endpoint's answer read. */
function tokensOf(res: Response, json: TokenAnswer, now: number): Tokens {
  if (!res.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    // invalid_grant: the refresh token was revoked or expired; invalid_client: the app's secret.
    if (json.error === "invalid_grant" || json.error === "invalid_client" || res.status === 401)
      throw new OAuthRevoked(`The sign-in was refused: ${firstLine(why)}`);
    throw new Error(`The sign-in server answered: ${firstLine(why)}`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token ?? null,
    email: emailOf(json.id_token),
  };
}

const firstLine = (s: string) => s.split(/\r?\n/, 1)[0] ?? s;
const secretOf = (c: OAuthClient): Record<string, string> =>
  c.clientSecret ? { client_secret: c.clientSecret } : {};

export async function exchangeCode(
  o: { client: OAuthClient; code: string; verifier: string; redirectUri: string },
  endpoints: OAuthEndpoints,
  now: number,
  http: typeof fetch = fetch,
): Promise<Tokens> {
  const { res, json } = await post(http, endpoints.tokenUrl, {
    grant_type: "authorization_code",
    client_id: o.client.clientId,
    ...secretOf(o.client),
    code: o.code,
    code_verifier: o.verifier,
    redirect_uri: o.redirectUri,
  });
  return tokensOf(res, json, now);
}

export async function refresh(
  o: { client: OAuthClient; refreshToken: string; provider: OAuthProvider },
  endpoints: OAuthEndpoints,
  now: number,
  http: typeof fetch = fetch,
): Promise<Tokens> {
  const { res, json } = await post(http, endpoints.tokenUrl, {
    grant_type: "refresh_token",
    client_id: o.client.clientId,
    ...secretOf(o.client),
    refresh_token: o.refreshToken,
    ...(o.provider === "microsoft" ? { scope: OAUTH.microsoft.scope } : {}),
  });
  return tokensOf(res, json, now);
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** Epoch ms. */
  expiresAt: number;
  /** Seconds between polls. */
  interval: number;
}

/** A code to type on the provider's page (Microsoft's device code flow). */
export async function deviceCode(
  o: { client: OAuthClient; provider: OAuthProvider },
  endpoints: OAuthEndpoints,
  now: number,
  http: typeof fetch = fetch,
): Promise<DeviceCode> {
  if (!endpoints.deviceUrl)
    throw new Error(`${OAUTH[o.provider].name} doesn't sign in mail with a code: use the browser.`);
  const { res, json } = await post(http, endpoints.deviceUrl, {
    client_id: o.client.clientId,
    scope: OAUTH[o.provider].scope,
  });
  const j = json as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
    error?: string;
  };
  if (!res.ok || !j.device_code || !j.user_code || !j.verification_uri)
    throw new Error(
      `The sign-in server answered: ${firstLine(j.error_description ?? j.error ?? `HTTP ${res.status}`)}`,
    );
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verificationUri: j.verification_uri,
    expiresAt: now + (j.expires_in ?? 900) * 1000,
    interval: j.interval ?? 5,
  };
}

/** One poll of a device code: tokens, still waiting, or slow down. */
export async function pollDevice(
  o: { client: OAuthClient; deviceCode: string },
  endpoints: OAuthEndpoints,
  now: number,
  http: typeof fetch = fetch,
): Promise<Tokens | "pending" | "slow_down"> {
  const { res, json } = await post(http, endpoints.tokenUrl, {
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    client_id: o.client.clientId,
    ...secretOf(o.client),
    device_code: o.deviceCode,
  });
  if (json.error === "authorization_pending") return "pending";
  if (json.error === "slow_down") return "slow_down";
  if (json.error === "expired_token" || json.error === "authorization_declined")
    throw new OAuthRevoked(
      json.error === "expired_token"
        ? "The code expired before it was used: start again."
        : "The sign-in was declined.",
    );
  return tokensOf(res, json, now);
}

/**
 * The address in an id token. It came straight from the provider's token
 * endpoint over TLS, so its claims are read, not verified.
 */
export function emailOf(idToken: string | undefined): string | null {
  const payload = idToken?.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      email?: string;
      preferred_username?: string;
    };
    return claims.email ?? claims.preferred_username ?? null;
  } catch {
    return null;
  }
}
