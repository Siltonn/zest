import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { plans } from "@zest/core";
import { human } from "@zest/shared";
import { readRun } from "../../runs.ts";
import { scriptedModel, textTurn, toolTurn } from "../testing.ts";
import { runCopy } from "./copy.ts";
import { runRework } from "./rework.ts";
import { polishDraft } from "./polish.ts";

/**
 * The copywriter's three entry points against the real pipeline plumbing:
 * a proposal lands as a pending post and marks its plan item written; a
 * rework puts the revision back in front of the operator with the note
 * cleared; a polish is a pure text round-trip.
 */

const url = process.env.DATABASE_URL;

describe("copywriter stages", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let planId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `copywriter-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `copywriter-${Date.now()}`,
        displayName: "Copywriter test",
      })
      .returning();
    accountId = account!.id;

    const plan = await plans.createPlan(db, {
      workspaceId,
      name: "Copy test",
      schedule: "manual",
      accountIds: [accountId],
    });
    planId = plan.id;

    await plans.addItems(db, {
      planId,
      workspaceId,
      items: [
        {
          accountId,
          topic: "Build cache wins",
          angle: "Numbers first",
          suggestedSlotAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a proposal lands pending approval and marks the item written", async () => {
    const [item] = await plans.pendingItems(db, planId, accountId);
    assert.ok(item);

    const result = await runCopy({
      db,
      workspaceId,
      planId,
      accountId,
      model: scriptedModel("scripted-copywriter", [
        toolTurn("propose_post", {
          accountId,
          text: "We cut cold builds from 14 minutes to 90 seconds. Here is how.",
          suggestedSlotAt: new Date(Date.now() + 86_400_000).toISOString(),
          reasoning: "The measured claim carries it.",
          planItemId: item!.id,
        }),
        textTurn("Proposed the build-cache post."),
      ]),
    });

    assert.equal(result.proposals, 1);
    assert.equal((await readRun(db, result.runId))?.status, "succeeded");

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(
        and(eq(schema.posts.workspaceId, workspaceId), eq(schema.posts.accountId, accountId)),
      );
    assert.equal(post?.status, "pending_approval");
    assert.equal(post?.agentRunId, result.runId);

    // The loop closes: nothing left for a retried stage to write twice.
    assert.equal((await plans.pendingItems(db, planId, accountId)).length, 0);
  });

  test("a rework puts the revision back in review with the note cleared", async () => {
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "needs_changes",
        content: { text: "Original draft, too salesy.", media: [] },
        errorMessage: "Less marketing voice, keep the number.",
        createdByActor: human("test-operator"),
      })
      .returning();

    const result = await runRework({
      db,
      workspaceId,
      postId: post!.id,
      model: scriptedModel("scripted-reworker", [
        textTurn("Cold builds: 14 minutes down to 90 seconds. That is the whole pitch."),
      ]),
    });

    assert.equal(result.revised, true);
    const [updated] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, post!.id));
    assert.equal(updated?.status, "pending_approval");
    assert.equal(updated?.errorMessage, null);
    assert.match(updated?.content.text ?? "", /90 seconds/);
  });

  test("an empty rewrite is a recorded skip, not a silent success", async () => {
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "needs_changes",
        content: { text: "Another draft.", media: [] },
        errorMessage: "Tighten it.",
        createdByActor: human("test-operator"),
      })
      .returning();

    const result = await runRework({
      db,
      workspaceId,
      postId: post!.id,
      model: scriptedModel("mute-reworker", [textTurn("   ")]),
    });

    assert.equal(result.revised, false);
    assert.match(result.skipped ?? "", /came back empty/);
  });

  test("a polish is a text round-trip that saves nothing", async () => {
    const result = await polishDraft({
      db,
      workspaceId,
      accountId,
      text: "we shipped the cache thing, its fast now",
      model: scriptedModel("scripted-polisher", [
        textTurn("We shipped the build cache. Cold builds are fast now."),
      ]),
    });

    assert.match(result.text, /build cache/);
    assert.equal((await readRun(db, result.runId))?.status, "succeeded");
  });
});
