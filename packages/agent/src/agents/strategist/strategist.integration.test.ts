import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { plans } from "@zest/core";
import { readRun } from "../../runs.ts";
import { scriptedModel, textTurn, toolTurn } from "../testing.ts";
import { runStrategy } from "./strategy.ts";

/**
 * The strategist's two contracts: a tool call becomes plan rows, and prose
 * without a tool call is a recorded failure — however articulate the prose.
 */

const url = process.env.DATABASE_URL;

describe("strategist stage", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let planId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `strategist-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `strategist-${Date.now()}`,
        displayName: "Strategist test",
      })
      .returning();
    accountId = account!.id;

    const plan = await plans.createPlan(db, {
      workspaceId,
      name: "Strategy test",
      schedule: "manual",
      accountIds: [accountId],
    });
    planId = plan.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("the tool call becomes plan rows and a succeeded run", async () => {
    const result = await runStrategy({
      db,
      workspaceId,
      planId,
      briefing: "Ship the queue story.",
      model: scriptedModel("scripted-strategist", [
        toolTurn("add_plan_items", {
          items: [
            {
              accountId,
              topic: "Postgres as a queue",
              angle: "The war story",
              suggestedSlotAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
        textTurn("Planned one post for the week."),
      ]),
    });

    assert.equal(result.items, 1);
    assert.equal(result.skipped, undefined);
    assert.equal((await plans.pendingItems(db, planId, accountId)).length, 1);

    const run = await readRun(db, result.runId);
    assert.equal(run?.status, "succeeded");
    assert.equal(run?.model, "scripted-strategist");

    // The transcript survives normalisation with the tool name intact — the
    // exact shape the team page's replay reads.
    const transcript = run?.transcript as { toolCalls?: { tool?: string }[] }[];
    assert.ok(
      transcript.some((step) =>
        step.toolCalls?.some((call) => call.tool === "add_plan_items"),
      ),
    );
  });

  test("a stocked queue reaches the brief, and topping up nothing is a clean run", async () => {
    const stocked = await plans.createPlan(db, {
      workspaceId,
      name: "Stocked plan",
      schedule: "manual",
      accountIds: [accountId],
    });
    await plans.addItems(db, {
      planId: stocked.id,
      workspaceId,
      items: [
        {
          accountId,
          topic: "Queue survivors",
          angle: "Already planned last cycle",
          suggestedSlotAt: new Date(Date.now() + 86_400_000),
        },
      ],
    });

    const model = scriptedModel("stocked-strategist", [
      textTurn("The queue already covers the coming week; nothing to add."),
    ]);
    const result = await runStrategy({
      db,
      workspaceId,
      planId: stocked.id,
      briefing: "Same angles as before.",
      model,
    });

    // The model was shown what is already queued…
    const prompt = JSON.stringify(model.calls[0]?.prompt ?? "");
    assert.match(prompt, /Already planned and not yet written/);
    assert.match(prompt, /Queue survivors/);

    // …and adding nothing on a stocked plan is the contract, not a failure.
    assert.equal(result.items, 0);
    assert.equal(result.skipped, undefined);
    assert.equal(result.pending, 1);
    assert.equal((await readRun(db, result.runId))?.status, "succeeded");
  });

  test("prose without a tool call fails the run with the reason recorded", async () => {
    const empty = await plans.createPlan(db, {
      workspaceId,
      name: "Empty plan",
      schedule: "manual",
      accountIds: [accountId],
    });

    const result = await runStrategy({
      db,
      workspaceId,
      planId: empty.id,
      briefing: "Anything.",
      model: scriptedModel("mute-strategist", [
        textTurn("A lovely plan, described entirely in prose."),
      ]),
    });

    assert.equal(result.items, 0);
    assert.match(result.skipped ?? "", /without recording any plan items/);
    assert.equal((await readRun(db, result.runId))?.status, "failed");
  });
});
