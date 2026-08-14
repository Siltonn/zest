import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post as HttpPost,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { and, desc, eq, schema, type Database } from "@zest/db";
import { approvals, audit, changeRequests, transition } from "@zest/core";
import { getConnector, listConnectorMeta } from "@zest/connectors";
import { hasModelAccess, polishDraft } from "@zest/agent";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_AGENT_RUN, QUEUE_PUBLISH } from "../queue/queue.constants.js";
import { enqueueUnique } from "../queue/enqueue.js";
import { WorkspaceGuard, type AuthedRequest } from "../auth/workspace.guard.js";

/**
 * Posts and the approval inbox.
 *
 * Controllers stay thin on purpose: authenticate, validate, call into
 * `@zest/core`, serialize. The MCP server and the queue processors call those
 * same functions, so behaviour cannot drift between the three entry points.
 */

const createPostSchema = z.object({
  accountId: z.string().uuid(),
  text: z.string().min(1),
  media: z.array(z.object({ url: z.string(), altText: z.string().optional() })).default([]),
  /** Follow-up thread parts; the connector's validate() enforces support. */
  thread: z.array(z.string().min(1)).max(24).optional(),
  scheduledAt: z.string().datetime().optional(),
});

const approveSchema = z.object({
  text: z.string().optional(),
  scheduledAt: z.string().datetime().optional(),
});

@Controller("api/v1")
@UseGuards(WorkspaceGuard)
export class PostsController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_PUBLISH) private readonly publishQueue: Queue,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
  ) {}

  @Get("platforms")
  platforms() {
    return listConnectorMeta();
  }

  @Get("posts")
  async list(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const conditions = [eq(schema.posts.workspaceId, req.workspaceId)];
    if (status) {
      conditions.push(eq(schema.posts.status, status as never));
    }

    const rows = await this.db
      .select({ post: schema.posts, account: schema.linkedAccounts })
      .from(schema.posts)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.posts.accountId, schema.linkedAccounts.id),
      )
      .where(and(...conditions))
      .orderBy(desc(schema.posts.createdAt))
      .limit(200);

    return rows.map(({ post, account }) => ({
      ...post,
      account: {
        id: account.id,
        handle: account.handle,
        connectorId: account.connectorId,
        avatarUrl: account.avatarUrl,
      },
    }));
  }

  @Get("posts/:id")
  async detail(@Req() req: AuthedRequest, @Param("id") id: string) {
    const [row] = await this.db
      .select({ post: schema.posts, account: schema.linkedAccounts })
      .from(schema.posts)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.posts.accountId, schema.linkedAccounts.id),
      )
      .where(
        and(eq(schema.posts.id, id), eq(schema.posts.workspaceId, req.workspaceId)),
      );

    if (!row) throw new NotFoundException("Post not found");

    // The timeline is what makes a post explainable: who moved it, when, why.
    const timeline = await audit.timelineFor(this.db, "post", id);
    return { ...row.post, account: row.account, timeline };
  }

  @HttpPost("posts")
  async create(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = createPostSchema.parse(body);

    const [account] = await this.db
      .select()
      .from(schema.linkedAccounts)
      .where(
        and(
          eq(schema.linkedAccounts.id, input.accountId),
          eq(schema.linkedAccounts.workspaceId, req.workspaceId),
        ),
      );
    if (!account) throw new NotFoundException("Account not found");

    const content = {
      text: input.text,
      media: input.media,
      ...(input.thread?.length ? { thread: input.thread } : {}),
    };
    const issues = getConnector(account.connectorId)
      .validate(content)
      .filter((i) => i.severity === "error");
    if (issues.length > 0) {
      throw new BadRequestException(issues.map((i) => i.message).join("; "));
    }

    const [created] = await this.db
      .insert(schema.posts)
      .values({
        workspaceId: req.workspaceId,
        accountId: account.id,
        status: "draft",
        content,
        createdByActor: req.actor,
      })
      .returning();
    if (!created) throw new BadRequestException("Could not create the post");

    if (input.scheduledAt) {
      await transition(this.db, {
        postId: created.id,
        action: "schedule",
        actor: req.actor,
        patch: { scheduledAt: new Date(input.scheduledAt) },
      });
    }

    return this.detail(req, created.id);
  }

  @HttpPost("posts/:id/approve")
  async approve(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const input = approveSchema.parse(body ?? {});
    const result = await approvals.approvePost(this.db, id, req.actor, {
      ...(input.text ? { content: { text: input.text, media: [] } } : {}),
      ...(input.scheduledAt ? { scheduledAt: new Date(input.scheduledAt) } : {}),
    });
    return result;
  }

  @HttpPost("posts/:id/reject")
  async reject(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    await approvals.rejectPost(this.db, id, req.actor, body?.reason);
    return { ok: true };
  }

  @HttpPost("posts/:id/request-changes")
  async requestChanges(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { feedback?: string },
  ) {
    if (!body?.feedback) throw new BadRequestException("Feedback is required");
    await approvals.requestChanges(this.db, id, req.actor, body.feedback);

    // The note is only worth writing if something reads it. With no model
    // configured the post still waits in the inbox for a human edit, and the
    // response says which of the two happened.
    if (hasModelAccess()) {
      await enqueueUnique(this.agentQueue, "rework", { workspaceId: req.workspaceId, postId: id }, `rework-${id}`);
      return { ok: true, reworking: true };
    }
    return {
      ok: true,
      reworking: false,
      note: "No model is configured, so this is waiting for you to edit it.",
    };
  }

  @HttpPost("posts/:id/schedule")
  async schedule(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { scheduledAt: string },
  ) {
    const result = await transition(this.db, {
      postId: id,
      action: "schedule",
      actor: req.actor,
      patch: { scheduledAt: new Date(body.scheduledAt) },
    });
    return { status: result.to };
  }

  /** Publish now: same path as the scheduler, just with the time set to now. */
  @HttpPost("posts/:id/publish-now")
  async publishNow(@Req() req: AuthedRequest, @Param("id") id: string) {
    await transition(this.db, {
      postId: id,
      action: "schedule",
      actor: req.actor,
      patch: { scheduledAt: new Date() },
    });
    await enqueueUnique(this.publishQueue, "publish-post", { postId: id }, `publish-${id}`);
    return { ok: true };
  }

  @HttpPost("posts/:id/cancel")
  async cancel(@Req() req: AuthedRequest, @Param("id") id: string) {
    const result = await transition(this.db, {
      postId: id,
      action: "cancel",
      actor: req.actor,
    });
    return { status: result.to };
  }

  @HttpPost("posts/:id/retry")
  async retry(@Req() req: AuthedRequest, @Param("id") id: string) {
    const result = await transition(this.db, {
      postId: id,
      action: "retry",
      actor: req.actor,
      patch: { scheduledAt: new Date(), errorMessage: null },
    });
    return { status: result.to };
  }

  /**
   * Polish a hand-written draft against the account's voice card. Inline
   * rather than queued — the operator is sitting in the composer waiting.
   */
  @HttpPost("compose/polish")
  async polish(@Req() req: AuthedRequest, @Body() body: unknown) {
    const input = z
      .object({ accountId: z.string().uuid(), text: z.string().min(1) })
      .parse(body);

    if (!hasModelAccess()) {
      throw new BadRequestException(
        "No LLM provider is configured. Set OPENROUTER_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY and restart to enable polish.",
      );
    }

    const result = await polishDraft({
      db: this.db,
      workspaceId: req.workspaceId,
      accountId: input.accountId,
      text: input.text,
    });
    if (result.skipped) throw new BadRequestException(result.skipped);
    return { text: result.text, runId: result.runId };
  }

  @Get("inbox")
  async inbox(@Req() req: AuthedRequest) {
    return approvals.listInbox(this.db, req.workspaceId);
  }

  @Get("inbox/count")
  async inboxCount(@Req() req: AuthedRequest) {
    return { count: await approvals.inboxCount(this.db, req.workspaceId) };
  }

  @HttpPost("replies/:id/approve")
  async approveReply(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { text?: string },
  ) {
    const draft = await approvals.approveReplyDraft(
      this.db,
      id,
      req.actor,
      body?.text ? { text: body.text, media: [] } : undefined,
    );
    await enqueueUnique(
      this.publishQueue,
      "send-reply",
      { replyDraftId: draft.id },
      `reply-${draft.id}`,
    );
    return { ok: true };
  }

  @HttpPost("replies/:id/reject")
  async rejectReply(@Req() req: AuthedRequest, @Param("id") id: string) {
    await approvals.rejectReplyDraft(this.db, id, req.actor);
    return { ok: true };
  }

  /**
   * Comments and mentions the agent has not answered yet.
   *
   * Without this they were a black hole: an inbound row only became visible
   * once triage had drafted a reply, so anything the agent skipped — or
   * everything, with no model configured — was silently lost. Audience replies
   * are the one thing an operator must never miss.
   */
  @Get("inbound")
  async inbound(@Req() req: AuthedRequest, @Query("status") status = "new") {
    const rows = await this.db
      .select({ item: schema.inboundItems, account: schema.linkedAccounts })
      .from(schema.inboundItems)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.inboundItems.accountId, schema.linkedAccounts.id),
      )
      .where(
        and(
          eq(schema.linkedAccounts.workspaceId, req.workspaceId),
          eq(schema.inboundItems.status, status as never),
        ),
      )
      .orderBy(desc(schema.inboundItems.receivedAt))
      .limit(100);

    return rows.map(({ item, account }) => ({
      ...item,
      account: {
        id: account.id,
        handle: account.handle,
        connectorId: account.connectorId,
      },
    }));
  }

  /**
   * Answer a comment yourself. The agent is the usual author, but the loop must
   * close without a model configured — otherwise a demo with no API key can
   * receive replies and never send one.
   */
  @HttpPost("inbound/:id/reply")
  async replyManually(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { text?: string },
  ) {
    const text = body?.text?.trim();
    if (!text) throw new BadRequestException("A reply needs some text");

    const [row] = await this.db
      .select({ item: schema.inboundItems, account: schema.linkedAccounts })
      .from(schema.inboundItems)
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.inboundItems.accountId, schema.linkedAccounts.id),
      )
      .where(
        and(
          eq(schema.inboundItems.id, id),
          eq(schema.linkedAccounts.workspaceId, req.workspaceId),
        ),
      );
    if (!row) throw new NotFoundException("No such comment");

    const issues = getConnector(row.account.connectorId)
      .validate({ text, media: [] })
      .filter((i) => i.severity === "error");
    if (issues.length > 0) {
      throw new BadRequestException(issues.map((i) => i.message).join("; "));
    }

    // Written straight to approved: a human typed it, so there is nobody left
    // to review it. It still goes through the same send path and audit trail.
    const [draft] = await this.db
      .insert(schema.replyDrafts)
      .values({
        workspaceId: req.workspaceId,
        inboundItemId: id,
        status: "approved",
        content: { text, media: [] },
        reasoning: "Written by the operator",
        createdByActor: req.actor,
      })
      .returning();
    if (!draft) throw new BadRequestException("Could not save the reply");

    await this.db
      .update(schema.inboundItems)
      .set({ status: "replied" })
      .where(eq(schema.inboundItems.id, id));

    await this.db.insert(schema.auditLogs).values({
      workspaceId: req.workspaceId,
      entityType: "reply_draft",
      entityId: draft.id,
      action: "reply_manually",
      toStatus: "approved",
      actor: req.actor,
    });

    await enqueueUnique(
      this.publishQueue,
      "send-reply",
      { replyDraftId: draft.id },
      `reply-${draft.id}`,
    );
    return { ok: true, draftId: draft.id };
  }

  @HttpPost("inbound/:id/ignore")
  async ignoreInbound(@Req() req: AuthedRequest, @Param("id") id: string) {
    await this.db
      .update(schema.inboundItems)
      .set({ status: "ignored" })
      .where(eq(schema.inboundItems.id, id));

    await this.db.insert(schema.auditLogs).values({
      workspaceId: req.workspaceId,
      entityType: "inbound_item",
      entityId: id,
      action: "ignore",
      toStatus: "ignored",
      actor: req.actor,
    });
    return { ok: true };
  }

  /**
   * Deciding on a change the agent wants to make to itself. Approving is not
   * bookkeeping — it writes the memory document the next run reads, or grants
   * the rule that changes what every tool may do without asking.
   */
  @HttpPost("changes/:id/approve")
  async approveChange(@Req() req: AuthedRequest, @Param("id") id: string) {
    try {
      return await changeRequests.approve(this.db, req.workspaceId, id, req.actor);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  @HttpPost("changes/:id/reject")
  async rejectChange(
    @Req() req: AuthedRequest,
    @Param("id") id: string,
    @Body() body: { reason?: string },
  ) {
    try {
      await changeRequests.reject(
        this.db,
        req.workspaceId,
        id,
        req.actor,
        body?.reason,
      );
      return { ok: true };
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
}
