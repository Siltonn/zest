import { and, eq, schema } from "@zest/db";
import { transition } from "@zest/core";
import { agent as agentActor } from "@zest/shared";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
} from "../../models.ts";
import { finishRun, reportProgress, startRun } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { copywriter } from "./agent.ts";

export type ReworkResult = {
  runId: string;
  revised: boolean;
  skipped?: string;
};

/**
 * Rewriting a post that was sent back with a note.
 *
 * This is what makes "ask for changes" different from "reject": the operator
 * says what is wrong once, in their own words, and the draft comes back
 * addressed rather than being retyped by hand. Without it `needs_changes` is a
 * dead end that the inbox keeps showing you.
 *
 * The copywriter does it, scoped to the one account, so the revision is bound by
 * the same playbook as the original.
 */
export async function runRework(
  options: RunOptions & { postId: string },
): Promise<ReworkResult> {
  const { db, workspaceId, postId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", revised: false, skipped: new NoModelConfiguredError().message };
  }

  const [row] = await db
    .select({ post: schema.posts, account: schema.linkedAccounts })
    .from(schema.posts)
    .innerJoin(
      schema.linkedAccounts,
      eq(schema.posts.accountId, schema.linkedAccounts.id),
    )
    .where(
      and(eq(schema.posts.id, postId), eq(schema.posts.workspaceId, workspaceId)),
    );
  if (!row) return { runId: "", revised: false, skipped: "No such post" };

  // The note lives in errorMessage — the same field a failed publish uses,
  // because both answer "why is this back in front of you".
  const feedback = row.post.errorMessage;
  if (row.post.status !== "needs_changes" || !feedback) {
    return { runId: "", revised: false, skipped: "That post is not awaiting a rewrite" };
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: "manual",
    role: "copywriter",
    accountId: row.account.id,
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    await reportProgress(
      handle,
      "rewriting",
      `Revising for @${row.account.handle}`,
      "copywriter",
    );

    const brief = [
      `You are revising an existing post for @${row.account.handle}, and nothing else.`,
      `## The draft as it stands\n\n${row.post.content.text}`,
      `## What the operator asked for\n\n${feedback}`,
      "Rewrite it to address that note. Change what was asked and leave the rest alone —",
      "this is a revision, not a fresh attempt. Reply with the new post text only:",
      "no preamble, no explanation, no quotes around it.",
    ].join("\n\n");

    const result = await generateStage(copywriter, brief, {
      ...options,
      runId: handle.id,
      role: "copywriter",
      accountId: row.account.id,
    });
    const revised = result.text.trim();

    if (!revised) {
      await finishRun(db, handle, {
        transcript: result.transcript,
        error: "The rewrite came back empty",
      });
      return { runId: handle.id, revised: false, skipped: "The rewrite came back empty" };
    }

    // Straight back to pending_approval: a revision the operator has not seen is
    // still a proposal, and clearing the note stops it reading as unaddressed.
    await transition(db, {
      postId,
      action: "edit",
      actor: agentActor(handle.id, "copywriter"),
      agentRunId: handle.id,
      patch: {
        content: { ...row.post.content, text: revised },
        errorMessage: null,
      },
    });

    await finishRun(db, handle, { transcript: result.transcript, output: revised });
    return { runId: handle.id, revised: true };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
