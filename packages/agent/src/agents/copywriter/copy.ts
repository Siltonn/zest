import { and, eq, schema, type Database } from "@zest/db";
import { plans } from "@zest/core";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { copywriter } from "./agent.ts";

export type CopyResult = {
  runId: string;
  proposals: number;
  skipped?: string;
};

/**
 * Stage three: the writing, one account at a time.
 *
 * Scoped to a single account on purpose. The copywriter used to be handed every
 * account in one context and asked to switch voice between items, which is how
 * a founder account starts sounding like a press release. One run per voice
 * costs a little more and keeps them apart.
 */
export async function runCopy(
  options: RunOptions & { planId: string; accountId: string; cycleId?: string },
): Promise<CopyResult> {
  const { db, workspaceId, planId, accountId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", proposals: 0, skipped: new NoModelConfiguredError().message };
  }

  const items = await plans.pendingItems(db, planId, accountId);
  if (items.length === 0) return { runId: "", proposals: 0, skipped: "Nothing left to write" };

  const [account] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.id, accountId));
  if (!account) return { runId: "", proposals: 0, skipped: "Unknown account" };

  const handle = await startRun(db, {
    workspaceId,
    trigger: "cron_plan",
    role: "copywriter",
    planId,
    accountId,
    cycleId: options.cycleId ?? null,
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    await reportProgress(handle, "writing", `Writing for @${account.handle}`, "copywriter");

    // The assignments are the task; the account's playbook and learnings
    // arrive through the copywriter's instructions, scoped to this run's account.
    const brief = [
      `You are writing for account ${account.id} (@${account.handle}) and no other.`,
      `## Your assignments\n\n${items
        .map(
          (item) =>
            `- planItemId ${item.id} — ${item.topic}${item.angle ? ` — angle: ${item.angle}` : ""}${
              item.suggestedSlotAt ? ` — slot: ${item.suggestedSlotAt.toISOString()}` : ""
            }`,
        )
        .join("\n")}`,
      "Write and propose each one, passing its planItemId so the plan knows it is done.",
      `Today is ${new Date().toISOString()}.`,
    ].join("\n\n");

    const before = await countProposals(db, workspaceId);
    const result = await generateStage(copywriter, brief, {
      ...options,
      runId: handle.id,
      role: "copywriter",
      planId,
      accountId,
    });
    const after = await countProposals(db, workspaceId);

    await finishRun(db, handle, {
      transcript: result.transcript,
      output: result.text,
    });
    return { runId: handle.id, proposals: after - before };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

async function countProposals(db: Database, workspaceId: string): Promise<number> {
  const rows = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.status, "pending_approval"),
      ),
    );
  return rows.length;
}
