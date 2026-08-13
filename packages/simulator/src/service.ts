import { and, asc, eq, lte, schema, sql, type Database } from "@zest/db";
import { planEngagement, type SimPersona } from "./engine.ts";
import { classifySentiment, composeReply, type ReplyGenerator } from "./replier.ts";
import { readClock } from "./clock.ts";

/**
 * Drives Pomelo: schedules engagement when a post appears, then releases those
 * reactions as simulated time passes. Everything it produces leaves through the
 * ordinary Pomelo API, so Zest ingests it via the connector like any platform.
 */

export async function loadPersonas(db: Database): Promise<SimPersona[]> {
  const rows = await db
    .select()
    .from(schema.pomeloUsers)
    .where(eq(schema.pomeloUsers.isPersona, true));

  return rows
    .filter((r) => r.personaConfig !== null)
    .map((r) => ({
      id: r.id,
      handle: r.handle,
      followerCount: r.followerCount,
      config: r.personaConfig!,
    }));
}

/**
 * Called right after a post lands on Pomelo. Writes the whole 48-hour reaction
 * schedule up front so the tick job only has to release what is due — which is
 * why fast-forwarding a day is instant rather than a long simulation.
 */
export async function scheduleEngagement(
  db: Database,
  input: {
    postId: string;
    text: string;
    authorId: string;
    authorFollowers: number;
    simNow: Date;
  },
): Promise<{ scheduled: number; quality: number; viral: boolean }> {
  const personas = (await loadPersonas(db)).filter((p) => p.id !== input.authorId);

  const plan = planEngagement({
    postId: input.postId,
    text: input.text,
    publishedAt: input.simNow,
    personas,
    authorFollowers: input.authorFollowers,
  });

  if (plan.events.length > 0) {
    await db.insert(schema.simEvents).values(
      plan.events.map((event) => ({
        postId: input.postId,
        actorId: event.actorId,
        kind: event.kind,
        payload: null,
        fireAtSim: new Date(input.simNow.getTime() + event.offsetMs),
        fired: false,
      })),
    );
  }

  return { scheduled: plan.events.length, quality: plan.quality, viral: plan.viral };
}

export type ReleasedEvent = {
  id: string;
  postId: string;
  kind: "impression" | "like" | "repost" | "reply" | "follow";
  actorHandle: string;
  text?: string;
};

/**
 * Releases every event whose simulated time has arrived, applying it to the
 * Pomelo tables. Replies are materialised as real Pomelo replies so the agent
 * can read and answer them through the normal API.
 */
export async function releaseDueEvents(
  db: Database,
  workspaceId: string,
  options: { limit?: number; generateReply?: ReplyGenerator } = {},
): Promise<ReleasedEvent[]> {
  const clock = await readClock(db, workspaceId);

  const due = await db
    .select({
      event: schema.simEvents,
      actor: schema.pomeloUsers,
      post: schema.pomeloPosts,
    })
    .from(schema.simEvents)
    .innerJoin(schema.pomeloUsers, eq(schema.simEvents.actorId, schema.pomeloUsers.id))
    .innerJoin(schema.pomeloPosts, eq(schema.simEvents.postId, schema.pomeloPosts.id))
    .where(
      and(
        eq(schema.simEvents.fired, false),
        lte(schema.simEvents.fireAtSim, clock.simNow),
      ),
    )
    .orderBy(asc(schema.simEvents.fireAtSim))
    .limit(options.limit ?? 200);

  const released: ReleasedEvent[] = [];

  for (const row of due) {
    const { event, actor, post } = row;

    // Mark fired first, conditionally: two overlapping ticks must not both
    // apply the same like.
    const [claimed] = await db
      .update(schema.simEvents)
      .set({ fired: true })
      .where(and(eq(schema.simEvents.id, event.id), eq(schema.simEvents.fired, false)))
      .returning({ id: schema.simEvents.id });
    if (!claimed) continue;

    switch (event.kind) {
      case "impression":
        await db
          .update(schema.pomeloPosts)
          .set({ impressions: sql`${schema.pomeloPosts.impressions} + 1` })
          .where(eq(schema.pomeloPosts.id, post.id));
        break;

      case "like":
        await db
          .update(schema.pomeloPosts)
          .set({ likeCount: sql`${schema.pomeloPosts.likeCount} + 1` })
          .where(eq(schema.pomeloPosts.id, post.id));
        break;

      case "repost":
        await db
          .update(schema.pomeloPosts)
          .set({ repostCount: sql`${schema.pomeloPosts.repostCount} + 1` })
          .where(eq(schema.pomeloPosts.id, post.id));
        break;

      case "follow":
        await db
          .insert(schema.pomeloFollows)
          .values({ followerId: actor.id, followeeId: post.authorId })
          .onConflictDoNothing();
        await db
          .update(schema.pomeloUsers)
          .set({ followerCount: sql`${schema.pomeloUsers.followerCount} + 1` })
          .where(eq(schema.pomeloUsers.id, post.authorId));
        break;

      case "reply": {
        if (!actor.personaConfig) break;
        const text = await composeReply(
          {
            postText: post.text,
            persona: { handle: actor.handle, config: actor.personaConfig },
            seed: event.id,
          },
          options.generateReply,
        );
        await db.insert(schema.pomeloReplies).values({
          postId: post.id,
          authorId: actor.id,
          text,
        });
        await db
          .update(schema.pomeloPosts)
          .set({ replyCount: sql`${schema.pomeloPosts.replyCount} + 1` })
          .where(eq(schema.pomeloPosts.id, post.id));
        released.push({
          id: event.id,
          postId: post.id,
          kind: "reply",
          actorHandle: actor.handle,
          text,
        });
        continue;
      }
    }

    released.push({
      id: event.id,
      postId: post.id,
      kind: event.kind,
      actorHandle: actor.handle,
    });
  }

  return released;
}

/** Nudges trending topics so `search_trends` returns a moving target. */
export async function advanceTrends(db: Database): Promise<void> {
  const trends = await db.select().from(schema.pomeloTrends);
  for (const trend of trends) {
    // Deterministic drift from the topic name: stable across restarts, still
    // varied across topics.
    const drift = ((trend.topic.length * 7 + trend.dayIndex * 13) % 21) - 10;
    const momentum = Math.max(5, Math.min(100, trend.momentum + drift));
    await db
      .update(schema.pomeloTrends)
      .set({ momentum, dayIndex: trend.dayIndex + 1, updatedAt: new Date() })
      .where(eq(schema.pomeloTrends.id, trend.id));
  }
}

export async function currentTrends(
  db: Database,
  limit = 6,
): Promise<{ topic: string; momentum: number }[]> {
  const rows = await db
    .select({
      topic: schema.pomeloTrends.topic,
      momentum: schema.pomeloTrends.momentum,
    })
    .from(schema.pomeloTrends)
    .orderBy(sql`${schema.pomeloTrends.momentum} desc`)
    .limit(limit);
  return rows;
}

/** Reply text plus sentiment, for the connector's inbound feed. */
export function describeInbound(text: string): {
  text: string;
  sentiment: ReturnType<typeof classifySentiment>;
} {
  return { text, sentiment: classifySentiment(text) };
}
