import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import { and, asc, eq, schema, type Database } from "@zest/db";
import { normalizeScopes, type Actor, type ApiScope } from "@zest/shared";
import { DATABASE } from "../infra/database.module.js";
import { AUTH, type Auth } from "./auth.js";
import { loadEnv } from "../config.js";

/**
 * Two ways in, one outcome.
 *
 * A browser arrives with a session cookie; an agent or script arrives with an
 * API key. Both resolve to the same {workspaceId, actor, scopes} triple, so a
 * controller never has to care which client it is serving — and the audit log
 * records honestly which one it was.
 */

export type AuthedRequest = Request & {
  workspaceId: string;
  actor: Actor;
  userId?: string;
  /** What the credential may do. A signed-in user carries every scope. */
  scopes: ReadonlySet<ApiScope>;
};

const ALL_SCOPES: ReadonlySet<ApiScope> = normalizeScopes([]);

/**
 * Resolve a presented API key to its workspace and scopes, or throw.
 * Shared by the REST guard and the MCP guard so the two surfaces cannot
 * drift on how a key is checked.
 */
export async function resolveApiKey(
  db: Database,
  presented: string,
): Promise<{ workspaceId: string; keyId: string; scopes: ReadonlySet<ApiScope> }> {
  // Keys are stored hashed, so a database leak does not hand over live keys.
  const hashed = createHash("sha256").update(presented).digest("hex");
  const [key] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.hashedKey, hashed));

  if (!key) throw new UnauthorizedException("Invalid API key");

  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, key.id));

  return {
    workspaceId: key.workspaceId,
    keyId: key.id,
    scopes: normalizeScopes(key.scopes),
  };
}

/**
 * Refuse the request unless the credential carries the scope. Humans always
 * pass — scopes narrow machine credentials, not people.
 */
export function requireScope(req: AuthedRequest, scope: ApiScope): void {
  if (req.scopes.has(scope)) return;
  throw new ForbiddenException(
    `This API key does not have the "${scope}" scope. Mint one with it in Settings → API keys.`,
  );
}

/**
 * Refuse unless a person stands behind the request — a session, or an MCP
 * OAuth token a user authorized. Guards the escalation surface: minting
 * credentials, adding delivery targets, granting the agent autonomy. A
 * standing machine credential must not be able to widen its own reach,
 * whatever scopes it carries.
 */
export function requireUserBacked(req: AuthedRequest): void {
  if (req.userId) return;
  throw new ForbiddenException(
    "This needs a signed-in user. API keys cannot change credentials, delivery targets, or the agent's autonomy.",
  );
}

/** Which of their workspaces this browser is currently working in. */
export const WORKSPACE_COOKIE = "zest_workspace";

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
    const key = await resolveApiKey(this.db, presented);
    req.workspaceId = key.workspaceId;
    req.actor = { kind: "api", keyId: key.keyId };
    req.scopes = key.scopes;
    return true;
  }

  private async authenticateSession(req: AuthedRequest): Promise<boolean> {
    const session = await this.auth.api.getSession({
      headers: req.headers as unknown as Headers,
    });

    let userId = session?.user?.id;

    // Demo mode signs in as the seeded operator so a fresh clone can be
    // clicked through immediately. `.env.example` ships it on, which means the
    // documented quick start produces an instance with no auth — deliberate for
    // a local demo, and the reason boot logs a warning about it.
    if (!userId && loadEnv().DEMO_MODE) {
      const [demoUser] = await this.db.select().from(schema.users).limit(1);
      userId = demoUser?.id;
    }

    if (!userId) throw new UnauthorizedException("Not signed in");

    // The cookie names the workspace this browser last switched into. It is
    // honored only when a membership backs it, so a stale or tampered value
    // degrades to the user's oldest workspace rather than into someone else's.
    const preferred = readCookie(req.headers.cookie, WORKSPACE_COOKIE);
    const workspaceId = await resolveWorkspaceForUser(this.db, userId, preferred);

    req.workspaceId = workspaceId;
    req.userId = userId;
    req.actor = { kind: "human", userId };
    req.scopes = ALL_SCOPES;
    return true;
  }

}

/**
 * The workspace a user's request acts in: the preferred one when a membership
 * backs it, their oldest otherwise. A freshly signed-up user has no workspace
 * yet, so one is provisioned — they land in a usable app instead of an error
 * they cannot act on. Shared by the session path and the MCP OAuth path, so a
 * user's MCP client and their browser resolve to the same default workspace.
 */
export async function resolveWorkspaceForUser(
  db: Database,
  userId: string,
  preferredWorkspaceId?: string | null,
): Promise<string> {
  const memberships = await db
    .select()
    .from(schema.memberships)
    .where(eq(schema.memberships.userId, userId))
    .orderBy(asc(schema.memberships.createdAt));

  const membership =
    memberships.find((m) => m.workspaceId === preferredWorkspaceId) ?? memberships[0];
  if (membership) return membership.workspaceId;

  const [user] = await db
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, userId));

  const workspace = await provisionWorkspace(db, {
    userId,
    name: user?.name ? `${user.name}'s workspace` : "My workspace",
  });
  return workspace.id;
}

/**
 * A workspace plus the membership that makes `userId` its owner — the pair
 * everything else assumes exists together. First sign-in and "New workspace"
 * both come through here so neither can create one without the other.
 * Timezone falls back to UTC; the settings page lets them change it.
 */
export async function provisionWorkspace(
  db: Database,
  input: { userId: string; name: string; timezone?: string },
): Promise<{ id: string; name: string }> {
  const [workspace] = await db
    .insert(schema.workspaces)
    .values({ name: input.name, timezone: input.timezone ?? "UTC" })
    .returning({ id: schema.workspaces.id, name: schema.workspaces.name });

  await db.insert(schema.memberships).values({
    workspaceId: workspace!.id,
    userId: input.userId,
    role: "owner",
  });

  return workspace!;
}

/**
 * One year, HttpOnly, Lax: the choice should survive browser restarts, is no
 * business of page scripts, and still rides along on top-level navigations so
 * the next load lands in the workspace that was just chosen.
 */
export function setWorkspaceCookie(res: Response, workspaceId: string): void {
  res.cookie(WORKSPACE_COOKIE, workspaceId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 365 * 24 * 60 * 60 * 1000,
  });
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
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
