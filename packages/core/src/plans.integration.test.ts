import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import {
  accountsWithPendingItems,
  activePlans,
  addItems,
  createPlan,
  listPlans,
  markWritten,
  pendingItems,
  readPlan,
  skipItem,
  updatePlan,
} from "./plans.ts";

/**
 * Content programmes.
 *
 * The assertions that matter are about fan-out and scoping: a plan must only
 * produce work for the accounts it targets, the copywriter must be handed one
 * account at a time, and an item must stop being pending the moment it is
 * written — otherwise a retried stage writes the same post twice.
 */

const url = process.env.DATABASE_URL;

describe("plans", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let founder: string;
  let brand: string;
  let outsider: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `plans-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const accounts = await db
      .insert(schema.linkedAccounts)
      .values(
        ["founder", "brand", "outsider"].map((handle) => ({
          workspaceId,
          connectorId: "pomelo",
          handle: `${handle}-${Date.now()}`,
          displayName: handle,
        })),
      )
      .returning();
    founder = accounts[0]!.id;
    brand = accounts[1]!.id;
    outsider = accounts[2]!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a plan targets accounts, so a campaign can span them", async () => {
    const launch = await createPlan(db, {
      workspaceId,
      name: "Launch week",
      schedule: "daily",
      accountIds: [founder, brand],
    });

    const found = await readPlan(db, workspaceId, launch.id);
    assert.deepEqual(found?.accountIds.sort(), [founder, brand].sort());
  });

  test("each plan carries its own cadence", async () => {
    await createPlan(db, {
      workspaceId,
      name: "Founder riffs",
      schedule: "weekdays",
      accountIds: [founder],
    });

    const all = await listPlans(db, workspaceId);
    const byName = Object.fromEntries(all.map((p) => [p.name, p.schedule]));
    assert.equal(byName["Launch week"], "daily");
    assert.equal(byName["Founder riffs"], "weekdays");
  });

  test("the copywriter fan-out is one account at a time", async () => {
    const [launch] = (await listPlans(db, workspaceId)).filter(
      (p) => p.name === "Launch week",
    );
    assert.ok(launch);

    await addItems(db, {
      planId: launch.id,
      workspaceId,
      items: [
        { accountId: founder, topic: "Why we rebuilt the scheduler", angle: "personal" },
        { accountId: founder, topic: "What broke first", angle: "war story" },
        { accountId: brand, topic: "Scheduler 2.0 is out", angle: "announcement" },
      ],
    });

    const accounts = await accountsWithPendingItems(db, workspaceId, launch.id);
    assert.equal(accounts.length, 2, "one writer per account, not per item");

    // Each writer sees only its own assignments — this is what keeps a founder
    // account from picking up the brand account's press-release cadence.
    const forFounder = await pendingItems(db, launch.id, founder);
    assert.equal(forFounder.length, 2);
    assert.ok(forFounder.every((i) => i.accountId === founder));
  });

  test("a written item stops being pending, so a retry cannot double-post", async () => {
    const [launch] = (await listPlans(db, workspaceId)).filter(
      (p) => p.name === "Launch week",
    );
    const items = await pendingItems(db, launch!.id, founder);
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId: founder,
        status: "draft",
        content: { text: "Why we rebuilt the scheduler", media: [] },
        createdByActor: { kind: "system", source: "test" },
      })
      .returning();

    await markWritten(db, items[0]!.id, post!.id);

    const still = await pendingItems(db, launch!.id, founder);
    assert.equal(still.length, 1, "the written item should not come back");
    assert.ok(!still.some((i) => i.id === items[0]!.id));

    const reread = await readPlan(db, workspaceId, launch!.id);
    const written = reread?.items.find((i) => i.id === items[0]!.id);
    assert.equal(written?.status, "written");
    assert.equal(written?.postId, post!.id, "the post traces back to its plan item");
  });

  test("skipping an item drops it before anyone writes it", async () => {
    const [launch] = (await listPlans(db, workspaceId)).filter(
      (p) => p.name === "Launch week",
    );
    const items = await pendingItems(db, launch!.id, brand);
    await skipItem(db, workspaceId, items[0]!.id);

    const after = await pendingItems(db, launch!.id, brand);
    assert.equal(after.length, 0);

    const accounts = await accountsWithPendingItems(db, workspaceId, launch!.id);
    assert.ok(
      !accounts.includes(brand),
      "an account with nothing left should not get a writer",
    );
  });

  test("a paused plan and an expired campaign both stop firing", async () => {
    const [riffs] = (await listPlans(db, workspaceId)).filter(
      (p) => p.name === "Founder riffs",
    );
    await updatePlan(db, workspaceId, riffs!.id, { status: "paused" });

    const expired = await createPlan(db, {
      workspaceId,
      name: "Conference week",
      schedule: "daily",
      accountIds: [brand],
      startsAt: new Date("2020-01-01"),
      endsAt: new Date("2020-01-08"),
    });

    const active = await activePlans(db, workspaceId);
    const names = active.map((p) => p.name);
    assert.ok(names.includes("Launch week"));
    assert.ok(!names.includes("Founder riffs"), "paused should not fire");
    assert.ok(!names.includes("Conference week"), "a finished campaign should not fire");
    assert.equal(expired.status, "active", "it is active but out of its window");
  });

  test("accounts outside the plan are never assigned work", async () => {
    const [launch] = (await listPlans(db, workspaceId)).filter(
      (p) => p.name === "Launch week",
    );
    const found = await readPlan(db, workspaceId, launch!.id);
    assert.ok(!found?.accountIds.includes(outsider));
    assert.ok(
      !found?.items.some((i) => i.accountId === outsider),
      "the strategist tool filters to the plan's own accounts",
    );
  });
});
