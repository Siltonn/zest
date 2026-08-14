import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, and, eq, isNotNull, schema, type Database } from "@zest/db";
import { grantAutonomy } from "./autonomy.ts";
import { recycleTick, selectCandidates, RECYCLE_COOLDOWN_DAYS } from "./recycle.ts";

/**
 * Evergreen recycling.
 *
 * The properties worth pinning: the pick is the *measured* best (not the
 * newest, not random), a re-run rests its original for the cooldown, a re-run
 * is itself never recycled, and the whole tick respects the same autonomy gate
 * as everything else — approve mode proposes, auto mode schedules.
 */

const url = process.env.DATABASE_URL;

describe("evergreen recycling", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let planId: string;
  let strongId: string;
  let weakId: string;

  async function publishPost(text: string, impressions: number, likes: number) {
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "published",
        content: { text, media: [] },
        publishedAt: new Date(Date.now() - 60 * 24 * 60 * 60_000),
        createdByActor: { kind: "system", source: "test" },
      })
      .returning();

    await db.insert(schema.metricPoints).values([
      {
        workspaceId,
        accountId,
        postId: post!.id,
        metric: "impressions",
        value: impressions,
        at: new Date(),
      },
      {
        workspaceId,
        accountId,
        postId: post!.id,
        metric: "likes",
        value: likes,
        at: new Date(),
      },
    ]);
    return post!.id;
  }

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `recycle-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `recycle-${Date.now()}`,
        displayName: "Recycle",
      })
      .returning();
    accountId = account!.id;

    const [plan] = await db
      .insert(schema.plans)
      .values({
        workspaceId,
        name: "Greatest hits",
        kind: "evergreen",
        schedule: "weekly",
      })
      .returning();
    planId = plan!.id;
    await db.insert(schema.planAccounts).values({ planId, accountId });

    // 30% engagement vs 2% — the pick should not be close.
    strongId = await publishPost("The strong one", 100, 30);
    weakId = await publishPost("The weak one", 100, 2);
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("the pick is the measured best, and it goes through the inbox", async () => {
    const result = await recycleTick(db, { workspaceId, planId });
    assert.equal(result.proposed, 1, "approve mode proposes rather than scheduling");
    assert.equal(result.scheduled, 0);

    const [copy] = await db
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.workspaceId, workspaceId),
          isNotNull(schema.posts.recycledFromId),
        ),
      );

    assert.equal(copy?.recycledFromId, strongId, "30% engagement beats 2%");
    assert.equal(copy?.status, "pending_approval", "a re-run is still a proposal");
    assert.equal(copy?.content.text, "The strong one");
    // The reasoning carries the evidence — that is what makes approving it a
    // decision rather than trust.
    assert.match(copy?.reasoning ?? "", /100 impressions/);
    assert.match(copy?.reasoning ?? "", /30\.0% engagement/);
  });

  test("a fresh re-run rests its original; the runner-up gets the next tick", async () => {
    const second = await recycleTick(db, { workspaceId, planId });
    assert.equal(second.proposed, 1);

    const copies = await db
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.workspaceId, workspaceId),
          isNotNull(schema.posts.recycledFromId),
        ),
      );
    assert.equal(copies.length, 2);
    assert.ok(
      copies.some((c) => c.recycledFromId === weakId),
      "with the strong one cooling, the weak one is the best remaining",
    );
  });

  test("with everything cooling, the tick says so instead of repeating", async () => {
    const third = await recycleTick(db, { workspaceId, planId });
    assert.equal(third.proposed + third.scheduled, 0);
    assert.match(third.skipped ?? "", /cooldown/i);
  });

  test("copies are never candidates themselves", async () => {
    // Even once cooldowns lapse, the rotation must recycle originals — a copy
    // of a copy of a copy is how a bot account reads.
    const candidates = await selectCandidates(db, workspaceId, [accountId]);
    for (const candidate of candidates) {
      const [row] = await db
        .select()
        .from(schema.posts)
        .where(eq(schema.posts.id, candidate.postId));
      assert.equal(row?.recycledFromId, null);
    }
  });

  test("under granted autonomy the tick schedules directly", async () => {
    // Age the strong original's copy out of the cooldown window, then grant.
    await db
      .update(schema.posts)
      .set({
        createdAt: new Date(
          Date.now() - (RECYCLE_COOLDOWN_DAYS + 1) * 24 * 60 * 60_000,
        ),
      })
      .where(isNotNull(schema.posts.recycledFromId));

    await grantAutonomy(db, {
      workspaceId,
      action: "schedule_post",
      mode: "auto",
      grantedBy: "tester",
    });

    const result = await recycleTick(db, { workspaceId, planId });
    assert.equal(result.scheduled, 1, "auto mode schedules without stopping at the inbox");
    assert.equal(result.proposed, 0);
  });

  test("a fresh plan cannot be recycled by mistake", async () => {
    const [freshPlan] = await db
      .insert(schema.plans)
      .values({ workspaceId, name: "Fresh", kind: "fresh", schedule: "weekly" })
      .returning();

    const result = await recycleTick(db, { workspaceId, planId: freshPlan!.id });
    assert.equal(result.skipped, "Not an evergreen plan");
  });
});
