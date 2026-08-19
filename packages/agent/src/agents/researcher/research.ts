import { eq, schema } from "@zest/db";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { researcher } from "./agent.ts";

export type ResearchResult = {
  runId: string;
  briefing: string;
  skipped?: string;
};

/**
 * Stage one: what is worth talking about.
 *
 * Deliberately workspace-wide and run once per cycle. Trends and performance
 * are shared across accounts, so researching per account would spend N times
 * the tokens on near-identical output — and worse, would stop the accounts
 * coordinating, which is the whole reason a brand account and a founder account
 * live in one workspace.
 */
export async function runResearch(options: RunOptions): Promise<ResearchResult> {
  const { db, workspaceId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", briefing: "", skipped: new NoModelConfiguredError().message };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "researcher",
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  // The cycle is named after the run that starts it, so every later stage can
  // point back without a separate table.
  await db
    .update(schema.agentRuns)
    .set({ cycleId: handle.id })
    .where(eq(schema.agentRuns.id, handle.id));

  try {
    await reportProgress(handle, "researching", "Looking at trends and recent performance", "researcher");

    const research = await generateStage(
      researcher,
      "Research what this brand should post about this week.",
      { ...options, runId: handle.id, role: "researcher" },
    );

    await finishRun(db, handle, {
      transcript: research.transcript,
      output: research.text,
    });
    return { runId: handle.id, briefing: research.text };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
