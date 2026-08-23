import { memory } from "@zest/core";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { analyst } from "./agent.ts";

export type AnalysisResult = {
  runId: string;
  report: string;
  skipped?: string;
};

/** Nightly review; also produces the weekly report when asked. */
export async function runAnalysis(
  options: RunOptions & { weekly?: boolean },
): Promise<AnalysisResult> {
  const { db, workspaceId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", report: "", skipped: new NoModelConfiguredError().message };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_analyze",
    role: "analyst",
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    await reportProgress(handle, "analysing", "Reviewing recent performance", "analyst");

    const task = options.weekly
      ? "Write this week's report: what went out, how it did, what you learned, what you plan next, and anything you need a decision on. Then update the learnings and, if the evidence supports it, the strategy."
      : "Review the last few days. Update the learnings document if you found something that holds up.";

    const result = await generateStage(analyst, task, {
      ...options,
      runId: handle.id,
      role: "analyst",
    });

    // The report is filed by the analyst through `write_report`, not scraped
    // from the run's text: `result.text` concatenates every step, so saving it
    // put "I'll review the recent performance… Let me start by gathering the
    // analytics" at the top of the operator's weekly report.
    if (options.weekly) {
      const filed = await memory.readMemory(db, workspaceId, "report");
      if (!filed) {
        await finishRun(db, handle, {
          transcript: result.transcript,
          output: result.text,
          error: "The analyst finished without filing a report.",
        });
        return {
          runId: handle.id,
          report: "",
          skipped: "The analyst finished without filing a report.",
        };
      }
    }

    await finishRun(db, handle, { transcript: result.transcript });
    return { runId: handle.id, report: result.text };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
