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
import { approvals, audit, transition } from "@zest/core";
import { getConnector, listConnectorMeta } from "@zest/connectors";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_PUBLISH } from "../queue/queue.constants.js";
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

    const content = { text: input.text, media: input.media };
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
    return { ok: true };
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
    await this.publishQueue.add("publish-post", { postId: id }, { jobId: `publish-${id}` });
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
    await this.publishQueue.add(
      "send-reply",
      { replyDraftId: draft.id },
      { jobId: `reply-${draft.id}` },
    );
    return { ok: true };
  }

  @HttpPost("replies/:id/reject")
  async rejectReply(@Req() req: AuthedRequest, @Param("id") id: string) {
    await approvals.rejectReplyDraft(this.db, id, req.actor);
    return { ok: true };
  }
}
