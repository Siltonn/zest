import { and, eq, schema, sql, type Database } from "@zest/db";
import type { AutonomyAction, AutonomyMode } from "@zest/shared";

/**
 * Graduated autonomy.
 *
 * Every mutating agent tool asks this guard what it is allowed to do. With no
 * rule granted the tool writes a proposal and returns "awaiting approval"; with
 * an `auto` rule it performs the action directly. The tool body and the prompt
 * are identical in both cases — only the operator's granted trust differs.
 *
 * Rules are matched most-specific-first: an account-level rule beats a
 * connector-level rule, which beats a workspace-wide rule. That lets someone
 * say "auto-publish on Pomelo, keep asking me about Bluesky".
 */

export type AutonomyDecision = {
  mode: AutonomyMode;
  /** The rule that granted `auto`, if any — recorded in the audit trail. */
  ruleId?: string;
  /** Present when an `auto` rule exists but its conditions were not met. */
  downgradeReason?: string;
};

export type GuardScope = {
  workspaceId: string;
  action: AutonomyAction;
  connectorId?: string;
  accountId?: string;
  /** Reply triage passes sentiment so rules can auto-answer only friendly posts. */
  sentiment?: "positive" | "neutral" | "negative" | "hostile";
};

function specificity(rule: typeof schema.autonomyRules.$inferSelect): number {
  if (rule.accountId) return 3;
  if (rule.connectorId) return 2;
  return 1;
}

export async function decide(
  db: Database,
  scope: GuardScope,
): Promise<AutonomyDecision> {
  const rules = await db
    .select()
    .from(schema.autonomyRules)
    .where(
      and(
        eq(schema.autonomyRules.workspaceId, scope.workspaceId),
        eq(schema.autonomyRules.action, scope.action),
      ),
    );

  const applicable = rules
    .filter((r) => !r.accountId || r.accountId === scope.accountId)
    .filter((r) => !r.connectorId || r.connectorId === scope.connectorId)
    .sort((a, b) => specificity(b) - specificity(a));

  const rule = applicable[0];
  if (!rule || rule.mode !== "auto") return { mode: "approve" };

  const conditions = rule.conditions;

  if (conditions?.sentiment && conditions.sentiment !== scope.sentiment) {
    return {
      mode: "approve",
      downgradeReason: `rule applies only to ${conditions.sentiment} sentiment`,
    };
  }

  if (conditions?.maxPerDay !== undefined) {
    const used = await countActionsToday(db, scope);
    if (used >= conditions.maxPerDay) {
      return {
        mode: "approve",
        downgradeReason: `daily limit of ${conditions.maxPerDay} reached`,
      };
    }
  }

  return { mode: "auto", ruleId: rule.id };
}

/** How many times the agent already took this action today, for rate limits. */
async function countActionsToday(db: Database, scope: GuardScope): Promise<number> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);

  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.workspaceId, scope.workspaceId),
        eq(schema.auditLogs.action, scope.action),
        sql`${schema.auditLogs.actor}->>'kind' = 'agent'`,
        sql`${schema.auditLogs.createdAt} >= ${since}`,
      ),
    );

  return row?.count ?? 0;
}

/**
 * Trust signal behind the "graduate me" prompt: how often a human accepted the
 * agent's proposals for this action unchanged. The agent uses this to ask for
 * autonomy rather than the operator having to think of it.
 */
export type TrustStats = {
  action: AutonomyAction;
  approved: number;
  editedOrRejected: number;
  consecutiveCleanApprovals: number;
  /** True once the streak is long enough to be worth offering. */
  readyToGraduate: boolean;
};

const GRADUATION_STREAK = 10;

export async function trustStats(
  db: Database,
  workspaceId: string,
  action: AutonomyAction,
): Promise<TrustStats> {
  const rows = await db
    .select({
      action: schema.auditLogs.action,
      createdAt: schema.auditLogs.createdAt,
    })
    .from(schema.auditLogs)
    .where(
      and(
        eq(schema.auditLogs.workspaceId, workspaceId),
        sql`${schema.auditLogs.actor}->>'kind' = 'human'`,
        sql`${schema.auditLogs.action} in ('approve', 'reject', 'request_changes')`,
      ),
    )
    .orderBy(sql`${schema.auditLogs.createdAt} desc`)
    .limit(100);

  let approved = 0;
  let editedOrRejected = 0;
  let streak = 0;
  let streakBroken = false;

  for (const row of rows) {
    const clean = row.action === "approve";
    if (clean) approved += 1;
    else editedOrRejected += 1;
    if (!streakBroken) {
      if (clean) streak += 1;
      else streakBroken = true;
    }
  }

  return {
    action,
    approved,
    editedOrRejected,
    consecutiveCleanApprovals: streak,
    readyToGraduate: streak >= GRADUATION_STREAK,
  };
}

export async function grantAutonomy(
  db: Database,
  input: {
    workspaceId: string;
    action: AutonomyAction;
    mode: AutonomyMode;
    connectorId?: string;
    accountId?: string;
    conditions?: { sentiment?: "positive" | "neutral" | "negative"; maxPerDay?: number };
    grantedBy: string;
  },
): Promise<typeof schema.autonomyRules.$inferSelect> {
  const [rule] = await db
    .insert(schema.autonomyRules)
    .values({
      workspaceId: input.workspaceId,
      action: input.action,
      mode: input.mode,
      connectorId: input.connectorId ?? null,
      accountId: input.accountId ?? null,
      conditions: input.conditions ?? null,
      grantedBy: input.grantedBy,
    })
    .returning();

  if (!rule) throw new Error("Failed to create autonomy rule");

  await db.insert(schema.auditLogs).values({
    workspaceId: input.workspaceId,
    entityType: "autonomy_rule",
    entityId: rule.id,
    action: "grant_autonomy",
    actor: { kind: "human", userId: input.grantedBy },
    diff: { action: input.action, mode: input.mode },
  });

  return rule;
}

export async function revokeAutonomy(
  db: Database,
  workspaceId: string,
  ruleId: string,
  userId: string,
): Promise<void> {
  await db
    .delete(schema.autonomyRules)
    .where(
      and(
        eq(schema.autonomyRules.id, ruleId),
        eq(schema.autonomyRules.workspaceId, workspaceId),
      ),
    );

  await db.insert(schema.auditLogs).values({
    workspaceId,
    entityType: "autonomy_rule",
    entityId: ruleId,
    action: "revoke_autonomy",
    actor: { kind: "human", userId },
  });
}
