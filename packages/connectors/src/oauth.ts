import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Generic OAuth 2.0 + PKCE helper shared by every OAuth connector.
 *
 * Endpoints come from environment variables by convention
 * (`ZEST_<ID>_AUTH_URL`, `_TOKEN_URL`, `_CLIENT_ID`, …), so adding an OAuth
 * platform is configuration plus a connector, never a new auth implementation.
 * That matters for an open-source project: every self-hoster brings their own
 * app credentials, because platform apps cannot be shared.
 */

export type OAuthEndpoints = {
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
};

export function endpointsFromEnv(
  connectorId: string,
  env: NodeJS.ProcessEnv = process.env,
): OAuthEndpoints | null {
  const prefix = `ZEST_${connectorId.toUpperCase()}`;
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !clientSecret) return null;

  return {
    authUrl: env[`${prefix}_AUTH_URL`] ?? "",
    tokenUrl: env[`${prefix}_TOKEN_URL`] ?? "",
    clientId,
    clientSecret,
    scopes: env[`${prefix}_SCOPES`] ?? "",
  };
}

export type PkcePair = { verifier: string; challenge: string };

export function createPkcePair(): PkcePair {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export type StatePayload = {
  workspaceId: string;
  connectorId: string;
  redirectTo?: string;
  /** Unix seconds; short-lived so a leaked link cannot be replayed later. */
  exp: number;
};

/**
 * OAuth state is signed rather than stored. No database round-trip on the
 * callback, and no rows to expire — the signature and `exp` carry everything
 * needed to trust the response.
 */
export function signState(payload: StatePayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyState(state: string, secret: string): StatePayload | null {
  const parts = state.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];

  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare lengths first.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as StatePayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Names the PKCE cookie after a hash of the state so parallel connects never collide. */
export function pkceCookieName(state: string): string {
  return `zest_pkce_${createHash("sha256").update(state).digest("hex").slice(0, 16)}`;
}

export function buildAuthorizeUrl(
  endpoints: OAuthEndpoints,
  params: { state: string; challenge: string; redirectUri: string },
): string {
  const url = new URL(endpoints.authUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", endpoints.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", endpoints.scopes);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
};

export async function exchangeCode(
  endpoints: OAuthEndpoints,
  params: { code: string; verifier: string; redirectUri: string },
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: endpoints.clientId,
    client_secret: endpoints.clientSecret,
    code_verifier: params.verifier,
  });

  const res = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshToken(
  endpoints: OAuthEndpoints,
  token: string,
): Promise<TokenResponse> {
  const res = await fetch(endpoints.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: token,
      client_id: endpoints.clientId,
      client_secret: endpoints.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as TokenResponse;
}
