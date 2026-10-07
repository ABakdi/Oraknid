import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";

/**
 * A stand-in for Google's or Microsoft's OAuth (ADR-063): an authorize page
 * that answers at once (as if I had clicked Allow) by redirecting back with
 * a code, a token endpoint that checks PKCE, the client and the refresh
 * token, and Microsoft's device code flow, approved when a test says so.
 * Access tokens are given to the stand-in mail server by `onAccessToken`.
 */
export interface FakeOAuth {
  url: string;
  endpoints: { authUrl: string; tokenUrl: string; deviceUrl: string };
  /** The token requests, as `grant_type`, with the client id; never a secret. */
  grants: { grant: string; clientId: string; hadSecret: boolean }[];
  /** The device code typed and allowed on the provider's page. */
  approveDevice(): void;
  /** Every refresh token revoked, as when I remove the app's access. */
  revoke(): void;
  close(): Promise<void>;
}

export async function startFakeOAuth(o: {
  email: string;
  clientId: string;
  /** Required with every token request when set (Google). */
  clientSecret?: string;
  /** Each access token given out, for the mail server to accept. */
  onAccessToken: (token: string) => void;
  /** Seconds an access token lives. */
  expiresIn?: number;
}): Promise<FakeOAuth> {
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const refreshTokens = new Set<string>();
  const devices = new Map<string, { approved: boolean }>();
  const grants: FakeOAuth["grants"] = [];
  const idToken = `x.${Buffer.from(JSON.stringify({ email: o.email })).toString("base64url")}.y`;

  const issue = () => {
    const access = `at-${randomBytes(8).toString("hex")}`;
    const refresh = `rt-${randomBytes(8).toString("hex")}`;
    refreshTokens.add(refresh);
    o.onAccessToken(access);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: o.expiresIn ?? 3600,
      id_token: idToken,
      token_type: "Bearer",
    };
  };

  const form = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        if (q.get("client_id") !== o.clientId || q.get("code_challenge_method") !== "S256")
          return json(400, { error: "invalid_request" });
        const code = `code-${randomBytes(6).toString("hex")}`;
        codes.set(code, {
          challenge: q.get("code_challenge") ?? "",
          redirect: q.get("redirect_uri") ?? "",
        });
        const back = new URL(q.get("redirect_uri") ?? "");
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (url.pathname === "/devicecode" && req.method === "POST") {
        const f = await form(req);
        if (f.get("client_id") !== o.clientId) return json(400, { error: "invalid_client" });
        const device = `dc-${randomBytes(6).toString("hex")}`;
        devices.set(device, { approved: false });
        return json(200, {
          device_code: device,
          user_code: "ABCD-1234",
          verification_uri: "https://microsoft.com/devicelogin",
          expires_in: 900,
          interval: 0,
        });
      }
      if (url.pathname === "/token" && req.method === "POST") {
        const f = await form(req);
        const grant = f.get("grant_type") ?? "";
        grants.push({
          grant,
          clientId: f.get("client_id") ?? "",
          hadSecret: f.has("client_secret"),
        });
        if (
          f.get("client_id") !== o.clientId ||
          (o.clientSecret && f.get("client_secret") !== o.clientSecret)
        )
          return json(401, { error: "invalid_client", error_description: "Wrong client." });
        if (grant === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          const challenge = createHash("sha256")
            .update(f.get("code_verifier") ?? "")
            .digest("base64url");
          if (!c || c.challenge !== challenge || c.redirect !== f.get("redirect_uri"))
            return json(400, { error: "invalid_grant", error_description: "Bad code." });
          return json(200, issue());
        }
        if (grant === "refresh_token") {
          if (!refreshTokens.has(f.get("refresh_token") ?? ""))
            return json(400, {
              error: "invalid_grant",
              error_description: "Token has been expired or revoked.",
            });
          return json(200, { ...issue(), refresh_token: undefined });
        }
        if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
          const d = devices.get(f.get("device_code") ?? "");
          if (!d) return json(400, { error: "expired_token" });
          if (!d.approved) return json(400, { error: "authorization_pending" });
          devices.delete(f.get("device_code") ?? "");
          return json(200, issue());
        }
        return json(400, { error: "unsupported_grant_type" });
      }
      json(404, { error: "not_found" });
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    url,
    endpoints: {
      authUrl: `${url}/authorize`,
      tokenUrl: `${url}/token`,
      deviceUrl: `${url}/devicecode`,
    },
    grants,
    approveDevice: () => {
      for (const d of devices.values()) d.approved = true;
    },
    revoke: () => refreshTokens.clear(),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
