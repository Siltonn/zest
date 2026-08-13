import {
  BadRequestException,
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
import { conversations } from "@zest/core";
import { NoModelConfiguredError, runChat } from "@zest/agent";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

/**
 * The operator's direct line to the agent.
 *
 * Runs inline rather than on the queue because someone is sitting there
 * waiting. It uses the same tools and the same autonomy guard as the scheduled
 * runs, so asking for a draft here produces a proposal — which comes back with
 * the message, to be approved without leaving the conversation.
 */
@Controller("api/v1/chat")
@UseGuards(WorkspaceGuard)
export class ChatController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    return conversations.listConversations(this.db, req.workspaceId);
  }

  @Get(":id")
  async read(@Req() req: AuthedRequest, @Param("id") id: string) {
    const found = await conversations.readConversation(this.db, req.workspaceId, id);
    if (!found) throw new NotFoundException("No such conversation");
    return found;
  }

  @Delete(":id")
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    await conversations.deleteConversation(this.db, req.workspaceId, id);
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

    const conversation = input.conversationId
      ? (await conversations.readConversation(
          this.db,
          req.workspaceId,
          input.conversationId,
        ))?.conversation
      : await conversations.createConversation(
          this.db,
          req.workspaceId,
          input.message,
        );

    if (!conversation) throw new NotFoundException("No such conversation");

    // Recorded before the run so the turn survives a failure mid-answer.
    const userMessage = await conversations.appendMessage(this.db, {
      conversationId: conversation.id,
      role: "user",
      content: input.message,
    });

    const history = await conversations.historyFor(this.db, conversation.id);

    try {
      const result = await runChat({
        db: this.db,
        workspaceId: req.workspaceId,
        publisher: this.redis,
        message: input.message,
        accountId: input.accountId,
        history,
        trigger: req.actor.kind === "mcp" ? "mcp" : "chat",
      });

      const proposals = await conversations.proposalsFromRun(
        this.db,
        req.workspaceId,
        result.runId,
      );

      const reply = await conversations.appendMessage(this.db, {
        conversationId: conversation.id,
        role: "assistant",
        content: result.reply,
        toolCalls: result.toolCalls,
        proposals,
        agentRunId: result.runId,
      });

      return { conversation, userMessage, reply };
    } catch (error) {
      if (error instanceof NoModelConfiguredError) {
        // Recorded as a turn so the reason stays visible in the thread.
        const reply = await conversations.appendMessage(this.db, {
          conversationId: conversation.id,
          role: "assistant",
          content: error.message,
        });
        return { conversation, userMessage, reply };
      }
      throw error;
    }
  }
}
