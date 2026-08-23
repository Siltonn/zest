import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import { verifyJwsAccessToken } from "better-auth/oauth2";
import type { Database } from "@zest/db";
import { normalizeScopes } from "@zest/shared";
import { DATABASE } from "../infra/database.module.js";
import { AUTH, type Auth } from "./auth.js";
import { mcpResource } from "./auth.options.js";
import { resolveApiKey, resolveWorkspaceForUser, type AuthedRequest } from "./workspace.guard.js";
import { loadEnv, publicBaseUrl } from "../config.js";

/**
 * Authentication for `/mcp`, and only `/mcp`.
 *
 * Deliberately narrower than the REST guard:
 *
 *  - **No session cookies.** An MCP request rides in a machine client; cookie
 *    auth here would make the endpoint a CSRF target and blur provenance.
 *  - **No demo fallback.** DEMO_MODE signs browsers in as the seeded operator
 *    so a fresh clone is clickable. Extending that to MCP would let any
 *    unauthenticated client act — and be recorded — as a human, which poisons
 *    both the audit trail and the approval-streak stats that autonomy
 *    graduation reads.
 *
 * Two credentials are accepted:
 *
 *  1. A workspace API key (`zest_…` bearer token or `x-api-key` header). The
 *     actor is a machine: `{kind: "mcp", clientId: <key id>}`, limited to the
 *     key's scopes.
 *  2. An OAuth access token issued by this instance's authorization server
 *     (`@better-auth/mcp`). The token traces to the user who approved the
 *     flow, so the actor is user-backed: `{kind: "mcp", clientId, userId}`
 *     with full scopes — the session acts with that user's authority.
 *
 * Anything else gets the RFC 9728 challenge: a 401 whose `WWW-Authenticate`
 * names the protected-resource metadata, which is all a spec-conforming client
 * needs to discover registration, authorize and token endpoints on its own.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
  /**
   * Identity for the verifier's JWKS cache. The key set is fetched through the
   * auth instance rather than over HTTP from our own public URL — a deployment
   * that keeps the server internal cannot necessarily reach its own front door
   * — and a function source is refetched on every call unless it is given a
   * stable object to cache under.
   */
  private readonly jwksCacheKey = {};

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<Response>();

    const bearer = readBearer(req);
    const apiKey = readApiKey(req, bearer);

    if (apiKey) {
      const key = await resolveApiKey(this.db, apiKey);
      req.workspaceId = key.workspaceId;
      req.actor = { kind: "mcp", clientId: key.keyId };
      req.scopes = key.scopes;
      return true;
    }

    if (bearer) {
      const claims = await this.verify(bearer);
      const userId = typeof claims?.sub === "string" ? claims.sub : null;
      if (claims && userId) {
        req.workspaceId = await resolveWorkspaceForUser(this.db, userId);
        req.userId = userId;
        req.actor = {
          kind: "mcp",
          clientId: typeof claims.client_id === "string" ? claims.client_id : "unknown",
          userId,
        };
        // A user authorized this session, so it carries the user's authority.
        req.scopes = normalizeScopes([]);
        return true;
      }
    }

    throw this.challenge(res);
  }

  /**
   * Access tokens are signed JWTs, so this is a signature check rather than a
   * database lookup: the token has to be signed by our own key, name us as
   * issuer, and be audience-bound to this MCP endpoint. A token minted for
   * some other resource on the same authorization server does not open `/mcp`.
   *
   * Returns null rather than throwing, so an unverifiable token produces the
   * same discovery challenge as no token at all.
   */
  private async verify(token: string) {
    const baseURL = publicBaseUrl(loadEnv());
    try {
      const claims = await verifyJwsAccessToken(token, {
        jwksFetch: () => this.auth.api.getJwks(),
        jwksCacheKey: this.jwksCacheKey,
        verifyOptions: {
          issuer: `${baseURL}/api/auth`,
          audience: mcpResource(baseURL),
        },
      });
      // `cnf` marks a sender-constrained (DPoP) token, whose proof this guard
      // does not check. Accepting one as a plain bearer would quietly discard
      // the binding the client asked for, so refuse it instead. Nothing here
      // issues DPoP-bound tokens today; this is the fence for the day it does.
      if (claims.cnf) return null;
      return claims;
    } catch {
      return null;
    }
  }

  /** 401 + WWW-Authenticate, per RFC 9728 §5.1 — the discovery entry point. */
  private challenge(res: Response): UnauthorizedException {
    const metadataUrl = `${publicBaseUrl(loadEnv())}/.well-known/oauth-protected-resource`;
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${metadataUrl}"`);
    res.setHeader("Access-Control-Expose-Headers", "WWW-Authenticate");
    return new UnauthorizedException(
      "Authenticate with a workspace API key, or complete the OAuth flow this server advertises in WWW-Authenticate.",
    );
  }
}

function readBearer(req: AuthedRequest): string | null {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
}

/** Zest API keys are prefixed; anything else in Bearer is an OAuth token. */
function readApiKey(req: AuthedRequest, bearer: string | null): string | null {
  if (bearer?.startsWith("zest_")) return bearer;
  const custom = req.headers["x-api-key"];
  if (typeof custom === "string" && custom.length > 0) return custom;
  return null;
}
