import { and, eq, gte, schema, sql, type Database } from "@zest/db";
import { system } from "@zest/shared";
import { decide } from "./autonomy.ts";

/**
 * Engagement automations: the small mechanical things a community manager does
 * on a schedule — thanking people, plugging a link once a post takes off,
 * answering a recurring question.
 *
 * These are rules rather than agent decisions, because they should be
 * predictable. But they still pass through the autonomy guard: an automation
 * that fires without permission is exactly the behaviour that makes people
 * distrust a tool with access to their accounts.
 */

export type AutomationKind = "auto_plug" | "auto_reply" | "auto_dm";

export type AutomationTrigger = {
  /** auto_plug: fire once a post passes this many interactions. */
  threshold?: number;
  /** auto_reply / auto_dm: only for comments matching this sentiment. */
  sentiment?: "positive" | "neutral" | "negative";
  /** auto_dm: only when the comment contains one of these words. */
  keywords?: string[];
};

export type Automation = typeof schema.engagementAutomations.$inferSelect;

export type AutomationAction =
  | { kind: "auto_plug"; postId: string; externalPostId: string; text: string }
  | { kind: "auto_reply"; inboundItemId: string; text: string }
  | { kind: "auto_dm"; targetHandle: string; text: string };

/**
 * Works out what should fire right now. Deliberately returns actions rather
 * than performing them, so the caller decides whether to execute or propose,
 * and so this is testable without a database of side effects.
 */
export async function evaluate(
  db: Database,
  workspaceId: string,
): Promise<AutomationAction[]> {
  const automations = await db
    .select()
    .from(schema.engagementAutomations)
    .where(eq(schema.engagementAutomations.workspaceId, workspaceId));

  if (automations.length === 0) return [];

  const actions: AutomationAction[] = [];

  for (const automation of automations) {
    const decision = await decide(db, {
      workspaceId,
      action: "engagement_automation",
      accountId: automation.accountId ?? undefined,
    });
    // No grant, no firing. The rule exists but stays dormant until trusted.
    if (decision.mode !== "auto") continue;

    switch (automation.kind) {
      case "auto_plug":
        actions.push(...(await plugCandidates(db, workspaceId, automation)));
        break;
      case "auto_reply":
        actions.push(...(await replyCandidates(db, workspaceId, automation)));
        break;
      case "auto_dm":
        actions.push(...(await dmCandidates(db, workspaceId, automation)));
        break;
    }
  }

  return actions;
}

/**
 * Auto-plug: once a post is doing well, add the follow-up comment with the
 * link. Waiting for traction is the whole idea — plugging a post nobody read
 * is just noise.
 */
async function plugCandidates(
  db: Database,
  workspaceId: string,
  automation: Automation,
): Promise<AutomationAction[]> {
  const threshold = (automation.trigger as AutomationTrigger)?.threshold ?? 25;

  const rows = await db
    .select({
      postId: schema.posts.id,
      externalId: schema.posts.externalId,
      interactions: sql<number>`coalesce(sum(${schema.metricPoints.value}), 0)::int`,
    })
    .from(schema.posts)
    .leftJoin(
      schema.metricPoints,
      and(
        eq(schema.metricPoints.postId, schema.posts.id),
        sql`${schema.metricPoints.metric} in ('likes', 'reposts', 'replies')`,
      ),
    )
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
        automation.accountId
          ? eq(schema.posts.accountId, automation.accountId)
          : sql`true`,
      ),
    )
    .groupBy(schema.posts.id);

  const eligible = rows.filter(
    (row) => row.interactions >= threshold && row.externalId,
  );

  // Only plug a post once, ever.
  const alreadyPlugged = await plugged(db, workspaceId);

  return eligible
    .filter((row) => !alreadyPlugged.has(row.postId))
    .map((row) => ({
      kind: "auto_plug" as const,
      postId: row.postId,
      externalPostId: row.externalId!,
      text: automation.template ?? "More on this here:",
    }));
}

async function plugged(db: Database, workspaceId: string): Promise<Set<string>> {
  const rows = await db
    .select({ entityId: schema.auditLogs.entityId })
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.workspaceId, workspaceId),
        eq(schema.auditLogs.action, "auto_plug"),
      ),
    );
  return new Set(rows.map((r) => r.entityId));
}

async function replyCandidates(
  db: Database,
  workspaceId: string,
  automation: Automation,
): Promise<AutomationAction[]> {
  const trigger = automation.trigger as AutomationTrigger;

  const rows = await db
    .select()
    .from(schema.inboundItems)
    .where(
      and(
        eq(schema.inboundItems.workspaceId, workspaceId),
        eq(schema.inboundItems.status, "new"),
        trigger?.sentiment
          ? eq(schema.inboundItems.sentiment, trigger.sentiment)
          : sql`true`,
      ),
    )
    .limit(20);

  return rows.map((item) => ({
    kind: "auto_reply" as const,
    inboundItemId: item.id,
    text: automation.template ?? "Thanks for reading — glad it was useful.",
  }));
}

async function dmCandidates(
  db: Database,
  workspaceId: string,
  automation: Automation,
): Promise<AutomationAction[]> {
  const trigger = automation.trigger as AutomationTrigger;
  const keywords = trigger?.keywords ?? [];
  if (keywords.length === 0) return [];

  const since = new Date(Date.now() - 86_400_000);
  const rows = await db
    .select()
    .from(schema.inboundItems)
    .where(
      and(
        eq(schema.inboundItems.workspaceId, workspaceId),
        eq(schema.inboundItems.status, "new"),
        gte(schema.inboundItems.receivedAt, since),
      ),
    )
    .limit(20);

  return rows
    .filter((item) =>
      keywords.some((word) => item.text.toLowerCase().includes(word.toLowerCase())),
    )
    .map((item) => ({
      kind: "auto_dm" as const,
      targetHandle: item.authorHandle,
      text: automation.template ?? "Saw your comment — happy to help, just ask.",
    }));
}

/** Records that an automation fired, so it shows up in the audit trail. */
export async function recordFired(
  db: Database,
  workspaceId: string,
  action: AutomationAction,
): Promise<void> {
  const entityId =
    action.kind === "auto_plug"
      ? action.postId
      : action.kind === "auto_reply"
        ? action.inboundItemId
        : workspaceId;

  await db.insert(schema.auditLogs).values({
    workspaceId,
    entityType: "automation",
    entityId,
    action: action.kind,
    actor: system("automation"),
    diff: { text: action.text },
  });
}

export async function createAutomation(
  db: Database,
  input: {
    workspaceId: string;
    kind: AutomationKind;
    accountId?: string;
    trigger: AutomationTrigger;
    template?: string;
  },
): Promise<Automation> {
  const [created] = await db
    .insert(schema.engagementAutomations)
    .values({
      workspaceId: input.workspaceId,
      kind: input.kind,
      accountId: input.accountId ?? null,
      trigger: input.trigger,
      template: input.template ?? null,
    })
    .returning();
  if (!created) throw new Error("Could not create the automation");
  return created;
}

export async function listAutomations(
  db: Database,
  workspaceId: string,
): Promise<Automation[]> {
  return db
    .select()
    .from(schema.engagementAutomations)
    .where(eq(schema.engagementAutomations.workspaceId, workspaceId));
}

export async function deleteAutomation(
  db: Database,
  workspaceId: string,
  id: string,
): Promise<void> {
  await db
    .delete(schema.engagementAutomations)
    .where(
      and(
        eq(schema.engagementAutomations.id, id),
        eq(schema.engagementAutomations.workspaceId, workspaceId),
      ),
    );
}
