import { and, desc, eq, schema, sql, type Database } from "@zest/db";

/**
 * Analytics over `metric_points`. Every platform — Pomelo included — feeds this
 * through the same connector ingestion path, so the dashboard cannot tell
 * simulated engagement from real, which is exactly the point.
 */

export type MetricName = "impressions" | "likes" | "reposts" | "replies" | "followers";

export type AnalyticsSummary = {
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  followers: number;
  engagementRate: number;
  postCount: number;
};

export async function summary(
  db: Database,
  workspaceId: string,
  sinceDays = 30,
): Promise<AnalyticsSummary> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);

  const rows = await db
    .select({
      metric: schema.metricPoints.metric,
      total: sql<number>`sum(${schema.metricPoints.value})::int`,
    })
    .from(schema.metricPoints)
    .where(
      and(
        eq(schema.metricPoints.workspaceId, workspaceId),
        sql`${schema.metricPoints.at} >= ${since}`,
      ),
    )
    .groupBy(schema.metricPoints.metric);

  const totals = Object.fromEntries(rows.map((r) => [r.metric, r.total ?? 0]));

  const [posts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
        sql`${schema.posts.publishedAt} >= ${since}`,
      ),
    );

  const impressions = totals.impressions ?? 0;
  const interactions =
    (totals.likes ?? 0) + (totals.reposts ?? 0) + (totals.replies ?? 0);

  return {
    impressions,
    likes: totals.likes ?? 0,
    reposts: totals.reposts ?? 0,
    replies: totals.replies ?? 0,
    // Followers is a running count, so the latest reading matters, not the sum.
    followers: await latestFollowers(db, workspaceId),
    engagementRate: impressions > 0 ? interactions / impressions : 0,
    postCount: posts?.n ?? 0,
  };
}

async function latestFollowers(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({
      accountId: schema.metricPoints.accountId,
      value: schema.metricPoints.value,
    })
    .from(schema.metricPoints)
    .where(
      and(
        eq(schema.metricPoints.workspaceId, workspaceId),
        eq(schema.metricPoints.metric, "followers"),
      ),
    )
    .orderBy(desc(schema.metricPoints.at))
    .limit(200);

  const perAccount = new Map<string, number>();
  for (const row of rows) {
    if (!perAccount.has(row.accountId)) perAccount.set(row.accountId, row.value);
  }
  return [...perAccount.values()].reduce((a, b) => a + b, 0);
}

export type TimeseriesPoint = { date: string; value: number };

export async function timeseries(
  db: Database,
  workspaceId: string,
  metric: MetricName,
  days = 30,
): Promise<TimeseriesPoint[]> {
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = await db
    .select({
      date: sql<string>`to_char(${schema.metricPoints.at}, 'YYYY-MM-DD')`,
      value: sql<number>`sum(${schema.metricPoints.value})::int`,
    })
    .from(schema.metricPoints)
    .where(
      and(
        eq(schema.metricPoints.workspaceId, workspaceId),
        eq(schema.metricPoints.metric, metric),
        sql`${schema.metricPoints.at} >= ${since}`,
      ),
    )
    .groupBy(sql`to_char(${schema.metricPoints.at}, 'YYYY-MM-DD')`)
    .orderBy(sql`to_char(${schema.metricPoints.at}, 'YYYY-MM-DD')`);

  return rows.map((r) => ({ date: r.date, value: r.value ?? 0 }));
}

export type PostPerformance = {
  postId: string;
  text: string;
  accountHandle: string;
  connectorId: string;
  publishedAt: Date | null;
  externalUrl: string | null;
  impressions: number;
  likes: number;
  reposts: number;
  replies: number;
  engagementRate: number;
};

export async function topPosts(
  db: Database,
  workspaceId: string,
  limit = 5,
): Promise<PostPerformance[]> {
  const rows = await db
    .select({
      post: schema.posts,
      account: schema.linkedAccounts,
      metric: schema.metricPoints.metric,
      value: sql<number>`sum(${schema.metricPoints.value})::int`,
    })
    .from(schema.posts)
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.posts.accountId, schema.linkedAccounts.id),
    )
    .leftJoin(schema.metricPoints, eq(schema.metricPoints.postId, schema.posts.id))
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
      ),
    )
    .groupBy(schema.posts.id, schema.linkedAccounts.id, schema.metricPoints.metric);

  const byPost = new Map<string, PostPerformance>();
  for (const row of rows) {
    const existing = byPost.get(row.post.id) ?? {
      postId: row.post.id,
      text: row.post.content.text,
      accountHandle: row.account.handle,
      connectorId: row.account.connectorId,
      publishedAt: row.post.publishedAt,
      externalUrl: row.post.externalUrl,
      impressions: 0,
      likes: 0,
      reposts: 0,
      replies: 0,
      engagementRate: 0,
    };
    if (row.metric && row.metric !== "followers") {
      existing[row.metric] = row.value ?? 0;
    }
    byPost.set(row.post.id, existing);
  }

  return [...byPost.values()]
    .map((p) => ({
      ...p,
      engagementRate:
        p.impressions > 0 ? (p.likes + p.reposts + p.replies) / p.impressions : 0,
    }))
    .sort((a, b) => b.engagementRate - a.engagementRate)
    .slice(0, limit);
}

/** Recorded by connector ingestion; upserts so re-polling does not double-count. */
export async function recordMetrics(
  db: Database,
  workspaceId: string,
  accountId: string,
  points: { metric: MetricName; value: number; postId?: string; at?: Date }[],
): Promise<void> {
  if (points.length === 0) return;
  await db.insert(schema.metricPoints).values(
    points.map((p) => ({
      workspaceId,
      accountId,
      postId: p.postId ?? null,
      metric: p.metric,
      value: p.value,
      at: p.at ?? new Date(),
    })),
  );
}
