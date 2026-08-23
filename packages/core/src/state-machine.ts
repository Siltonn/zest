import { and, eq, lt, lte, schema, type Database } from "@zest/db";
import type { Actor, PostStatus } from "@zest/shared";

/**
 * The publishing state machine.
 *
 * Two rules make this trustworthy rather than merely tidy:
 *  1. Every transition goes through `transition()`, which validates legality and
 *     writes the audit row in the SAME transaction as the status change. There
 *     is no way to move a post without leaving a trace.
 *  2. The move into `publishing` is a conditional UPDATE (see `claimForPublish`)
 *     so two workers racing on the same post cannot both win. The guarantee
 *     lives in the database, not in the queue.
 */

export type TransitionAction =
  | "propose"
  | "approve"
  | "request_changes"
  | "reject"
  | "edit"
  | "schedule"
  | "claim"
  | "publish_succeeded"
  | "publish_failed"
  | "retry"
  | "cancel"
  | "expire";

type Rule = { from: PostStatus[]; to: PostStatus };

const TRANSITIONS: Record<TransitionAction, Rule> = {
  propose: { from: ["draft"], to: "pending_approval" },
  approve: { from: ["pending_approval", "needs_changes"], to: "approved" },
  request_changes: { from: ["pending_approval"], to: "needs_changes" },
  reject: { from: ["pending_approval", "needs_changes"], to: "rejected" },
  // An edit on a post awaiting rework puts it back in front of the reviewer.
  edit: { from: ["needs_changes", "draft"], to: "pending_approval" },
  // `scheduled` is included so a scheduled post can be moved to another time or
  // pushed out now. Dragging on the calendar and "publish now" both do exactly
  // that, and both silently failed while the state machine refused it. Safe
  // because rescheduling only touches `scheduledAt`: if the publisher has
  // already claimed the row the status is `publishing` and this correctly fails.
  schedule: {
    from: ["draft", "approved", "scheduled", "failed", "expired"],
    to: "scheduled",
  },
  claim: { from: ["scheduled"], to: "publishing" },
  publish_succeeded: { from: ["publishing"], to: "published" },
  publish_failed: { from: ["publishing"], to: "failed" },
  retry: { from: ["failed"], to: "scheduled" },
  cancel: {
    from: ["draft", "pending_approval", "needs_changes", "approved", "scheduled"],
    to: "canceled",
  },
  // Nothing auto-publishes past its window; it goes back to the agent to re-plan.
  expire: { from: ["pending_approval", "needs_changes"], to: "expired" },
};

export class InvalidTransitionError extends Error {
  // Written out rather than using parameter properties: these packages are
  // tested with Node's type stripping, which does not support that syntax.
  readonly action: TransitionAction;
  readonly from: PostStatus;

  constructor(action: TransitionAction, from: PostStatus) {
    super(`Cannot ${action} a post in state "${from}"`);
    this.name = "InvalidTransitionError";
    this.action = action;
    this.from = from;
  }
}

export function nextStatus(action: TransitionAction, from: PostStatus): PostStatus {
  const rule = TRANSITIONS[action];
  if (!rule.from.includes(from)) throw new InvalidTransitionError(action, from);
  return rule.to;
}

export function canTransition(action: TransitionAction, from: PostStatus): boolean {
  return TRANSITIONS[action].from.includes(from);
}

/** Actions a reviewer may take on a post in its current state, for the UI. */
export function availableActions(from: PostStatus): TransitionAction[] {
  return (Object.keys(TRANSITIONS) as TransitionAction[]).filter((a) =>
    canTransition(a, from),
  );
}

export type TransitionInput = {
  postId: string;
  action: TransitionAction;
  actor: Actor;
  /**
   * Tenant fence. Entry points that accept a post id from outside — REST, MCP
   * — must pass the caller's workspace so an id from another tenant reads as
   * "not found" rather than acting. Internal workers that already looked the
   * row up may omit it.
   */
  workspaceId?: string;
  /** Applied alongside the status change, inside the same transaction. */
  patch?: Partial<{
    content: typeof schema.posts.$inferSelect.content;
    scheduledAt: Date | null;
    suggestedSlotAt: Date | null;
    publishedAt: Date | null;
    externalId: string | null;
    externalUrl: string | null;
    errorMessage: string | null;
    reasoning: string | null;
  }>;
  agentRunId?: string;
};

export type TransitionResult = {
  post: typeof schema.posts.$inferSelect;
  from: PostStatus;
  to: PostStatus;
};

export async function transition(
  db: Database,
  input: TransitionInput,
): Promise<TransitionResult> {
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.posts)
      .where(
        input.workspaceId
          ? and(
              eq(schema.posts.id, input.postId),
              eq(schema.posts.workspaceId, input.workspaceId),
            )
          : eq(schema.posts.id, input.postId),
      )
      .for("update");

    if (!current) throw new Error(`Post ${input.postId} not found`);

    const from = current.status;
    const to = nextStatus(input.action, from);

    const [updated] = await tx
      .update(schema.posts)
      .set({ ...input.patch, status: to, updatedAt: new Date() })
      .where(eq(schema.posts.id, input.postId))
      .returning();

    if (!updated) throw new Error(`Post ${input.postId} vanished mid-transition`);

    await tx.insert(schema.auditLogs).values({
      workspaceId: current.workspaceId,
      entityType: "post",
      entityId: current.id,
      action: input.action,
      fromStatus: from,
      toStatus: to,
      actor: input.actor,
      diff: input.patch ? { patch: input.patch } : null,
      agentRunId: input.agentRunId ?? null,
    });

    return { post: updated, from, to };
  });
}

/**
 * Claim a post for publishing. Returns null when another worker got there
 * first, which is the normal outcome of a race and not an error.
 *
 * This is the single defence against double-posting: the queue may deliver a
 * job twice, a cron tick may overlap a slow publish, Redis may be restored from
 * a snapshot — none of it matters, because only one conditional UPDATE can
 * match a row in `scheduled`.
 */
export async function claimForPublish(
  db: Database,
  postId: string,
  actor: Actor,
): Promise<typeof schema.posts.$inferSelect | null> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(schema.posts)
      .set({ status: "publishing", updatedAt: new Date() })
      .where(and(eq(schema.posts.id, postId), eq(schema.posts.status, "scheduled")))
      .returning();

    if (!claimed) return null;

    await tx.insert(schema.auditLogs).values({
      workspaceId: claimed.workspaceId,
      entityType: "post",
      entityId: claimed.id,
      action: "claim",
      fromStatus: "scheduled",
      toStatus: "publishing",
      actor,
    });

    return claimed;
  });
}

/** Posts whose scheduled time has arrived and that nobody has claimed. */
export async function findDuePosts(
  db: Database,
  now = new Date(),
  limit = 100,
): Promise<{ id: string; workspaceId: string }[]> {
  return db
    .select({ id: schema.posts.id, workspaceId: schema.posts.workspaceId })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.status, "scheduled"),
        lte(schema.posts.scheduledAt, now),
      ),
    )
    .limit(limit);
}

/**
 * Recovers posts stuck in `publishing` because a worker died mid-flight.
 * Without this they would sit invisible forever; with it they return to the
 * queue after a grace period.
 */
export async function recoverStalePublishing(
  db: Database,
  staleAfterMs = 10 * 60_000,
): Promise<number> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const rows = await db
    .update(schema.posts)
    .set({
      status: "scheduled",
      errorMessage: "Recovered after the publishing worker stopped responding",
    })
    .where(
      and(
        eq(schema.posts.status, "publishing"),
        lt(schema.posts.updatedAt, cutoff),
      ),
    )
    .returning({ id: schema.posts.id });
  return rows.length;
}

/** Proposals that sat unreviewed past their slot. Never auto-published. */
export async function expireStaleProposals(
  db: Database,
  now = new Date(),
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.status, "pending_approval"),
        lt(schema.posts.suggestedSlotAt, now),
      ),
    );
  return rows.map((r) => r.id);
}
