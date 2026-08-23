import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import type { Database } from "@zest/db";
import { normalizeScopes } from "@zest/shared";
import { DATABASE } from "../infra/database.module.js";
import { AUTH, type Auth } from "./auth.js";
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
 *     (Better Auth's `mcp` plugin). The token traces to the user who approved
 *     the flow, so the actor is user-backed: `{kind: "mcp", clientId, userId}`
 *     with full scopes — the session acts with that user's authority.
 *
 * Anything else gets the RFC 9728 challenge: a 401 whose `WWW-Authenticate`
 * names the protected-resource metadata, which is all a spec-conforming client
 * needs to discover registration, authorize and token endpoints on its own.
 */
@Injectable()
export class McpAuthGuard implements CanActivate {
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
      const session = await this.auth.api.getMcpSession({
        headers: toFetchHeaders(req),
      });
      if (session?.userId) {
        req.workspaceId = await resolveWorkspaceForUser(this.db, session.userId);
        req.userId = session.userId;
        req.actor = {
          kind: "mcp",
          clientId: session.clientId,
          userId: session.userId,
        };
        // A user authorized this session, so it carries the user's authority.
        req.scopes = normalizeScopes([]);
        return true;
      }
    }

    throw this.challenge(res);
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

/** Express headers can repeat; flatten to the shape Better Auth's API expects. */
function toFetchHeaders(req: AuthedRequest): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}
