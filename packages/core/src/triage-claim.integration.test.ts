import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { and, closeDatabase, createDatabase, eq, inArray, schema, type Database } from "@zest/db";

/**
 * Two triage runs must not draft the same comment twice.
 *
 * Triage fires both from the ingest processor and from the operator's button,
 * so overlap is normal rather than exotic. Before the claim, every one of seven
 * comments came back with two drafted replies waiting in the inbox.
 *
 * This exercises the claim itself against real Postgres, for the same reason
 * the publishing claim is tested that way: it depends on how the database
 * serialises concurrent conditional updates, and a mock would prove nothing.
 */

const url = process.env.DATABASE_URL;

describe("triage claim", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `triage-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `triage-${Date.now()}`,
        displayName: "Triage",
      })
      .returning();
    accountId = account!.id;

    await db.insert(schema.inboundItems).values(
      Array.from({ length: 6 }, (_, i) => ({
        workspaceId,
        accountId,
        kind: "reply" as const,
        externalId: `ext-${Date.now()}-${i}`,
        authorHandle: `commenter_${i}`,
        text: `Comment number ${i}`,
        status: "new" as const,
      })),
    );
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  /** The same claim runReplyTriage performs. */
  function claim(limit: number) {
    return db
      .update(schema.inboundItems)
      .set({ status: "triaged" })
      .where(
        and(
          eq(schema.inboundItems.workspaceId, workspaceId),
          eq(schema.inboundItems.status, "new"),
          inArray(
            schema.inboundItems.id,
            db
              .select({ id: schema.inboundItems.id })
              .from(schema.inboundItems)
              .where(
                and(
                  eq(schema.inboundItems.workspaceId, workspaceId),
                  eq(schema.inboundItems.status, "new"),
                ),
              )
              .limit(limit),
          ),
        ),
      )
      .returning();
  }

  test("concurrent triage runs never claim the same comment", async () => {
    const runs = await Promise.all([claim(15), claim(15), claim(15)]);
    const claimed = runs.flat().map((r) => r.id);

    assert.equal(claimed.length, 6, "every comment is claimed exactly once");
    assert.equal(
      new Set(claimed).size,
      6,
      "no comment may be handed to two runs — that is a duplicate draft",
    );

    // Exactly one run should have done the work; the others find nothing.
    const winners = runs.filter((r) => r.length > 0);
    assert.equal(winners.length, 1, "the losing runs get an empty set and stop");
  });

  test("a second pass finds nothing left to claim", async () => {
    const again = await claim(15);
    assert.equal(again.length, 0);
  });
});
