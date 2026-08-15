import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq, schema, type Database } from "@zest/db";
import {
  claimForPublish,
  emit,
  expireStaleProposals,
  findDuePosts,
  recoverStalePublishing,
  transition,
  Notifier,
} from "@zest/core";
import { getConnector } from "@zest/connectors";
import { system } from "@zest/shared";
import { reapStaleRuns } from "@zest/agent";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { NOTIFIER } from "../infra/notifier.module.js";
import { QUEUE_PUBLISH } from "../queue/queue.constants.js";
import { enqueueUnique } from "../queue/enqueue.js";
import { credentialsFor } from "./credentials.js";

/**
 * Publishing.
 *
 * The sweep finds what is due and fans out one job per post; the publish job
 * claims the row before it talks to any platform. That claim — a conditional
 * UPDATE — is the only thing standing between a duplicated cron tick and a
 * double-posted account, and it lives in the database rather than the queue on
 * purpose: Redis can be restored from a snapshot, Postgres rows cannot be
 * un-claimed.
 */
@Processor(QUEUE_PUBLISH)
export class PublishProcessor extends WorkerHost {
  private readonly logger = new Logger(PublishProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @Inject(NOTIFIER) private readonly notifier: Notifier,
    @InjectQueue(QUEUE_PUBLISH) private readonly queue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    switch (job.name) {
      case "sweep-due-posts":
        return this.sweep();
      case "publish-post":
        return this.publishPost(job.data.postId as string);
      case "send-reply":
        return this.sendReply(job.data.replyDraftId as string);
      case "reconcile":
        return this.reconcile();
      default:
        this.logger.warn(`Unknown job ${job.name}`);
        return null;
    }
  }

  /** Enqueues one job per due post, keyed by post id so duplicates collapse. */
  private async sweep(): Promise<{ enqueued: number }> {
    const due = await findDuePosts(this.db);
    for (const post of due) {
      await enqueueUnique(
        this.queue,
        "publish-post",
        { postId: post.id },
        `publish-${post.id}`,
      );
    }
    return { enqueued: due.length };
  }

  private async publishPost(postId: string): Promise<{ published: boolean }> {
    const actor = system("scheduler");

    const claimed = await claimForPublish(this.db, postId, actor);
    if (!claimed) {
      // Someone else has it. Not an error — this is the guard working.
      this.logger.debug(`Post ${postId} was already claimed; skipping`);
      return { published: false };
    }

    const [account] = await this.db
      .select()
      .from(schema.linkedAccounts)
      .where(eq(schema.linkedAccounts.id, claimed.accountId));

    if (!account) {
      await this.fail(postId, "The connected account no longer exists");
      return { published: false };
    }

    try {
      const connector = getConnector(account.connectorId);
      // Resolved once and reused for the thread parts below: refreshing per
      // part would trade one token exchange for as many as the thread is long.
      const credentials = await credentialsFor(this.db, account, connector);
      const result = await connector.publish(credentials, claimed.content);

      /**
       * Thread parts chain as replies to whatever went out last. Every
       * connector already speaks `reply()`, so threads need no per-platform
       * code at all.
       *
       * Parts after a successful root are best-effort on purpose: the root is
       * live, so failing the job here would retry it and double-post part one —
       * the exact bug the claim exists to prevent. A broken chain is recorded
       * on the post instead, where the operator can see it and finish by hand.
       */
      let threadNote: string | null = null;
      let previousExternalId = result.externalId;
      for (const [index, part] of (claimed.content.thread ?? []).entries()) {
        try {
          const published = await connector.reply(credentials, previousExternalId, {
            text: part,
            media: [],
          });
          previousExternalId = published.externalId;
        } catch (error) {
          threadNote = `Thread part ${index + 2} of ${
            (claimed.content.thread?.length ?? 0) + 1
          } failed to publish: ${(error as Error).message}`;
          this.logger.warn(`${postId}: ${threadNote}`);
          break;
        }
      }

      await transition(this.db, {
        postId,
        action: "publish_succeeded",
        actor,
        patch: {
          publishedAt: new Date(),
          externalId: result.externalId,
          externalUrl: result.url,
          errorMessage: threadNote,
        },
      });

      await emit(this.redis, {
        type: "post.status_changed",
        workspaceId: claimed.workspaceId,
        postId,
        from: "publishing",
        to: "published",
        actorKind: "system",
      });

      await this.notifier.dispatch(this.db, {
        workspaceId: claimed.workspaceId,
        title: `Published to ${connector.meta.name}`,
        body: claimed.content.text.slice(0, 200),
        url: `/calendar?post=${postId}`,
        kind: "published",
      });

      return { published: true };
    } catch (error) {
      await this.fail(postId, (error as Error).message);
      throw error;
    }
  }

  private async fail(postId: string, message: string): Promise<void> {
    await transition(this.db, {
      postId,
      action: "publish_failed",
      actor: system("scheduler"),
      patch: { errorMessage: message },
    });
    this.logger.error(`Publishing ${postId} failed: ${message}`);
  }

  private async sendReply(replyDraftId: string): Promise<{ sent: boolean }> {
    const [row] = await this.db
      .select({
        draft: schema.replyDrafts,
        inbound: schema.inboundItems,
        account: schema.linkedAccounts,
      })
      .from(schema.replyDrafts)
      .innerJoin(
        schema.inboundItems,
        eq(schema.replyDrafts.inboundItemId, schema.inboundItems.id),
      )
      .innerJoin(
        schema.linkedAccounts,
        eq(schema.inboundItems.accountId, schema.linkedAccounts.id),
      )
      .where(
        and(
          eq(schema.replyDrafts.id, replyDraftId),
          eq(schema.replyDrafts.status, "approved"),
        ),
      );

    if (!row) return { sent: false };

    try {
      const connector = getConnector(row.account.connectorId);
      const result = await connector.reply(
        await credentialsFor(this.db, row.account, connector),
        row.inbound.externalId,
        row.draft.content,
      );

      await this.db
        .update(schema.replyDrafts)
        .set({
          status: "published",
          externalId: result.externalId,
          externalUrl: result.url,
        })
        .where(eq(schema.replyDrafts.id, replyDraftId));

      await this.db
        .update(schema.inboundItems)
        .set({ status: "replied" })
        .where(eq(schema.inboundItems.id, row.inbound.id));

      return { sent: true };
    } catch (error) {
      await this.db
        .update(schema.replyDrafts)
        .set({ status: "failed", errorMessage: (error as Error).message })
        .where(eq(schema.replyDrafts.id, replyDraftId));
      throw error;
    }
  }

  /**
   * Safety net for the gap between Postgres and Redis: a post can be scheduled
   * in a committed transaction and still lose its queue job if Redis blips.
   * This re-enqueues anything the sweep missed, unsticks posts abandoned
   * mid-publish, and expires proposals nobody reviewed in time.
   */
  private async reconcile(): Promise<{
    recovered: number;
    expired: number;
    abandonedRuns: number;
  }> {
    const recovered = await recoverStalePublishing(this.db);

    // A worker killed mid-run leaves its row in `running` forever: the team
    // page spins and nothing retries. Same sweep, one layer up.
    const abandonedRuns = await reapStaleRuns(this.db);

    const stale = await expireStaleProposals(this.db);
    for (const postId of stale) {
      await transition(this.db, {
        postId,
        action: "expire",
        actor: system("scheduler"),
      });
    }

    if (recovered > 0 || stale.length > 0 || abandonedRuns > 0) {
      this.logger.log(
        `Reconciled: ${recovered} recovered from publishing, ${stale.length} proposals expired, ${abandonedRuns} abandoned runs failed`,
      );
    }
    return { recovered, expired: stale.length, abandonedRuns };
  }
}
