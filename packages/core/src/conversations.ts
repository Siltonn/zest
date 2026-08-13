import { and, asc, desc, eq, gte, schema, type Database } from "@zest/db";

/**
 * Chat conversations.
 *
 * The point of persisting these is not a history list — it is that the agent
 * can see what was already said. Without it, "make that one shorter" has no
 * referent, which is not a conversation so much as a series of unrelated
 * requests.
 */

export type Conversation = typeof schema.conversations.$inferSelect;
export type Message = typeof schema.messages.$inferSelect;

export async function listConversations(
  db: Database,
  workspaceId: string,
  limit = 30,
): Promise<Conversation[]> {
  return db
    .select()
    .from(schema.conversations)
    .where(eq(schema.conversations.workspaceId, workspaceId))
    .orderBy(desc(schema.conversations.updatedAt))
    .limit(limit);
}

export async function readConversation(
  db: Database,
  workspaceId: string,
  conversationId: string,
): Promise<{ conversation: Conversation; messages: Message[] } | null> {
  const [conversation] = await db
    .select()
    .from(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    );
  if (!conversation) return null;

  const messages = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(asc(schema.messages.createdAt));

  return { conversation, messages };
}

export async function createConversation(
  db: Database,
  workspaceId: string,
  firstMessage: string,
): Promise<Conversation> {
  const [created] = await db
    .insert(schema.conversations)
    .values({ workspaceId, title: titleFrom(firstMessage) })
    .returning();
  if (!created) throw new Error("Could not start a conversation");
  return created;
}

export async function appendMessage(
  db: Database,
  input: {
    conversationId: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: { tool: string; summary?: string }[];
    proposals?: { kind: "post" | "reply"; id: string }[];
    agentRunId?: string;
  },
): Promise<Message> {
  const [message] = await db
    .insert(schema.messages)
    .values({
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? [],
      proposals: input.proposals ?? [],
      agentRunId: input.agentRunId ?? null,
    })
    .returning();
  if (!message) throw new Error("Could not append the message");

  // Keeps the history list ordered by real activity.
  await db
    .update(schema.conversations)
    .set({ updatedAt: new Date() })
    .where(eq(schema.conversations.id, input.conversationId));

  return message;
}

export async function deleteConversation(
  db: Database,
  workspaceId: string,
  conversationId: string,
): Promise<void> {
  await db
    .delete(schema.conversations)
    .where(
      and(
        eq(schema.conversations.id, conversationId),
        eq(schema.conversations.workspaceId, workspaceId),
      ),
    );
}

/**
 * Recent turns as plain text, for the prompt. Capped because a chat that has
 * run all afternoon should not push the brand brief out of the window.
 */
export async function historyFor(
  db: Database,
  conversationId: string,
  turns = 12,
): Promise<string> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(turns);

  if (rows.length === 0) return "";

  return rows
    .reverse()
    .map((m) => `${m.role === "user" ? "Operator" : "You"}: ${m.content}`)
    .join("\n\n");
}

/**
 * Anything the agent proposed during a run, so the chat can offer it for
 * approval inline instead of sending the operator away to find it.
 */
export async function proposalsFromRun(
  db: Database,
  workspaceId: string,
  runId: string,
): Promise<{ kind: "post" | "reply"; id: string }[]> {
  const posts = await db
    .select({ id: schema.posts.id })
    .from(schema.posts)
    .where(
      and(
        eq(schema.posts.workspaceId, workspaceId),
        eq(schema.posts.agentRunId, runId),
      ),
    );

  const replies = await db
    .select({ id: schema.replyDrafts.id })
    .from(schema.replyDrafts)
    .where(
      and(
        eq(schema.replyDrafts.workspaceId, workspaceId),
        eq(schema.replyDrafts.agentRunId, runId),
      ),
    );

  return [
    ...posts.map((p) => ({ kind: "post" as const, id: p.id })),
    ...replies.map((r) => ({ kind: "reply" as const, id: r.id })),
  ];
}

/** A first line short enough for a sidebar, without cutting mid-word. */
function titleFrom(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= 48) return flat || "New conversation";
  return `${flat.slice(0, 45).replace(/\s\S*$/, "")}…`;
}
