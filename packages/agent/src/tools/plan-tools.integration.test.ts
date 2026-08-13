import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { closeDatabase, createDatabase, eq, schema, type Database } from "@zest/db";
import { agent as agentActor } from "@zest/shared";
import { plans } from "@zest/core";
import { buildRequestContext } from "../context.ts";
import { WRITE_TOOLS } from "./write.ts";

/**
 * The seam between the strategist and the copywriter.
 *
 * Tools are ordinary functions over domain services, so they can be exercised
 * without a model — which is the point of keeping them framework-neutral. What
 * is worth asserting is the plumbing a prompt cannot guarantee: that a plan only
 * produces work for the accounts it names, and that writing an item marks it
 * done so a retried stage cannot post it twice.
 */

const url = process.env.DATABASE_URL;

describe("plan tools", { skip: !url }, () => {
  let db: Database;
  let workspaceId: string;
  let planId: string;
  let onPlan: string;
  let offPlan: string;
  let runId: string;

  const contextFor = (overrides: { planId?: string; accountId?: string } = {}) =>
    buildRequestContext({
      db,
      workspaceId,
      actor: agentActor(runId, "strategist"),
      runId,
      planId,
      ...overrides,
    });

  before(async () => {
    db = createDatabase(url!);
    const [workspace] = await db
      .insert(schema.workspaces)
      .values({ name: `plan-tools-${Date.now()}`, timezone: "UTC" })
      .returning();
    workspaceId = workspace!.id;

    const accounts = await db
      .insert(schema.linkedAccounts)
      .values(
        ["on", "off"].map((tag) => ({
          workspaceId,
          connectorId: "pomelo",
          handle: `${tag}-${Date.now()}`,
          displayName: tag,
        })),
      )
      .returning();
    onPlan = accounts[0]!.id;
    offPlan = accounts[1]!.id;

    const plan = await plans.createPlan(db, {
      workspaceId,
      name: "Tool test",
      schedule: "manual",
      accountIds: [onPlan],
    });
    planId = plan.id;

    const [run] = await db
      .insert(schema.agentRuns)
      .values({ workspaceId, trigger: "cron_plan", role: "strategist", planId })
      .returning();
    runId = run!.id;
  });

  after(async () => {
    await db.delete(schema.workspaces).where(eq(schema.workspaces.id, workspaceId));
    await closeDatabase(db);
  });

  test("add_plan_items records the plan as rows", async () => {
    const result = (await WRITE_TOOLS.add_plan_items.execute(
      {
        items: [
          {
            accountId: onPlan,
            topic: "Why we rebuilt the scheduler",
            angle: "personal, not a changelog",
            suggestedSlotAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
        ],
      },
      { requestContext: contextFor() } as never,
    )) as { ok: boolean; added: number };

    assert.equal(result.ok, true);
    assert.equal(result.added, 1);

    const pending = await plans.pendingItems(db, planId, onPlan);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.angle, "personal, not a changelog");
    assert.equal(pending[0]!.agentRunId, runId, "the item traces to the run that planned it");
  });

  test("items for accounts outside the plan are refused, not silently dropped", async () => {
    const result = (await WRITE_TOOLS.add_plan_items.execute(
      {
        items: [
          {
            accountId: onPlan,
            topic: "Kept",
            angle: "on the plan",
            suggestedSlotAt: new Date().toISOString(),
          },
          {
            accountId: offPlan,
            topic: "Dropped",
            angle: "not on the plan",
            suggestedSlotAt: new Date().toISOString(),
          },
        ],
      },
      { requestContext: contextFor() } as never,
    )) as { ok: boolean; added: number; skipped?: string };

    assert.equal(result.added, 1, "only the account on the plan gets work");
    // Reported back so the model can correct itself rather than believing it
    // planned something the fan-out will never pick up.
    assert.match(result.skipped ?? "", /not on this plan/);

    const strays = await plans.pendingItems(db, planId, offPlan);
    assert.equal(strays.length, 0);
  });

  test("a run with no plan attached cannot invent one", async () => {
    const loose = buildRequestContext({
      db,
      workspaceId,
      actor: agentActor(runId, "strategist"),
      runId,
    });

    const result = (await WRITE_TOOLS.add_plan_items.execute(
      {
        items: [
          {
            accountId: onPlan,
            topic: "Orphan",
            angle: "nowhere to go",
            suggestedSlotAt: new Date().toISOString(),
          },
        ],
      },
      { requestContext: loose } as never,
    )) as { ok: boolean; error?: string };

    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not attached to a plan/);
  });

  test("proposing a post against an item marks it written", async () => {
    const [item] = await plans.pendingItems(db, planId, onPlan);
    assert.ok(item);

    const result = (await WRITE_TOOLS.propose_post.execute(
      {
        accountId: onPlan,
        text: "We rebuilt the scheduler. Here is what broke first.",
        suggestedSlotAt: new Date(Date.now() + 3_600_000).toISOString(),
        reasoning: "Opens with the failure, which is the part people remember.",
        planItemId: item.id,
      },
      {
        requestContext: contextFor({ accountId: onPlan }),
      } as never,
    )) as { ok: boolean; postId: string };

    assert.equal(result.ok, true);

    // The item leaving the pending set is what stops a retried copy stage from
    // writing the same post a second time.
    const stillPending = await plans.pendingItems(db, planId, onPlan);
    assert.ok(!stillPending.some((i) => i.id === item.id));

    const detail = await plans.readPlan(db, workspaceId, planId);
    const written = detail?.items.find((i) => i.id === item.id);
    assert.equal(written?.status, "written");
    assert.equal(written?.postId, result.postId, "the post traces back to its item");
  });

  test("a post proposed without an item still works", async () => {
    // Chat and ad-hoc runs have no plan behind them; the link is optional.
    const result = (await WRITE_TOOLS.propose_post.execute(
      {
        accountId: onPlan,
        text: "A one-off thought that was not planned.",
        suggestedSlotAt: new Date(Date.now() + 7_200_000).toISOString(),
        reasoning: "Asked for directly in chat.",
      },
      { requestContext: contextFor({ accountId: onPlan }) } as never,
    )) as { ok: boolean; postId: string };

    assert.equal(result.ok, true);
    const [post] = await db
      .select()
      .from(schema.posts)
      .where(eq(schema.posts.id, result.postId));
    assert.equal(post?.status, "pending_approval");
  });
});
