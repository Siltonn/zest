import { randomUUID } from "node:crypto";
import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Redis } from "ioredis";
import type { Database } from "@zest/db";
import { approvals } from "@zest/core";
import {
  NoModelConfiguredError,
  annotateChatMessage,
  clearAssistantNotes,
  createMastra,
  deleteChatThread,
  listChatThreads,
  openChatThread,
  readAssistantNotes,
  readChatThread,
  runChat,
  saveChatTurn,
  titleFrom,
  type ChatMessage,
  type ChatThread,
} from "@zest/agent";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { MASTRA } from "../infra/mastra.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

type ZestMastra = ReturnType<typeof createMastra>;

/**
 * The operator's direct line to the agent.
 *
 * Runs inline rather than on the queue because someone is sitting there
 * waiting. It uses the same tools and the same autonomy guard as the scheduled
 * runs, so asking for a draft here produces a proposal — which comes back with
 * the message, to be approved without leaving the conversation.
 *
 * Conversations are the assistant's memory threads, stored by Mastra in its
 * own schema: history loads and persists inside the agent turn itself, and
 * this controller's job shrinks to ownership checks, the run's annotations
 * (which run replied, what it proposed), and keeping the response shape the
 * panel has always rendered.
 */
@Controller("api/v1/chat")
@UseGuards(WorkspaceGuard)
export class ChatController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @Inject(MASTRA) private readonly mastra: ZestMastra,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return listChatThreads(this.mastra, req.workspaceId);
  }

  /**
   * The assistant's notepad — working memory the agent keeps about how this
   * workspace's operator works. Declared before `:id` so the literal path
   * wins the route match. Read-only plus a veto: the notes are the agent's to
   * write, the operator's to see and to wipe.
   */
  @Get("notes")
  async notes(@Req() req: AuthedRequest) {
    return readAssistantNotes(this.mastra, req.workspaceId);
  }

  @Delete("notes")
  async forget(@Req() req: AuthedRequest) {
    await clearAssistantNotes(this.mastra, req.workspaceId);
    return { ok: true };
  }

  @Get(":id")
  async read(@Req() req: AuthedRequest, @Param("id") id: string) {
    const found = await readChatThread(this.mastra, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such conversation");
    return found;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await deleteChatThread(this.mastra, req.workspaceId, id);
    return { ok: true };
  }

  @Post()
  async send(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({
        message: z.string().min(1),
        conversationId: z.string().uuid().optional(),
        accountId: z.string().uuid().optional(),
      })
      .parse(body);

    const conversation = await openChatThread(this.mastra, req.workspaceId, {
      threadId: input.conversationId ?? randomUUID(),
      title: titleFrom(input.message),
      existing: Boolean(input.conversationId),
    });
    if (!conversation) throw new NotFoundException("No such conversation");

    try {
      const result = await runChat({
        db: this.db,
        workspaceId: req.workspaceId,
        publisher: this.redis,
        message: input.message,
        accountId: input.accountId,
        thread: conversation.id,
        trigger: req.actor.kind === "mcp" ? "mcp" : "chat",
      });

      const proposals = await approvals.proposalsFromRun(
        this.db,
        req.workspaceId,
        result.runId,
      );

      // Stamped onto the stored message by its own id, so the thread shows the
      // run link and the approval cards on re-read exactly as it does now.
      if (result.messageId) {
        await annotateChatMessage(this.mastra, result.messageId, {
          agentRunId: result.runId,
          proposals,
        });
      }

      const now = new Date();
      const userMessage: ChatMessage = {
        id: result.userMessageId ?? randomUUID(),
        role: "user",
        content: input.message,
        toolCalls: [],
        proposals: [],
        agentRunId: null,
        createdAt: now,
      };
      const reply: ChatMessage = {
        id: result.messageId ?? randomUUID(),
        role: "assistant",
        content: result.reply,
        toolCalls: result.toolCalls,
        proposals,
        agentRunId: result.runId,
        createdAt: now,
      };

      return { conversation: touched(conversation, now), userMessage, reply };
    } catch (error) {
      if (error instanceof NoModelConfiguredError) {
        // Recorded as a turn so the reason stays visible in the thread.
        const turn = await saveChatTurn(this.mastra, {
          workspaceId: req.workspaceId,
          threadId: conversation.id,
          user: input.message,
          reply: error.message,
        });
        return { conversation, ...turn };
      }
      throw error;
    }
  }
}

/** The list sorts by updatedAt; reflect the turn without re-reading the row. */
function touched(conversation: ChatThread, at: Date): ChatThread {
  return { ...conversation, updatedAt: at };
}
