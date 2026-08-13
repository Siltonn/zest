import { and, desc, eq, schema, sql, type Database } from "@zest/db";
import type { Actor } from "@zest/shared";

/**
 * Provenance queries. The audit log is written inside the same transaction as
 * every state change (see state-machine.ts), so this view is complete by
 * construction rather than best-effort.
 */

export type AuditEntry = typeof schema.auditLogs.$inferSelect;

export type AuditFilter = {
  entityType?: string;
  entityId?: string;
  actorKind?: Actor["kind"];
  limit?: number;
};

export async function listAudit(
  db: Database,
  workspaceId: string,
  filter: AuditFilter = {},
): Promise<AuditEntry[]> {
  const conditions = [eq(schema.auditLogs.workspaceId, workspaceId)];
  if (filter.entityType) {
    conditions.push(eq(schema.auditLogs.entityType, filter.entityType));
  }
  if (filter.entityId) conditions.push(eq(schema.auditLogs.entityId, filter.entityId));
  if (filter.actorKind) {
    conditions.push(sql`${schema.auditLogs.actor}->>'kind' = ${filter.actorKind}`);
  }

  return db
    .select()
    .from(schema.auditLogs)
    .where(and(...conditions))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(filter.limit ?? 100);
}

/** The full history of one entity, oldest first — powers the status timeline. */
export async function timelineFor(
  db: Database,
  entityType: string,
  entityId: string,
): Promise<AuditEntry[]> {
  return db
    .select()
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.entityType, entityType),
        eq(schema.auditLogs.entityId, entityId),
      ),
    )
    .orderBy(schema.auditLogs.createdAt);
}

export async function record(
  db: Database,
  entry: {
    workspaceId: string;
    entityType: string;
    entityId: string;
    action: string;
    actor: Actor;
    fromStatus?: string;
    toStatus?: string;
    diff?: unknown;
    agentRunId?: string;
  },
): Promise<void> {
  await db.insert(schema.auditLogs).values({
    workspaceId: entry.workspaceId,
    entityType: entry.entityType,
    entityId: entry.entityId,
    action: entry.action,
    fromStatus: entry.fromStatus ?? null,
    toStatus: entry.toStatus ?? null,
    actor: entry.actor,
    diff: entry.diff ?? null,
    agentRunId: entry.agentRunId ?? null,
  });
}

/** Who did what, for the audit page's summary strip. */
export async function actorBreakdown(
  db: Database,
  workspaceId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      kind: sql<string>`${schema.auditLogs.actor}->>'kind'`,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.workspaceId, workspaceId))
    .groupBy(sql`${schema.auditLogs.actor}->>'kind'`);

  return Object.fromEntries(rows.map((r) => [r.kind ?? "unknown", r.n]));
}
