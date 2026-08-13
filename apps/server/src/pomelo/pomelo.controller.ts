import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, schema, sql, type Database } from "@zest/db";
import { readClock, scheduleEngagement } from "@zest/simulator";
import { z } from "zod";
import { DATABASE } from "../infra/database.module.js";
import { QUEUE_SIMULATOR } from "../queue/queue.constants.js";

/**
 * Pomelo's public API — the simulated network pretending to be a real one.
 *
 * This is deliberately a genuine HTTP API with its own bearer tokens rather
 * than an internal function call. The mock connector talks to it exactly as the
 * Bluesky connector talks to bsky.social, so the offline demo exercises real
 * request/response/auth code instead of a shortcut that would hide bugs.
 */
@Controller("pomelo")
export class PomeloController {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @InjectQueue(QUEUE_SIMULATOR) private readonly simulatorQueue: Queue,
  ) {}

  private async authenticate(
    authorization?: string,
  ): Promise<typeof schema.pomeloUsers.$inferSelect> {
    const token = authorization?.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new UnauthorizedException("Missing Pomelo API key");

    const [user] = await this.db
      .select()
      .from(schema.pomeloUsers)
      .where(eq(schema.pomeloUsers.apiKey, token));
    if (!user) throw new UnauthorizedException("Invalid Pomelo API key");
    return user;
  }

  /** Registering needs no credentials — that is what makes the demo keyless. */
  @Post("accounts")
  async register(@Body() body: unknown) {
    const input = z
      .object({
        handle: z.string().min(2).max(30),
        displayName: z.string().optional(),
      })
      .parse(body);

    const [existing] = await this.db
      .select()
      .from(schema.pomeloUsers)
      .where(eq(schema.pomeloUsers.handle, input.handle));
    if (existing) throw new BadRequestException("That handle is taken on Pomelo");

    const apiKey = `pomelo_${randomBytes(18).toString("base64url")}`;
    const [user] = await this.db
      .insert(schema.pomeloUsers)
      .values({
        handle: input.handle,
        displayName: input.displayName ?? input.handle,
        avatarUrl: `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(input.handle)}`,
        isPersona: false,
        apiKey,
      })
      .returning();

    return {
      externalId: user!.id,
      handle: user!.handle,
      displayName: user!.displayName,
      avatarUrl: user!.avatarUrl,
      profileUrl: `/pomelo/@${user!.handle}`,
      followerCount: 0,
      apiKey,
    };
  }

  @Get("me")
  async me(@Headers("authorization") authorization?: string) {
    const user = await this.authenticate(authorization);
    return {
      externalId: user.id,
      handle: user.handle,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: `/pomelo/@${user.handle}`,
      followerCount: user.followerCount,
    };
  }

  @Post("posts")
  async createPost(
    @Body() body: unknown,
    @Headers("authorization") authorization?: string,
  ) {
    const user = await this.authenticate(authorization);
    const input = z
      .object({
        text: z.string().min(1).max(420),
        media: z
          .array(z.object({ url: z.string(), altText: z.string().optional() }))
          .default([]),
      })
      .parse(body);

    const [post] = await this.db
      .insert(schema.pomeloPosts)
      .values({ authorId: user.id, text: input.text, media: input.media })
      .returning();

    // Plan the whole 48-hour reaction curve now, so fast-forward is instant.
    const [workspace] = await this.db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .limit(1);

    if (workspace) {
      const clock = await readClock(this.db, workspace.id);
      await scheduleEngagement(this.db, {
        postId: post!.id,
        text: input.text,
        authorId: user.id,
        authorFollowers: user.followerCount,
        simNow: clock.simNow,
      });
      await this.simulatorQueue.add("tick", { workspaceId: workspace.id });
    }

    return { id: post!.id, createdAt: post!.createdAt };
  }

  /**
   * Reply to a post, or to a comment on one.
   *
   * Answering someone's comment is the common case, and the id we are handed is
   * that comment's id — so this resolves a reply id back to its parent post.
   * Pomelo threads flat, like early Twitter, so both land in the same
   * conversation.
   */
  @Post("posts/:id/replies")
  async createReply(
    @Param("id") targetId: string,
    @Body() body: { text: string },
    @Headers("authorization") authorization?: string,
  ) {
    const user = await this.authenticate(authorization);

    const postId = await this.resolveToPostId(targetId);
    if (!postId) {
      throw new NotFoundException("Nothing on Pomelo with that id to reply to");
    }

    const [reply] = await this.db
      .insert(schema.pomeloReplies)
      .values({ postId, authorId: user.id, text: body.text })
      .returning();

    await this.db
      .update(schema.pomeloPosts)
      .set({ replyCount: sql`${schema.pomeloPosts.replyCount} + 1` })
      .where(eq(schema.pomeloPosts.id, postId));

    return { id: reply!.id, postId };
  }

  private async resolveToPostId(id: string): Promise<string | null> {
    // A malformed id would otherwise fail the uuid cast and surface as a 500.
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;

    const [post] = await this.db
      .select({ id: schema.pomeloPosts.id })
      .from(schema.pomeloPosts)
      .where(eq(schema.pomeloPosts.id, id));
    if (post) return post.id;

    const [reply] = await this.db
      .select({ postId: schema.pomeloReplies.postId })
      .from(schema.pomeloReplies)
      .where(eq(schema.pomeloReplies.id, id));
    return reply?.postId ?? null;
  }

  /** Everything new since a timestamp: metrics plus inbound conversation. */
  @Get("engagement")
  async engagement(
    @Query("since") since: string,
    @Headers("authorization") authorization?: string,
  ) {
    const user = await this.authenticate(authorization);
    const sinceDate = since ? new Date(since) : new Date(Date.now() - 86_400_000);

    const posts = await this.db
      .select()
      .from(schema.pomeloPosts)
      .where(eq(schema.pomeloPosts.authorId, user.id));

    const now = new Date().toISOString();
    const metrics: {
      metric: "impressions" | "likes" | "reposts" | "replies" | "followers";
      value: number;
      externalPostId?: string;
      at: string;
    }[] = posts.flatMap((post) => [
      { metric: "impressions", value: post.impressions, externalPostId: post.id, at: now },
      { metric: "likes", value: post.likeCount, externalPostId: post.id, at: now },
      { metric: "reposts", value: post.repostCount, externalPostId: post.id, at: now },
      { metric: "replies", value: post.replyCount, externalPostId: post.id, at: now },
    ]);
    // Followers is account-wide, so it carries no post id.
    metrics.push({ metric: "followers", value: user.followerCount, at: now });

    const postIds = posts.map((p) => p.id);
    const replies =
      postIds.length > 0
        ? await this.db
            .select({ reply: schema.pomeloReplies, author: schema.pomeloUsers })
            .from(schema.pomeloReplies)
            .innerJoin(
              schema.pomeloUsers,
              eq(schema.pomeloReplies.authorId, schema.pomeloUsers.id),
            )
            .where(
              and(
                inArray(schema.pomeloReplies.postId, postIds),
                gte(schema.pomeloReplies.createdAt, sinceDate),
              ),
            )
            .orderBy(desc(schema.pomeloReplies.createdAt))
            .limit(100)
        : [];

    return {
      metrics,
      inbound: replies
        // Our own replies are not incoming conversation.
        .filter((r) => r.author.id !== user.id)
        .map((r) => ({
          kind: "reply" as const,
          externalId: r.reply.id,
          authorHandle: r.author.handle,
          authorName: r.author.displayName,
          authorAvatarUrl: r.author.avatarUrl,
          text: r.reply.text,
          inReplyToExternalId: r.reply.postId,
          receivedAt: r.reply.createdAt.toISOString(),
        })),
    };
  }

  @Post("dms")
  async sendDm(
    @Body() body: { to: string; text: string },
    @Headers("authorization") authorization?: string,
  ) {
    await this.authenticate(authorization);
    // Pomelo accepts DMs so the auto-DM automation has somewhere real to run.
    return { ok: true, to: body.to };
  }

  // ── Public read surface, used by the in-app Pomelo feed ────────────────

  @Get("feed")
  async feed(@Query("limit") limit = "50") {
    const rows = await this.db
      .select({ post: schema.pomeloPosts, author: schema.pomeloUsers })
      .from(schema.pomeloPosts)
      .innerJoin(
        schema.pomeloUsers,
        eq(schema.pomeloPosts.authorId, schema.pomeloUsers.id),
      )
      .orderBy(desc(schema.pomeloPosts.createdAt))
      .limit(Math.min(Number(limit) || 50, 100));

    return rows.map(({ post, author }) => ({
      id: post.id,
      text: post.text,
      media: post.media,
      likeCount: post.likeCount,
      repostCount: post.repostCount,
      replyCount: post.replyCount,
      impressions: post.impressions,
      createdAt: post.createdAt,
      author: {
        handle: author.handle,
        displayName: author.displayName,
        avatarUrl: author.avatarUrl,
        isPersona: author.isPersona,
      },
    }));
  }

  @Get("posts/:id")
  async post(@Param("id") id: string) {
    const [row] = await this.db
      .select({ post: schema.pomeloPosts, author: schema.pomeloUsers })
      .from(schema.pomeloPosts)
      .innerJoin(
        schema.pomeloUsers,
        eq(schema.pomeloPosts.authorId, schema.pomeloUsers.id),
      )
      .where(eq(schema.pomeloPosts.id, id));
    if (!row) throw new NotFoundException("No such post on Pomelo");

    const replies = await this.db
      .select({ reply: schema.pomeloReplies, author: schema.pomeloUsers })
      .from(schema.pomeloReplies)
      .innerJoin(
        schema.pomeloUsers,
        eq(schema.pomeloReplies.authorId, schema.pomeloUsers.id),
      )
      .where(eq(schema.pomeloReplies.postId, id))
      .orderBy(schema.pomeloReplies.createdAt);

    return {
      ...row.post,
      author: row.author,
      replies: replies.map(({ reply, author }) => ({
        id: reply.id,
        text: reply.text,
        createdAt: reply.createdAt,
        author: {
          handle: author.handle,
          displayName: author.displayName,
          avatarUrl: author.avatarUrl,
        },
      })),
    };
  }

  @Get("trends")
  async trends() {
    return this.db
      .select({
        topic: schema.pomeloTrends.topic,
        momentum: schema.pomeloTrends.momentum,
      })
      .from(schema.pomeloTrends)
      .orderBy(desc(schema.pomeloTrends.momentum))
      .limit(8);
  }

  @Get("residents")
  async residents() {
    return this.db
      .select({
        handle: schema.pomeloUsers.handle,
        displayName: schema.pomeloUsers.displayName,
        avatarUrl: schema.pomeloUsers.avatarUrl,
        bio: schema.pomeloUsers.bio,
        followerCount: schema.pomeloUsers.followerCount,
        personaConfig: schema.pomeloUsers.personaConfig,
      })
      .from(schema.pomeloUsers)
      .where(eq(schema.pomeloUsers.isPersona, true))
      .orderBy(desc(schema.pomeloUsers.followerCount));
  }
}
