import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { reapStaleRuns } from "./runs.ts";

/**
 * Runs whose process went away.
 *
 * Nothing times out a model call, so a worker killed mid-run leaves its row in
 * `running` permanently: the team page spins on it and no retry ever happens,
 * because the job that would have retried is gone too. Observed for real — a
 * triage run sat at `running` for fourteen minutes with nothing behind it.
 */

const url = process.env.DATABASE_URL;

describe("abandoned runs", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `reap-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a long-abandoned run is failed with a reason", async () => {
    const [old] = await db
      .insert(schema.agentRuns)
      .values({
        workspaceId,
        trigger: "cron_plan",
        role: "researcher",
        status: "running",
        startedAt: new Date(Date.now() - 45 * 60_000),
      })
      .returning();

    const reaped = await reapStaleRuns(db);
    assert.ok(reaped >= 1);

    const [after] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, old!.id));

    assert.equal(after?.status, "failed");
    assert.ok(after?.endedAt, "a failed run needs an end time or it still reads as live");
    // The reason matters: "failed" with no message is indistinguishable from a
    // model error, and sends you looking in the wrong place.
    assert.match(after!.errorMessage ?? "", /abandoned/i);
  });

  test("a run that started moments ago is left alone", async () => {
    const [fresh] = await db
      .insert(schema.agentRuns)
      .values({
        workspaceId,
        trigger: "cron_plan",
        role: "strategist",
        status: "running",
      })
      .returning();

    await reapStaleRuns(db);

    const [after] = await db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.id, fresh!.id));
    assert.equal(after?.status, "running", "a slow model must not be declared dead");
  });
});
