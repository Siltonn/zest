import { and, desc, eq, inArray, schema, sql, type Database } from "@zest/db";
import type { Actor, PostContent } from "@zest/shared";
import { transition } from "./state-machine.ts";
import * as changeRequests from "./change-requests.ts";

/**
 * The approval inbox.
 *
 * Proposals are ordinary rows, which is what lets this exist at all: they can
 * be listed, filtered, bulk-approved, deep-linked from Slack, approved over
 * MCP, and expired by a cron. None of that is possible if pending state is
 * hidden inside an agent framework's checkpoint.
 */

export type InboxItemKind = "post" | "reply" | "memory" | "autonomy_request";

export type InboxItem = {
  id: string;
  kind: InboxItemKind;
  workspaceId: string;
  title: string;
  body: string;
  accountId?: string;
  accountHandle?: string;
  connectorId?: string;
  suggestedSlotAt?: Date | null;
  reasoning?: string | null;
  agentRunId?: string | null;
  createdAt: Date;
  /** Present on reply drafts: what the agent is answering. */
  context?: { author: string; text: string; sentiment?: string | null };
  /** Present on memory proposals: the document as it stands today. */
  before?: string | null;
};

export async function listInbox(
  db: Database,
  workspaceId: string,
): Promise<InboxItem[]> {
  const pending = ["pending_approval", "needs_changes"] as const;

  const postRows = await db
    .select({
      post: schema.posts,
      account: schema.linkedAccounts,
    })
    .from(schema.posts)
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.posts.accountId, schema.linkedAccounts.id),
    )
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        inArray(schema.posts.status, [...pending]),
      ),
    )
    .orderBy(desc(schema.posts.createdAt));

  const replyRows = await db
    .select({
      draft: schema.replyDrafts,
      inbound: schema.inboundItems,
      account: schema.linkedAccounts,
    })
    .from(schema.replyDrafts)
    .innerJoin(
      schema.inboundItems,
      eq(schema.replyDrafts.inboundItemId, schema.inboundItems.id),
    )
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.inboundItems.accountId, schema.linkedAccounts.id),
    )
    .where(
      and(
        eq(schema.replyDrafts.workspaceId, workspaceId),
        inArray(schema.replyDrafts.status, [...pending]),
      ),
    )
    .orderBy(desc(schema.replyDrafts.createdAt));

  const posts: InboxItem[] = postRows.map(({ post, account }) => ({
    id: post.id,
    kind: "post",
    workspaceId: post.workspaceId,
    title: `Post for @${account.handle}`,
    body: post.content.text,
    accountId: account.id,
    accountHandle: account.handle,
    connectorId: account.connectorId,
    suggestedSlotAt: post.suggestedSlotAt,
    reasoning: post.reasoning,
    agentRunId: post.agentRunId,
    createdAt: post.createdAt,
  }));

  // A persona proposal can name an account that has nothing else pending, so
  // the handle has to come from the account list rather than the rows above.
  const accountsById = new Map(
    (
      await db
        .select()
        .from(schema.linkedAccounts)
        .where(eq(schema.linkedAccounts.workspaceId, workspaceId))
    ).map((account) => [account.id, account]),
  );

  const changes: InboxItem[] = (
    await changeRequests.listPending(db, workspaceId)
  ).map((request) => {
    const memoryPayload =
      request.kind === "memory"
        ? (request.payload as unknown as changeRequests.MemoryPayload)
        : null;
    const account = memoryPayload?.accountId
      ? accountsById.get(memoryPayload.accountId)
      : undefined;

    return {
      id: request.id,
      kind: request.kind === "memory" ? "memory" : "autonomy_request",
      workspaceId: request.workspaceId,
      title: request.summary,
      body: memoryPayload
        ? memoryPayload.after
        : (request.rationale ?? "The agent is asking to act without review."),
      accountId: account?.id,
      accountHandle: account?.handle,
      connectorId: account?.connectorId,
      reasoning: request.rationale,
      agentRunId: request.agentRunId,
      createdAt: request.createdAt,
      before: memoryPayload?.before ?? null,
    };
  });

  const replies: InboxItem[] = replyRows.map(({ draft, inbound, account }) => ({
    id: draft.id,
    kind: "reply",
    workspaceId: draft.workspaceId,
    title: `Reply to @${inbound.authorHandle}`,
    body: draft.content.text,
    accountId: account.id,
    accountHandle: account.handle,
    connectorId: account.connectorId,
    reasoning: draft.reasoning,
    agentRunId: draft.agentRunId,
    createdAt: draft.createdAt,
    context: {
      author: inbound.authorHandle,
      text: inbound.text,
      sentiment: inbound.sentiment,
    },
  }));

  return [...posts, ...replies, ...changes].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
}

export async function inboxCount(db: Database, workspaceId: string): Promise<number> {
  const [postCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        inArray(schema.posts.status, ["pending_approval", "needs_changes"]),
      ),
    );
  const [replyCount] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.replyDrafts)
    .where(
      and(
        eq(schema.replyDrafts.workspaceId, workspaceId),
        inArray(schema.replyDrafts.status, ["pending_approval", "needs_changes"]),
      ),
    );
  const changeCount = await changeRequests.pendingCount(db, workspaceId);
  return (postCount?.n ?? 0) + (replyCount?.n ?? 0) + changeCount;
}

/**
 * Approve a post. When the proposal carried a suggested slot we schedule it in
 * the same move, so "approve" means "this will go out" rather than leaving the
 * operator a second chore.
 */
export async function approvePost(
  db: Database,
  postId: string,
  actor: Actor,
  options?: { content?: PostContent; scheduledAt?: Date },
): Promise<{ status: string; scheduledAt: Date | null }> {
  const [post] = await db
    .select()
    .from(schema.posts)
    .where(eq(schema.posts.id, postId));
  if (!post) throw new Error(`Post ${postId} not found`);

  await transition(db, {
    postId,
    action: "approve",
    actor,
    patch: options?.content ? { content: options.content } : undefined,
  });

  const slot = options?.scheduledAt ?? post.suggestedSlotAt;
  if (!slot) return { status: "approved", scheduledAt: null };

  const result = await transition(db, {
    postId,
    action: "schedule",
    actor,
    patch: { scheduledAt: slot },
  });
  return { status: result.to, scheduledAt: slot };
}

export async function rejectPost(
  db: Database,
  postId: string,
  actor: Actor,
  reason?: string,
): Promise<void> {
  await transition(db, {
    postId,
    action: "reject",
    actor,
    patch: reason ? { errorMessage: reason } : undefined,
  });
}

/**
 * Send a proposal back for rework with a note. The agent picks these up and
 * rewrites, which turns review into a conversation instead of a veto.
 */
export async function requestChanges(
  db: Database,
  postId: string,
  actor: Actor,
  feedback: string,
): Promise<void> {
  await transition(db, {
    postId,
    action: "request_changes",
    actor,
    patch: { errorMessage: feedback },
  });
}

export async function approveReplyDraft(
  db: Database,
  draftId: string,
  actor: Actor,
  content?: PostContent,
): Promise<typeof schema.replyDrafts.$inferSelect> {
  return db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(schema.replyDrafts)
      .where(eq(schema.replyDrafts.id, draftId))
      .for("update");
    if (!draft) throw new Error(`Reply draft ${draftId} not found`);

    const [updated] = await tx
      .update(schema.replyDrafts)
      .set({ status: "approved", ...(content ? { content } : {}) })
      .where(eq(schema.replyDrafts.id, draftId))
      .returning();
    if (!updated) throw new Error("Reply draft vanished mid-approval");

    await tx.insert(schema.auditLogs).values({
      workspaceId: draft.workspaceId,
      entityType: "reply_draft",
      entityId: draftId,
      action: "approve",
      fromStatus: draft.status,
      toStatus: "approved",
      actor,
    });

    return updated;
  });
}

export async function rejectReplyDraft(
  db: Database,
  draftId: string,
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [draft] = await tx
      .select()
      .from(schema.replyDrafts)
      .where(eq(schema.replyDrafts.id, draftId));
    if (!draft) throw new Error(`Reply draft ${draftId} not found`);

    await tx
      .update(schema.replyDrafts)
      .set({ status: "rejected" })
      .where(eq(schema.replyDrafts.id, draftId));

    await tx
      .update(schema.inboundItems)
      .set({ status: "ignored" })
      .where(eq(schema.inboundItems.id, draft.inboundItemId));

    await tx.insert(schema.auditLogs).values({
      workspaceId: draft.workspaceId,
      entityType: "reply_draft",
      entityId: draftId,
      action: "reject",
      fromStatus: draft.status,
      toStatus: "rejected",
      actor,
    });
  });
}
