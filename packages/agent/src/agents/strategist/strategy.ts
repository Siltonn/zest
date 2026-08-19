import { inArray, schema } from "@zest/db";
import { plans } from "@zest/core";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { strategist } from "./agent.ts";

export type StrategyResult = {
  runId: string;
  plan: string;
  /** Items added this run. */
  items: number;
  /** Items still unwritten on the plan after this run, added or inherited. */
  pending?: number;
  skipped?: string;
};

/**
 * Stage two: what this programme will post, as rows.
 *
 * Runs once per plan, so a launch week and an always-on programme each get
 * their own strategist pass over the same briefing. The output is plan items,
 * not prose — which is what makes it reviewable before anything is written.
 */
export async function runStrategy(
  options: RunOptions & { planId: string; briefing: string; cycleId?: string },
): Promise<StrategyResult> {
  const { db, workspaceId, planId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", plan: "", items: 0, skipped: new NoModelConfiguredError().message };
  }

  const found = await plans.readPlan(db, workspaceId, planId);
  if (!found) return { runId: "", plan: "", items: 0, skipped: "No such plan" };
  if (found.accountIds.length === 0) {
    return { runId: "", plan: "", items: 0, skipped: `"${found.plan.name}" has no accounts` };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "strategist",
    planId,
    cycleId: options.cycleId ?? null,
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    await reportProgress(handle, "planning", `Planning "${found.plan.name}"`, "strategist");

    const accounts = await db
      .select({
        id: schema.linkedAccounts.id,
        handle: schema.linkedAccounts.handle,
        connectorId: schema.linkedAccounts.connectorId,
      })
      .from(schema.linkedAccounts)
      .where(inArray(schema.linkedAccounts.id, found.accountIds));

    const window = [
      found.plan.startsAt ? `starts ${found.plan.startsAt.toISOString()}` : null,
      found.plan.endsAt ? `ends ${found.plan.endsAt.toISOString()}` : null,
    ]
      .filter(Boolean)
      .join(", ");

    // A cycle can fire while earlier items are still waiting to be written —
    // held at the review gate, or left by a failed copy stage. The strategist
    // sees that queue so it tops the plan up instead of planning the same
    // period twice; before this, two run-nows in a day meant two weeks of
    // items.
    const pendingBefore = found.items.filter((item) => item.status === "planned");

    // The briefing and the programme's own facts are the task; who the brand
    // is arrives through the strategist's instructions.
    const brief = [
      `## Research briefing\n\n${options.briefing}`,
      `## Programme: ${found.plan.name}`,
      found.plan.objective ? `Objective: ${found.plan.objective}` : null,
      `Cadence: ${found.plan.schedule}${window ? ` (${window})` : ""}`,
      `Accounts this programme writes for:\n${accounts
        .map((a) => `- ${a.id} — @${a.handle} on ${a.connectorId}`)
        .join("\n")}`,
      pendingBefore.length > 0
        ? `## Already planned and not yet written\n\n${pendingBefore
            .map(
              (item) =>
                `- ${item.accountId} — ${item.topic}${item.angle ? ` — ${item.angle}` : ""}${
                  item.suggestedSlotAt ? ` — slot: ${item.suggestedSlotAt.toISOString()}` : ""
                }`,
            )
            .join(
              "\n",
            )}\n\nPlan on top of this queue: add only what the cadence still needs, and never re-add a topic that is already queued. If the queue already covers the coming period, add nothing and say so.`
        : null,
      `Today is ${new Date().toISOString()}.`,
      "Call add_plan_items once with every new item. Use only the account ids listed above.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const before = found.items.length;
    const result = await generateStage(strategist, brief, {
      ...options,
      runId: handle.id,
      role: "strategist",
      planId,
    });
    const after = await plans.readPlan(db, workspaceId, planId);

    const added = (after?.items.length ?? before) - before;

    if (added === 0) {
      // With a stocked queue, adding nothing is the incremental contract being
      // honoured — record it as a clean run so the copy pass still covers what
      // is already waiting.
      if (pendingBefore.length > 0) {
        await finishRun(db, handle, {
          transcript: result.transcript,
          output: result.text,
        });
        return {
          runId: handle.id,
          plan: result.text,
          items: 0,
          pending: pendingBefore.length,
        };
      }

      // But on an empty plan, prose and no items is a failure however
      // articulate the prose was: the copywriter fan-out reads rows, so the
      // cycle ends here with nothing to show and no reason recorded.
      const reason =
        "The strategist finished without recording any plan items — nothing to write.";
      await finishRun(db, handle, {
        transcript: result.transcript,
        output: result.text,
        error: reason,
      });
      return { runId: handle.id, plan: result.text, items: 0, skipped: reason };
    }

    await finishRun(db, handle, {
      transcript: result.transcript,
      output: result.text,
    });
    return {
      runId: handle.id,
      plan: result.text,
      items: added,
      pending: pendingBefore.length + added,
    };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
