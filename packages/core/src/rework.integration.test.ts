import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { human } from "@zest/shared";
import { requestChanges } from "./approvals.ts";
import { listInbox } from "./approvals.ts";
import { transition } from "./state-machine.ts";

/**
 * Sending a draft back with a note.
 *
 * The interesting property is that the note survives somewhere the rewrite can
 * read it, and that the post stays visible while it waits — a post sent back
 * that vanishes from the inbox is indistinguishable from one that was rejected.
 */

const url = process.env.DATABASE_URL;

describe("asking for changes", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let postId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `rework-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `rework-${Date.now()}`,
        displayName: "Rework",
      })
      .returning();
    accountId = account!.id;

    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status: "draft",
        content: { text: "We shipped a thing. It is good.", media: [] },
        createdByActor: { kind: "system", source: "test" },
      })
      .returning();
    postId = post!.id;
    await transition(db, { postId, action: "propose", actor: human("tester") });
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("the note is stored where the rewrite can read it", async () => {
    await requestChanges(db, postId, human("tester"), "Lead with the failure.");

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId));
    assert.equal(post?.status, "needs_changes");
    assert.equal(post?.errorMessage, "Lead with the failure.");
  });

  test("a post awaiting a rewrite stays in the inbox", async () => {
    // Otherwise it is indistinguishable from a rejection: the operator asked
    // for a change and watched the item disappear.
    const inbox = await listInbox(db, workspaceId);
    const item = inbox.find((i) => i.id === postId);
    assert.ok(item, "needs_changes must still be listed");
    assert.equal(item.kind, "post");
  });

  test("a revision returns it to review rather than publishing it", async () => {
    const result = await transition(db, {
      postId,
      action: "edit",
      actor: human("tester"),
      patch: {
        content: { text: "It broke during a launch. Here is what we changed.", media: [] },
        errorMessage: null,
      },
    });

    assert.equal(result.to, "pending_approval", "a rewrite is still a proposal");

    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, postId));
    assert.match(post!.content.text, /broke during a launch/);
    // Clearing the note stops the revision reading as still unaddressed.
    assert.equal(post?.errorMessage, null);
  });
});
