import { randomUUID } from "node:crypto";
import type { Mastra } from "@mastra/core";
import { assistant } from "./agent.ts";

/**
 * The conversation surface over the assistant's memory.
 *
 * Threads and messages live in Mastra's storage (Postgres in the server,
 * LibSQL in Studio); what the product needs on top is thin: workspace
 * ownership checks, the DTO shape the chat panel renders, and the two
 * annotations a turn leaves behind — which run produced a reply and what it
 * proposed. All of that lives here, next to the agent whose memory it is,
 * so the server's controller stays HTTP glue.
 */

export type ChatThread = {
  id: string;
  workspaceId: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls: { tool: string; summary?: string }[];
  proposals: { kind: "post" | "reply"; id: string }[];
  agentRunId: string | null;
  createdAt: Date;
};

export type ChatAnnotation = {
  agentRunId: string;
  proposals: { kind: "post" | "reply"; id: string }[];
};

type AssistantMemory = NonNullable<Awaited<ReturnType<typeof assistant.getMemory>>>;

async function memoryOf(mastra: Mastra): Promise<AssistantMemory> {
  const memory = await mastra.getAgent("zest-assistant").getMemory();
  if (!memory) {
    throw new Error(
      "The assistant has no memory configured — chat threads need the Mastra instance built by createMastra with a storage.",
    );
  }
  return memory;
}

/** Titles come from the opening message: deterministic, and free. */
export function titleFrom(message: string): string {
  const clean = message.replace(/\s+/g, " ").trim();
  if (clean.length === 0) return "New conversation";
  if (clean.length <= 48) return clean;
  return `${clean.slice(0, 45).replace(/\s\S*$/, "")}…`;
}

type RawThread = {
  id: string;
  resourceId: string;
  title?: string;
  createdAt: Date;
  updatedAt: Date;
};

function toThread(thread: RawThread): ChatThread {
  return {
    id: thread.id,
    workspaceId: thread.resourceId,
    title: thread.title ?? "New conversation",
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
  };
}

type RawPart = {
  type: string;
  text?: string;
  toolInvocation?: { toolName?: string };
};

type RawMessage = {
  id: string;
  role: string;
  createdAt: Date | string;
  content?: {
    parts?: RawPart[];
    metadata?: Record<string, unknown>;
  };
};

/**
 * A stored message, flattened to what the panel renders: the text, the tools
 * that ran (kept as parts by Mastra), and the annotation a turn wrote.
 */
function toChatMessage(message: RawMessage): ChatMessage {
  const parts = message.content?.parts ?? [];
  const metadata = message.content?.metadata ?? {};
  const annotation = metadata as Partial<ChatAnnotation>;

  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: parts
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(""),
    toolCalls: parts
      .filter((part) => part.type === "tool-invocation")
      .map((part) => ({ tool: part.toolInvocation?.toolName ?? "" }))
      .filter((call) => call.tool.length > 0),
    proposals: annotation.proposals ?? [],
    agentRunId: annotation.agentRunId ?? null,
    createdAt: new Date(message.createdAt),
  };
}

export async function listChatThreads(
  mastra: Mastra,
  workspaceId: string,
): Promise<ChatThread[]> {
  const memory = await memoryOf(mastra);
  const { threads } = await memory.listThreads({
    filter: { resourceId: workspaceId },
    orderBy: { field: "updatedAt", direction: "DESC" },
    perPage: 30,
  });
  return threads.map(toThread);
}

/**
 * Opens the thread a turn will run under: the existing one when the caller
 * names it (never someone else's — ownership is the workspace), a fresh one
 * otherwise. Returns null when a named conversation does not exist, which the
 * API turns into its 404.
 */
export async function openChatThread(
  mastra: Mastra,
  workspaceId: string,
  input: { threadId: string; title: string; existing: boolean },
): Promise<ChatThread | null> {
  const memory = await memoryOf(mastra);

  if (input.existing) {
    const thread = await memory.getThreadById({ threadId: input.threadId });
    if (!thread || thread.resourceId !== workspaceId) return null;
    return toThread(thread);
  }

  const thread = await memory.createThread({
    threadId: input.threadId,
    resourceId: workspaceId,
    title: input.title,
  });
  return toThread(thread);
}

export async function readChatThread(
  mastra: Mastra,
  workspaceId: string,
  threadId: string,
): Promise<{ conversation: ChatThread; messages: ChatMessage[] } | null> {
  const memory = await memoryOf(mastra);
  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== workspaceId) return null;

  const { messages } = await memory.recall({ threadId, perPage: false });
  const chat = (messages as RawMessage[])
    .map(toChatMessage)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  return { conversation: toThread(thread), messages: chat };
}

export async function deleteChatThread(
  mastra: Mastra,
  workspaceId: string,
  threadId: string,
): Promise<boolean> {
  const memory = await memoryOf(mastra);
  const thread = await memory.getThreadById({ threadId });
  if (!thread || thread.resourceId !== workspaceId) return false;
  await memory.deleteThread(threadId);
  return true;
}

/**
 * The assistant's notepad, surfaced. Working memory is written by the agent
 * mid-turn and folded into its prompts invisibly — which is exactly the kind
 * of quiet accumulation this product does not do. Reading it back makes the
 * notes inspectable in the chat panel; clearing them is the operator's veto.
 * Scope is the workspace, so `resourceId` carries it — the threadId argument
 * is required by the signature and unused on the resource path.
 */
export async function readAssistantNotes(
  mastra: Mastra,
  workspaceId: string,
): Promise<{ notes: string | null }> {
  const memory = await memoryOf(mastra);
  const notes = await memory.getWorkingMemory({
    threadId: workspaceId,
    resourceId: workspaceId,
  });
  return { notes: notes?.trim() ? notes : null };
}

export async function clearAssistantNotes(
  mastra: Mastra,
  workspaceId: string,
): Promise<void> {
  const memory = await memoryOf(mastra);
  await memory.updateWorkingMemory({
    threadId: workspaceId,
    resourceId: workspaceId,
    workingMemory: "",
  });
}

/**
 * Stamps a persisted assistant message with what its run left behind. By id,
 * from the turn's own result — never "the latest message", which two
 * operators in one workspace chat would race.
 */
export async function annotateChatMessage(
  mastra: Mastra,
  messageId: string,
  annotation: ChatAnnotation,
): Promise<void> {
  const memory = await memoryOf(mastra);
  const store = await memory.storage.getStore("memory");
  await store?.updateMessages({
    // The declared type wants a whole content object, but the adapters treat
    // this as a partial and merge — updating metadata alone is the documented
    // use. The cast is the price of the truer call.
    messages: [{ id: messageId, content: { metadata: annotation } } as never],
  });
}

/**
 * The keyless fallback: no model means no generate, so the turn is written by
 * hand — the operator's message and the explanation — and the thread stays a
 * faithful record of what happened.
 */
export async function saveChatTurn(
  mastra: Mastra,
  input: { workspaceId: string; threadId: string; user: string; reply: string },
): Promise<{ userMessage: ChatMessage; reply: ChatMessage }> {
  const memory = await memoryOf(mastra);
  const now = new Date();

  const rows = [
    { role: "user" as const, text: input.user },
    { role: "assistant" as const, text: input.reply },
  ].map(({ role, text }, index) => ({
    id: randomUUID(),
    threadId: input.threadId,
    resourceId: input.workspaceId,
    role,
    // A millisecond apart so every reader agrees on the order.
    createdAt: new Date(now.getTime() + index),
    content: { format: 2 as const, parts: [{ type: "text" as const, text }] },
  }));

  await memory.saveMessages({ messages: rows as never });

  const [user, reply] = rows.map((row) => toChatMessage(row));
  return { userMessage: user!, reply: reply! };
}
