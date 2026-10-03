import { createHash, randomBytes } from "node:crypto";

// OAuth2 for Gmail and Outlook (ADR-032): the authorization code flow with
// PKCE, back to the daemon on 127.0.0.1, then XOAUTH2 for IMAP and SMTP.
// It works once I register Oraknid as an app with Google or Microsoft and
// paste its client id and secret; until then, app passwords.

export type OAuthProvider = "google" | "microsoft";

export interface OAuthEndpoints {
  authUrl: string;
  tokenUrl: string;
}

export const OAUTH: Record<
  OAuthProvider,
  OAuthEndpoints & {
    scope: string;
    extra: Record<string, string>;
    provider: "gmail" | "outlook";
  }
> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scope: "https://mail.google.com/ openid email",
    // A refresh token every time, so a reconnect replaces a revoked one.
    extra: { access_type: "offline", prompt: "consent" },
    provider: "gmail",
  },
  microsoft: {
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scope:
      "offline_access openid email https://outlook.office.com/IMAP.AccessAsUser.All https://outlook.office.com/SMTP.Send",
    extra: { prompt: "select_account" },
    provider: "outlook",
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

/** A login the provider refused for good (revoked, expired, wrong secret): only signing in again helps. */
export class OAuthRevoked extends Error {}

export interface PendingLogin {
  provider: OAuthProvider;
  verifier: string;
  redirectUri: string;
  /** Signing in again to an existing account. */
  accountId: string | null;
  createdAt: number;
}

const b64url = (b: Buffer) => b.toString("base64url");

/** The address to open in the browser, and what the callback needs to finish. */
export function authorizationUrl(
  o: {
    provider: OAuthProvider;
    clientId: string;
    redirectUri: string;
    loginHint?: string;
  },
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

async function tokenRequest(
  endpoints: OAuthEndpoints,
  body: Record<string, string>,
  now: number,
): Promise<Tokens> {
  let res: Response;
  try {
    res = await fetch(endpoints.tokenUrl, {
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
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    const why = json.error_description ?? json.error ?? `HTTP ${res.status}`;
    // invalid_grant: the refresh token was revoked or expired; invalid_client: the app's secret.
    if (json.error === "invalid_grant" || json.error === "invalid_client" || res.status === 401)
      throw new OAuthRevoked(`The sign-in was refused: ${why}`);
    throw new Error(`The sign-in server answered: ${why}`);
  }
  return {
    accessToken: json.access_token,
    expiresAt: now + (json.expires_in ?? 3600) * 1000,
    refreshToken: json.refresh_token ?? null,
    email: emailOf(json.id_token),
  };
}

export function exchangeCode(
  o: { clientId: string; clientSecret: string; code: string; login: PendingLogin },
  endpoints: OAuthEndpoints,
  now: number,
): Promise<Tokens> {
  return tokenRequest(
    endpoints,
    {
      grant_type: "authorization_code",
      client_id: o.clientId,
      client_secret: o.clientSecret,
      code: o.code,
      code_verifier: o.login.verifier,
      redirect_uri: o.login.redirectUri,
    },
    now,
  );
}

export function refresh(
  o: { clientId: string; clientSecret: string; refreshToken: string; provider: OAuthProvider },
  endpoints: OAuthEndpoints,
  now: number,
): Promise<Tokens> {
  return tokenRequest(
    endpoints,
    {
      grant_type: "refresh_token",
      client_id: o.clientId,
      client_secret: o.clientSecret,
      refresh_token: o.refreshToken,
      ...(o.provider === "microsoft" ? { scope: OAUTH.microsoft.scope } : {}),
    },
    now,
  );
}

/**
 * The address in an id token. It came straight from the provider's token
 * endpoint over TLS, so its claims are read, not verified.
 */
function emailOf(idToken: string | undefined): string | null {
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
