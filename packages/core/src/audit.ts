import { and, desc, eq, lt, schema, sql, type Database } from "@zest/db";
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
  /** Cursor: return rows strictly older than this. */
  before?: Date;
  limit?: number;
};

/**
 * A page of the log, newest first.
 *
 * Cursor-paged rather than offset-paged: the log is append-only and read
 * backwards, so an offset shifts under you the moment anything happens and you
 * see a row twice or miss one. The cursor is the last row's timestamp — stable
 * regardless of what arrives while you read.
 */
export async function listAudit(
  db: Database,
  workspaceId: string,
  filter: AuditFilter = {},
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const conditions = [eq(schema.auditLogs.workspaceId, workspaceId)];
  if (filter.entityType) {
    conditions.push(eq(schema.auditLogs.entityType, filter.entityType));
  }
  if (filter.entityId) conditions.push(eq(schema.auditLogs.entityId, filter.entityId));
  if (filter.actorKind) {
    conditions.push(sql`${schema.auditLogs.actor}->>'kind' = ${filter.actorKind}`);
  }
  if (filter.before) {
    conditions.push(lt(schema.auditLogs.createdAt, filter.before));
  }

  const limit = filter.limit ?? 50;

  // One extra row answers "is there more" without a second count query.
  const rows = await db
    .select()
    .from(schema.auditLogs)
    .where(and(...conditions))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(limit + 1);

  const entries = rows.slice(0, limit);
  const nextCursor =
    rows.length > limit ? (entries.at(-1)?.createdAt.toISOString() ?? null) : null;

  return { entries, nextCursor };
}

/** The distinct entity types present, so the filter offers only real ones. */
export async function entityTypes(
  db: Database,
  workspaceId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ entityType: schema.auditLogs.entityType })
    .from(schema.auditLogs)
    .where(eq(schema.auditLogs.workspaceId, workspaceId));
  return rows.map((r) => r.entityType).sort();
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
