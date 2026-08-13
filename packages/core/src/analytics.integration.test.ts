import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { human } from "@zest/shared";
import { recordMetrics, summary, timeseries, topPosts } from "./analytics.ts";

/**
 * Guards the snapshot-vs-increment distinction.
 *
 * Platforms report cumulative totals, so polling twice must not double the
 * numbers. That bug shipped once — 43 real impressions displayed as 86 — and
 * these tests exist so it cannot come back quietly.
 */

const url = process.env.DATABASE_URL;

describe("analytics", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let postId: string;

  before(async () => {
    db = createDatabase(url!);

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `analytics-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `analytics-test-${Date.now()}`,
      })
      .returning();
    accountId = account!.id;

    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "published",
        content: { text: "measured post", media: [] },
        publishedAt: new Date(),
        createdByActor: human("test"),
      })
      .returning();
    postId = post!.id;
  });

  after(async () => {
    if (workspaceId) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await closeDatabase(db);
  });

  test("polling repeatedly does not inflate the totals", async () => {
    // Three polls of a post that grew from 100 to 120 impressions.
    for (const [impressions, likes] of [
      [100, 5],
      [110, 7],
      [120, 9],
    ] as const) {
      await recordMetrics(db, workspaceId, accountId, [
        { metric: "impressions", value: impressions, postId },
        { metric: "likes", value: likes, postId },
      ]);
      // Distinct timestamps so "latest" is well defined.
      await new Promise((resolve) => setTimeout(resolve, 12));
    }

    const totals = await summary(db, workspaceId, 30);
    assert.equal(totals.impressions, 120, "should report the latest, not 330");
    assert.equal(totals.likes, 9, "should report the latest, not 21");
  });

  test("engagement rate uses the deduplicated totals", async () => {
    const totals = await summary(db, workspaceId, 30);
    // 9 likes over 120 impressions — not a figure inflated by poll count.
    assert.ok(totals.engagementRate > 0.07 && totals.engagementRate < 0.08);
  });

  test("totals add across posts, not across readings", async () => {
    const [second] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "published",
        content: { text: "another measured post", media: [] },
        publishedAt: new Date(),
        createdByActor: human("test"),
      })
      .returning();

    await recordMetrics(db, workspaceId, accountId, [
      { metric: "impressions", value: 80, postId: second!.id },
    ]);

    const totals = await summary(db, workspaceId, 30);
    assert.equal(totals.impressions, 200, "120 + 80 across two posts");
  });

  test("per-post performance reports the latest reading", async () => {
    const best = await topPosts(db, workspaceId, 5);
    const measured = best.find((p) => p.postId === postId);
    assert.equal(measured?.impressions, 120);
    assert.equal(measured?.likes, 9);
  });

  test("the daily series takes one reading per day", async () => {
    const series = await timeseries(db, workspaceId, "impressions", 30);
    const today = series.at(-1);
    assert.ok(today, "there should be a point for today");
    assert.equal(today?.value, 200, "the day's last reading per post, summed");
  });
});
