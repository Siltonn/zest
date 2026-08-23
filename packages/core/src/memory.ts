import { and, desc, eq, isNull, schema, type Database } from "@zest/db";
import type { Actor } from "@zest/shared";

/**
 * Agent memory as versioned markdown documents.
 *
 * Deliberately not a vector store. Inspectable, diffable memory is a product
 * feature: the operator can read exactly what the agent believes about their
 * brand, see what changed after each analysis run, and roll it back.
 *
 * Two layers, mirroring what an operations team actually keeps on its desk:
 *
 * - Workspace: the brand's shared truth. `brand_brief` (facts and red lines),
 *   `strategy` (how the accounts divide the work — the matrix, not any one
 *   account's tactics), `learnings` (patterns that hold whichever handle
 *   posts), `report`.
 * - Account: `persona` — one playbook per handle: who is speaking, its
 *   positioning, content pillars, red lines, cadence notes. And `learnings`
 *   scoped to an account, for the patterns that only hold there.
 *
 * The test for which learnings layer a pattern belongs to: would it survive
 * being posted from a different handle? Yes → workspace; no → that account.
 *
 * `assertMemoryScope` is the single gate that keeps the layers honest — the
 * schema can store any kind at either scope, and before the gate existed an
 * account-scoped strategy could be written through the API, versioned,
 * audited, approved… and read by nothing, ever.
 */

export type MemoryKind =
  | "brand_brief"
  | "strategy"
  | "learnings"
  | "persona"
  | "report";

export type MemoryDoc = typeof schema.memoryDocs.$inferSelect;

/** A scope rule rejecting a write is the caller's mistake, not a crash. */
export class MemoryScopeError extends Error {}

/**
 * Which kinds live at which scope. Enforced at the one choke point every
 * write path shares, so the API, the agent tool, and the approval flow cannot
 * disagree about it.
 */
export function assertMemoryScope(kind: MemoryKind, accountId?: string | null): void {
  if (kind === "persona" && !accountId) {
    throw new MemoryScopeError(
      "A playbook belongs to an account — persona needs an accountId.",
    );
  }
  if ((kind === "brand_brief" || kind === "strategy" || kind === "report") && accountId) {
    throw new MemoryScopeError(
      `${kind} is workspace-wide. The account-level counterpart of the brief and ` +
        "the strategy is the account's playbook (persona), not a per-account copy.",
    );
  }
}

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
  assertMemoryScope(input.kind, input.accountId);

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
 * Assembles the context block injected into every agent run: identity first
 * (brand, then this account's playbook), then policy, then evidence (general,
 * then account-specific). The layers stack — nothing overrides anything, so
 * every section in the prompt has exactly one source.
 *
 * Account-scoped work gets its own playbook and its own learnings and nothing
 * from its siblings — the mechanism that stops voices drifting together
 * across handles.
 */
export async function buildContext(
  db: Database,
  workspaceId: string,
  accountId?: string,
): Promise<string> {
  const [brief, strategy, learnings, persona, accountLearnings] = await Promise.all([
    readMemory(db, workspaceId, "brand_brief"),
    readMemory(db, workspaceId, "strategy"),
    readMemory(db, workspaceId, "learnings"),
    accountId ? readMemory(db, workspaceId, "persona", accountId) : null,
    accountId ? readMemory(db, workspaceId, "learnings", accountId) : null,
  ]);

  const sections: string[] = [];
  if (brief) sections.push(`## Brand brief\n\n${brief.contentMd}`);
  if (persona) sections.push(`## This account's playbook\n\n${persona.contentMd}`);
  if (strategy) sections.push(`## Current strategy\n\n${strategy.contentMd}`);
  if (learnings) sections.push(`## What we have learned so far\n\n${learnings.contentMd}`);
  if (accountLearnings) {
    sections.push(`## What works on this account\n\n${accountLearnings.contentMd}`);
  }

  return sections.length > 0
    ? sections.join("\n\n")
    : "No brand memory has been written yet. Ask the operator for a brief before proposing content.";
}
