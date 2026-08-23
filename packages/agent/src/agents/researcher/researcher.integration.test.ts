import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { readRun } from "../../runs.ts";
import { scriptedModel, textTurn } from "../testing.ts";
import { runResearch } from "./research.ts";

/**
 * The researcher's stage, end to end minus the network: a scripted model, the
 * real agent with its real tools, the real database, the real run bookkeeping.
 */

const url = process.env.DATABASE_URL;

describe("researcher stage", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `researcher-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a briefing comes back and the run names its own cycle", async () => {
    const result = await runResearch({
      db,
      workspaceId,
      model: scriptedModel("scripted-researcher", [
        textTurn("Angle one: postgres as a queue. Angle two: build cache wins."),
      ]),
    });

    assert.match(result.briefing, /postgres as a queue/);
    assert.equal(result.skipped, undefined);

    const run = await readRun(db, result.runId);
    assert.equal(run?.status, "succeeded");
    // The cycle is named after the run that starts it.
    assert.equal(run?.cycleId, result.runId);
    // The audit trail records the injected model by its own id.
    assert.equal(run?.model, "scripted-researcher");
  });
});
