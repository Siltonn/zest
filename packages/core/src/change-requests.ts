import { and, desc, eq, schema, sql, type Database } from "@zest/db";
import { actorUserId, isUserBacked, type Actor, type AutonomyAction } from "@zest/shared";
import * as autonomy from "./autonomy.ts";
import * as memory from "./memory.ts";

/**
 * Changes the agent wants to make to itself.
 *
 * Posts and replies are domain rows with a state machine; a proposed rewrite of
 * the strategy — or a request to stop asking permission — needs the same
 * treatment. Approving one is not a bookkeeping update: it rewrites the memory
 * document the next run reads, or grants a rule that changes what every tool is
 * allowed to do. So the decision belongs in the same inbox as the rest.
 */

export type ChangeRequest = typeof schema.changeRequests.$inferSelect;

export type MemoryPayload = {
  kind: memory.MemoryKind;
  accountId: string | null;
  before: string | null;
  after: string;
};

export type AutonomyPayload = {
  action: AutonomyAction;
  connectorId: string | null;
  accountId: string | null;
  consecutiveCleanApprovals: number;
};

export async function open(
  db: Database,
  input: {
    workspaceId: string;
    kind: "memory" | "autonomy";
    summary: string;
    rationale?: string;
    payload: MemoryPayload | AutonomyPayload;
    agentRunId?: string | null;
  },
): Promise<ChangeRequest> {
  const [created] = await db
    .insert(schema.changeRequests)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      summary: input.summary,
      rationale: input.rationale ?? null,
      payload: input.payload as unknown as Record<string, unknown>,
      agentRunId: input.agentRunId ?? null,
    })
    .returning();
  if (!created) throw new Error("Could not open the change request");
  return created;
}

export async function listPending(
  db: Database,
  workspaceId: string,
): Promise<ChangeRequest[]> {
  return db
    .select()
    .from(schema.changeRequests)
    .where(
      and(
        eq(schema.changeRequests.workspaceId, workspaceId),
        eq(schema.changeRequests.status, "pending"),
      ),
    )
    .orderBy(desc(schema.changeRequests.createdAt));
}

export async function pendingCount(
  db: Database,
  workspaceId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.changeRequests)
    .where(
      and(
        eq(schema.changeRequests.workspaceId, workspaceId),
        eq(schema.changeRequests.status, "pending"),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Approving is what makes the change real: a memory request writes a new
 * version of the document, an autonomy request grants the rule. Both are
 * claimed with a conditional UPDATE first, for the same reason publishing is —
 * two operators clicking approve must not grant the rule twice.
 */
export async function approve(
  db: Database,
  workspaceId: string,
  id: string,
  actor: Actor,
): Promise<{ kind: string; applied: string }> {
  // Checked before the claim, so a refused grant leaves the request pending
  // for a person to decide rather than half-approved.
  const [pending] = await db
    .select({ kind: schema.changeRequests.kind })
    .from(schema.changeRequests)
    .where(
      and(
        eq(schema.changeRequests.id, id),
        eq(schema.changeRequests.workspaceId, workspaceId),
        eq(schema.changeRequests.status, "pending"),
      ),
    );
  if (!pending) throw new Error("That request has already been decided");

  // An autonomy request is the agent asking to act without review. Approving
  // it must trace to a person — a session, or an MCP token a user authorized.
  // A standing machine credential (API key, agent, system) granting it would
  // be the exact escalation the review gate exists to prevent.
  if (pending.kind === "autonomy" && !isUserBacked(actor)) {
    throw new Error(
      "Granting autonomy requires a signed-in user. API keys cannot approve autonomy requests — use the web inbox, or connect over MCP with a user-authorized OAuth session.",
    );
  }

  const [claimed] = await db
    .update(schema.changeRequests)
    .set({
      status: "approved",
      resolvedAt: new Date(),
      resolvedBy: actorLabel(actor),
    })
    .where(
      and(
        eq(schema.changeRequests.id, id),
        eq(schema.changeRequests.workspaceId, workspaceId),
        eq(schema.changeRequests.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) throw new Error("That request has already been decided");

  if (claimed.kind === "memory") {
    const payload = claimed.payload as unknown as MemoryPayload;
    const doc = await memory.writeMemory(db, {
      workspaceId,
      kind: payload.kind,
      contentMd: payload.after,
      accountId: payload.accountId ?? undefined,
      actor,
    });
    await record(db, workspaceId, claimed, actor, "approve_memory_update");
    return { kind: "memory", applied: `${payload.kind} v${doc.version}` };
  }

  const payload = claimed.payload as unknown as AutonomyPayload;
  await autonomy.grantAutonomy(db, {
    workspaceId,
    action: payload.action,
    mode: "auto",
    connectorId: payload.connectorId ?? undefined,
    accountId: payload.accountId ?? undefined,
    // The gate above guarantees a user stands behind this actor.
    grantedBy: actorUserId(actor) ?? actorLabel(actor),
    actor,
  });
  await record(db, workspaceId, claimed, actor, "approve_autonomy_request");
  return { kind: "autonomy", applied: payload.action };
}

export async function reject(
  db: Database,
  workspaceId: string,
  id: string,
  actor: Actor,
  reason?: string,
): Promise<void> {
  const [claimed] = await db
    .update(schema.changeRequests)
    .set({
      status: "rejected",
      resolvedAt: new Date(),
      resolvedBy: actorLabel(actor),
    })
    .where(
      and(
        eq(schema.changeRequests.id, id),
        eq(schema.changeRequests.workspaceId, workspaceId),
        eq(schema.changeRequests.status, "pending"),
      ),
    )
    .returning();
  if (!claimed) throw new Error("That request has already been decided");

  await record(db, workspaceId, claimed, actor, "reject_change_request", reason);
}

async function record(
  db: Database,
  workspaceId: string,
  request: ChangeRequest,
  actor: Actor,
  action: string,
  reason?: string,
): Promise<void> {
  await db.insert(schema.auditLogs).values({
    workspaceId,
    entityType: request.kind === "memory" ? "memory_proposal" : "autonomy_request",
    entityId: request.id,
    action,
    fromStatus: "pending",
    toStatus: request.status,
    actor,
    diff: { summary: request.summary, ...(reason ? { reason } : {}) },
    agentRunId: request.agentRunId,
  });
}

function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "human":
      return `human:${actor.userId}`;
    case "agent":
      return `agent:${actor.runId}`;
    case "mcp":
      return `mcp:${actor.clientId}`;
    case "api":
      return `api:${actor.keyId}`;
    default:
      return "system";
  }
}
