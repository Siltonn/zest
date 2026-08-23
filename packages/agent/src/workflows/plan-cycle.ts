import { createStep, createWorkflow } from "@mastra/core/workflows";
import { autonomy, emit, plans } from "@zest/core";
import { z } from "zod";
import { buildStageContext, readStageContext } from "../context.ts";
import { runCopy } from "../agents/copywriter/copy.ts";
import { runResearch } from "../agents/researcher/research.ts";
import { runStrategy } from "../agents/strategist/strategy.ts";
import type { RunOptions } from "../agents/shared.ts";

/**
 * The planning pipeline as one workflow: research → a strategist per plan →
 * the write_plan gate → a copywriter per account.
 *
 * This is the only Mastra workflow in the package, on purpose. A workflow
 * earns its place when there is orchestration — fan-out, a gate, stages whose
 * outputs feed each other. The stages themselves stay plain functions in each
 * agent's directory; the steps here are thin adapters over them, which keeps
 * the functions testable directly and the graph inspectable in Studio.
 *
 * Two properties carried over from the queue-chained version this replaces:
 * one plan's failure does not take the others down (each fan-out item is
 * caught and reported as skipped — the stage already recorded the failed run),
 * and evergreen plans never reach the strategist (their tick is the model-free
 * recycleTick, dispatched server-side).
 */

const cycleInput = z.object({
  planId: z
    .string()
    .optional()
    .describe("Run for this plan only; default is every active plan"),
  model: z
    .string()
    .optional()
    .describe("Model override for every stage, as ZEST_MODEL would set it"),
});

const researched = z.object({
  planId: z.string().optional(),
  model: z.string().optional(),
  cycleId: z.string().optional(),
  briefing: z.string(),
  skipped: z.string().optional(),
});

const research = createStep({
  id: "research",
  description: "runResearch — one briefing per cycle, workspace-wide",
  inputSchema: cycleInput,
  outputSchema: researched,
  execute: async ({ inputData, requestContext }) => {
    const stage = readStageContext(requestContext);
    // A research failure fails the cycle: nothing after it makes sense, and
    // the stage has no side effects beyond its own run row, so re-running is
    // safe. The fan-out stages below are the ones that must not repeat.
    const result = await runResearch({
      ...stage,
      model: stage.model ?? inputData.model,
    });
    return {
      planId: inputData.planId,
      model: inputData.model,
      cycleId: result.runId || undefined,
      briefing: result.briefing,
      skipped: result.skipped,
    };
  },
});

const strategyTarget = z.object({
  planId: z.string(),
  briefing: z.string(),
  cycleId: z.string().optional(),
  model: z.string().optional(),
});

const planned = z.object({
  planId: z.string(),
  items: z.number(),
  pending: z.number().optional(),
  runId: z.string().optional(),
  skipped: z.string().optional(),
  cycleId: z.string().optional(),
  model: z.string().optional(),
});

const strategy = createStep({
  id: "strategy",
  description: "runStrategy for one plan — the briefing becomes plan items",
  inputSchema: strategyTarget,
  outputSchema: planned,
  execute: async ({ inputData, requestContext }) => {
    const stage = readStageContext(requestContext);
    const base = {
      planId: inputData.planId,
      cycleId: inputData.cycleId,
      model: inputData.model,
    };
    try {
      const result = await runStrategy({
        ...stage,
        model: stage.model ?? inputData.model,
        planId: inputData.planId,
        briefing: inputData.briefing,
        cycleId: inputData.cycleId,
      });
      return {
        ...base,
        items: result.items,
        pending: result.pending,
        runId: result.runId || undefined,
        skipped: result.skipped,
      };
    } catch (error) {
      // The failed run is already recorded by the stage; reporting it as
      // skipped keeps the other plans' fan-out alive.
      return { ...base, items: 0, skipped: (error as Error).message };
    }
  },
});

const copyTarget = z.object({
  planId: z.string(),
  accountId: z.string(),
  cycleId: z.string().optional(),
  model: z.string().optional(),
});

const gated = z.object({
  targets: z.array(copyTarget),
  awaitingReview: z.number(),
  planned: z.array(planned),
});

const gate = createStep({
  id: "write-plan-gate",
  description:
    "The cheap review altitude: without a write_plan grant the planned week waits in the inbox as one card; with auto it goes straight to the writers.",
  inputSchema: z.array(planned),
  outputSchema: gated,
  execute: async ({ inputData, requestContext }) => {
    const stage = readStageContext(requestContext);
    // Two different questions. Review needs to hear about what this cycle
    // newly planned; the writers must cover whatever is unwritten, this
    // cycle's or an earlier one's — a stocked plan whose strategist rightly
    // added nothing still gets its copy pass, or items stranded by a failed
    // copy stage would never be retried.
    const freshlyPlanned = inputData.filter((plan) => !plan.skipped && plan.items > 0);
    const writable = inputData.filter((plan) => !plan.skipped);

    const decision = await autonomy.decide(stage.db, {
      workspaceId: stage.workspaceId,
      action: "write_plan",
    });

    if (decision.mode !== "auto") {
      for (const plan of freshlyPlanned) {
        if (!stage.publisher) break;
        await emit(stage.publisher, {
          type: "inbox.new",
          workspaceId: stage.workspaceId,
          itemKind: "plan",
          entityId: plan.planId,
          summary: "A week of content is planned and waiting for review",
        });
      }
      return { targets: [], awaitingReview: freshlyPlanned.length, planned: inputData };
    }

    const targets: z.infer<typeof copyTarget>[] = [];
    for (const plan of writable) {
      for (const accountId of await plans.accountsWithPendingItems(
        stage.db,
        stage.workspaceId,
        plan.planId,
      )) {
        targets.push({
          planId: plan.planId,
          accountId,
          cycleId: plan.cycleId,
          model: plan.model,
        });
      }
    }
    return { targets, awaitingReview: 0, planned: inputData };
  },
});

const written = z.object({
  planId: z.string(),
  accountId: z.string(),
  proposals: z.number(),
  runId: z.string().optional(),
  skipped: z.string().optional(),
});

const copy = createStep({
  id: "copy",
  description: "runCopy for one account — one run per voice",
  inputSchema: copyTarget,
  outputSchema: written,
  execute: async ({ inputData, requestContext }) => {
    const stage = readStageContext(requestContext);
    const base = { planId: inputData.planId, accountId: inputData.accountId };
    try {
      const result = await runCopy({
        ...stage,
        model: stage.model ?? inputData.model,
        planId: inputData.planId,
        accountId: inputData.accountId,
        cycleId: inputData.cycleId,
      });
      return {
        ...base,
        proposals: result.proposals,
        runId: result.runId || undefined,
        skipped: result.skipped,
      };
    } catch (error) {
      return { ...base, proposals: 0, skipped: (error as Error).message };
    }
  },
});

const cycleOutput = z.object({
  briefing: z.string(),
  skipped: z.string().optional(),
  planned: z.array(planned),
  written: z.array(written),
  proposals: z.number(),
  awaitingReview: z.number(),
});

export const planCycle = createWorkflow({
  id: "plan-cycle",
  description:
    "The planning pipeline as the cron runs it: research → strategy per plan → copy per account. Writes real plan items and proposals; the write_plan gate is honoured, so without autonomy the planned week stops at the inbox.",
  inputSchema: cycleInput,
  outputSchema: cycleOutput,
})
  .then(research)
  .map(async ({ inputData, requestContext }) => {
    if (inputData.skipped) return [];
    const stage = readStageContext(requestContext);
    const active = await plans.activePlans(stage.db, stage.workspaceId);
    return active
      .filter((plan) => (inputData.planId ? plan.id === inputData.planId : true))
      // Evergreen plans re-propose measured winners without a model; the
      // worker routes them to recycleTick, never to the strategist.
      .filter((plan) => plan.kind !== "evergreen")
      .map((plan) => ({
        planId: plan.id,
        briefing: inputData.briefing,
        cycleId: inputData.cycleId,
        model: inputData.model,
      }));
  })
  .foreach(strategy, { concurrency: 1 })
  .then(gate)
  .map(async ({ inputData }) => inputData.targets)
  .foreach(copy, { concurrency: 1 })
  .map(async ({ inputData, getStepResult }) => {
    const researchOut = getStepResult(research);
    const gateOut = getStepResult(gate);
    return {
      briefing: researchOut.briefing,
      skipped: researchOut.skipped,
      planned: gateOut.planned,
      written: inputData,
      proposals: inputData.reduce((sum, item) => sum + item.proposals, 0),
      awaitingReview: gateOut.awaitingReview,
    };
  })
  .commit();

export type PlanCycleResult = z.infer<typeof cycleOutput>;

/**
 * The programmatic entry point the worker uses. The workflow runs standalone —
 * no Mastra instance required — with the stage context on the request context,
 * which is how the steps reach the database and how a test injects its model.
 */
export async function runPlanCycle(
  options: RunOptions & { planId?: string },
): Promise<PlanCycleResult> {
  const run = await planCycle.createRun();
  const outcome = await run.start({
    inputData: { planId: options.planId },
    requestContext: buildStageContext(options),
  });
  if (outcome.status === "success") return outcome.result;
  if (outcome.status === "failed") throw outcome.error;
  throw new Error(`plan-cycle run ended ${outcome.status}`);
}
