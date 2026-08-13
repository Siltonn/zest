import { InjectQueue, Processor, WorkerHost } from "@nestjs/bullmq";
import { Inject, Logger } from "@nestjs/common";
import type { Job, Queue } from "bullmq";
import type { Redis } from "ioredis";
import { and, eq, schema, type Database } from "@zest/db";
import { analytics, emit } from "@zest/core";
import { getConnector } from "@zest/connectors";
import { classifySentiment } from "@zest/simulator";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_PUB } from "../infra/redis.module.js";
import { QUEUE_AGENT_RUN, QUEUE_INGEST } from "../queue/queue.constants.js";
import { toCredentials } from "./credentials.js";

/**
 * Pulls engagement back in from every connected account.
 *
 * Pomelo and Bluesky arrive through the same code path — the simulator's output
 * is not special-cased anywhere — so the analytics, the reply inbox and the
 * agent's view of "how did we do" are identical whether the audience is
 * simulated or real.
 */
@Processor(QUEUE_INGEST)
export class IngestProcessor extends WorkerHost {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_PUB) private readonly redis: Redis,
    @InjectQueue(QUEUE_AGENT_RUN) private readonly agentQueue: Queue,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const explicit = job.data?.workspaceId as string | undefined;
    const workspaces = explicit
      ? [{ id: explicit }]
      : await this.db.select({ id: schema.workspaces.id }).from(schema.workspaces);

    let newInbound = 0;

    for (const workspace of workspaces) {
      const accounts = await this.db
        .select()
        .from(schema.linkedAccounts)
        .where(eq(schema.linkedAccounts.workspaceId, workspace.id));

      for (const account of accounts) {
        try {
          newInbound += await this.ingestAccount(workspace.id, account);
        } catch (error) {
          // One unreachable platform must not stop the others.
          this.logger.warn(
            `Ingest failed for @${account.handle}: ${(error as Error).message}`,
          );
        }
      }

      if (newInbound > 0) {
        await this.agentQueue.add("triage", { workspaceId: workspace.id });
      }
    }

    return { newInbound };
  }

  private async ingestAccount(
    workspaceId: string,
    account: typeof schema.linkedAccounts.$inferSelect,
  ): Promise<number> {
    const connector = getConnector(account.connectorId);
    const since = new Date(Date.now() - 7 * 86_400_000);
    const snapshot = await connector.fetchEngagement(toCredentials(account), since);

    // Map platform post ids back to ours so metrics attach to the right row.
    const posts = await this.db
      .select({ id: schema.posts.id, externalId: schema.posts.externalId })
      .from(schema.posts)
      .where(eq(schema.posts.accountId, account.id));
    const byExternalId = new Map(
      posts.filter((p) => p.externalId).map((p) => [p.externalId!, p.id]),
    );

    if (snapshot.metrics.length > 0) {
      await analytics.recordMetrics(
        this.db,
        workspaceId,
        account.id,
        snapshot.metrics.map((m) => ({
          metric: m.metric,
          value: m.value,
          postId: m.externalPostId ? byExternalId.get(m.externalPostId) : undefined,
          at: m.at,
        })),
      );
      await emit(this.redis, {
        type: "metric.updated",
        workspaceId,
        accountId: account.id,
      });
    }

    let created = 0;
    for (const message of snapshot.inbound) {
      // Platforms re-serve the same notifications; the external id keeps this
      // idempotent so a comment is never triaged twice.
      const [existing] = await this.db
        .select({ id: schema.inboundItems.id })
        .from(schema.inboundItems)
        .where(
          and(
            eq(schema.inboundItems.accountId, account.id),
            eq(schema.inboundItems.externalId, message.externalId),
          ),
        );
      if (existing) continue;

      await this.db.insert(schema.inboundItems).values({
        workspaceId,
        accountId: account.id,
        kind: message.kind,
        externalId: message.externalId,
        authorHandle: message.authorHandle,
        authorName: message.authorName ?? null,
        authorAvatarUrl: message.authorAvatarUrl ?? null,
        text: message.text,
        sentiment: classifySentiment(message.text),
        postId: message.inReplyToExternalId
          ? (byExternalId.get(message.inReplyToExternalId) ?? null)
          : null,
        status: "new",
        receivedAt: message.receivedAt,
      });
      created += 1;
    }

    return created;
  }
}
