import { and, eq, inArray, schema } from "@zest/db";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { community } from "./agent.ts";

export type TriageResult = {
  runId: string;
  handled: number;
  skipped?: string;
};

/** Triages new replies and mentions, drafting responses or recommending silence. */
export async function runReplyTriage(options: RunOptions): Promise<TriageResult> {
  const { db, workspaceId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", handled: 0, skipped: new NoModelConfiguredError().message };
  }

  /**
   * Claim the comments before drafting anything.
   *
   * Triage fires from two places — the ingest processor when new comments
   * arrive, and the operator pressing the button — so two runs overlap easily.
   * Reading the `new` rows and marking them later meant both runs saw the same
   * comments and both drafted: measured, every one of seven comments came back
   * with two replies waiting in the inbox.
   *
   * The same conditional UPDATE the publisher uses to claim a due post: the
   * status flip is the claim, and a losing run gets an empty set and stops. In
   * the database, not the queue, for the same reason as publishing.
   */
  const pending = await db
    .update(schema.inboundItems)
    .set({ status: "triaged" })
    .where(
      and(
        eq(schema.inboundItems.workspaceId, workspaceId),
        eq(schema.inboundItems.status, "new"),
        inArray(
          schema.inboundItems.id,
          db
            .select({ id: schema.inboundItems.id })
            .from(schema.inboundItems)
            .where(
              and(
                eq(schema.inboundItems.workspaceId, workspaceId),
                eq(schema.inboundItems.status, "new"),
              ),
            )
            .limit(15),
        ),
      ),
    )
    .returning();

  if (pending.length === 0) return { runId: "", handled: 0 };

  const handle = await startRun(db, {
    workspaceId,
    trigger: "event_reply",
    role: "community",
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    const listing = pending
      .map(
        (item) =>
          `- id=${item.id} from @${item.authorHandle} (${item.sentiment ?? "unclassified"}): ${item.text}`,
      )
      .join("\n");

    await reportProgress(handle, "triaging", `${pending.length} new comments`, "community");

    const result = await generateStage(
      community,
      `## New comments\n\n${listing}\n\nTriage each one: draft a reply or recommend ignoring it. Read the full item first when the excerpt is not enough.`,
      { ...options, runId: handle.id, role: "community" },
    );

    await finishRun(db, handle, { transcript: result.transcript });
    return { runId: handle.id, handled: pending.length };
  } catch (error) {
    // Give the claim back. A crashed run holding six comments in `triaged`
    // with nothing drafted is worse than a duplicate: they stop showing as
    // unanswered and nobody ever sees them again.
    await db
      .update(schema.inboundItems)
      .set({ status: "new" })
      .where(
        and(
          inArray(
            schema.inboundItems.id,
            pending.map((item) => item.id),
          ),
          eq(schema.inboundItems.status, "triaged"),
        ),
      );

    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
