import { generateText } from "ai";
import { eq, schema } from "@zest/db";
import { memory } from "@zest/core";
import {
  NoModelConfiguredError,
  hasModelAccess,
  injectedModel,
  modelIdFor,
  resolveModel,
} from "../../models.ts";
import { finishRun, startRun } from "../../runs.ts";
import type { RunOptions } from "../shared.ts";

export type PolishResult = {
  runId: string;
  text: string;
  skipped?: string;
};

/**
 * Polishing a hand-written draft against an account's playbook.
 *
 * The composer was the one agent-free surface in the product — the comparison
 * with Postiz made that embarrassing, since even the scheduler-first competitor
 * embeds a copilot in its editor. Ours is narrower on purpose: not "generate a
 * post about X" but "take what the operator wrote and make it sound like this
 * account", which is the half generation tools get wrong.
 *
 * Plain `generateText` rather than the tool-carrying copywriter agent: this is
 * an inline request someone is sitting on, and a text transform has no business
 * proposing posts as a side effect. Because no agent runs here, the memory
 * block stays in the prompt — there are no instructions to carry it.
 */
export async function polishDraft(
  options: RunOptions & { accountId: string; text: string },
): Promise<PolishResult> {
  const { db, workspaceId, accountId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    return { runId: "", text: options.text, skipped: new NoModelConfiguredError().message };
  }

  const [account] = await db
    .select()
    .from(schema.linkedAccounts)
    .where(eq(schema.linkedAccounts.id, accountId));
  if (!account) return { runId: "", text: options.text, skipped: "Unknown account" };

  const handle = await startRun(db, {
    workspaceId,
    trigger: "manual",
    role: "copywriter",
    accountId,
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    const context = await memory.buildContext(db, workspaceId, accountId);

    const { text } = await generateText({
      model: injectedModel(options.model)
        ? options.model
        : resolveModel(options.model),
      prompt: [
        context,
        `The operator drafted this for @${account.handle}:`,
        options.text,
        "Polish it: keep their point and their facts, tighten the wording, and make",
        "it match this account's playbook. Do not add claims, hashtags, or emoji",
        "they did not write. If it already reads well, change less rather than more.",
        "Reply with the post text only — no preamble, no quotes around it.",
      ].join("\n\n"),
    });

    const polished = text.trim();
    if (!polished) {
      await finishRun(db, handle, { error: "The polish came back empty" });
      return { runId: handle.id, text: options.text, skipped: "The polish came back empty" };
    }

    await finishRun(db, handle, {
      transcript: [{ text: polished, finishReason: "stop" }],
      output: polished,
    });
    return { runId: handle.id, text: polished };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}
