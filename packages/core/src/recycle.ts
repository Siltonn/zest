import { and, eq, gt, inArray, isNotNull, isNull, schema, sql, type Database } from "@zest/db";
import { system } from "@zest/shared";
import * as autonomy from "./autonomy.ts";
import { emit, type EventPublisher } from "./events.ts";
import { transition } from "./state-machine.ts";

/**
 * Evergreen recycling: re-proposing the best of what already worked.
 *
 * An evergreen plan's cadence tick does not write anything new — it picks each
 * account's strongest published post that has not run recently and puts it
 * forward again, through the same approval gate and the same autonomy guard as
 * everything else. A re-run is still a proposal.
 *
 * Deliberately deterministic. Ranking by measured engagement needs no model, so
 * evergreen plans work in the zero-key demo — and "your greatest hits, on a
 * schedule" is a judgment the numbers already made.
 */

/**
 * How long an original rests after a re-run before it is eligible again.
 * A greatest-hits rotation that repeats inside a month reads as a bot.
 */
export const RECYCLE_COOLDOWN_DAYS = 30;

export type RecycleCandidate = {
  postId: string;
  accountId: string;
  text: string;
  impressions: number;
  interactions: number;
  engagementRate: number;
  publishedAt: Date | null;
};

/**
 * The strongest eligible original per account, engagement-ranked.
 *
 * Eligible means: published, an original (not itself a re-run — recycling a
 * recycle would compound the rotation), actually seen by someone, and not
 * re-run within the cooldown.
 */
export async function selectCandidates(
  db: Database,
  workspaceId: string,
  accountIds: string[],
): Promise<RecycleCandidate[]> {
  if (accountIds.length === 0) return [];

  const published = await db
    .select()
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
        inArray(schema.posts.accountId, accountIds),
        isNull(schema.posts.recycledFromId),
      ),
    );
  if (published.length === 0) return [];

  // Originals whose most recent re-run is still inside the cooldown.
  const cutoff = new Date(Date.now() - RECYCLE_COOLDOWN_DAYS * 24 * 60 * 60_000);
  const recentCopies = await db
    .select({ recycledFromId: schema.posts.recycledFromId })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        isNotNull(schema.posts.recycledFromId),
        // A JS Date inside a raw sql template breaks under postgres.js —
        // the same trap the due-post sweep hit in M2. The typed helper binds it.
        gt(schema.posts.createdAt, cutoff),
      ),
    );
  const cooling = new Set(recentCopies.map((r) => r.recycledFromId));

  // Latest value per (post, metric): snapshots are cumulative, so summing
  // them would double-count — the same lesson the analytics module learned.
  const metricRows = await db.execute<{
    post_id: string;
    metric: string;
    value: number;
  }>(sql`
    select distinct on (post_id, metric)
      post_id, metric, value
    from metric_points
    where workspace_id = ${workspaceId}
      and post_id is not null
    order by post_id, metric, at desc
  `);

  const metrics = new Map<string, { impressions: number; interactions: number }>();
  for (const row of metricRows) {
    const entry = metrics.get(row.post_id) ?? { impressions: 0, interactions: 0 };
    if (row.metric === "impressions") entry.impressions = Number(row.value);
    if (["likes", "reposts", "replies"].includes(row.metric)) {
      entry.interactions += Number(row.value);
    }
    metrics.set(row.post_id, entry);
  }

  const best = new Map<string, RecycleCandidate>();
  for (const post of published) {
    if (cooling.has(post.id)) continue;

    const m = metrics.get(post.id);
    // A post nobody measurably saw has no evidence to rerun on.
    if (!m || m.impressions < 5) continue;

    const candidate: RecycleCandidate = {
      postId: post.id,
      accountId: post.accountId,
      text: post.content.text,
      impressions: m.impressions,
      interactions: m.interactions,
      engagementRate: m.interactions / m.impressions,
      publishedAt: post.publishedAt,
    };

    const current = best.get(post.accountId);
    if (!current || candidate.engagementRate > current.engagementRate) {
      best.set(post.accountId, candidate);
    }
  }

  return [...best.values()];
}

export type RecycleResult = {
  proposed: number;
  scheduled: number;
  skipped: string | null;
};

/**
 * One cadence tick of an evergreen plan: propose (or, under autonomy, schedule)
 * the best re-run per account. The copy is a full post row with
 * `recycledFromId` set, so it can be approved, edited, audited and traced like
 * anything else — and the original's cooldown starts from the copy's creation.
 */
export async function recycleTick(
  db: Database,
  input: { workspaceId: string; planId: string; publisher?: EventPublisher },
): Promise<RecycleResult> {
  const { workspaceId, planId } = input;

  const [plan] = await db
    .select()
    .from(schema.plans)
    .where(
      and(eq(schema.plans.id, planId), eq(schema.plans.workspaceId, workspaceId)),
    );
  if (!plan) return { proposed: 0, scheduled: 0, skipped: "No such plan" };
  if (plan.kind !== "evergreen") {
    return { proposed: 0, scheduled: 0, skipped: "Not an evergreen plan" };
  }

  const links = await db
    .select()
    .from(schema.planAccounts)
    .where(eq(schema.planAccounts.planId, planId));
  const candidates = await selectCandidates(
    db,
    workspaceId,
    links.map((l) => l.accountId),
  );

  if (candidates.length === 0) {
    return {
      proposed: 0,
      scheduled: 0,
      skipped: "Nothing eligible — no measured post outside its cooldown",
    };
  }

  const actor = system("evergreen");
  let proposed = 0;
  let scheduled = 0;

  for (const candidate of candidates) {
    const [account] = await db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.id, candidate.accountId));
    if (!account) continue;

    const [original] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, candidate.postId));
    if (!original) continue;

    const when = candidate.publishedAt
      ? ` when it ran ${candidate.publishedAt.toISOString().slice(0, 10)}`
      : "";
    const reasoning =
      `Evergreen re-run from "${plan.name}": earned ${candidate.impressions} impressions` +
      ` and ${(candidate.engagementRate * 100).toFixed(1)}% engagement${when}.` +
      ` Rested ${RECYCLE_COOLDOWN_DAYS}+ days.`;

    const slot = new Date(Date.now() + 60 * 60_000);
    const decision = await autonomy.decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: account.connectorId,
      accountId: account.id,
    });

    const [copy] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId: account.id,
        status: "draft",
        content: original.content,
        suggestedSlotAt: slot,
        reasoning,
        recycledFromId: original.id,
        createdByActor: actor,
      })
      .returning();
    if (!copy) continue;

    if (decision.mode === "auto") {
      await transition(db, {
        postId: copy.id,
        action: "schedule",
        actor,
        patch: { scheduledAt: slot },
      });
      scheduled += 1;
      continue;
    }

    await transition(db, { postId: copy.id, action: "propose", actor });
    proposed += 1;

    if (input.publisher) {
      await emit(input.publisher, {
        type: "inbox.new",
        workspaceId,
        itemKind: "post",
        entityId: copy.id,
        summary: `Evergreen re-run proposed for @${account.handle}`,
      });
    }
  }

  return { proposed, scheduled, skipped: null };
}
