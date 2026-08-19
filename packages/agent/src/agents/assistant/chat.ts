import { NoModelConfiguredError, hasModelAccess, injectedModel, modelIdFor } from "../../models.ts";
import { finishRun, startRun, type TriggerName } from "../../runs.ts";
import { generateStage, type RunOptions } from "../shared.ts";
import { assistant } from "./agent.ts";

export type ChatResult = {
  runId: string;
  reply: string;
  toolCalls: { tool: string; summary?: string }[];
  /** The persisted assistant message, when the turn ran under a thread. */
  messageId?: string;
  /** The persisted operator message, same condition. */
  userMessageId?: string;
};

/**
 * A chat turn. Same tools and the same autonomy guard as the scheduled runs —
 * asking for a draft here still produces a proposal, not a live post.
 *
 * The message given to the model is exactly what the operator typed: who the
 * brand is arrives through the assistant's instructions, and prior turns
 * arrive through its memory when a `thread` is passed — Mastra loads the
 * recent history and persists both sides of this turn under that thread. No
 * thread means no history and nothing saved, which is what a one-off
 * programmatic call wants.
 */
export async function runChat(
  options: RunOptions & {
    message: string;
    accountId?: string;
    trigger?: TriggerName;
    thread?: string;
  },
): Promise<ChatResult> {
  const { db, workspaceId } = options;

  if (!injectedModel(options.model) && !hasModelAccess()) {
    throw new NoModelConfiguredError();
  }

  const handle = await startRun(db, {
    workspaceId,
    trigger: options.trigger ?? "chat",
    role: "assistant",
    publisher: options.publisher,
    model: modelIdFor(options.model),
  });

  try {
    const result = await generateStage(assistant, options.message, {
      ...options,
      runId: handle.id,
      role: "assistant",
      accountId: options.accountId,
      memory: options.thread
        ? { thread: { id: options.thread }, resource: workspaceId }
        : undefined,
    });

    await finishRun(db, handle, { transcript: result.transcript });
    return {
      runId: handle.id,
      reply: result.text,
      toolCalls: toolCallsFrom(result.transcript),
      messageId: options.thread
        ? result.responseMessages.filter((m) => m.role === "assistant").at(-1)?.id
        : undefined,
      userMessageId: options.thread
        ? result.responseMessages.find((m) => m.role === "user")?.id
        : undefined,
    };
  } catch (error) {
    await finishRun(db, handle, { error: (error as Error).message });
    throw error;
  }
}

/** Flattens a transcript into the list of tools that actually ran. */
export function toolCallsFrom(transcript: unknown[]): { tool: string; summary?: string }[] {
  const calls: { tool: string; summary?: string }[] = [];
  for (const step of transcript) {
    const s = step as { toolCalls?: { tool?: string }[] };
    for (const call of s.toolCalls ?? []) {
      if (call.tool) calls.push({ tool: call.tool });
    }
  }
  return calls;
}
