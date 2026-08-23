import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { readRun } from "../../runs.ts";
import { scriptedModel, textTurn, toolTurn } from "../testing.ts";
import { runAnalysis } from "./analysis.ts";

/**
 * The analyst's weekly contract: the report is what gets filed through
 * write_report, and a run that narrates instead of filing is a recorded
 * failure — not a report made of narration.
 */

const url = process.env.DATABASE_URL;

describe("analyst stage", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `analyst-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("a weekly run that files nothing is a recorded failure", async () => {
    const result = await runAnalysis({
      db,
      workspaceId,
      weekly: true,
      model: scriptedModel("mute-analyst", [
        textTurn("I would summarise the week here, at length, without filing it."),
      ]),
    });

    assert.match(result.skipped ?? "", /without filing a report/);
    assert.equal((await readRun(db, result.runId))?.status, "failed");
  });

  test("a filed report succeeds and lands in memory", async () => {
    const result = await runAnalysis({
      db,
      workspaceId,
      weekly: true,
      model: scriptedModel("scripted-analyst", [
        toolTurn("write_report", {
          contentMd: "# Week 33\n\nTwo posts out; the build-cache one carried the week.",
        }),
        textTurn("Filed."),
      ]),
    });

    assert.equal(result.skipped, undefined);
    assert.equal((await readRun(db, result.runId))?.status, "succeeded");
  });
});
