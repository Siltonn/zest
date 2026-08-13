import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request } from "express";
import { and, eq, schema, type Database } from "@zest/db";
import type { Actor } from "@zest/shared";
import { DATABASE } from "../infra/database.module.js";
import { AUTH, type Auth } from "./auth.js";
import { loadEnv } from "../config.js";

/**
 * Two ways in, one outcome.
 *
 * A browser arrives with a session cookie; an agent or script arrives with an
 * API key. Both resolve to the same {workspaceId, actor} pair, so a controller
 * never has to care which client it is serving — and the audit log records
 * honestly which one it was.
 */

export type AuthedRequest = Request & {
  workspaceId: string;
  actor: Actor;
  userId?: string;
};

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AUTH) private readonly auth: Auth,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const apiKey = extractApiKey(req);
    if (apiKey) return this.authenticateApiKey(req, apiKey);

    return this.authenticateSession(req);
  }

  private async authenticateApiKey(
    req: AuthedRequest,
    presented: string,
  ): Promise<boolean> {
    // Keys are stored hashed, so a database leak does not hand over live keys.
    const hashed = createHash("sha256").update(presented).digest("hex");
    const [key] = await this.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.hashedKey, hashed));

    if (!key) throw new UnauthorizedException("Invalid API key");

    await this.db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, key.id));

    req.workspaceId = key.workspaceId;
    req.actor = { kind: "api", keyId: key.id };
    return true;
  }

  private async authenticateSession(req: AuthedRequest): Promise<boolean> {
    const session = await this.auth.api.getSession({
      headers: req.headers as unknown as Headers,
    });

    let userId = session?.user?.id;

    // Demo mode signs in as the seeded operator so a fresh clone can be
    // clicked through immediately. Never enabled by default.
    if (!userId && loadEnv().DEMO_MODE) {
      const [demoUser] = await this.db.select().from(schema.users).limit(1);
      userId = demoUser?.id;
    }

    if (!userId) throw new UnauthorizedException("Not signed in");

    const [membership] = await this.db
      .select()
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, userId));

    if (!membership) throw new UnauthorizedException("No workspace for this user");

    req.workspaceId = membership.workspaceId;
    req.userId = userId;
    req.actor = { kind: "human", userId };
    return true;
  }
}

function extractApiKey(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice(7).trim();
    // Session tokens also ride in Authorization on some clients; ours are prefixed.
    if (token.startsWith("zest_")) return token;
  }
  const custom = req.headers["x-api-key"];
  if (typeof custom === "string" && custom.length > 0) return custom;
  return null;
}

/** Verifies a workspace actually belongs to the caller before acting on it. */
export async function assertWorkspaceAccess(
  db: Database,
  workspaceId: string,
  userId: string,
): Promise<void> {
  const [membership] = await db
    .select()
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.workspaceId, workspaceId),
        eq(schema.memberships.userId, userId),
      ),
    );
  if (!membership) throw new UnauthorizedException("No access to this workspace");
}
