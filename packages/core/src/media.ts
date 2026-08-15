import { and, desc, eq, lt, schema, sql, type Database } from "@zest/db";
import type { Actor } from "@zest/shared";

/**
 * The media library.
 *
 * Uploads previously wrote a file and returned a URL, and that was the entire
 * lifecycle — no record, so nothing could list what existed, tell which files a
 * post still referenced, or remove the ones nothing did. Recording each upload
 * fixes all three, and incidentally gives the agent something it never had: a
 * way to know which images are available at all.
 */

export type MediaAsset = typeof schema.mediaAssets.$inferSelect;

export async function recordUpload(
  db: Database,
  input: {
    workspaceId: string;
    url: string;
    storageKey: string;
    filename: string;
    mimeType: string;
    bytes: number;
    width?: number;
    height?: number;
    actor: Actor;
  },
): Promise<MediaAsset> {
  const [row] = await db
    .insert(schema.mediaAssets)
    .values({
      workspaceId: input.workspaceId,
      url: input.url,
      storageKey: input.storageKey,
      filename: input.filename,
      mimeType: input.mimeType,
      bytes: input.bytes,
      width: input.width ?? null,
      height: input.height ?? null,
      createdByActor: input.actor,
    })
    .returning();
  return row!;
}

/**
 * Newest first, cursor-paged.
 *
 * Offsets are wrong for the same reason they were wrong in the audit log: this
 * list only grows at the head, so an offset shifts under the reader the moment
 * anyone uploads anything.
 */
export async function listMedia(
  db: Database,
  workspaceId: string,
  options: { before?: string; limit?: number } = {},
): Promise<{ assets: MediaAsset[]; nextCursor: string | null }> {
  const limit = Math.min(options.limit ?? 60, 200);

  const rows = await db
    .select()
    .from(schema.mediaAssets)
    .where(
      options.before
        ? and(
            eq(schema.mediaAssets.workspaceId, workspaceId),
            lt(schema.mediaAssets.createdAt, new Date(options.before)),
          )
        : eq(schema.mediaAssets.workspaceId, workspaceId),
    )
    .orderBy(desc(schema.mediaAssets.createdAt))
    .limit(limit + 1);

  const assets = rows.slice(0, limit);
  return {
    assets,
    nextCursor:
      rows.length > limit ? (assets.at(-1)?.createdAt.toISOString() ?? null) : null,
  };
}

/**
 * Which posts still reference this image.
 *
 * Media lives inside the post's `content` JSON rather than a join table, so
 * this reaches into it. Worth the awkwardness: a delete that silently breaks a
 * published post is the failure this whole table exists to prevent, and the
 * operator deserves to be told what would break rather than discovering it in
 * the feed.
 */
export async function usedBy(
  db: Database,
  workspaceId: string,
  url: string,
): Promise<{ id: string; status: string; text: string }[]> {
  return db
    .select({
      id: schema.posts.id,
      status: sql<string>`${schema.posts.status}::text`,
      text: sql<string>`${schema.posts.content}->>'text'`,
    })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        sql`${schema.posts.content}->'media' @> ${JSON.stringify([{ url }])}::jsonb`,
      ),
    )
    .limit(20);
}

/**
 * Removes the record and reports the file to delete.
 *
 * The caller unlinks the file, because core has no business knowing where the
 * bytes live — the same reason connectors never touch the vault. Refuses while
 * a post still points at it unless forced, so "tidy up the library" cannot
 * quietly blank an image out of something already published.
 */
export async function deleteMedia(
  db: Database,
  workspaceId: string,
  id: string,
  options: { force?: boolean } = {},
): Promise<
  | { deleted: true; storageKey: string }
  | { deleted: false; reason: "not_found" }
  | { deleted: false; reason: "in_use"; posts: { id: string; status: string }[] }
> {
  const asset = await db.query.mediaAssets.findFirst({
    where: and(
      eq(schema.mediaAssets.id, id),
      eq(schema.mediaAssets.workspaceId, workspaceId),
    ),
  });
  if (!asset) return { deleted: false, reason: "not_found" };

  if (!options.force) {
    const posts = await usedBy(db, workspaceId, asset.url);
    if (posts.length > 0) {
      return {
        deleted: false,
        reason: "in_use",
        posts: posts.map(({ id, status }) => ({ id, status })),
      };
    }
  }

  await db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, id));
  return { deleted: true, storageKey: asset.storageKey };
}

/**
 * Uploads nothing has ever pointed at.
 *
 * The orphans this table was added to make findable: someone attached a picture
 * to a draft, changed their mind, and the bytes stayed on disk forever. Old
 * enough to be safe — an image uploaded a minute ago belongs to a post still
 * being written.
 */
export async function findOrphans(
  db: Database,
  workspaceId: string,
  olderThanHours = 24,
): Promise<MediaAsset[]> {
  const cutoff = new Date(Date.now() - olderThanHours * 3_600_000);
  const assets = await db
    .select()
    .from(schema.mediaAssets)
    .where(
      and(
        eq(schema.mediaAssets.workspaceId, workspaceId),
        lt(schema.mediaAssets.createdAt, cutoff),
      ),
    );

  const orphans: MediaAsset[] = [];
  for (const asset of assets) {
    const posts = await usedBy(db, workspaceId, asset.url);
    if (posts.length === 0) orphans.push(asset);
  }
  return orphans;
}
