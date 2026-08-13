import { and, desc, eq, gte, schema, sql, type Database } from "@zest/db";

/**
 * Analytics over `metric_points`. Every platform — Pomelo included — feeds this
 * through the same connector ingestion path, so the dashboard cannot tell
 * simulated engagement from real, which is exactly the point.
 *
 * **Metrics are cumulative snapshots, not increments.** A platform reports
 * "this post has 19 impressions", so every poll writes a fresh total. Summing
 * those rows multiplies the numbers by however many times we polled — which is
 * exactly the bug this file used to have (43 real impressions reported as 86
 * after two polls). Everything below reads the *latest* value per post and adds
 * across posts, never across readings.
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

/**
 * Latest reading per (account, post, metric), summed across posts.
 * `DISTINCT ON` is the Postgres idiom for "one row per group, ordered".
 */
async function latestTotals(
  db: Database,
  workspaceId: string,
  since: Date,
): Promise<Record<string, number>> {
  const rows = await db.execute<{ metric: string; total: number }>(sql`
    select metric, sum(value)::int as total
    from (
      select distinct on (account_id, post_id, metric)
        metric, value
      from metric_points
      where workspace_id = ${workspaceId}
        and at >= ${since.toISOString()}
      order by account_id, post_id, metric, at desc
    ) latest
    group by metric
  `);

  return Object.fromEntries(
    Array.from(rows as Iterable<{ metric: string; total: number }>).map((r) => [
      r.metric,
      Number(r.total ?? 0),
    ]),
  );
}

export async function summary(
  db: Database,
  workspaceId: string,
  sinceDays = 30,
): Promise<AnalyticsSummary> {
  const since = new Date(Date.now() - sinceDays * 86_400_000);
  const totals = await latestTotals(db, workspaceId, since);

  const [posts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
        gte(schema.posts.publishedAt, since),
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
    followers: await latestFollowers(db, workspaceId),
    engagementRate: impressions > 0 ? interactions / impressions : 0,
    postCount: posts?.n ?? 0,
  };
}

/** Follower count is per account, so the newest reading per account wins. */
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
    .limit(500);

  const perAccount = new Map<string, number>();
  for (const row of rows) {
    if (!perAccount.has(row.accountId)) perAccount.set(row.accountId, row.value);
  }
  return [...perAccount.values()].reduce((a, b) => a + b, 0);
}

export type TimeseriesPoint = { date: string; value: number };

/** One point per day: that day's last reading, summed across posts. */
export async function timeseries(
  db: Database,
  workspaceId: string,
  metric: MetricName,
  days = 30,
): Promise<TimeseriesPoint[]> {
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await db.execute<{ date: string; value: number }>(sql`
    select date, sum(value)::int as value
    from (
      select distinct on (account_id, post_id, to_char(at, 'YYYY-MM-DD'))
        to_char(at, 'YYYY-MM-DD') as date, value
      from metric_points
      where workspace_id = ${workspaceId}
        and metric = ${metric}
        and at >= ${since.toISOString()}
      order by account_id, post_id, to_char(at, 'YYYY-MM-DD'), at desc
    ) daily
    group by date
    order by date
  `);

  return Array.from(rows as Iterable<{ date: string; value: number }>).map((r) => ({
    date: r.date,
    value: Number(r.value ?? 0),
  }));
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
  const published = await db
    .select({ post: schema.posts, account: schema.linkedAccounts })
    .from(schema.posts)
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.posts.accountId, schema.linkedAccounts.id),
    )
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "published"),
      ),
    );

  if (published.length === 0) return [];

  const rows = await db.execute<{
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

  const byPost = new Map<string, PostPerformance>(
    published.map(({ post, account }) => [
      post.id,
      {
        postId: post.id,
        text: post.content.text,
        accountHandle: account.handle,
        connectorId: account.connectorId,
        publishedAt: post.publishedAt,
        externalUrl: post.externalUrl,
        impressions: 0,
        likes: 0,
        reposts: 0,
        replies: 0,
        engagementRate: 0,
      },
    ]),
  );

  for (const row of rows as Iterable<{
    post_id: string;
    metric: string;
    value: number;
  }>) {
    const entry = byPost.get(row.post_id);
    if (!entry || row.metric === "followers") continue;
    entry[row.metric as "impressions" | "likes" | "reposts" | "replies"] = Number(
      row.value ?? 0,
    );
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

/**
 * Records a snapshot from a connector. Rows accumulate as history — the read
 * side takes the latest, so re-polling is safe and the trend stays visible.
 */
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
