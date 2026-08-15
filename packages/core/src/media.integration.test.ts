import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { human } from "@zest/shared";
import { deleteMedia, findOrphans, listMedia, recordUpload, usedBy } from "./media.ts";

/**
 * The media lifecycle, against a real Postgres.
 *
 * `usedBy` reaches into the post's `content` JSON with a containment query, so
 * it is only as correct as Postgres's jsonb behaviour — mocking it would test
 * the mock. And what it guards is the whole reason the table exists: deleting
 * an image that a published post still points at.
 *
 * Skipped when DATABASE_URL is unset, like the other integration suites.
 */

const url = process.env.DATABASE_URL;

describe("media library", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `media-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `media-test-${Date.now()}`,
      })
      .returning();
    accountId = account!.id;
  });

  after(async () => {
    if (workspaceId) {
      await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    }
    await closeDatabase(db);
  });

  let counter = 0;
  async function upload(overrides: { createdAt?: Date } = {}) {
    counter += 1;
    const asset = await recordUpload(db, {
      workspaceId,
      url: `http://localhost:4000/media/${workspaceId}/file-${counter}.png`,
      storageKey: `${workspaceId}/file-${counter}.png`,
      filename: `file-${counter}.png`,
      mimeType: "image/png",
      bytes: 1234,
      width: 320,
      height: 180,
      actor: human("test"),
    });
    if (overrides.createdAt) {
      await db
        .update(schema.mediaAssets)
        .set({ createdAt: overrides.createdAt })
        .where(eq(schema.mediaAssets.id, asset.id));
    }
    return asset;
  }

  async function postUsing(imageUrl: string, status: "draft" | "published" = "draft") {
    const [post] = await db
      .insert(schema.posts)
      .values({
        workspaceId,
        accountId,
        status,
        content: { text: "a post with a picture", media: [{ url: imageUrl }] },
        createdByActor: human("test"),
      })
      .returning();
    return post!;
  }

  test("an upload is recorded with its dimensions and author", async () => {
    const asset = await upload();
    assert.equal(asset.width, 320);
    assert.equal(asset.height, 180);
    assert.equal(asset.createdByActor.kind, "human");

    const { assets } = await listMedia(db, workspaceId);
    assert.ok(assets.some((a) => a.id === asset.id));
  });

  test("the list is newest first and pages by cursor", async () => {
    const older = await upload({ createdAt: new Date(Date.now() - 200_000) });
    const newer = await upload({ createdAt: new Date(Date.now() - 100_000) });

    const first = await listMedia(db, workspaceId, { limit: 1 });
    assert.equal(first.assets.length, 1);
    assert.ok(first.nextCursor, "more remain, so a cursor is returned");

    // Walk the cursor and confirm both show up, newest before oldest.
    const seen: string[] = [];
    let cursor: string | null | undefined = undefined;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof listMedia>> = await listMedia(
        db,
        workspaceId,
        { limit: 2, before: cursor ?? undefined },
      );
      seen.push(...result.assets.map((a) => a.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    assert.ok(seen.indexOf(newer.id) < seen.indexOf(older.id));
  });

  test("usedBy finds the posts that reference an image", async () => {
    const asset = await upload();
    const unrelated = await upload();
    const post = await postUsing(asset.url);

    const users = await usedBy(db, workspaceId, asset.url);
    assert.equal(users.length, 1);
    assert.equal(users[0]!.id, post.id);

    assert.equal(
      (await usedBy(db, workspaceId, unrelated.url)).length,
      0,
      "a containment query must not match an image that merely shares a prefix",
    );
  });

  test("an image still used by a post is not deleted", async () => {
    const asset = await upload();
    await postUsing(asset.url, "published");

    const result = await deleteMedia(db, workspaceId, asset.id);

    assert.equal(result.deleted, false);
    assert.equal(result.reason === "in_use" && result.posts.length, 1);
    // Still there — the whole point.
    const still = await db.query.mediaAssets.findFirst({
      where: eq(schema.mediaAssets.id, asset.id),
    });
    assert.ok(still);
  });

  test("force deletes despite usage, and reports the file to unlink", async () => {
    const asset = await upload();
    await postUsing(asset.url);

    const result = await deleteMedia(db, workspaceId, asset.id, { force: true });

    assert.equal(result.deleted, true);
    assert.equal(
      result.deleted && result.storageKey,
      asset.storageKey,
      "the caller needs the key to remove the bytes",
    );
    assert.equal(
      await db.query.mediaAssets.findFirst({
        where: eq(schema.mediaAssets.id, asset.id),
      }),
      undefined,
    );
  });

  test("an unused image deletes cleanly", async () => {
    const asset = await upload();
    const result = await deleteMedia(db, workspaceId, asset.id);
    assert.equal(result.deleted, true);
  });

  test("another workspace cannot delete this one's image", async () => {
    const asset = await upload();
    const [other] = await db
      .insert(schema.workspaces)
      .values({ name: `media-other-${Date.now()}`, timezone: "UTC" })
      .returning();

    const result = await deleteMedia(db, other!.id, asset.id);
    assert.equal(result.deleted, false);
    assert.equal(result.reason, "not_found");

    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, other!.id));
  });

  test("orphans are old uploads nothing points at", async () => {
    const orphan = await upload({ createdAt: new Date(Date.now() - 48 * 3_600_000) });
    const used = await upload({ createdAt: new Date(Date.now() - 48 * 3_600_000) });
    await postUsing(used.url);
    // Recent, so still plausibly attached to something being written.
    const fresh = await upload();

    const orphans = await findOrphans(db, workspaceId, 24);
    const ids = orphans.map((a) => a.id);

    assert.ok(ids.includes(orphan.id));
    assert.ok(!ids.includes(used.id), "referenced images are not orphans");
    assert.ok(!ids.includes(fresh.id), "a fresh upload is not yet abandoned");
  });
});
