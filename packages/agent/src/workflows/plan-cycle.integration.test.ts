import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { autonomy, plans } from "@zest/core";
import { scriptedModel, textTurn, throwingTurn, toolTurn } from "../agents/testing.ts";
import { runPlanCycle } from "./plan-cycle.ts";

/**
 * The pipeline as one workflow, with the three properties that matter:
 * without a write_plan grant the planned week stops at the gate; with one it
 * runs through to proposals; and a stage blowing up is contained to its item
 * instead of taking the cycle down.
 */

const url = process.env.DATABASE_URL;

describe("plan-cycle workflow", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let accountId: string;
  let planId: string;

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `plan-cycle-test-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const [account] = await db
      .insert(schema.linkedAccounts)
      .values({
        workspaceId,
        connectorId: "pomelo",
        handle: `cycle-${Date.now()}`,
        displayName: "Cycle test",
      })
      .returning();
    accountId = account!.id;

    const plan = await plans.createPlan(db, {
      workspaceId,
      name: "Cycle plan",
      schedule: "manual",
      accountIds: [accountId],
    });
    planId = plan.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("without autonomy the planned week stops at the gate", async () => {
    const result = await runPlanCycle({
      db,
      workspaceId,
      planId,
      model: scriptedModel("gated-cycle", [
        textTurn("Briefing: the queue story has momentum."),
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
        textTurn("One post planned."),
      ]),
    });

    assert.match(result.briefing, /queue story/);
    assert.equal(result.planned[0]?.items, 1);
    assert.equal(result.awaitingReview, 1);
    assert.deepEqual(result.written, []);
    assert.equal(result.proposals, 0);
  });

  test("with write_plan granted the cycle runs through to proposals", async () => {
    await autonomy.grantAutonomy(db, {
      workspaceId,
      action: "write_plan",
      mode: "auto",
      grantedBy: "test-operator",
    });

    const result = await runPlanCycle({
      db,
      workspaceId,
      planId,
      model: scriptedModel("auto-cycle", [
        textTurn("Briefing: keep going."),
        toolTurn("add_plan_items", {
          items: [
            {
              accountId,
              topic: "Build cache wins",
              angle: "Numbers first",
              suggestedSlotAt: new Date(Date.now() + 172_800_000).toISOString(),
            },
          ],
        }),
        textTurn("Planned."),
        toolTurn("propose_post", {
          accountId,
          text: "Cold builds: 14 minutes to 90 seconds.",
          suggestedSlotAt: new Date(Date.now() + 172_800_000).toISOString(),
          reasoning: "The number carries it.",
        }),
        textTurn("Proposed."),
      ]),
    });

    assert.equal(result.awaitingReview, 0);
    assert.equal(result.proposals, 1);
    assert.equal(result.written[0]?.proposals, 1);
  });

  test("a stocked plan that adds nothing still gets its copy pass", async () => {
    // Earlier tests left unwritten items on the plan (their copy turns proposed
    // without planItemId). The strategist rightly tops up nothing — and the
    // writers must still cover the queue, or a failed copy stage would strand
    // its items forever.
    const result = await runPlanCycle({
      db,
      workspaceId,
      planId,
      model: scriptedModel("stocked-cycle", [
        textTurn("Briefing: steady as she goes."),
        textTurn("The queue already covers the week; adding nothing."),
        toolTurn("propose_post", {
          accountId,
          text: "Queue survivor, finally written.",
          suggestedSlotAt: new Date(Date.now() + 86_400_000).toISOString(),
          reasoning: "It was already planned.",
        }),
        textTurn("Wrote the queued item."),
      ]),
    });

    assert.equal(result.planned[0]?.items, 0);
    assert.equal(result.planned[0]?.skipped, undefined);
    assert.equal(result.proposals, 1);
  });

  test("a strategist blowing up is contained to its plan, not the cycle", async () => {
    const result = await runPlanCycle({
      db,
      workspaceId,
      planId,
      model: scriptedModel("contained-cycle", [
        textTurn("Briefing survives."),
        throwingTurn("strategist fell over"),
      ]),
    });

    // The cycle completed; the failure is a per-plan skip whose run row holds
    // the message, and nothing downstream ran for it.
    assert.match(result.briefing, /survives/);
    assert.match(result.planned[0]?.skipped ?? "", /strategist fell over/);
    assert.equal(result.proposals, 0);
  });
});
