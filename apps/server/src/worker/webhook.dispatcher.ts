import { InjectQueue } from "@nestjs/bullmq";
import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import { type Database } from "@zest/db";
import { parseEvent, webhooks, type DomainEvent } from "@zest/core";
import { DATABASE } from "../infra/database.module.js";
import { REDIS_SUB } from "../infra/redis.module.js";
import { QUEUE_WEBHOOK } from "../queue/queue.constants.js";

/**
 * Turns domain events into webhook deliveries.
 *
 * Subscribes to the same Redis channel the SSE endpoint reads, which is the
 * whole reason the state machine emits events instead of calling its consumers:
 * outbound webhooks reach production without a single line changing in any
 * producer. Third subscriber, zero coupling.
 *
 * Pattern-subscribed across workspaces because the worker has no request
 * context to tell it which one to watch — unlike SSE, where a connection
 * belongs to exactly one.
 */
@Injectable()
export class WebhookDispatcher implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebhookDispatcher.name);
  private connection: Redis | undefined;

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(REDIS_SUB) private readonly redis: Redis,
    @InjectQueue(QUEUE_WEBHOOK) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    this.connection = this.redis.duplicate();
    await this.connection.psubscribe("zest:ws:*");
    this.connection.on("pmessage", (_pattern, _channel, raw: string) => {
      const event = parseEvent(raw);
      if (event) void this.fanOut(event);
    });
    this.logger.log("Subscribed to domain events for webhook delivery");
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.quit().catch(() => undefined);
  }

  /**
   * One job per endpoint rather than one per event: a slow receiver must not
   * delay a fast one, and a retry should re-send to the endpoint that failed
   * rather than to everybody.
   */
  private async fanOut(event: DomainEvent): Promise<void> {
    try {
      const endpoints = webhooks.endpointsFor(
        await webhooks.listEndpoints(this.db, event.workspaceId),
        event,
      );
      if (endpoints.length === 0) return;

      const { type, workspaceId, ...data } = event;
      for (const endpoint of endpoints) {
        await this.queue.add(
          "deliver",
          {
            endpointId: endpoint.id,
            delivery: {
              id: randomUUID(),
              type,
              workspaceId,
              createdAt: new Date().toISOString(),
              data,
            },
          },
          {
            attempts: 5,
            // A receiver that is down usually stays down for a moment; backing
            // off from 5s to ~80s spreads the retries over several minutes
            // without the operator configuring anything.
            backoff: { type: "exponential", delay: 5_000 },
            removeOnComplete: 200,
            removeOnFail: 500,
          },
        );
      }
    } catch (error) {
      // A webhook problem must never take down the event stream that feeds the
      // UI. Log and drop.
      this.logger.warn(`Could not fan out ${event.type}: ${(error as Error).message}`);
    }
  }
}
