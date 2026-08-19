import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { failingModel, scriptedModel, textTurn, toolTurn } from "../testing.ts";
import { runReplyTriage } from "./triage.ts";

/**
 * Triage's two guarantees: handled comments end up triaged or ignored with
 * their drafts in the inbox, and a crashed run gives its claim back so the
 * comments are not silently lost.
 */

const url = process.env.DATABASE_URL;

describe("community triage", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let postId: string;

  const seedComment = async (text: string) => {
    const [item] = await db
      .insert(schema.inboundItems)
      .values({
        workspaceId,
        accountId,
        postId,
        kind: "reply",
        externalId: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        authorHandle: "curious_dev",
        text,
        status: "new",
      })
      .returning();
    return item!;
  };

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `community-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `community-${Date.now()}`,
        displayName: "Community test",
      })
      .returning();
    accountId = account!.id;

    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "published",
        content: { text: "The build cache post.", media: [] },
        createdByActor: { kind: "system", source: "test" },
      })
      .returning();
    postId = post!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a question gets a draft, bait gets ignored, both leave the queue", async () => {
    const question = await seedComment("How does the cache handle lockfile changes?");
    const bait = await seedComment("tools like this are why software is bloated");

    const result = await runReplyTriage({
      db,
      workspaceId,
      model: scriptedModel("scripted-community", [
        toolTurn("propose_reply", {
          inboundItemId: question.id,
          text: "Lockfile changes key the cache, so a change means a clean build.",
          reasoning: "A real question deserves the mechanism.",
        }),
        toolTurn("ignore_inbound", {
          inboundItemId: bait.id,
          reason: "Bait; nothing to add.",
        }),
        textTurn("Two comments triaged."),
      ]),
    });

    assert.equal(result.handled, 2);

    const [afterQuestion] = await db
      .select()
      .from(schema.inboundItems)
      .where(eq(schema.inboundItems.id, question.id));
    assert.equal(afterQuestion?.status, "triaged");

    const [afterBait] = await db
      .select()
      .from(schema.inboundItems)
      .where(eq(schema.inboundItems.id, bait.id));
    assert.equal(afterBait?.status, "ignored");

    const drafts = await db
      .select()
      .from(schema.replyDrafts)
      .where(eq(schema.replyDrafts.workspaceId, workspaceId));
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.status, "pending_approval");
  });

  test("a crashed run gives its claim back", async () => {
    const stranded = await seedComment("Genuine question that must not vanish.");

    await assert.rejects(
      runReplyTriage({
        db,
        workspaceId,
        model: failingModel("dying-community", "provider fell over"),
      }),
      /provider fell over/,
    );

    // The claim was returned: the comment shows as unanswered again rather
    // than sitting in `triaged` with nothing drafted, invisible forever.
    const [row] = await db
      .select()
      .from(schema.inboundItems)
      .where(eq(schema.inboundItems.id, stranded.id));
    assert.equal(row?.status, "new");

    const failed = await db
      .select()
      .from(schema.agentRuns)
      .where(
        and(
          eq(schema.agentRuns.workspaceId, workspaceId),
          eq(schema.agentRuns.status, "failed"),
        ),
      );
    assert.equal(failed.length, 1);
  });
});
