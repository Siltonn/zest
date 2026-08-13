import { and, asc, desc, eq, inArray, schema, sql, type Database } from "@zest/db";

/**
 * Content programmes and the intended posts inside them.
 *
 * A plan is the unit that carries a cadence and names the accounts it writes
 * for. That shape is what lets research stay shared — one look at the market
 * feeds every plan in the workspace — while a launch week spanning two accounts
 * and an always-on founder programme keep their own rhythms.
 */

export type Plan = typeof schema.plans.$inferSelect;
export type PlanItem = typeof schema.planItems.$inferSelect;

export type PlanWithAccounts = Plan & {
  accountIds: string[];
  itemCounts: { planned: number; written: number; skipped: number };
};

export async function listPlans(
  db: Database,
  workspaceId: string,
): Promise<PlanWithAccounts[]> {
  const rows = await db
    .select()
    .from(schema.plans)
    .where(eq(schema.plans.workspaceId, workspaceId))
    .orderBy(desc(schema.plans.createdAt));
  if (rows.length === 0) return [];

  const ids = rows.map((p) => p.id);

  const links = await db
    .select()
    .from(schema.planAccounts)
    .where(inArray(schema.planAccounts.planId, ids));

  const counts = await db
    .select({
      planId: schema.planItems.planId,
      status: schema.planItems.status,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.planItems)
    .where(inArray(schema.planItems.planId, ids))
    .groupBy(schema.planItems.planId, schema.planItems.status);

  return rows.map((plan) => ({
    ...plan,
    accountIds: links.filter((l) => l.planId === plan.id).map((l) => l.accountId),
    itemCounts: {
      planned: countFor(counts, plan.id, "planned"),
      written: countFor(counts, plan.id, "written"),
      skipped: countFor(counts, plan.id, "skipped"),
    },
  }));
}

function countFor(
  rows: { planId: string; status: string; n: number }[],
  planId: string,
  status: string,
): number {
  return rows.find((r) => r.planId === planId && r.status === status)?.n ?? 0;
}

export async function readPlan(
  db: Database,
  workspaceId: string,
  planId: string,
): Promise<{ plan: Plan; accountIds: string[]; items: PlanItem[] } | null> {
  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(
      and(eq(schema.plans.id, planId), eq(schema.plans.workspaceId, workspaceId)),
    );
  if (!plan) return null;

  const links = await db
    .select()
    .from(schema.planAccounts)
    .where(eq(schema.planAccounts.planId, planId));

  const items = await db
    .select()
    .from(schema.planItems)
    .where(eq(schema.planItems.planId, planId))
    .orderBy(asc(schema.planItems.suggestedSlotAt), desc(schema.planItems.createdAt));

  return { plan, accountIds: links.map((l) => l.accountId), items };
}

export async function createPlan(
  db: Database,
  input: {
    workspaceId: string;
    name: string;
    objective?: string;
    schedule?: string;
    accountIds: string[];
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<Plan> {
  const [plan] = await db
    .insert(schema.plans)
    .values({
      workspaceId: input.workspaceId,
      name: input.name,
      objective: input.objective ?? null,
      schedule: input.schedule ?? "weekly",
      startsAt: input.startsAt ?? null,
      endsAt: input.endsAt ?? null,
    })
    .returning();
  if (!plan) throw new Error("Could not create the plan");

  await setPlanAccounts(db, plan.id, input.accountIds);
  return plan;
}

export async function updatePlan(
  db: Database,
  workspaceId: string,
  planId: string,
  patch: {
    name?: string;
    objective?: string | null;
    schedule?: string;
    status?: "active" | "paused" | "archived";
    accountIds?: string[];
    startsAt?: Date | null;
    endsAt?: Date | null;
  },
): Promise<Plan> {
  const { accountIds, ...fields } = patch;

  const [plan] = await db
    .update(schema.plans)
    .set({ ...fields, updatedAt: new Date() })
    .where(
      and(eq(schema.plans.id, planId), eq(schema.plans.workspaceId, workspaceId)),
    )
    .returning();
  if (!plan) throw new Error("No such plan");

  if (accountIds) await setPlanAccounts(db, planId, accountIds);
  return plan;
}

export async function setPlanAccounts(
  db: Database,
  planId: string,
  accountIds: string[],
): Promise<void> {
  await db.delete(schema.planAccounts).where(eq(schema.planAccounts.planId, planId));
  if (accountIds.length === 0) return;
  await db
    .insert(schema.planAccounts)
    .values(accountIds.map((accountId) => ({ planId, accountId })));
}

export async function deletePlan(
  db: Database,
  workspaceId: string,
  planId: string,
): Promise<void> {
  await db
    .delete(schema.plans)
    .where(
      and(eq(schema.plans.id, planId), eq(schema.plans.workspaceId, workspaceId)),
    );
}

/** Plans whose cadence should fire — active, and inside their date window. */
export async function activePlans(
  db: Database,
  workspaceId: string,
  now = new Date(),
): Promise<PlanWithAccounts[]> {
  const all = await listPlans(db, workspaceId);
  return all.filter(
    (plan) =>
      plan.status === "active" &&
      (!plan.startsAt || plan.startsAt <= now) &&
      (!plan.endsAt || plan.endsAt >= now),
  );
}

export async function addItems(
  db: Database,
  input: {
    planId: string;
    workspaceId: string;
    agentRunId?: string | null;
    items: {
      accountId: string;
      topic: string;
      angle?: string;
      suggestedSlotAt?: Date | null;
    }[];
  },
): Promise<PlanItem[]> {
  if (input.items.length === 0) return [];
  return db
    .insert(schema.planItems)
    .values(
      input.items.map((item) => ({
        planId: input.planId,
        workspaceId: input.workspaceId,
        accountId: item.accountId,
        topic: item.topic,
        angle: item.angle ?? null,
        suggestedSlotAt: item.suggestedSlotAt ?? null,
        agentRunId: input.agentRunId ?? null,
      })),
    )
    .returning();
}

/** What the copywriter still has to write for one account on one plan. */
export async function pendingItems(
  db: Database,
  planId: string,
  accountId: string,
): Promise<PlanItem[]> {
  return db
    .select()
    .from(schema.planItems)
    .where(
      and(
        eq(schema.planItems.planId, planId),
        eq(schema.planItems.accountId, accountId),
        eq(schema.planItems.status, "planned"),
      ),
    )
    .orderBy(asc(schema.planItems.suggestedSlotAt));
}

/** Accounts on this plan that still have something unwritten. */
export async function accountsWithPendingItems(
  db: Database,
  planId: string,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ accountId: schema.planItems.accountId })
    .from(schema.planItems)
    .where(
      and(
        eq(schema.planItems.planId, planId),
        eq(schema.planItems.status, "planned"),
      ),
    );
  return rows.map((r) => r.accountId);
}

export async function markWritten(
  db: Database,
  itemId: string,
  postId: string,
): Promise<void> {
  await db
    .update(schema.planItems)
    .set({ status: "written", postId })
    .where(eq(schema.planItems.id, itemId));
}

export async function skipItem(
  db: Database,
  workspaceId: string,
  itemId: string,
): Promise<void> {
  await db
    .update(schema.planItems)
    .set({ status: "skipped" })
    .where(
      and(
        eq(schema.planItems.id, itemId),
        eq(schema.planItems.workspaceId, workspaceId),
      ),
    );
}

export async function updateItem(
  db: Database,
  workspaceId: string,
  itemId: string,
  patch: { topic?: string; angle?: string | null; suggestedSlotAt?: Date | null },
): Promise<PlanItem> {
  const [item] = await db
    .update(schema.planItems)
    .set(patch)
    .where(
      and(
        eq(schema.planItems.id, itemId),
        eq(schema.planItems.workspaceId, workspaceId),
      ),
    )
    .returning();
  if (!item) throw new Error("No such plan item");
  return item;
}
