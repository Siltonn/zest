import { and, desc, eq, isNull, schema, type Database } from "@zest/db";
import type { Actor } from "@zest/shared";

/**
 * Agent memory as versioned markdown documents.
 *
 * Deliberately not a vector store. Inspectable, diffable memory is a product
 * feature: the operator can read exactly what the agent believes about their
 * brand, see what changed after each analysis run, and roll it back.
 *
 * Scope matters for multi-account workspaces. Brand facts and strategy are
 * workspace-wide; the persona card is per account, so a founder's personal
 * handle and the company handle keep distinct voices instead of blurring into
 * one another.
 */

export type MemoryKind =
  | "brand_brief"
  | "strategy"
  | "learnings"
  | "persona"
  | "report";

export type MemoryDoc = typeof schema.memoryDocs.$inferSelect;

export async function readMemory(
  db: Database,
  workspaceId: string,
  kind: MemoryKind,
  accountId?: string,
): Promise<MemoryDoc | null> {
  const [doc] = await db
    .select()
    .from(schema.memoryDocs)
    .where(
      and(
        eq(schema.memoryDocs.workspaceId, workspaceId),
        eq(schema.memoryDocs.kind, kind),
        accountId
          ? eq(schema.memoryDocs.accountId, accountId)
          : isNull(schema.memoryDocs.accountId),
      ),
    )
    .orderBy(desc(schema.memoryDocs.version))
    .limit(1);

  return doc ?? null;
}

/** Every write creates a new version; nothing is overwritten in place. */
export async function writeMemory(
  db: Database,
  input: {
    workspaceId: string;
    kind: MemoryKind;
    contentMd: string;
    actor: Actor;
    accountId?: string;
  },
): Promise<MemoryDoc> {
  const current = await readMemory(db, input.workspaceId, input.kind, input.accountId);
  const version = (current?.version ?? 0) + 1;

  return db.transaction(async (tx) => {
    const [doc] = await tx
      .insert(schema.memoryDocs)
      .values({
        workspaceId: input.workspaceId,
        scope: input.accountId ? "account" : "workspace",
        accountId: input.accountId ?? null,
        kind: input.kind,
        version,
        contentMd: input.contentMd,
        updatedByActor: input.actor,
      })
      .returning();

    if (!doc) throw new Error("Failed to write memory doc");

    await tx.insert(schema.auditLogs).values({
      workspaceId: input.workspaceId,
      entityType: "memory_doc",
      entityId: doc.id,
      action: "update_memory",
      actor: input.actor,
      diff: {
        kind: input.kind,
        version,
        previousVersion: current?.version ?? null,
        before: current?.contentMd ?? null,
        after: input.contentMd,
      },
    });

    return doc;
  });
}

export async function memoryHistory(
  db: Database,
  workspaceId: string,
  kind: MemoryKind,
  accountId?: string,
): Promise<MemoryDoc[]> {
  return db
    .select()
    .from(schema.memoryDocs)
    .where(
      and(
        eq(schema.memoryDocs.workspaceId, workspaceId),
        eq(schema.memoryDocs.kind, kind),
        accountId
          ? eq(schema.memoryDocs.accountId, accountId)
          : isNull(schema.memoryDocs.accountId),
      ),
    )
    .orderBy(desc(schema.memoryDocs.version));
}

/**
 * Assembles the context block injected into every agent run. Account-scoped
 * work gets that account's persona and nothing from its siblings — the
 * mechanism that stops voices drifting together across handles.
 */
export async function buildContext(
  db: Database,
  workspaceId: string,
  accountId?: string,
): Promise<string> {
  const [brief, strategy, learnings, persona] = await Promise.all([
    readMemory(db, workspaceId, "brand_brief"),
    readMemory(db, workspaceId, "strategy"),
    readMemory(db, workspaceId, "learnings"),
    accountId ? readMemory(db, workspaceId, "persona", accountId) : null,
  ]);

  const sections: string[] = [];
  if (brief) sections.push(`## Brand brief\n\n${brief.contentMd}`);
  if (persona) sections.push(`## Voice for this account\n\n${persona.contentMd}`);
  if (strategy) sections.push(`## Current strategy\n\n${strategy.contentMd}`);
  if (learnings) sections.push(`## What we have learned so far\n\n${learnings.contentMd}`);

  return sections.length > 0
    ? sections.join("\n\n")
    : "No brand memory has been written yet. Ask the operator for a brief before proposing content.";
}
