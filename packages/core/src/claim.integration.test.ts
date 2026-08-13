import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { human, system } from "@zest/shared";
import { claimForPublish, findDuePosts, transition } from "./state-machine.ts";
import { decide, grantAutonomy } from "./autonomy.ts";

/**
 * Integration tests against a real Postgres.
 *
 * The double-publish guarantee is the one claim in this codebase that cannot be
 * tested with a mock: it depends on how Postgres actually serialises concurrent
 * conditional updates. Asserting it in unit tests would prove nothing.
 *
 * Skipped when DATABASE_URL is unset so `pnpm test` still works offline.
 */

const url = process.env.DATABASE_URL;

describe("publishing claim", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;

  before(async () => {
    db = createDatabase(url!);

    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `claim-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `claim-test-${Date.now()}`,
      })
      .returning();
    accountId = account!.id;
  });

  after(async () => {
    // Cascades clear posts, audit rows and rules along with the workspace.
    if (workspaceId) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await closeDatabase(db);
  });

  async function scheduledPost(when = new Date(Date.now() - 1000)): Promise<string> {
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "scheduled",
        content: { text: "a post that must publish exactly once", media: [] },
        scheduledAt: when,
        createdByActor: human("test"),
      })
      .returning();
    return post!.id;
  }

  test("only one of many concurrent workers can claim a post", async () => {
    const postId = await scheduledPost();

    // Ten workers racing on the same row, as an overlapping cron tick would.
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimForPublish(db, postId, system("scheduler")),
      ),
    );

    const winners = results.filter((r) => r !== null);
    assert.equal(winners.length, 1, "exactly one worker must win the claim");

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId));
    assert.equal(post?.status, "publishing");
  });

  test("a claim is recorded in the audit trail", async () => {
    const postId = await scheduledPost();
    await claimForPublish(db, postId, system("scheduler"));

    const entries = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, postId));

    const claim = entries.find((e) => e.action === "claim");
    assert.ok(claim, "the claim must leave a trace");
    assert.equal(claim?.fromStatus, "scheduled");
    assert.equal(claim?.toStatus, "publishing");
  });

  test("an already-published post cannot be claimed again", async () => {
    const postId = await scheduledPost();
    await claimForPublish(db, postId, system("scheduler"));
    await transition(db, {
      postId,
      action: "publish_succeeded",
      actor: system("scheduler"),
      patch: { publishedAt: new Date(), externalId: "x", externalUrl: "/x" },
    });

    const second = await claimForPublish(db, postId, system("scheduler"));
    assert.equal(second, null, "a published post must never be re-claimed");
  });

  test("the due sweep ignores posts scheduled for later", async () => {
    const soon = await scheduledPost(new Date(Date.now() - 5000));
    const later = await scheduledPost(new Date(Date.now() + 3_600_000));

    const due = await findDuePosts(db, new Date());
    const ids = due.map((d) => d.id);

    assert.ok(ids.includes(soon), "a post whose time has passed should be due");
    assert.ok(!ids.includes(later), "a future post must not be swept up");
  });

  test("a transition and its audit row commit together", async () => {
    const postId = await scheduledPost();
    await transition(db, {
      postId,
      action: "cancel",
      actor: human("someone"),
    });

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId));
    const entries = await db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.entityId, postId));

    assert.equal(post?.status, "canceled");
    assert.ok(
      entries.some((e) => e.action === "cancel" && e.actor.kind === "human"),
      "the actor must be recorded, not just the change",
    );
  });

  test("an illegal transition changes nothing", async () => {
    const postId = await scheduledPost();
    await claimForPublish(db, postId, system("scheduler"));
    await transition(db, {
      postId,
      action: "publish_succeeded",
      actor: system("scheduler"),
    });

    await assert.rejects(
      () => transition(db, { postId, action: "approve", actor: human("test") }),
      /Cannot approve a post in state "published"/,
    );

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId));
    assert.equal(post?.status, "published", "the rejected transition must not apply");
  });
});

describe("autonomy guard", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `autonomy-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    if (workspaceId) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await closeDatabase(db);
  });

  test("without a rule, tools must ask", async () => {
    const decision = await decide(db, { workspaceId, action: "schedule_post" });
    assert.equal(decision.mode, "approve");
  });

  test("a granted rule lets the tool act", async () => {
    await grantAutonomy(db, {
      workspaceId,
      action: "send_reply",
      mode: "auto",
      grantedBy: "test",
    });
    const decision = await decide(db, { workspaceId, action: "send_reply" });
    assert.equal(decision.mode, "auto");
  });

  test("a rule scoped to one platform does not leak to another", async () => {
    await grantAutonomy(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: "pomelo",
      mode: "auto",
      grantedBy: "test",
    });

    const pomelo = await decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: "pomelo",
    });
    const bluesky = await decide(db, {
      workspaceId,
      action: "schedule_post",
      connectorId: "bluesky",
    });

    assert.equal(pomelo.mode, "auto");
    assert.equal(bluesky.mode, "approve", "autonomy must not spread across platforms");
  });

  test("conditions downgrade the decision and say why", async () => {
    await grantAutonomy(db, {
      workspaceId,
      action: "engagement_automation",
      mode: "auto",
      conditions: { sentiment: "positive" },
      grantedBy: "test",
    });

    const friendly = await decide(db, {
      workspaceId,
      action: "engagement_automation",
      sentiment: "positive",
    });
    const hostile = await decide(db, {
      workspaceId,
      action: "engagement_automation",
      sentiment: "hostile",
    });

    assert.equal(friendly.mode, "auto");
    assert.equal(hostile.mode, "approve");
    assert.match(hostile.downgradeReason ?? "", /positive/);
  });
});
